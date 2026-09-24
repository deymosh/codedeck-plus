/**
 * OpenCode backend over `@opencode-ai/sdk`, implementing the SAME `SdkFacade`
 * / `SdkSessionHandle` seam `RealSdkFacade`/`RealSdkSessionHandle` (facade.ts)
 * implement for Claude Code. Everything downstream of these two classes —
 * SessionRunner, PermissionBroker, the Nostr publish path — is unaware which
 * backend produced a session; only `bridge.ts`'s `makeRunner` picks this
 * facade over the Claude Code one, and only `opencodeAdapter.ts` (not this
 * file) knows OpenCode's own message/event shapes well enough to translate
 * them into OutputEntry objects.
 *
 * Speaks the SDK's v2 client only (`@opencode-ai/sdk/v2/client`) — the API
 * OpenCode 1.x servers serve, and the only one with question replies and the
 * current permission-reply endpoint. The v1 client's types no longer
 * describe what a 1.x server sends (`permission.asked` instead of
 * `permission.updated`, patch-based `session.diff`).
 *
 * Design choices deliberately kept minimal:
 *  - Permission bridging is allow/deny only — no "always"/pattern rules. See
 *    handlePermission below.
 *  - getContextUsage()/getUsageSnapshot() always return null — OpenCode has
 *    no equivalent control request to feature-detect, and fabricating a
 *    number would be worse than admitting we don't know.
 *  - setPermissionMode()/setEffort() are documented no-ops (see their doc
 *    comments) — OpenCode has no session-scoped analog for either.
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type {
  Event,
  EventPermissionAsked,
  EventQuestionAsked,
  OpencodeClient,
  Part,
  QuestionAnswer,
  QuestionInfo,
  Session,
  SnapshotFileDiff,
} from '@opencode-ai/sdk/v2/client';
import type { EffortLevel, PermissionMode } from '@codedeck/protocol';
import type { AskQuestionSpec } from './adapter';
import { toolCallDiffs } from './opencodeAdapter';
import type {
  SdkCanUseTool,
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkModelDescriptor,
  SdkPermissionResult,
  SdkSessionHandle,
  SdkSessionOptions,
} from './facade';

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

/** The pieces of an ask `canUseTool` needs, normalized from either ask shape,
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

/** The tool OpenCode uses to ask the user questions. Its own call is not
 *  shown as a generic tool row: `question.asked` renders it as a question
 *  card instead (see handleQuestion). */
const QUESTION_TOOL = 'question';

export interface OpenCodeFacadeOptions {
  /**
   * OpenCode server to talk to (`createOpencodeClient({ baseUrl })`). Always
   * required — this facade only ever speaks to a URL; it never spawns a
   * server itself. The bridge's own wiring (apps/bridge/src/commands.ts)
   * decides WHICH URL to pass: either an external server the user pointed it
   * at (`CODEDECK_OPENCODE_SERVER_URL`), or one it spawned itself via
   * `sdk/opencodeServer.ts`'s `startOpenCodeServer()` when auto-start is
   * configured. Keeping that decision out of this class is deliberate — one
   * place resolves "how do we get a URL", this class only uses the result.
   */
  baseUrl: string;
}

/** `model/providerID` split — OpenCode's prompt body wants `{providerID,
 *  modelID}`, not a single string. A phone-facing model id with no `/` (or
 *  an empty half) has no valid split, so the field is omitted entirely and
 *  OpenCode falls back to its own configured default — no fabrication. */
function splitModelId(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
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

/** OpenCode's questions in the AskUserQuestion shape the broker and the
 *  phone's question card already speak. */
export function toAskQuestions(questions: QuestionInfo[]): AskQuestionSpec[] {
  return questions.map((q) => ({
    question: q.question,
    header: q.header,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
    multiSelect: q.multiple ?? false,
  }));
}

/**
 * The broker's answers (question text → one string; a multi-select arrives
 * as its labels joined by ", ") back into OpenCode's per-question label
 * arrays. A multi-select string is split only when every piece is one of
 * the offered labels — otherwise it is a typed answer kept whole.
 */
export function toQuestionAnswers(questions: QuestionInfo[], answers: Record<string, string>): QuestionAnswer[] {
  return questions.map((q) => {
    const raw = answers[q.question];
    if (raw === undefined || raw === '') return [];
    if (q.multiple) {
      const labels = new Set(q.options.map((o) => o.label));
      const pieces = raw.split(', ');
      if (pieces.every((p) => labels.has(p))) return pieces;
    }
    return [raw];
  });
}

/** Minimal SPSC async queue — the OpenCode counterpart of facade.ts's
 *  createInputChannel, generalized to output messages instead of input. */
class OpenCodeMessageQueue {
  private queue: SdkMessage[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private error: unknown;

  push(msg: SdkMessage): void {
    if (this.closed) return;
    this.queue.push(msg);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.();
  }

  /** Same as close(), but drain()'s `for await` throws `err` once the
   *  buffered messages are exhausted, instead of returning cleanly — the only
   *  way SessionRunner.consume() (session/runner.ts) can tell a broken stream
   *  (network drop, OpenCode server restart) from a graceful end, which is
   *  what routes it into handleStreamError()'s up-to-2-restarts logic instead
   *  of ending the session outright on the first blip. */
  closeWithError(err: unknown): void {
    this.error = err;
    this.close();
  }

  async *drain(): AsyncGenerator<SdkMessage, void, unknown> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

class OpenCodeSessionHandle implements SdkSessionHandle {
  private readonly cwd: string;
  private readonly canUseTool: SdkCanUseTool;
  private readonly abortController = new AbortController();
  private readonly queue = new OpenCodeMessageQueue();
  private ended = false;
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
   *  card (opencodeAdapter.ts's toolCallDiffs). The next `session.diff`
   *  change to such a file is that same edit — dropped instead of shown
   *  twice — and consumes the entry, so a LATER change to the file (a shell
   *  command, say) still gets its card. */
  private readonly toolDiffedFiles = new Set<string>();
  /** Ask ids (permissions and questions) already handled — an ask could in
   *  theory refire; a second reply is rejected by the server anyway, but this
   *  avoids the wasted round trip and a second canUseTool call. */
  private readonly answeredAsks = new Set<string>();

  /** Resolves once the OpenCode session exists server-side. probeReady()
   *  awaits this — the same "control-channel round trip" contract
   *  RealSdkSessionHandle's probeReady() has for Claude Code (see its doc
   *  comment in facade.ts): a fresh session confirms readiness before any
   *  init-shaped message is guaranteed to have arrived. */
  private readonly ready: Promise<{ client: OpencodeClient; session: Session }>;

  constructor(opts: SdkSessionOptions, clientPromise: Promise<OpencodeClient>) {
    this.cwd = opts.cwd;
    this.canUseTool = opts.canUseTool;
    this.model = splitModelId(opts.model);
    // Fire-and-forget: SdkFacade.createSession() must return synchronously,
    // with the actual server round trips happening in the background —
    // probeReady()/messages() are how a caller observes the outcome.
    this.ready = this.init(clientPromise, opts);
    this.ready.catch(() => {
      // init() already pushed an opencode-error entry into the queue on
      // failure; swallow the rejection here so it doesn't surface as an
      // unhandled promise rejection. probeReady() is the contract that
      // reports failure to the runner (it awaits this same promise).
    });
  }

  private async init(
    clientPromise: Promise<OpencodeClient>,
    opts: SdkSessionOptions,
  ): Promise<{ client: OpencodeClient; session: Session }> {
    // Everything in this method up to (and including) starting consumeEvents
    // can fail before the queue has any consumer telling it to close — any
    // rejection here must close the queue itself, or messages()'s `for await`
    // (session/runner.ts) hangs forever with no error ever surfacing, since
    // probeReady() is skipped entirely for resumed sessions.
    try {
      const client = await clientPromise;
      // Subscribe BEFORE resolving/creating the session so no event in the gap
      // between "session exists" and "we started listening" is missed. The
      // stream is directory-scoped (a server can host multiple projects); this
      // handle further filters by sessionID once it is known.
      const { stream } = await client.event.subscribe(
        { directory: this.cwd },
        { signal: this.abortController.signal },
      );

      const { session, resumeLost } = await this.resolveSession(client, opts);

      // Report the fallback to a fresh session BEFORE the init message, so the
      // phone sees "memory was lost" ahead of "session started" rather than
      // the other way round. Mirrors the same envelope-per-concern pattern
      // this class already uses for errors/init — see OpenCodeResumeLostMessage.
      if (resumeLost) {
        this.queue.push({ type: 'opencode-resume-lost' } as unknown as SdkMessage);
      }

      this.queue.push({
        type: 'system',
        subtype: 'init',
        session_id: session.id,
        ...(opts.model ? { model: opts.model } : {}),
        permissionMode: opts.permissionMode,
      } as unknown as SdkMessage);

      // Consume the event stream for the rest of this handle's life. A clean
      // end (server closed the connection) closes the queue normally; a
      // rejection (network drop, server restart) closes it WITH the error, so
      // messages()'s `for await` (session/runner.ts's SessionRunner.consume())
      // throws instead of ending "cleanly" — that distinction is what routes a
      // broken stream into handleStreamError()'s restart logic instead of
      // ending the session outright on the first network blip.
      void this.consumeEvents(client, stream as AsyncIterable<StreamEvent>, session.id).then(
        () => this.queue.close(),
        (err) => this.queue.closeWithError(err),
      );

      return { client, session };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queue.push({ type: 'opencode-error', content: message } as unknown as SdkMessage);
      this.queue.close();
      throw err;
    }
  }

  /** `opts.resume` names a previously seen OpenCode session id (round-tripped
   *  through SessionRegistry, same as Claude Code's sdkSessionId). Verify it
   *  still exists server-side before trusting it — a session the server no
   *  longer knows about (deleted, server restarted with no persistence) falls
   *  through to creating a fresh one rather than failing the whole session.
   *  `resumeLost` tells the caller whether that fallback happened, so it can
   *  push a user-visible notice (init() does) instead of a silent swap — a
   *  lost resume target means the model no longer remembers earlier turns,
   *  the same fact Claude Code's CDX-056/073 mechanism always surfaces to the
   *  phone. */
  private async resolveSession(
    client: OpencodeClient,
    opts: SdkSessionOptions,
  ): Promise<{ session: Session; resumeLost: boolean }> {
    if (opts.resume) {
      const { data, error } = await client.session.get({ sessionID: opts.resume, directory: this.cwd });
      if (!error && data) return { session: data, resumeLost: false };
      console.error(
        `[OpenCodeFacade] resume ${opts.resume} not found server-side ` +
          `(${error ? JSON.stringify(error) : 'no session returned'}) — starting a fresh session instead`,
      );
      return { session: await this.createSessionRemote(client, opts), resumeLost: true };
    }
    return { session: await this.createSessionRemote(client, opts), resumeLost: false };
  }

  private async createSessionRemote(client: OpencodeClient, opts: SdkSessionOptions): Promise<Session> {
    const { data, error } = await client.session.create({ directory: this.cwd, title: opts.sessionId });
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
          if (info.sessionID !== sessionId) continue;
          this.roles.set(info.id, info.role);
          if (info.role === 'assistant' && info.error) {
            this.queue.push({
              type: 'opencode-error',
              content: formatOpenCodeError(info.error),
            } as unknown as SdkMessage);
          }
          break;
        }
        case 'message.part.updated': {
          const part = event.properties.part;
          if (part.sessionID !== sessionId) continue;
          if (part.type === 'tool') this.toolParts.set(part.callID, part);
          if (!this.shouldEmitPart(part)) continue;
          if (part.type === 'tool' && part.state.status === 'completed') {
            for (const diff of toolCallDiffs(part.tool, part.state.input, part.state.metadata)) {
              this.toolDiffedFiles.add(diff.path);
            }
          }
          this.pushPart(part);
          break;
        }
        case 'session.idle': {
          if (event.properties.sessionID !== sessionId) continue;
          this.queue.push({
            type: 'system',
            subtype: 'session_state_changed',
            state: 'idle',
          } as unknown as SdkMessage);
          break;
        }
        // Turn-boundary signal, the OpenCode counterpart of Claude Code's own
        // SDK-emitted session_state_changed('running') — without it,
        // SessionRunner.sessionState (session/runner.ts) stays at 'idle' after
        // the FIRST turn (only 'session.idle' above ever fires), so the
        // phone's "thinking…" indicator never shows again from the second
        // turn onward. `status.type === 'idle'` overlaps with 'session.idle'
        // above; both just assign the same state, so the overlap is harmless.
        case 'session.status': {
          if (event.properties.sessionID !== sessionId) continue;
          const status = event.properties.status.type;
          if (status !== 'busy' && status !== 'idle') break;
          this.queue.push({
            type: 'system',
            subtype: 'session_state_changed',
            state: status === 'busy' ? 'running' : 'idle',
          } as unknown as SdkMessage);
          break;
        }
        case 'session.diff': {
          if (event.properties.sessionID !== sessionId) continue;
          // Gating on the phone's 'diff' capability happens in
          // opencodeAdapter.ts (opts.emitDiffEntries), same as Claude Code's
          // adapter.ts — pushed unconditionally here, exactly like every other
          // event this switch turns into a queue message.
          const files = this.changedDiffs(event.properties.diff);
          if (files.length > 0) {
            this.queue.push({ type: 'opencode-diff', files } as unknown as SdkMessage);
          }
          break;
        }
        case 'session.error': {
          if (event.properties.sessionID && event.properties.sessionID !== sessionId) continue;
          if (event.properties.error) {
            this.queue.push({
              type: 'opencode-error',
              content: formatOpenCodeError(event.properties.error),
            } as unknown as SdkMessage);
          }
          break;
        }
        case 'permission.asked': {
          const ask = event.properties;
          if (ask.sessionID !== sessionId) continue;
          this.showCall(ask.tool?.callID);
          this.handlePermission(this.fromAsk(client, ask));
          break;
        }
        case 'permission.updated': {
          const permission = event.properties;
          if (permission.sessionID !== sessionId) continue;
          this.showCall(permission.callID);
          this.handlePermission(this.fromLegacyPermission(client, permission));
          break;
        }
        case 'question.asked': {
          const ask = event.properties;
          if (ask.sessionID !== sessionId) continue;
          this.handleQuestion(client, ask);
          break;
        }
        default:
          break;
      }
    }
  }

  private pushPart(part: Part): void {
    const role = this.roles.get(part.messageID) ?? 'assistant';
    this.queue.push({ type: 'opencode-part', part, role } as unknown as SdkMessage);
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

  /** Deduplicates streaming updates into at-most-one OutputEntry-worthy
   *  translation per part, WITHOUT the pure opencodeAdapter.ts needing any
   *  state: text/reasoning parts only qualify once they stop changing (`time`
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
        // Unhandled part kinds fall through to opencodeMessageToEntries'
        // default case, which drops them the same way sdkMessageToEntries
        // drops unrecognized SDK message types.
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
   * Bridges one OpenCode permission ask into the SAME `canUseTool` callback
   * SessionRunner already builds for Claude Code (session/runner.ts's
   * `canUseTool` field, which forwards into `PermissionBroker.handleCanUseTool`)
   * — this facade never talks to PermissionBroker directly, only through the
   * SdkSessionOptions.canUseTool seam every facade is handed.
   *
   * Reply is allow/deny only — 'once' or 'reject' — no 'always' persistence.
   */
  private handlePermission(permission: NormalizedPermission): void {
    if (this.answeredAsks.has(permission.id)) return;
    this.answeredAsks.add(permission.id);

    const reply = (result: SdkPermissionResult | null): Promise<void> => {
      // null means "already answered out-of-band" per the CanUseTool contract
      // (see facade.ts's re-exported type doc) — nothing in this facade ever
      // does that, but honoring the contract means not guessing at a response.
      if (!result) return Promise.resolve();
      return permission.reply(result.behavior === 'allow' ? 'once' : 'reject').catch(() => {
        // Best-effort — the ask then stays pending server-side; there is no
        // live connection left to retry over.
      });
    };

    this.canUseTool(permission.toolName, permission.input, {
      signal: this.abortController.signal,
      toolUseID: permission.toolUseID,
      requestId: permission.id,
      title: permission.title,
      ...(permission.description ? { description: permission.description } : {}),
    })
      .then(reply)
      .catch((err) => {
        // Fail closed: an unexpected canUseTool rejection must not leave
        // OpenCode's tool call waiting on a reply that never comes.
        void reply({ behavior: 'deny', message: err instanceof Error ? err.message : String(err) });
      });
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
        const { session } = await this.ready;
        await client.permission.respond({
          sessionID: session.id,
          permissionID: permission.id,
          directory: this.cwd,
          response,
        });
      },
    };
  }

  /**
   * One OpenCode `question.asked`: shown as the phone's question card and
   * routed through `canUseTool('AskUserQuestion')`, the same path Claude
   * Code's questions take, so the phone's answer reaches the broker the usual
   * way. Keyed by the question tool's call id: the card groups under it and
   * that call's own result marks the card answered. Always answered — a
   * denial or timeout rejects the question, so OpenCode never waits on a
   * reply that is not coming.
   */
  private handleQuestion(client: OpencodeClient, ask: QuestionAsk): void {
    if (this.answeredAsks.has(ask.id)) return;
    this.answeredAsks.add(ask.id);

    const toolUseID = ask.tool?.callID ?? ask.id;
    const questions = toAskQuestions(ask.questions);
    this.queue.push({ type: 'opencode-question', toolUseId: toolUseID, questions } as unknown as SdkMessage);

    const reject = (): void => {
      void client.question.reject({ requestID: ask.id, directory: this.cwd }).catch(() => {});
    };
    this.canUseTool('AskUserQuestion', { questions }, {
      signal: this.abortController.signal,
      toolUseID,
      requestId: ask.id,
    })
      .then((result) => {
        if (!result) return;
        if (result.behavior !== 'allow') return reject();
        const answers = ((result.updatedInput as { answers?: Record<string, string> } | undefined)?.answers) ?? {};
        return client.question
          .reply({ requestID: ask.id, directory: this.cwd, answers: toQuestionAnswers(ask.questions, answers) })
          .then(({ error }) => {
            if (error) reject();
          });
      })
      .catch(reject);
  }

  messages(): AsyncIterable<SdkMessage> {
    return this.queue.drain();
  }

  pushInput(text: string): void {
    this.ready
      .then(({ client, session }) =>
        client.session.promptAsync({
          sessionID: session.id,
          directory: this.cwd,
          parts: [{ type: 'text', text }],
          ...(this.model ? { model: this.model } : {}),
        }),
      )
      .then(({ error }) => {
        if (error) {
          this.queue.push({
            type: 'opencode-error',
            content: `OpenCode prompt failed: ${JSON.stringify(error)}`,
          } as unknown as SdkMessage);
        }
      })
      .catch((err) => {
        this.queue.push({
          type: 'opencode-error',
          content: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}`,
        } as unknown as SdkMessage);
      });
  }

  /** No OpenCode equivalent to Claude Code's session-scoped permission mode:
   *  OpenCode always asks per tool call via its permission events, and this
   *  facade always bridges every ask through canUseTool regardless of mode
   *  (see handlePermission) — there is nothing to switch. Intentional no-op;
   *  must not throw (SdkSessionHandle's contract). */
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}

  /** No OpenCode equivalent to Claude Code's mid-session reasoning-effort
   *  control. Intentional no-op; must not throw (SdkSessionHandle's
   *  contract). */
  async setEffort(_level: EffortLevel): Promise<void> {}

  /** OpenCode has no session-level "current model" setter — model selection
   *  is a per-prompt field. Store the split id and apply it to every
   *  subsequent pushInput's prompt call. */
  async setModel(model: string): Promise<void> {
    this.model = splitModelId(model);
  }

  async interrupt(): Promise<void> {
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ sessionID: session.id, directory: this.cwd });
    } catch {
      // Best-effort, mirrors RealSdkSessionHandle's fire-and-forget
      // q.interrupt() — an already-idle OpenCode session can legitimately
      // 404 on abort.
    }
  }

  async probeReady(): Promise<void> {
    await this.ready;
  }

  /** OpenCode has no equivalent control request to feature-detect against —
   *  always null, never fabricated (see this module's doc comment). */
  async getContextUsage(): Promise<SdkContextUsage | null> {
    return null;
  }

  /** Same as getContextUsage(): no OpenCode equivalent, always null. */
  async getUsageSnapshot(): Promise<unknown | null> {
    return null;
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.abortController.abort();
    this.queue.close();
    try {
      const { client, session } = await this.ready;
      await client.session.abort({ sessionID: session.id, directory: this.cwd });
    } catch {
      // Best-effort — `ready` may itself have rejected (session never
      // created), or the session may already be gone server-side.
    }
  }
}

export class OpenCodeFacade implements SdkFacade {
  private readonly baseUrl: string;
  private clientPromise: Promise<OpencodeClient> | null = null;

  constructor(opts: OpenCodeFacadeOptions) {
    this.baseUrl = opts.baseUrl;
  }

  private getClient(): Promise<OpencodeClient> {
    if (!this.clientPromise) {
      this.clientPromise = Promise.resolve(createOpencodeClient({ baseUrl: this.baseUrl }));
    }
    return this.clientPromise;
  }

  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    return new OpenCodeSessionHandle(opts, this.getClient());
  }

  /** Best-effort model list from OpenCode's configured providers — empty
   *  array on any failure (no live session required to ask, unlike Claude
   *  Code's supportedModels(), which needs a live query). Ids are composed as
   *  `<providerID>/<modelID>` — the same shape splitModelId expects back. */
  async supportedModels(): Promise<SdkModelDescriptor[]> {
    try {
      const client = await this.getClient();
      const { data, error } = await client.config.providers();
      if (error || !data) return [];
      const out: SdkModelDescriptor[] = [];
      for (const provider of data.providers) {
        for (const model of Object.values(provider.models)) {
          out.push({ id: `${provider.id}/${model.id}`, label: model.name });
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
