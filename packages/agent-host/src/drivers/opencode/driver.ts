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
 *  - no usage or context numbers: OpenCode has no equivalent to ask, and a
 *    fabricated number would be worse than none;
 *  - no effort levels; models are per prompt (`provider/model` ids).
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
import type { Driver, DriverSession, SessionContext } from '../../driver';
import { touchesSecretPath } from '../../policy';
import { PERMISSION_ALLOW, PERMISSION_DENY, toolKindOf, toolLocations, toolTitle } from '../../tools';
import { newTranslateContext } from '../../transcript';
import type { AgentInfo, ModelEntry, QuestionSpec, SessionOption, StartSession, UsageData } from '../../types';
import { opencodeEventToEntries, toolCallDiffs, type OpenCodeEvent } from './adapter';
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
  private readonly denySecretPaths: boolean;
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

  /** Resolves once the OpenCode session exists server-side. */
  private readonly ready: Promise<{ client: OpencodeClient; session: Session }>;

  constructor(
    params: StartSession,
    private readonly ctx: SessionContext,
    clientPromise: Promise<OpencodeClient>,
  ) {
    this.cwd = params.cwd;
    this.mode = params.mode ?? DEFAULT_MODE;
    this.model = splitModelId(params.model ?? undefined);
    this.denySecretPaths = params.denySecretPaths ?? false;
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
        this.ctx.emit({ type: 'info', nativeSessionId: session.id, ...(params.model ? { model: params.model } : {}), mode: this.mode });
        this.deliver({ type: 'started', ...(params.model ? { model: params.model } : {}) });
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
          if (info.sessionID !== sessionId) continue;
          this.roles.set(info.id, info.role);
          if (info.role === 'assistant' && info.error) {
            this.deliver({ type: 'error', content: formatOpenCodeError(info.error) });
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
          this.deliver({ type: 'idle' });
          if (!this.ended) this.ctx.emit({ type: 'turn', state: 'idle' });
          break;
        }
        // Turn-boundary signal: `busy` starts a turn. `idle` overlaps with
        // 'session.idle' above; reporting the same state twice is harmless.
        case 'session.status': {
          if (event.properties.sessionID !== sessionId) continue;
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
          if (event.properties.sessionID && event.properties.sessionID !== sessionId) continue;
          if (event.properties.error) {
            this.deliver({ type: 'error', content: formatOpenCodeError(event.properties.error) });
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
    this.deliver({ type: 'part', part, role });
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
  private handlePermission(permission: NormalizedPermission): void {
    if (this.answeredAsks.has(permission.id)) return;
    this.answeredAsks.add(permission.id);
    const reply = (response: 'once' | 'reject'): void => {
      // Best effort — the ask then stays pending server-side; there is no
      // live connection left to retry over.
      permission.reply(response).catch(() => {});
    };

    if (this.denySecretPaths && touchesSecretPath(permission.toolName, permission.input)) {
      this.ctx.log(`[opencode] DENIED secret-path access by test session ${this.ctx.sessionId}: ${permission.toolName}`);
      reply('reject');
      return;
    }
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

  prompt(text: string): void {
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
        if (error) this.deliver({ type: 'error', content: `OpenCode prompt failed: ${JSON.stringify(error)}` });
      })
      .catch((err) => {
        this.deliver({ type: 'error', content: `OpenCode prompt failed: ${err instanceof Error ? err.message : String(err)}` });
      });
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

  private constructor(private readonly options: OpenCodeDriverOptions) {}

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
      supports: { models: true, usage: false, providers: false, gsd: true, interrupt: true },
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
    return new OpenCodeSession(params, ctx, this.clientPromise);
  }

  /** Best-effort model list from OpenCode's configured providers — empty on
   *  any failure. Ids are `<providerID>/<modelID>`, the shape a prompt
   *  expects back. */
  async listModels(): Promise<{ models: ModelEntry[] }> {
    if (!this.clientPromise) return { models: [] };
    try {
      const client = await this.clientPromise;
      const { data, error } = await client.config.providers();
      if (error || !data) return { models: [] };
      const models: ModelEntry[] = [];
      for (const provider of data.providers) {
        for (const model of Object.values(provider.models)) {
          models.push({ id: `${provider.id}/${model.id}`, label: model.name });
        }
      }
      return { models };
    } catch {
      return { models: [] };
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.server?.close();
  }
}
