/**
 * The OpenCode driver, over `@opencode-ai/sdk`'s v2 client — the API
 * OpenCode 1.x servers serve, and the only one with question replies and the
 * current permission-reply endpoint.
 *
 * One `OpenCodeSession` per bridge session: it subscribes to the server's
 * event stream, filters it down to stable `OpenCodeEvent`s (adapter.ts
 * translates those into entries), and answers OpenCode's permission and
 * question asks through the bridge.
 *
 * Deliberate limits:
 *  - permission replies are allow/deny only — no "always"/pattern rules;
 *  - no subscription usage: OpenCode has no equivalent to ask, and a
 *    fabricated number would be worse than none. Context usage is reported
 *    only for models whose provider declares a context limit;
 *  - no effort levels; models are per prompt (`provider/model` ids).
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type {
  AssistantMessage,
  Command,
  Event,
  EventPermissionAsked,
  EventQuestionAsked,
  OpencodeClient,
  Part,
  Provider,
  QuestionAnswer,
  QuestionInfo,
  Session,
  SnapshotFileDiff,
} from '@opencode-ai/sdk/v2/client';
import { parseSlashCommand, slashCommand } from '../../sdk/commands';
import type { Driver, DriverSession, McpManager, PluginManager, SessionContext, SessionMcpState } from '../../sdk/driver';
import { PERMISSION_ALLOW, PERMISSION_DENY, toolKindOf, toolLocations, toolTitle } from '../../sdk/tools';
import { newTranslateContext } from '../../sdk/transcript';
import type {
  AgentInfo,
  ModelEntry,
  QuestionSpec,
  SessionOption,
  SlashCommand,
  StartSession,
  Subagent,
  UsageData,
} from '../../sdk/types';
import { opencodeEventToEntries, toolCallDiffs, type OpenCodeEvent } from './adapter';
import { OpenCodeMcp, openCodeSessionMcp, toggleOpenCodeMcp } from './mcp';
import { OpenCodePlugins } from './plugins';
import { resolveOpenCodePath, startOpenCodeServer, type OpenCodeServerHandle } from './server';

export const OPENCODE_AGENT_ID = 'opencode';

/** `ask` sends every permission OpenCode asks for to the phone; `default`
 *  (the auto-approve mode every agent shares) allows them all. */
const AUTO_APPROVE_MODE = 'default';
const DEFAULT_MODE = 'ask';
const OPENCODE_MODES = [
  { id: DEFAULT_MODE, label: 'Ask', description: 'Ask before each tool call' },
  { id: AUTO_APPROVE_MODE, label: 'YOLO', description: 'Run every tool without asking' },
];

type ToolPart = Extract<Part, { type: 'tool' }>;
type PermissionAsk = EventPermissionAsked['properties'];
type QuestionAsk = EventQuestionAsked['properties'];

/** The permission ask older (pre-1.x) servers sent. 1.x sends
 *  `permission.asked` instead and never this; kept so an external older
 *  server still gets its asks answered. Not in the v2 `Event` union, hence
 *  declared here. */
interface LegacyPermissionUpdated {
  type: 'permission.updated';
  properties: {
    id: string;
    type: string;
    sessionID: string;
    callID?: string;
    title: string;
    metadata?: Record<string, unknown>;
  };
}

type StreamEvent = Event | LegacyPermissionUpdated;

/** The pieces of an ask the phone needs, normalized from either ask shape,
 *  plus how to send the answer back on the matching endpoint. */
interface NormalizedPermission {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title: string;
  description?: string;
  reply: (response: 'once' | 'reject') => Promise<void>;
}

/** A sub-agent's child session, as its `task` call described it. */
interface ChildSession {
  callId: string;
  title: string;
  label?: string;
  /** The sub-agent was left running in the background, and has not ended. */
  background: boolean;
  /** The user asked it to stop: its end is a stop, not a completion. */
  stopping: boolean;
}

function subagentOf(child: ChildSession): Subagent {
  return { ...(child.label ? { label: child.label } : {}), parentCallId: child.callId };
}

/** The tool OpenCode uses to ask the user questions. Its own call is not
 *  shown as a generic tool row: `question.asked` renders it as a question
 *  card instead (see handleQuestion). */
const QUESTION_TOOL = 'question';

/** `model/providerID` split — OpenCode's prompt body wants `{providerID,
 *  modelID}`, not a single string. A model id with no `/` (or an empty half)
 *  has no valid split, so the field is omitted entirely and OpenCode falls
 *  back to its own configured default — no fabrication. */
function splitModelId(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** OpenCode's models and the one a session defaults to. */
export interface OpenCodeCatalog {
  models: ModelEntry[];
  defaultModel?: string;
  /** Context window per model id, for the models whose provider declares
   *  one. OpenCode reports an undeclared limit as 0 and then never compacts
   *  on its own, so such a model has no entry rather than a guessed size. */
  contextLimits?: Record<string, number>;
}

/** Tokens the conversation occupies after an assistant step: everything the
 *  step read and wrote. The measure OpenCode's own context meter shows. */
export function contextTokens(message: AssistantMessage): number {
  const t = message.tokens;
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
}

/** The provider OpenCode Zen serves under — the one provider every OpenCode
 *  install has, whose free models need no API key at all. */
const ZEN_PROVIDER = 'opencode';

/**
 * The model a session runs when the phone names none, as a
 * `<providerID>/<modelID>` id from `providers`: the model OpenCode's own
 * config names, when it is one of them; else a free OpenCode Zen model, which
 * works with no credential set up; else the first provider's own default
 * (`serverDefaults`, providerID → modelID). Deprecated models are skipped.
 */
export function pickDefaultModel(
  configured: string | undefined,
  providers: Provider[],
  serverDefaults: Record<string, string>,
): string | undefined {
  const usable = (p: Provider) => Object.values(p.models).filter((m) => m.status !== 'deprecated');
  const ids = new Set(providers.flatMap((p) => usable(p).map((m) => `${p.id}/${m.id}`)));
  if (configured && ids.has(configured)) return configured;
  const zen = providers.find((p) => p.id === ZEN_PROVIDER);
  const free = zen && usable(zen).find((m) => m.cost.input === 0 && m.cost.output === 0);
  if (free) return `${ZEN_PROVIDER}/${free.id}`;
  for (const p of providers) {
    const id = `${p.id}/${serverDefaults[p.id] ?? ''}`;
    if (ids.has(id)) return id;
  }
  return undefined;
}

/** Why OpenCode cannot run `model`: none of its providers offers it. When
 *  the model list could not be fetched, nothing is refused. */
export function unsupportedModelReason(model: string, models: ModelEntry[]): string | undefined {
  if (models.length === 0 || models.some((m) => m.id === model)) return undefined;
  return `OpenCode does not offer the model '${model}' — none of its configured providers serves it; choose one from its model list.`;
}

/** Best-effort human-readable text out of OpenCode's error-union shapes
 *  (ProviderAuthError / UnknownError / MessageOutputLengthError /
 *  MessageAbortedError / ApiError) without importing every member by name —
 *  all but one carry `data.message`; the odd one out (MessageOutputLengthError)
 *  falls back to its `name`. */
function formatOpenCodeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; data?: { message?: unknown } };
    if (typeof e.data?.message === 'string') return e.data.message;
    if (typeof e.name === 'string') return e.name;
  }
  return 'OpenCode reported an error';
}

/**
 * The phone-facing description of a permission ask. OpenCode names the
 * RULE that needs approval (`external_directory`, `edit`, `bash`, …), not
 * the tool; the tool itself is shown as the card's title (see fromAsk), so
 * this says what the approval is actually for.
 */
export function describePermission(permission: string, patterns: string[]): string {
  const what = patterns.filter((p) => p.length > 0).join(', ');
  switch (permission) {
    case 'external_directory':
      return what ? `Access outside the project: ${what}` : 'Access outside the project';
    case 'doom_loop':
      return 'The same tool call keeps repeating — let it continue?';
    case 'bash':
      return what ? `Run: ${what}` : 'Run a shell command';
    case 'edit':
      return what ? `Edit: ${what}` : 'Edit files';
    case 'read':
      return what ? `Read: ${what}` : 'Read files';
    case 'webfetch':
      return what ? `Fetch: ${what}` : 'Fetch a URL';
    default:
      return what ? `${permission}: ${what}` : permission;
  }
}

/** A command's argument placeholders (`$ARGUMENTS`, `$1`, …) as a hint the
 *  phone can show; none when the command takes no arguments. */
export function commandArgumentHint(hints: string[]): string | undefined {
  const shown = hints.map((h) => (h === '$ARGUMENTS' ? '<arguments>' : h.replace(/^\$(\d+)$/, '<arg$1>')));
  return shown.length > 0 ? shown.join(' ') : undefined;
}

/** OpenCode's commands as the phone's command menu lists them. */
export function toSlashCommands(commands: Command[]): SlashCommand[] {
  return commands.map((c) => slashCommand(c.name, c.description, commandArgumentHint(c.hints ?? [])));
}

/** OpenCode's questions in the wire's question shape. */
export function toQuestionSpecs(questions: QuestionInfo[]): QuestionSpec[] {
  return questions.map((q) => ({
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    ...(q.multiple ? { multiSelect: true } : {}),
  }));
}

/**
 * The user's answers (one string per question; a multi-select arrives as its
 * labels joined by ", ") back into OpenCode's per-question label arrays. A
 * multi-select string is split only when every piece is one of the offered
 * labels — otherwise it is a typed answer kept whole.
 */
export function toQuestionAnswers(questions: QuestionInfo[], answers: string[]): QuestionAnswer[] {
  return questions.map((q, i) => {
    const raw = answers[i];
    if (raw === undefined || raw === '') return [];
    if (q.multiple) {
      const labels = new Set(q.options.map((o) => o.label));
      const pieces = raw.split(', ');
      if (pieces.every((p) => labels.has(p))) return pieces;
    }
    return [raw];
  });
}

export class OpenCodeSession implements DriverSession {
  private readonly cwd: string;
  private readonly abortController = new AbortController();
  private readonly translate = newTranslateContext();
  private ended = false;
  private mode: string;
  private model?: { providerID: string; modelID: string };

  /** messageID -> role, seeded from message.updated events, so a later
   *  message.part.updated for the same messageID can be tagged — Part itself
   *  carries no role. Defaults to 'assistant' when unseen (the common case:
   *  the role event for a message reliably precedes its part events). */
  private readonly roles = new Map<string, 'user' | 'assistant'>();
  /** Text/reasoning part ids already emitted — each part is translated at
   *  most once, when it reaches a stable (non-streaming) state; see
   *  shouldEmitPart. */
  private readonly emittedPartIds = new Set<string>();
  /** Tool callID -> last part status an entry was emitted for. A callID that
   *  reached a terminal status (completed/error) never emits again — without
   *  this guard a duplicate late message.part.updated for an already-finished
   *  call would re-emit a second tool_result; a repeat of the same status
   *  (e.g. two 'running' updates) is suppressed the same way. */
  private readonly emittedToolStatus = new Map<string, ToolPart['state']['status']>();
  /** Latest part per tool callID, including still-`pending` ones. OpenCode
   *  asks for permission (and asks questions) BEFORE the call goes
   *  `running`, so the call would otherwise only appear in the transcript
   *  after its own approval card; showCall() emits it first from here. */
  private readonly toolParts = new Map<string, ToolPart>();
  /** Last diff fingerprint per file. `session.diff` repeats the whole
   *  session's diff on every step; only files whose diff changed become a
   *  new card. */
  private readonly lastDiffs = new Map<string, string>();
  /** Files a completed edit/write/apply_patch call already showed as a diff
   *  card (adapter.ts's toolCallDiffs). The next `session.diff` change to
   *  such a file is that same edit — dropped instead of shown twice — and
   *  consumes the entry, so a LATER change to the file (a shell command, say)
   *  still gets its card. */
  private readonly toolDiffedFiles = new Set<string>();
  /** Ask ids (permissions and questions) already handled — an ask could in
   *  theory refire; a second reply is rejected by the server anyway, but this
   *  avoids the wasted round trip and a second card. */
  private readonly answeredAsks = new Set<string>();
  /** Sub-agent sessions this session started (OpenCode's `task` tool runs
   *  each in a child session), by session id: the call that started it, the
   *  sub-agent's kind, and — for one left running in the background — that
   *  it is a task, and whether the user asked it to stop. */
  private readonly children = new Map<string, ChildSession>();
  /** The providers' context limits, fetched on the first step that used
   *  tokens; dropped again when the fetch came back empty, so a server that
   *  was briefly unreachable is asked again. */
  private contextLimits?: Promise<Record<string, number>>;
  private contextWindow?: number;
  private contextPercentage?: number;
  /** Names of the session's commands, from the last list fetched: a typed
   *  `/name` runs as that command only when OpenCode has one by that name.
   *  Dropped again when the fetch failed, so the next one asks again. */
  private commandNames?: Promise<Set<string>>;

  /** Resolves once the OpenCode session exists server-side. */
  private readonly ready: Promise<{ client: OpencodeClient; session: Session }>;

  constructor(
    params: StartSession,
    private readonly ctx: SessionContext,
    clientPromise: Promise<OpencodeClient>,
    private readonly catalog: () => Promise<OpenCodeCatalog> = async () => ({ models: [] }),
  ) {
    this.cwd = params.cwd;
    this.mode = params.mode ?? DEFAULT_MODE;
    this.model = splitModelId(params.model ?? undefined);
    this.ready = this.init(clientPromise, params);
    // init() reports its own failure as `ended`; nothing else awaits this
    // rejection except prompt/interrupt, which catch it themselves.
    this.ready.catch(() => {});
  }

  private deliver(event: OpenCodeEvent): void {
    if (this.ended) return;
    const entries = opencodeEventToEntries(event, this.translate);
    if (entries.length > 0) this.ctx.emit({ type: 'entries', entries });
  }

  private finish(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}) });
  }

  private async init(
    clientPromise: Promise<OpencodeClient>,
    params: StartSession,
  ): Promise<{ client: OpencodeClient; session: Session }> {
    try {
      const client = await clientPromise;
      // With no model named, the session runs the default the phone was
      // shown, sent with every prompt — never whatever OpenCode would pick on
      // its own (the last model used, possibly one with no credential).
      // A resumed conversation already ran on its model; only a new start is
      // checked against what the providers offer.
      const catalog = !params.model || !params.resume ? await this.catalog() : { models: [] };
      if (params.model && !params.resume) {
        const refused = unsupportedModelReason(params.model, catalog.models);
        if (refused) throw new Error(refused);
      }
      const model = params.model ?? catalog.defaultModel;
      if (!params.model) this.model = splitModelId(model);
      // Subscribe BEFORE resolving/creating the session so no event in the gap
      // between "session exists" and "we started listening" is missed. The
      // stream is directory-scoped (a server can host multiple projects); this
      // session further filters by sessionID once it is known.
      const { stream } = await client.event.subscribe(
        { directory: this.cwd },
        { signal: this.abortController.signal },
      );
      const { session, resumeLost } = await this.resolveSession(client, params);
      // The "memory was lost" notice goes ahead of "session started".
      if (resumeLost) this.deliver({ type: 'resume-lost' });
      if (!this.ended) {
        this.ctx.emit({ type: 'info', nativeSessionId: session.id, ...(model ? { model } : {}), mode: this.mode });
        this.deliver({ type: 'started', ...(model ? { model } : {}) });
        this.ctx.emit({ type: 'ready' });
      }
      // Consume the event stream for the rest of this session's life. A clean
      // end (server closed the connection) ends the session normally; a
      // rejection (network drop, server restart) ends it with the error, so
      // the bridge's restart policy can bring it back.
      void this.consumeEvents(client, stream as AsyncIterable<StreamEvent>, session.id).then(
        () => this.finish(),
        (err) => this.finish(err instanceof Error ? err.message : String(err)),
      );
      return { client, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deliver({ type: 'error', content: message });
      this.finish(message);
      throw err;
    }
  }

  /** `params.resume` names a previously seen OpenCode session id. Verify it
   *  still exists server-side before trusting it — a session the server no
   *  longer knows about (deleted, server restarted with no persistence) falls
   *  through to creating a fresh one rather than failing the whole session.
   *  `resumeLost` says whether that fallback happened, so the user is told. */
  private async resolveSession(
    client: OpencodeClient,
    params: StartSession,
  ): Promise<{ session: Session; resumeLost: boolean }> {
    if (params.resume) {
      const { data, error } = await client.session.get({ sessionID: params.resume, directory: this.cwd });
      if (!error && data) return { session: data, resumeLost: false };
      this.ctx.log(
        `[opencode] resume ${params.resume} not found server-side ` +
          `(${error ? JSON.stringify(error) : 'no session returned'}) — starting a fresh session instead`,
      );
      return { session: await this.createSessionRemote(client, params), resumeLost: true };
    }
    return { session: await this.createSessionRemote(client, params), resumeLost: false };
  }

  private async createSessionRemote(client: OpencodeClient, params: StartSession): Promise<Session> {
    const { data, error } = await client.session.create({ directory: this.cwd, title: params.sessionId });
    if (error || !data) {
      throw new Error(`OpenCode session.create failed: ${JSON.stringify(error ?? 'no session returned')}`);
    }
    return data;
  }

  private async consumeEvents(
    client: OpencodeClient,
    stream: AsyncIterable<StreamEvent>,
    sessionId: string,
  ): Promise<void> {
    for await (const event of stream) {
      if (this.ended) break;
      switch (event.type) {
        case 'message.updated': {
          const info = event.properties.info;
          if (info.sessionID !== sessionId) {
            // A sub-agent's messages: their roles, for its parts; its
            // errors and context are its own.
            if (this.children.has(info.sessionID)) this.roles.set(info.id, info.role);
            continue;
          }
          this.roles.set(info.id, info.role);
          if (info.role === 'assistant' && info.error) {
            this.deliver({ type: 'error', content: formatOpenCodeError(info.error) });
          }
          if (info.role === 'assistant') this.reportContext(info);
          break;
        }
        case 'message.part.updated': {
          const part = event.properties.part;
          const child = this.children.get(part.sessionID);
          if (part.sessionID !== sessionId && !child) continue;
          if (part.type === 'tool') {
            this.toolParts.set(part.callID, part);
            this.noteSubagent(part);
          }
          if (!this.shouldEmitPart(part)) continue;
          if (part.type === 'tool' && part.state.status === 'completed') {
            for (const diff of toolCallDiffs(part.tool, part.state.input, part.state.metadata)) {
              this.toolDiffedFiles.add(diff.path);
            }
          }
          this.pushPart(part, child);
          break;
        }
        case 'session.idle': {
          if (event.properties.sessionID !== sessionId) {
            this.childEnded(event.properties.sessionID, 'completed');
            continue;
          }
          this.deliver({ type: 'idle' });
          if (!this.ended) this.ctx.emit({ type: 'turn', state: 'idle' });
          break;
        }
        // Turn-boundary signal: `busy` starts a turn. `idle` overlaps with
        // 'session.idle' above; reporting the same state twice is harmless.
        case 'session.status': {
          if (event.properties.sessionID !== sessionId) {
            if (event.properties.status.type === 'idle') this.childEnded(event.properties.sessionID, 'completed');
            continue;
          }
          const status = event.properties.status.type;
          if (status !== 'busy' && status !== 'idle') break;
          if (!this.ended) this.ctx.emit({ type: 'turn', state: status === 'busy' ? 'running' : 'idle' });
          break;
        }
        case 'session.diff': {
          if (event.properties.sessionID !== sessionId) continue;
          const files = this.changedDiffs(event.properties.diff);
          if (files.length > 0) this.deliver({ type: 'diff', files });
          break;
        }
        case 'session.error': {
          if (event.properties.sessionID && event.properties.sessionID !== sessionId) {
            this.childEnded(event.properties.sessionID, 'failed');
            continue;
          }
          if (event.properties.error) {
            this.deliver({ type: 'error', content: formatOpenCodeError(event.properties.error) });
          }
          break;
        }
        case 'permission.asked': {
          const ask = event.properties;
          if (ask.sessionID !== sessionId && !this.children.has(ask.sessionID)) continue;
          this.showCall(ask.tool?.callID);
          this.handlePermission(this.fromAsk(client, ask), this.children.get(ask.sessionID));
          break;
        }
        case 'permission.updated': {
          const permission = event.properties;
          if (permission.sessionID !== sessionId && !this.children.has(permission.sessionID)) continue;
          this.showCall(permission.callID);
          this.handlePermission(this.fromLegacyPermission(client, permission), this.children.get(permission.sessionID));
          break;
        }
        case 'question.asked': {
          const ask = event.properties;
          if (ask.sessionID !== sessionId && !this.children.has(ask.sessionID)) continue;
          this.handleQuestion(client, ask);
          break;
        }
        default:
          break;
      }
    }
  }

  /** Report how full the context is after an assistant step, over the
   *  window of the model that ran it — only what changed, and nothing for a
   *  model with no declared limit. */
  private reportContext(message: AssistantMessage): void {
    const used = contextTokens(message);
    if (used <= 0) return;
    this.contextLimits ??= this.catalog().then((c) => {
      if (c.models.length === 0) this.contextLimits = undefined;
      return c.contextLimits ?? {};
    });
    void this.contextLimits.then((limits) => {
      const window = limits[`${message.providerID}/${message.modelID}`];
      if (!window || this.ended) return;
      const pct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
      const changedPct = pct !== this.contextPercentage;
      const changedCw = window !== this.contextWindow;
      if (!changedPct && !changedCw) return;
      this.contextPercentage = pct;
      this.contextWindow = window;
      this.ctx.emit({
        type: 'info',
        ...(changedPct ? { contextPercentage: pct } : {}),
        ...(changedCw ? { contextWindow: window } : {}),
      });
    });
  }

  private pushPart(part: Part, child?: ChildSession): void {
    const role = this.roles.get(part.messageID) ?? 'assistant';
    this.deliver({ type: 'part', part, role, ...(child ? { subagent: subagentOf(child) } : {}) });
  }

  /**
   * A `task` call names the child session its sub-agent runs in
   * (`metadata.sessionId`) as soon as it starts, before the sub-agent does
   * anything: from then on that session's events are this one's. A call
   * that completes with `metadata.background` left the sub-agent running on
   * its own — a background task, until the child goes idle.
   */
  private noteSubagent(part: ToolPart): void {
    if (part.tool !== 'task' || part.state.status === 'pending') return;
    const metadata = (part.state as { metadata?: Record<string, unknown> }).metadata;
    const childId = typeof metadata?.sessionId === 'string' ? metadata.sessionId : '';
    if (!childId) return;
    let child = this.children.get(childId);
    if (!child) {
      const input = (part.state.input ?? {}) as Record<string, unknown>;
      const label = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : undefined;
      const title = typeof input.description === 'string' && input.description ? input.description : 'Sub-agent';
      child = { callId: part.callID, title, ...(label ? { label } : {}), background: false, stopping: false };
      this.children.set(childId, child);
    }
    if (part.state.status === 'completed' && metadata?.background === true && !child.background) {
      child.background = true;
      this.deliver({ type: 'task', taskId: childId, title: child.title, status: 'running', callId: child.callId });
    }
  }

  /** A child session went idle or failed: a background sub-agent's task
   *  ended (stopped, when the user asked for that). */
  private childEnded(childId: string, status: 'completed' | 'failed'): void {
    const child = this.children.get(childId);
    if (!child?.background) return;
    child.background = false;
    this.deliver({
      type: 'task',
      taskId: childId,
      title: child.title,
      status: child.stopping ? 'stopped' : status,
      callId: child.callId,
    });
  }

  /**
   * Emit the tool call an ask belongs to, if it has not been shown yet. The
   * part is still `pending` at ask time (the adapter drops pending parts as
   * unstable), so it is emitted as `running` with the input it already has;
   * the later real `running` update is then suppressed as a repeat.
   */
  private showCall(callID: string | undefined): void {
    if (!callID || this.emittedToolStatus.has(callID)) return;
    const part = this.toolParts.get(callID);
    if (!part || part.tool === QUESTION_TOOL) return;
    this.emittedToolStatus.set(callID, 'running');
    this.pushPart({
      ...part,
      state: { status: 'running', input: part.state.input, time: { start: Date.now() } },
    });
  }

  /** Deduplicates streaming updates into at-most-one translation per part:
   *  text/reasoning parts only qualify once they stop changing (`time`
   *  absent — no timing info at all — or `time.end` set); a tool's 'running'
   *  transition is reported once per call, its terminal transition
   *  (completed/error) always reported. The question tool's call itself is
   *  never a row (its card comes from `question.asked`), but its result is:
   *  that is what marks the card answered. */
  private shouldEmitPart(part: Part): boolean {
    switch (part.type) {
      case 'text':
      case 'reasoning': {
        if (this.emittedPartIds.has(part.id)) return false;
        const finished = part.time === undefined || part.time.end !== undefined;
        if (!finished) return false;
        this.emittedPartIds.add(part.id);
        return true;
      }
      case 'tool': {
        const status = part.state.status;
        if (status === 'pending') return false;
        if (status === 'running' && part.tool === QUESTION_TOOL) return false;
        const last = this.emittedToolStatus.get(part.callID);
        if (last === 'completed' || last === 'error') return false;
        if (last === status) return false;
        this.emittedToolStatus.set(part.callID, status);
        return true;
      }
      default:
        return true;
    }
  }

  /** Files of a `session.diff` whose content differs from the last time they
   *  were shown. */
  private changedDiffs(files: SnapshotFileDiff[]): SnapshotFileDiff[] {
    return files.filter((f) => {
      const key = f.file ?? '';
      const fingerprint = `${f.status ?? ''}\u0000${f.additions}\u0000${f.deletions}\u0000${f.patch ?? ''}`;
      if (this.lastDiffs.get(key) === fingerprint) return false;
      this.lastDiffs.set(key, fingerprint);
      return !this.consumeToolDiff(key);
    });
  }

  /** Whether a tool call already showed `file`'s change (removing that
   *  record). Tool calls name files by absolute path, `session.diff` by
   *  worktree-relative path, so either may be a path-suffix of the other. */
  private consumeToolDiff(file: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const target = norm(file);
    for (const shown of this.toolDiffedFiles) {
      const s = norm(shown);
      if (s === target || s.endsWith(`/${target}`) || target.endsWith(`/${s}`)) {
        this.toolDiffedFiles.delete(shown);
        return true;
      }
    }
    return false;
  }

  /**
   * Answer one OpenCode permission ask: refused outright when it touches a
   * secret path in a session that forbids that, allowed in the auto-approve
   * mode, otherwise sent to the phone. Always answered — OpenCode must never
   * wait on a reply that is not coming.
   */
  private handlePermission(permission: NormalizedPermission, child?: ChildSession): void {
    if (this.answeredAsks.has(permission.id)) return;
    this.answeredAsks.add(permission.id);
    const reply = (response: 'once' | 'reject'): void => {
      // Best effort — the ask then stays pending server-side; there is no
      // live connection left to retry over.
      permission.reply(response).catch(() => {});
    };

    if (this.mode === AUTO_APPROVE_MODE) {
      reply('once');
      return;
    }
    this.ctx
      .requestPermission({
        requestId: permission.toolUseID,
        toolName: permission.toolName,
        kind: toolKindOf(permission.toolName),
        title: toolTitle(permission.toolName, permission.input) || permission.toolName,
        description: permission.description ?? permission.title,
        locations: toolLocations(permission.input),
        rawInput: permission.input,
        options: [PERMISSION_ALLOW, PERMISSION_DENY],
        ...(child ? { subagent: subagentOf(child) } : {}),
      })
      .then((outcome) => reply(outcome.outcome === 'selected' && outcome.optionId === PERMISSION_ALLOW.id ? 'once' : 'reject'))
      .catch(() => reply('reject'));
  }

  /**
   * A v2 `permission.asked`, answered on `/permission/{requestID}/reply`.
   * The card names the tool the ask came from with that call's own input
   * (what the user recognizes from the tool row above it); the permission
   * rule being asked about goes into the description.
   */
  private fromAsk(client: OpencodeClient, ask: PermissionAsk): NormalizedPermission {
    const part = ask.tool ? this.toolParts.get(ask.tool.callID) : undefined;
    const description = describePermission(ask.permission, ask.patterns);
    return {
      id: ask.id,
      toolName: part?.tool ?? ask.permission,
      input: part?.state.input ?? ask.metadata ?? {},
      toolUseID: ask.tool?.callID ?? ask.id,
      title: description,
      description,
      reply: async (response) => {
        const { error } = await client.permission.reply({
          requestID: ask.id,
          directory: this.cwd,
          reply: response,
        });
        if (error) throw new Error(JSON.stringify(error));
      },
    };
  }

  /** A `permission.updated` from an older server, answered on the per-session
   *  endpoint those servers expose. */
  private fromLegacyPermission(
    client: OpencodeClient,
    permission: LegacyPermissionUpdated['properties'],
  ): NormalizedPermission {
    return {
      id: permission.id,
      toolName: permission.type,
      input: permission.metadata ?? {},
      toolUseID: permission.callID ?? permission.id,
      title: permission.title,
      reply: async (response) => {
        await client.permission.respond({
          sessionID: permission.sessionID,
          permissionID: permission.id,
          directory: this.cwd,
          response,
        });
      },
    };
  }

  /**
   * One OpenCode `question.asked`, asked on the phone. Keyed by the question
   * tool's call id: the card groups under it and that call's own result
   * marks the card answered. Always answered — a cancellation rejects the
   * question, so OpenCode never waits on a reply that is not coming.
   */
  private handleQuestion(client: OpencodeClient, ask: QuestionAsk): void {
    if (this.answeredAsks.has(ask.id)) return;
    this.answeredAsks.add(ask.id);

    const toolUseID = ask.tool?.callID ?? ask.id;
    this.deliver({ type: 'question', toolUseId: toolUseID });

    const reject = (): void => {
      void client.question.reject({ requestID: ask.id, directory: this.cwd }).catch(() => {});
    };
    this.ctx
      .askQuestion(toolUseID, toQuestionSpecs(ask.questions))
      .then((outcome) => {
        if (outcome.outcome !== 'answered') return reject();
        return client.question
          .reply({ requestID: ask.id, directory: this.cwd, answers: toQuestionAnswers(ask.questions, outcome.answers) })
          .then(({ error }) => {
            if (error) reject();
          });
      })
      .catch(reject);
  }

  /**
   * A typed `/name args` naming one of OpenCode's commands runs through
   * `session.command`, which expands the command's template; sent as plain
   * text it would reach the model verbatim. Anything else is a prompt.
   */
  prompt(text: string): void {
    const command = parseSlashCommand(text);
    this.ready
      .then(async ({ client, session }) => {
        if (command && (await this.knownCommands(client)).has(command.name)) {
          this.runCommand(client, session.id, command.name, command.args);
          return;
        }
        const { error } = await client.session.promptAsync({
          sessionID: session.id,
          directory: this.cwd,
          parts: [{ type: 'text', text }],
          ...(this.model ? { model: this.model } : {}),
        });
        if (error) this.deliver({ type: 'error', content: `OpenCode prompt failed: ${JSON.stringify(error)}` });
      })
      .catch((err) => {
        this.deliver({ type: 'error', content: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}` });
      });
  }

  /** `session.command` answers only once the whole turn is over, so it is
   *  not awaited: the turn itself arrives on the event stream. A refusal
   *  becomes an error entry; a connection given up on while the turn runs
   *  (the stream still carries it) is only logged. */
  private runCommand(client: OpencodeClient, sessionID: string, name: string, args: string): void {
    const model = this.model ? `${this.model.providerID}/${this.model.modelID}` : undefined;
    client.session
      .command({ sessionID, directory: this.cwd, command: name, arguments: args, ...(model ? { model } : {}) })
      .then(({ error }) => {
        if (error) this.deliver({ type: 'error', content: `OpenCode /${name} failed: ${JSON.stringify(error)}` });
      })
      .catch((err) => this.ctx.log(`[opencode] /${name}: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async fetchCommands(client: OpencodeClient): Promise<Command[]> {
    const { data, error } = await client.command.list({ directory: this.cwd });
    if (error || !data) throw new Error(`OpenCode could not list its commands: ${JSON.stringify(error ?? 'no list')}`);
    this.commandNames = Promise.resolve(new Set(data.map((c) => c.name)));
    return data;
  }

  private knownCommands(client: OpencodeClient): Promise<Set<string>> {
    this.commandNames ??= this.fetchCommands(client).then(
      (commands) => new Set(commands.map((c) => c.name)),
      () => {
        this.commandNames = undefined;
        return new Set<string>();
      },
    );
    return this.commandNames;
  }

  async listCommands(): Promise<SlashCommand[]> {
    const { client } = await this.ready;
    return toSlashCommands(await this.fetchCommands(client));
  }

  async mcpStatus(): Promise<SessionMcpState> {
    const { client } = await this.ready;
    return openCodeSessionMcp(client, this.cwd);
  }

  async toggleMcp(name: string, enabled: boolean): Promise<SessionMcpState> {
    const { client } = await this.ready;
    return toggleOpenCodeMcp(client, this.cwd, name, enabled);
  }

  async setOption(option: SessionOption, value: string): Promise<void> {
    switch (option) {
      case 'mode':
        if (!OPENCODE_MODES.some((m) => m.id === value)) throw new Error(`OpenCode has no mode '${value}'`);
        this.mode = value;
        return;
      case 'model': {
        // Model selection is per prompt in OpenCode; the next prompt uses it.
        const split = splitModelId(value);
        if (!split) throw new Error(`'${value}' is not an OpenCode provider/model id`);
        const refused = unsupportedModelReason(value, (await this.catalog()).models);
        if (refused) throw new Error(refused);
        this.model = split;
        return;
      }
      case 'effort':
        throw new Error('OpenCode has no effort levels');
    }
  }

  async interrupt(): Promise<void> {
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ sessionID: session.id, directory: this.cwd });
    } catch {
      // Best effort — an already-idle OpenCode session can legitimately 404
      // on abort.
    }
  }

  /** Stop a sub-agent left running in the background (its task id is its
   *  child session's id). */
  async stopTask(taskId: string): Promise<void> {
    const child = this.children.get(taskId);
    if (!child?.background) throw new Error('No such task is running');
    child.stopping = true;
    const { client } = await this.ready;
    const { error } = await client.session.abort({ sessionID: taskId, directory: this.cwd });
    if (error) throw new Error(`OpenCode could not stop the task: ${JSON.stringify(error)}`);
  }

  async getUsage(): Promise<UsageData | null> {
    return null;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ sessionID: session.id, directory: this.cwd });
    } catch {
      // Best effort — the session may never have been created, or may
      // already be gone server-side.
    }
  }
}

export interface OpenCodeDriverOptions {
  /** An OpenCode server to connect to. Wins over `autoStart`. */
  serverUrl?: string;
  /** Spawn and manage an OpenCode server when no `serverUrl` is given. */
  autoStart?: boolean;
  /** `opencode` executable for auto-start (else resolved from PATH). */
  binaryPath?: string;
  /** Installs `opencode` for auto-start when none is found. */
  installOpenCode?: () => Promise<string>;
  /** The environment to look for an installed `opencode` in (PATH,
   *  CODEDECK_OPENCODE_PATH); the host's own by default. */
  lookupEnv?: NodeJS.ProcessEnv;
  port?: number;
  log: (message: string) => void;
}

/** Why OpenCode cannot run, when it is enabled but unusable. */
const NOT_CONFIGURED =
  'This bridge has no OpenCode backend configured (set CODEDECK_OPENCODE_SERVER_URL, or CODEDECK_OPENCODE_AUTO_START=1).';

export class OpenCodeDriver implements Driver {
  private clientPromise: Promise<OpencodeClient> | null = null;
  private server: OpenCodeServerHandle | null = null;
  private unavailable: string | undefined;
  /** Auto-start with no `opencode` on the machine: it is installed, then
   *  started, in the background; a failed attempt is retried by the next
   *  session. */
  private installs = false;
  private stopped = false;
  readonly plugins: PluginManager = new OpenCodePlugins(() => this.client());
  readonly mcp: McpManager = new OpenCodeMcp(() => this.client());

  private constructor(private readonly options: OpenCodeDriverOptions) {}

  /** The server's client, starting an install that failed before over. */
  private client(): Promise<OpencodeClient> {
    if (!this.clientPromise && this.installs && !this.stopped) this.launchInstalled();
    return this.clientPromise ?? Promise.reject(new Error(this.unavailable ?? NOT_CONFIGURED));
  }

  /** Connect to (or start) the configured server. Never throws: a driver
   *  that cannot reach OpenCode is still advertised, with the reason. */
  static async create(options: OpenCodeDriverOptions): Promise<OpenCodeDriver> {
    const driver = new OpenCodeDriver(options);
    if (options.serverUrl) {
      if (options.autoStart) options.log('[opencode] both a server URL and auto-start are configured — using the server URL');
      driver.connect(options.serverUrl);
    } else if (options.autoStart) {
      const bin = resolveOpenCodePath(options.binaryPath, options.lookupEnv);
      if (!bin && options.installOpenCode) {
        driver.installs = true;
        driver.launchInstalled();
      } else if (!bin) {
        driver.unavailable =
          'OpenCode auto-start is enabled but the `opencode` executable was not found (set CODEDECK_OPENCODE_PATH).';
      } else {
        try {
          driver.server = await startOpenCodeServer({ command: bin, ...(options.port !== undefined ? { port: options.port } : {}) });
          options.log(`[opencode] started ${driver.server.url} (pid ${driver.server.pid ?? '?'})`);
          driver.connect(driver.server.url);
        } catch (err) {
          driver.unavailable = `The OpenCode server failed to start: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else {
      driver.unavailable = NOT_CONFIGURED;
    }
    if (driver.unavailable) options.log(`[opencode] unavailable: ${driver.unavailable}`);
    return driver;
  }

  /** A driver over an existing client (tests). */
  static withClient(client: OpencodeClient): OpenCodeDriver {
    const driver = new OpenCodeDriver({ log: () => {} });
    driver.clientPromise = Promise.resolve(client);
    return driver;
  }

  private connect(baseUrl: string): void {
    this.clientPromise = Promise.resolve(createOpencodeClient({ baseUrl }));
  }

  /** Install `opencode`, start its server and connect — sessions started
   *  meanwhile wait on the same promise. */
  private launchInstalled(): void {
    const { installOpenCode, port, log } = this.options;
    const attempt = (async (): Promise<OpencodeClient> => {
      const bin = await installOpenCode!();
      let server: OpenCodeServerHandle;
      try {
        server = await startOpenCodeServer({ command: bin, ...(port !== undefined ? { port } : {}) });
      } catch (err) {
        throw new Error(`The OpenCode server failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped) {
        await server.close();
        throw new Error('the agent host is shutting down');
      }
      this.server = server;
      log(`[opencode] started ${server.url} (pid ${server.pid ?? '?'})`);
      return createOpencodeClient({ baseUrl: server.url });
    })();
    this.clientPromise = attempt;
    attempt.catch((err: unknown) => {
      log(`[opencode] unavailable: ${err instanceof Error ? err.message : String(err)}`);
      if (this.clientPromise === attempt) this.clientPromise = null;
    });
  }

  info(): AgentInfo {
    return {
      id: OPENCODE_AGENT_ID,
      displayName: 'OpenCode',
      modes: OPENCODE_MODES,
      efforts: [],
      defaultMode: DEFAULT_MODE,
      // No subscription usage; sessions always use the providers configured
      // on the OpenCode server itself.
      supports: { models: true, usage: false, providers: false, gsd: true, interrupt: true, commands: true, plugins: true, mcp: true, tasks: true },
      credentials: [],
      ...(this.unavailable ? { unavailableReason: this.unavailable } : {}),
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (!this.clientPromise && this.installs && !this.stopped) this.launchInstalled();
    if (!this.clientPromise) throw new Error(this.unavailable ?? NOT_CONFIGURED);
    if (params.mode !== undefined && !OPENCODE_MODES.some((m) => m.id === params.mode)) {
      throw new Error(`OpenCode has no mode '${params.mode}'`);
    }
    if (params.model && !splitModelId(params.model)) {
      throw new Error(`'${params.model}' is not an OpenCode provider/model id — choose one from its model list.`);
    }
    return new OpenCodeSession(params, ctx, this.clientPromise, () => this.listModels());
  }

  /** Best-effort model list from OpenCode's configured providers, and the
   *  default among them (see pickDefaultModel) — empty on any failure. Ids
   *  are `<providerID>/<modelID>`, the shape a prompt expects back. */
  async listModels(): Promise<OpenCodeCatalog> {
    if (!this.clientPromise) return { models: [] };
    try {
      const client = await this.clientPromise;
      const [providers, config] = await Promise.all([client.config.providers(), client.config.get().catch(() => null)]);
      const { data, error } = providers;
      if (error || !data) return { models: [] };
      const models: ModelEntry[] = [];
      const contextLimits: Record<string, number> = {};
      for (const provider of data.providers) {
        for (const model of Object.values(provider.models)) {
          const id = `${provider.id}/${model.id}`;
          models.push({ id, label: model.name, provider: provider.name || provider.id });
          const window = model.limit?.context ?? 0;
          if (window > 0) contextLimits[id] = window;
        }
      }
      const defaultModel = pickDefaultModel(config?.data?.model, data.providers, data.default);
      return { models, contextLimits, ...(defaultModel ? { defaultModel } : {}) };
    } catch {
      return { models: [] };
    }
  }

  /** OpenCode deletes a session's subagent sessions with it. */
  async deleteConversation(conversationId: string, cwd: string): Promise<void> {
    const client = await this.client();
    const { error, response } = await client.session.delete({ sessionID: conversationId, directory: cwd });
    if (error && response?.status !== 404) {
      throw new Error(`OpenCode could not delete session ${conversationId}: ${JSON.stringify(error)}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.server?.close();
  }
}
