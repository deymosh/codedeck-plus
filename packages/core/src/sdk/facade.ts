/**
 * The ONE seam between @codedeck/core and `@anthropic-ai/claude-agent-sdk`.
 *
 * Everything else in core (and in the hosts) programs against the narrow
 * `SdkFacade` / `SdkSessionHandle` interfaces defined here, so an SDK upgrade
 * only ever touches this file. Tests run against `FakeSdkFacade` from
 * @codedeck/testkit — `RealSdkFacade` is deliberately NOT unit-tested: it is
 * kept so thin (pure API-shape adaptation, no business logic) that its only
 * meaningful test would be spawning a real Claude Code subprocess.
 *
 * SDK type re-exports: modules that must speak SDK message shapes (the
 * adapter, the permission broker) import them from HERE, type-only, never
 * from the SDK package directly.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, PermissionMode } from '@codedeck/protocol';

// --- Re-exported SDK types (type-only; the seam for everyone else) ---
export type {
  SDKMessage as SdkMessage,
  SDKAssistantMessage as SdkAssistantMessage,
  SDKUserMessage as SdkUserMessage,
  SDKResultMessage as SdkResultMessage,
  SDKResultError as SdkResultError,
  SDKSystemMessage as SdkSystemMessage,
  SDKAuthStatusMessage as SdkAuthStatusMessage,
  SDKSessionStateChangedMessage as SdkSessionStateChangedMessage,
  PermissionResult as SdkPermissionResult,
  PermissionUpdate as SdkPermissionUpdate,
  CanUseTool as SdkCanUseTool,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Fallback model used by every session's query() Options. If the primary model
 * is overloaded or unavailable, the SDK degrades to this rather than failing
 * the turn.
 */
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

export interface SdkSessionOptions {
  /** Our session id — becomes the SDK sessionId (create) or is ignored when `resume` is set. */
  sessionId: string;
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  /** Phone-level effort. Applied at query() construction (Options.effort takes
   *  the full set incl. 'max'); 'auto'/unset → omit → model default. */
  effortLevel?: EffortLevel;
  /** SDK session id to resume instead of creating a fresh session. */
  resume?: string;
  canUseTool: CanUseTool;
  mcpServers?: Record<string, McpServerConfig>;
  /** Explicit path to the `claude` executable (see resolveClaudeExecutable). */
  pathToClaudeCodeExecutable?: string;
  /**
   * Subprocess environment for the Claude Code CLI. The SDK REPLACES the
   * environment with this value (no merge) — callers must spread process.env
   * themselves. Used to feed phone-set credentials (ANTHROPIC_API_KEY /
   * GITHUB_TOKEN) into sessions (CDX-011; old bridge's buildSessionEnv).
   * Values are secrets: never log this object.
   */
  env?: Record<string, string>;
  /**
   * CDX-062 tri-state fallback model for Options.fallbackModel:
   * - undefined → today's FALLBACK_MODEL (unchanged default behavior);
   * - null → OMIT the option entirely (provider-bound sessions: the constant
   *   `claude-sonnet-4-6` is not a valid model at a custom provider);
   * - string → use as given.
   */
  fallbackModel?: string | null;
  /**
   * CDX-071: the custom provider profile this session is bound to, if any.
   * The EXPLICIT signal that replaces env sniffing — see
   * isProviderBoundSession. Purely declarative: buildQueryOptions never
   * forwards it to the SDK (the binding reaches the CLI as env).
   */
  providerId?: string;
}

/**
 * CDX-071: is this session bound to a custom AI provider, and therefore
 * disqualified from answering the machine-wide (Anthropic) model list?
 *
 * The pre-fix test was `!!opts.env?.ANTHROPIC_BASE_URL` — a reintroduction of
 * the CDX-022 bug it was written to avoid. `ANTHROPIC_BASE_URL` in the BRIDGE
 * OPERATOR'S own shell is a documented Claude Code setup (LLM gateway), and
 * every session inherits the operator's env whenever any credential is stored.
 * So on such a machine EVERY plain Anthropic session was flagged
 * provider-bound, every handle got filtered out of firstSupportedModels, and
 * the phone showed an empty model list — the exact CDX-022 device symptom.
 *
 * Both signals below are caller-supplied session options, never ambient env:
 * - `providerId` — the session's provider binding, the authoritative one;
 * - `fallbackModel === null` — already documented above as meaning exactly
 *   "provider-bound" (the Anthropic fallback constant is not a valid model at
 *   a custom provider). Kept as a second reading so the guard cannot regress
 *   while a caller still passes only the tri-state; it is not a fallback to
 *   env sniffing, just the other half of the same explicit contract.
 */
export function isProviderBoundSession(
  opts: Pick<SdkSessionOptions, 'providerId' | 'fallbackModel'>,
): boolean {
  return opts.providerId !== undefined || opts.fallbackModel === null;
}

export interface SdkContextUsage {
  /** 0–100, the same meter the Claude Code terminal shows. */
  percentage?: number;
  /** Real context-window size in tokens (honest denominator, incl. 1M beta). */
  contextWindow?: number;
}

export interface SdkSessionHandle {
  /** The session's message stream. Iterate exactly once. */
  messages(): AsyncIterable<SDKMessage>;
  /** Queue a user text message into the session's input channel. */
  pushInput(text: string): void;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  /** Mid-session effort change. SDK 0.3.220+ accepts session-scoped 'max'
   *  directly; 'auto' resets to the model default. */
  setEffort(level: EffortLevel): Promise<void>;
  /** Interrupt the current turn (Ctrl+C equivalent). */
  interrupt(): Promise<void>;
  /**
   * Cheap control-channel round-trip proving the CLI subprocess spawned and
   * responds, usable BEFORE any input. SDK 0.3.222 emits the `init` message
   * only after the FIRST streamed user message, so a freshly created idle
   * session never confirms via init alone — the runner flips pending→ready on
   * this probe instead (found on the real-socket rig, CDX-009 Phase 3d).
   * Resolves once the subprocess answers; rejects on spawn/startup failure.
   */
  probeReady(): Promise<void>;
  /** Feature-detected `query.getContextUsage()`. Null when unsupported/failed. */
  getContextUsage(): Promise<SdkContextUsage | null>;
  /** Feature-detected experimental `/usage` snapshot (rate-limit windows).
   *  Raw SDK shape — normalization is the caller's job. Null when unsupported. */
  getUsageSnapshot(): Promise<unknown | null>;
  /** Close the input channel and abort the subprocess. Idempotent. */
  end(): Promise<void>;
}

export interface SdkModelDescriptor {
  id: string;
  label?: string;
}

export interface SdkFacade {
  createSession(opts: SdkSessionOptions): SdkSessionHandle;
  /** Available models, via `query.supportedModels()` when the SDK offers it. */
  supportedModels(): Promise<SdkModelDescriptor[]>;
}

// --- Model-list aggregation (CDX-022) ---

/** The slice of a session handle the model-list aggregation needs. */
export interface ModelsQueryHandle {
  readonly isEnded: boolean;
  /** Ask this handle's query for the supported-model list. May reject (dead
   *  subprocess: "No conversation found with session ID …") or never settle
   *  (subprocess wedged pre-init — `supportedModels()` awaits the SDK's
   *  unbounded `initialization` promise). */
  queryModels(): Promise<SdkModelDescriptor[]>;
}

/** Per-handle budget for a supportedModels control request. A live CLI answers
 *  in ~1s (measured); anything slower is treated as dead and skipped. */
export const SUPPORTED_MODELS_TIMEOUT_MS = 3_000;

/**
 * Ask every live handle for its model list and return the FIRST non-empty
 * answer (CDX-022). The old behavior — return whatever the first handle in
 * insertion order said — meant one dead handle (a failed resume-on-boot query
 * is always first after a bridge restart) poisoned the list forever: its
 * control request either rejects (→ `[]`) or never settles (→ the
 * models-request handler suspends and publishes nothing, with no error
 * logged — exactly the device symptom of CDX-022). Now a dead, hung, or
 * empty-answering handle just means "try the next one".
 */
export async function firstSupportedModels(
  handles: Iterable<ModelsQueryHandle>,
  timeoutMs: number = SUPPORTED_MODELS_TIMEOUT_MS,
  log?: (msg: string) => void,
): Promise<SdkModelDescriptor[]> {
  for (const handle of handles) {
    if (handle.isEnded) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        handle.queryModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`supportedModels timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (models.length > 0) return models;
    } catch (err) {
      log?.(`[SdkFacade] supportedModels: skipping dead handle: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

// --- Async input channel (ported verbatim from old sdkSession.ts) ---

/** Creates a controllable async generator that yields SDKUserMessage objects.
 *  Call push() to queue a message, and the generator will yield it. */
function createInputChannel(): {
  generator: AsyncGenerator<SDKUserMessage, void>;
  push: (msg: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  const generator = (async function* () {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((r) => { resolve = r; });
        resolve = null;
      }
    }
  })();

  return {
    generator,
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
}

/**
 * Map a phone effort level to the SDK's Options.effort value (used at query()
 * construction). 'auto' / undefined → omit (model default).
 */
function toOptionsEffort(effort?: EffortLevel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined; // 'auto' or unset → model default
  }
}

/**
 * Locate the `claude` executable for Options.pathToClaudeCodeExecutable.
 * Order: explicit config path → CODEDECK_CLAUDE_PATH env → `which claude` →
 * common install locations. Returns null when nothing is found (the SDK then
 * falls back to its own resolution).
 */
export function resolveClaudeExecutable(explicitPath?: string): string | null {
  const isFile = (p: string): boolean => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };

  if (explicitPath && isFile(explicitPath)) return explicitPath;

  const env = process.env.CODEDECK_CLAUDE_PATH?.trim();
  if (env && isFile(env)) return env;

  try {
    const out = execFileSync('which', ['claude'], { timeout: 3000, encoding: 'utf8' }).trim();
    if (out && isFile(out)) return out;
  } catch { /* not on PATH */ }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (isFile(p)) return p;
  }
  return null;
}

/**
 * The Claude CLI's own cwd→directory-name mapping for `<config>/projects/`,
 * read out of the 2.1.220 binary:
 *
 *   function x0(e){let t=e.replace(/[^a-zA-Z0-9]/g,"-");
 *                  if(t.length<=axt)return t;return `${t.slice(0,axt)}-${eCh(e)}`}   // axt=200
 *
 * Under the cap the name is reproducible exactly. Over it the CLI appends a
 * Bun-hash suffix we cannot compute here, so we return every directory that
 * carries the truncated prefix and let the caller check them all — an over-long
 * cwd must degrade to "maybe", never to a confident "no".
 */
const CLAUDE_PROJECT_SLUG_MAX = 200;

export function claudeProjectDirs(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const root = path.join(configDir, 'projects');
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= CLAUDE_PROJECT_SLUG_MAX) return [path.join(root, slug)];
  const prefix = `${slug.slice(0, CLAUDE_PROJECT_SLUG_MAX)}-`;
  try {
    return fs.readdirSync(root)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

/**
 * CDX-076: does the CLI already hold a conversation under this id, in this cwd?
 *
 * Proven on the real 2.1.220 binary (run-sheet check 43): `<uuid>.jsonl` is
 * written at the FIRST TURN, not at spawn — a session that was created and
 * never given a turn leaves no file (the project directory is not even
 * created) — and a spawn carrying `--session-id X` when `<X>.jsonl` DOES exist
 * dies immediately with `Error: Session ID X is already in use.` and exit 1.
 * The check is per-cwd: the same id spawns happily in a different project dir.
 *
 * Unknowable ⇒ taken. A wrongly-omitted `--session-id` costs nothing but a
 * CLI-minted conversation name; a wrongly-sent one is a fatal spawn failure.
 */
export function sdkConversationExists(
  sessionId: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const dirs = claudeProjectDirs(cwd, env);
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) return true;
    } catch {
      return true; // cannot tell — assume taken (see above)
    }
  }
  return false;
}

/**
 * Build the SDK `Options` for one session spawn — extracted pure from the
 * RealSdkSessionHandle constructor so the mapping (notably the CDX-062
 * `fallbackModel` tri-state) is unit-testable without spawning anything.
 *
 * `conversationExists` is injected so the CDX-076 branch is testable without
 * a real `~/.claude/projects` tree.
 */
export function buildQueryOptions(
  opts: SdkSessionOptions,
  abortController: AbortController = new AbortController(),
  conversationExists: (
    sessionId: string,
    cwd: string,
    env?: Record<string, string | undefined>,
  ) => boolean = sdkConversationExists,
): Options {
  const optionsEffort = toOptionsEffort(opts.effortLevel);
  // CDX-062 tri-state: undefined → the historical constant; null → omit
  // (custom-provider sessions); string → as given.
  const fallbackModel = opts.fallbackModel === undefined ? FALLBACK_MODEL : opts.fallbackModel;
  // CDX-076: the SDK maps `sessionId` → `--session-id=` and `resume` →
  // `--resume=` independently, so the mutual exclusion below is OURS. That is
  // fine — but `--session-id X` is a HARD spawn error once a conversation for
  // X exists in this cwd, and every "start fresh" recovery (CDX-056's turn-less
  // resume, CDX-073's post-drop restart) asks for exactly our own id again. The
  // recoveries are safe today because no file exists in those states — but only
  // by luck: a lost `sdkSessionId` registry write (CDX-075's whole-file update)
  // or a false-positive drop leaves the file behind and kills the spawn with an
  // error no restart can clear. So: claim the id only while it is free, and
  // otherwise send no id at all and let the CLI mint its own. Our `sessionId`
  // stays the CodeDeck-side identity the phone keys everything on; `init`'s
  // `session_id` remains the authoritative sdk id the runner persists and
  // resumes, exactly as it already does for a CLI-chosen id.
  const claimOwnId = !opts.resume && !conversationExists(opts.sessionId, opts.cwd, opts.env);
  return {
    ...(opts.resume ? { resume: opts.resume } : claimOwnId ? { sessionId: opts.sessionId } : {}),
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    abortController,
    canUseTool: opts.canUseTool,
    settingSources: ['user', 'project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    ...(fallbackModel !== null ? { fallbackModel } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(optionsEffort ? { effort: optionsEffort } : {}),
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable }
      : {}),
    ...(opts.env ? { env: opts.env } : {}),
  };
}

// --- Real implementation over query() ---

class RealSdkSessionHandle implements SdkSessionHandle {
  private readonly q: Query;
  private readonly input: ReturnType<typeof createInputChannel>;
  private readonly abortController: AbortController;
  private ended = false;

  /** CDX-062: bound to a custom provider — this handle must never answer the
   *  machine-wide (Anthropic) model list. CDX-071: decided from the session's
   *  own options, never from the inherited environment. */
  readonly customProvider: boolean;

  constructor(opts: SdkSessionOptions) {
    this.input = createInputChannel();
    this.abortController = new AbortController();
    this.customProvider = isProviderBoundSession(opts);

    this.q = query({
      prompt: this.input.generator,
      options: buildQueryOptions(opts, this.abortController),
    });
  }

  /** The underlying Query — used by RealSdkFacade for supportedModels(). */
  get rawQuery(): Query {
    return this.q;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** ModelsQueryHandle: this handle's supported-model list, SDK shape → ours. */
  async queryModels(): Promise<SdkModelDescriptor[]> {
    const fn = (this.q as Partial<Pick<Query, 'supportedModels'>>).supportedModels;
    if (typeof fn !== 'function') return [];
    const models = await fn.call(this.q);
    return models.map((m) => ({ id: m.value, label: m.displayName }));
  }

  messages(): AsyncIterable<SDKMessage> {
    return this.q;
  }

  pushInput(text: string): void {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
  }

  async setModel(model: string): Promise<void> {
    await this.q.setModel(model);
  }

  async setEffort(level: EffortLevel): Promise<void> {
    // SDK 0.3.220+ applyFlagSettings accepts the full effort set INCLUDING a
    // session-scoped 'max' — the old mid-session max→xhigh downgrade is
    // obsolete (CDB-029) and deliberately not ported. 'auto' → null resets to
    // the model default.
    await this.q.applyFlagSettings({ effortLevel: level === 'auto' ? null : level });
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  async probeReady(): Promise<void> {
    // supportedModels() is a read-only control request the CLI answers as soon
    // as it is up — verified to resolve ~1s after spawn on an idle session and
    // to reject immediately when the executable is missing/broken.
    await this.q.supportedModels();
  }

  async getContextUsage(): Promise<SdkContextUsage | null> {
    // getContextUsage is typed on Query, but the underlying Claude Code binary
    // may not implement the control request — feature-detect + try/catch.
    const fn = (this.q as Partial<Pick<Query, 'getContextUsage'>>).getContextUsage;
    if (typeof fn !== 'function') return null;
    try {
      const res = await fn.call(this.q);
      return {
        ...(typeof res?.percentage === 'number' && isFinite(res.percentage)
          ? { percentage: res.percentage }
          : {}),
        ...(typeof res?.maxTokens === 'number' && res.maxTokens > 0
          ? { contextWindow: res.maxTokens }
          : {}),
      };
    } catch {
      return null;
    }
  }

  async getUsageSnapshot(): Promise<unknown | null> {
    // The method name is intentionally unstable; reach it dynamically + feature-detect.
    const q = this.q as unknown as {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
    };
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') return null;
    try {
      return await fn.call(this.q);
    } catch {
      return null;
    }
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.input.close();
    this.abortController.abort();
  }
}

export class RealSdkFacade implements SdkFacade {
  private handles = new Set<RealSdkSessionHandle>();

  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    const handle = new RealSdkSessionHandle(opts);
    this.handles.add(handle);
    return handle;
  }

  async supportedModels(): Promise<SdkModelDescriptor[]> {
    // supportedModels() is a control request on a live Query — try EVERY live
    // session's query, first non-empty answer wins (CDX-022: a dead handle
    // must not poison the list). With no live session there is nothing to ask;
    // callers treat [] as "unknown, use defaults".
    for (const handle of [...this.handles]) {
      if (handle.isEnded) this.handles.delete(handle);
    }
    // CDX-062: a handle bound to a custom provider would answer with THAT
    // provider's models — a lone live Kimi session must not poison the
    // machine-wide Anthropic model list. Skip such handles. (CDX-071: the
    // binding is read from session options, not from ANTHROPIC_BASE_URL in the
    // operator's own env, which flagged every Anthropic session on a machine
    // configured for an LLM gateway.)
    return firstSupportedModels([...this.handles].filter((h) => !h.customProvider));
  }
}
