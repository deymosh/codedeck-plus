/**
 * A scripted ACP agent behind a driver's spawn seam: it answers the ACP
 * requests a session makes, in the shapes a real agent sends, so a driver
 * can be tested without the CLI, a credential or a network.
 *
 * Two agents sit behind this fake, and they do not behave alike. `deepseek`
 * reproduces the DeepSeek Harness's `dsh --profile acp` (pinned 0.2.1-rc.2),
 * `qwen` reproduces Qwen Code's `qwen --acp` (pinned 0.26.1). A test says
 * which one it drives; everything a driver can observe — the initialize
 * capabilities, how a session is created, resumed, listed and closed, where a
 * tool call's name travels, what a refused config option says, the permission
 * ask and the end of a turn — comes from that profile.
 *
 * Verified against dsh 0.2.1-rc.2 / qwen-code 0.26.1 on 2026-10-27; re-probe
 * on a bump. The probes (raw ACP over the agent's stdio, throwaway homes and
 * the local fake model for the turns) answered, per agent:
 *  - initialize: agentInfo, prompt/mcp/session capabilities, `loadSession`
 *    and `authMethods`; only the harness advertises `session/close`, only
 *    Qwen Code advertises `loadSession`; both advertise `list` and `resume`.
 *  - session/new, session/resume (active and after close), session/list (the
 *    harness lists a conversation only once it is closed; Qwen Code lists it
 *    while live and needs `cwd`), session/load (Qwen Code has it, the harness
 *    answers method-not-found) and session/close (Qwen Code answers
 *    method-not-found; the harness closes once and calls a second close of
 *    the same id unknown).
 *  - a `/tool` turn: the harness's `tool_call` names the tool as `title`
 *    (`bash`, `kind: "other"`) with its arguments; Qwen Code's first
 *    `tool_call` carries `_meta.toolName` and no arguments, and the
 *    arguments arrive in a following `tool_call_update`. Neither sends `name`.
 *  - session/set_config_option with an offered and an unoffered model and
 *    effort, and with an unknown config id: both refuse an unoffered value
 *    with -32602 and their own message.
 *  - session/set_mode: offered, unoffered, and on the harness (no modes, so
 *    method-not-found).
 *  - session/request_permission: the harness names only the tool call's id
 *    (it asks when a model requests a wider sandbox, which is why the probe
 *    also read `@deepseek-ai/dsh-acp`'s ask); Qwen Code repeats the call's
 *    facts and offers allow-always choices beside Allow and Reject.
 *  - a turn ends with a `stopReason`; Qwen Code adds its branch point in
 *    `_meta`.
 *
 * A test still sets `options` to the option state its agent composes and
 * `onPrompt` to script one turn — sending updates and asking for a
 * permission — while everything else is answered the way that agent does.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Which real agent a `FakeAgent` stands in for. */
export type AcpProfile = 'deepseek' | 'qwen';

/** Minimal fake ChildProcess: the streams the driver talks over, plus the
 *  exit and kill behaviour the runtime's close ladder needs. */
export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly killed: string[] = [];

  kill(signal: string): boolean {
    this.killed.push(signal);
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }

  /** The agent process dying on its own (a crash, a plugin error). */
  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** One message the driver sent to the agent. */
interface Sent {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** One conversation the fake created or resumed. */
interface SessionRecord {
  sessionId: string;
  cwd: string;
  closed: boolean;
  /** The conversation's opening line, which Qwen Code shows as its title. */
  title: string;
  /** How many turns ran in it (Qwen Code turns them into branch points). */
  turns: number;
}

/** What differs between the two real agents, verified by the probes above. */
interface Profile {
  agentInfo: unknown;
  authMethods: unknown[];
  /** `agentCapabilities` exactly as `initialize` answers it. */
  agentCapabilities: Record<string, unknown>;
  /** Whether `session/close` is served at all. */
  closesSessions: boolean;
  /** Whether `session/set_mode` is served at all. */
  hasModes: boolean;
  /** How `session/list` reads: the harness lists persisted conversations
   *  only (a live one is not there yet), Qwen Code lists the live ones for
   *  the `cwd` it is given and needs that `cwd`. */
  list: 'persisted' | 'by-cwd';
  /** The tool name a `tool_call` update carries, and its shape. */
  toolCall(sessionId: string, toolCallId: string, name: string, input: Record<string, unknown>): unknown[];
  /** The permission ask an agent sends for one tool call. */
  permissionAsk(toolCallId: string, facts: ToolCallFacts | undefined, options: unknown[] | undefined): Record<string, unknown>;
  /** The refusal of a `session/set_config_option` the agent did not offer. */
  configRefusal(configId: string, value: string, options: unknown[]): string;
  /** The refusal of a config id the agent does not have. */
  unknownConfigRefusal(configId: string): string;
  /** What a settled `session/prompt` answers beyond its stop reason. */
  promptResult(session: SessionRecord): Record<string, unknown>;
}

/** What a tool call's own update said, for a later permission ask. */
interface ToolCallFacts {
  name: string;
  input: Record<string, unknown>;
}

/** The method-not-found error an ACP agent answers with (the SDK's own
 *  wording, quotes included). */
function methodNotFound(method: string): { code: number; message: string; data: { method: string } } {
  return { code: -32601, message: `"Method not found": ${method}`, data: { method } };
}

/** A select option's values, flat or grouped (the harness groups its models
 *  by provider). */
function offeredValues(options: unknown[]): string[] {
  const values: string[] = [];
  for (const entry of options) {
    const record = asRecord(entry);
    if (Array.isArray(record.options)) values.push(...offeredValues(record.options));
    else if (typeof record.value === 'string') values.push(record.value);
  }
  return values;
}

/** The model id the harness's selector value encodes (`[provider, model]`). */
function harnessModelId(currentValue: string): string {
  try {
    const parsed: unknown = JSON.parse(currentValue);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {
    // Not a selector: the value is already what it looks like.
  }
  return currentValue;
}

/** The display title Qwen Code gives a tool: a friendly word, never the
 *  tool's own name (which travels in `_meta.toolName`). */
function qwenTitle(name: string): string {
  switch (name) {
    case 'run_shell_command':
      return 'Shell';
    case 'edit':
    case 'write_file':
      return 'Edit';
    default:
      return name;
  }
}

const DEEPSEEK: Profile = {
  agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
  authMethods: [],
  agentCapabilities: {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities: { close: {}, list: {}, resume: {} },
  },
  closesSessions: true,
  hasModes: false,
  list: 'persisted',
  toolCall(_sessionId, toolCallId, name, input) {
    // The harness sends the standard lifecycle with the tool's own name as
    // its title, `kind: "other"`, and the arguments already in the start.
    return [{ sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput: input }];
  },
  permissionAsk(toolCallId, _facts, options) {
    // It names only the call; the driver reads the tool from the call's own
    // earlier update.
    return {
      toolCall: { toolCallId },
      options:
        options ??
        [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
    };
  },
  configRefusal(configId, value, options) {
    if (configId === 'model') return `Invalid params: unknown model option: ${value}`;
    // The harness names the model the effort was refused for.
    const model = asRecord(options.find((entry) => asRecord(entry).id === 'model')).currentValue;
    return `Invalid params: unknown reasoning effort for ${harnessModelId(typeof model === 'string' ? model : '')}: ${value}`;
  },
  unknownConfigRefusal(configId) {
    return `Invalid params: unknown session config option: ${configId}`;
  },
  promptResult() {
    return {};
  },
};

const QWEN: Profile = {
  agentInfo: { name: 'qwen-code', title: 'Qwen Code', version: '0.26.1' },
  authMethods: [
    {
      id: 'openai',
      name: 'Use OpenAI API key',
      description: 'Requires setting the `OPENAI_API_KEY` environment variable',
      _meta: { type: 'terminal', args: ['--auth-type=openai'] },
    },
  ],
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    sessionCapabilities: { list: {}, resume: {} },
    mcpCapabilities: { sse: true, http: true },
    _meta: { imageCapability: { autoHandlesWrongModel: true, maxBytes: 10_380_902, maxImagesPerTurn: 4 } },
  },
  closesSessions: false,
  hasModes: true,
  list: 'by-cwd',
  toolCall(_sessionId, toolCallId, name, input) {
    const meta = { toolName: name, provenance: 'builtin' };
    // The first update says what is about to run and carries no arguments;
    // the arguments arrive in the update that starts it running.
    const updates: unknown[] = [
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        status: 'pending',
        title: qwenTitle(name),
        content: [],
        locations: [],
        kind: qwenKind(name),
        rawInput: {},
        _meta: { ...meta, phase: 'preparing' },
      },
    ];
    if (Object.keys(input).length > 0) {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        title: qwenTitle(name),
        content: [],
        locations: [],
        kind: qwenKind(name),
        rawInput: input,
        _meta: { ...meta, startedAt: Date.now() },
      });
    }
    return updates;
  },
  permissionAsk(toolCallId, facts, options) {
    const name = facts?.name ?? 'run_shell_command';
    return {
      toolCall: {
        toolCallId,
        status: 'pending',
        title: qwenTitle(name),
        content: [],
        locations: [],
        kind: qwenKind(name),
        rawInput: facts?.input ?? {},
        _meta: { toolName: name },
      },
      options:
        options ??
        [
          { optionId: 'proceed_always_project', name: 'Always Allow in project', kind: 'allow_always' },
          { optionId: 'proceed_always_user', name: 'Always Allow for user', kind: 'allow_always' },
          { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
        ],
    };
  },
  configRefusal(configId, value, options) {
    if (configId === 'model') return `Invalid params: Model '${value}' not found for authType 'openai'`;
    const option = options.find((entry) => asRecord(entry).id === configId);
    const offered = offeredValues(option === undefined ? [] : [option]);
    // The message puts the provider default first, then the option list.
    const choices = ['default', ...offered.filter((entry) => entry !== 'default')].join(', ');
    return `Invalid params: Unknown reasoning effort: ${value}. Choose one of: ${choices}`;
  },
  unknownConfigRefusal(configId) {
    return `Invalid params: Unsupported configId: ${configId}`;
  },
  promptResult(session) {
    return {
      _meta: {
        'qwen.branchPoint': {
          assistantRecordUuid: `${session.sessionId}-assistant-${session.turns}`,
          checkpointUuid: `${session.sessionId}-checkpoint-${session.turns}`,
        },
      },
    };
  },
};

function qwenKind(name: string): string {
  switch (name) {
    case 'run_shell_command':
      return 'execute';
    case 'edit':
    case 'write_file':
      return 'edit';
    default:
      return 'other';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const PROFILES: Record<AcpProfile, Profile> = { deepseek: DEEPSEEK, qwen: QWEN };

export class FakeAgent {
  readonly child = new FakeChild();
  /** Requests the driver sent, in order. */
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Notifications the driver sent, in order. */
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Every `session/new` the driver asked for. */
  readonly newSessions: Array<Record<string, unknown>> = [];
  readonly resumed: Array<Record<string, unknown>> = [];
  readonly closed: string[] = [];
  readonly setOptions: Array<{ sessionId: string; configId: string; value: string }> = [];
  /** Every `session/set_mode` the driver asked for. */
  readonly setModes: Array<{ sessionId: string; modeId: string }> = [];
  /** The option state session/new and session/resume answer with. */
  options: unknown[] = [];
  /** The mode state those answers carry, for an agent that has modes. */
  modes: unknown = null;
  /** What `initialize` answers as the agent's own name and version. */
  agentInfo: unknown;
  /** Make `session/resume` fail the way a missing conversation does. */
  resumeError: string | undefined;
  /** Whether the agent accepts the values `set_config_option` is given. */
  acceptsOptions = true;
  /** Whether the connection advertises `session/resume`: `true` as `{}`,
   *  `false` by leaving the field out, `'null'` as an explicit `null`. */
  supportsResume: boolean | 'null' = true;
  /** Whether `session/new` succeeds. */
  newSessionError: string | undefined;
  /** Whether the agent answers `session/new` at all — a wedged start. */
  ignoreNewSession = false;
  /** Hold the NEXT `session/new` until `answerNewSession()`: a start that
   *  times out and only then creates its session. */
  holdNextNewSession = false;
  private heldNew?: { id: number | string; params: Record<string, unknown> };
  /** Whether the agent answers `session/close` at all — a wedged end. Only
   *  an agent that advertises the method is asked. */
  ignoreClose = false;
  /** Whether the agent ignores `session/cancel` — a wedged turn. */
  ignoresCancel = false;
  /** Scripts one turn; the default completes at once. */
  onPrompt: ((sessionId: string, text: string, agent: FakeAgent) => Promise<string> | string) | undefined;
  private readonly profile: Profile;
  private readonly sessions: SessionRecord[] = [];
  private readonly callFacts = new Map<string, ToolCallFacts>();
  private nextId = 1;
  private readonly pending = new Map<number | string, (message: Sent) => void>();
  private readonly inbound: Sent[] = [];
  private buffer = '';

  constructor(readonly acpProfile: AcpProfile = 'deepseek') {
    this.profile = PROFILES[acpProfile];
    this.agentInfo = this.profile.agentInfo;
    this.child.stdin.on('data', (chunk: Buffer) => this.receive(chunk.toString()));
    // Nothing reads the agent's own log here; keep the stream drained.
    this.child.stderr.resume();
  }

  private receive(text: string): void {
    this.buffer += text;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim() === '') continue;
      this.handle(JSON.parse(line) as Sent);
    }
  }

  private handle(message: Sent): void {
    if (message.method === undefined) {
      const settle = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (settle && message.id !== undefined) {
        this.pending.delete(message.id);
        settle(message);
      }
      return;
    }
    if (message.id === undefined) {
      this.notifications.push({ method: message.method, params: message.params ?? {} });
      if (message.method === 'session/cancel' && !this.ignoresCancel) {
        this.resolveTurn(message.params?.sessionId as string, 'cancelled');
      }
      return;
    }
    const params = message.params ?? {};
    this.requests.push({ method: message.method, params });
    void this.answer(message.id, message.method, params);
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case 'initialize':
        this.reply(id, {
          protocolVersion: 1,
          agentInfo: this.agentInfo,
          agentCapabilities: {
            ...this.profile.agentCapabilities,
            sessionCapabilities: {
              ...(asRecord(this.profile.agentCapabilities.sessionCapabilities) ?? {}),
              ...(this.supportsResume === true ? { resume: {} } : this.supportsResume === 'null' ? { resume: null } : { resume: undefined }),
            },
          },
          authMethods: this.profile.authMethods,
        });
        return;
      case 'session/new': {
        if (this.ignoreNewSession) return;
        if (this.holdNextNewSession) {
          this.holdNextNewSession = false;
          this.heldNew = { id, params };
          return;
        }
        if (this.newSessionError !== undefined) {
          this.errorReply(id, -32602, `Invalid params: ${this.newSessionError}`);
          return;
        }
        this.newSessions.push(params);
        const sessionId = `s${this.newSessions.length}`;
        this.sessions.push({ sessionId, cwd: String(params.cwd ?? ''), closed: false, title: '(session)', turns: 0 });
        this.reply(id, this.sessionState(sessionId));
        return;
      }
      case 'session/resume': {
        if (this.resumeError !== undefined) {
          this.errorReply(id, -32602, `Invalid params: ${this.resumeError}`);
          return;
        }
        this.resumed.push(params);
        // An agent that does not advertise resume does not serve it either.
        if (this.supportsResume !== true) {
          this.errorReply(id, -32601, 'Method not found: session/resume');
          return;
        }
        const sessionId = String(params.sessionId);
        const record = this.sessions.find((entry) => entry.sessionId === sessionId);
        if (record === undefined) {
          this.sessions.push({ sessionId, cwd: String(params.cwd ?? ''), closed: false, title: '(session)', turns: 0 });
        } else {
          record.closed = false;
        }
        this.reply(id, this.sessionState(sessionId, false));
        return;
      }
      case 'session/list': {
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        // The harness lists a conversation only once it has been closed (and
        // flushed); Qwen Code lists the ones it has while they are live, for
        // the cwd it is asked about.
        const listed =
          this.profile.list === 'persisted'
            ? this.sessions.filter((entry) => entry.closed)
            : cwd === undefined
              ? []
              : this.sessions.filter((entry) => entry.cwd === cwd);
        this.reply(id, {
          sessions: listed.map((entry) => ({ sessionId: entry.sessionId, cwd: entry.cwd, title: entry.title })),
        });
        return;
      }
      case 'session/load': {
        // The harness has no load; Qwen Code has it but this fake does not
        // model a conversation transcript, so it answers like a resume.
        if (this.acpProfile === 'deepseek') {
          const error = methodNotFound('session/load');
          this.rawErrorReply(id, error);
          return;
        }
        this.reply(id, this.sessionState(String(params.sessionId), false));
        return;
      }
      case 'session/set_mode': {
        if (!this.profile.hasModes) {
          const error = methodNotFound('session/set_mode');
          this.rawErrorReply(id, error);
          return;
        }
        const sessionId = String(params.sessionId);
        const modeId = String(params.modeId);
        this.setModes.push({ sessionId, modeId });
        // An agent that has modes refuses one it does not offer.
        const state = this.modes as { currentModeId?: string; availableModes?: Array<{ id?: string }> } | null;
        if (state?.availableModes !== undefined && !state.availableModes.some((mode) => mode.id === modeId)) {
          this.errorReply(id, -32602, `Invalid params: Unknown approval mode: ${modeId}`);
          return;
        }
        if (state) this.modes = { ...state, currentModeId: modeId };
        this.reply(id, {});
        return;
      }
      case 'session/set_config_option': {
        const configId = String(params.configId);
        const value = String(params.value);
        this.setOptions.push({ sessionId: String(params.sessionId), configId, value });
        const option = this.options.find(
          (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: string }).id === configId,
        );
        if (option === undefined) {
          this.errorReply(id, -32602, this.profile.unknownConfigRefusal(configId));
          return;
        }
        // The agent answers a change with the complete, updated option
        // state — including a current value the change did not accept.
        const offered = offeredValues([option]).includes(value);
        if (!this.acceptsOptions || !offered) {
          this.errorReply(id, -32602, this.profile.configRefusal(configId, value, this.options));
          return;
        }
        this.options = this.options.map((entry) => (entry === option ? { ...(entry as object), currentValue: value } : entry));
        this.reply(id, { configOptions: this.options });
        return;
      }
      case 'session/close': {
        if (!this.profile.closesSessions) {
          const error = methodNotFound('session/close');
          this.rawErrorReply(id, error);
          return;
        }
        if (this.ignoreClose) return;
        const sessionId = String(params.sessionId);
        const record = this.sessions.find((entry) => entry.sessionId === sessionId);
        if (record === undefined || record.closed) {
          // A second close of the same id is unknown: the harness removes the
          // record as it closes.
          this.errorReply(id, -32602, `Invalid params: unknown session: ${sessionId}`);
          return;
        }
        record.closed = true;
        this.closed.push(sessionId);
        this.reply(id, {});
        return;
      }
      case 'session/prompt': {
        const sessionId = String(params.sessionId);
        const text = (params.prompt as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
        this.turnIds.set(sessionId, id);
        let stop = 'end_turn';
        try {
          stop = this.onPrompt ? await this.onPrompt(sessionId, text, this) : 'end_turn';
        } catch (error) {
          // A turn that failed is a failed request, as an agent reports it.
          this.turnIds.delete(sessionId);
          this.errorReply(id, -32603, `Internal error: turn failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        // A scripted turn may have been completed by a cancel already.
        if (this.turnIds.get(sessionId) === id) {
          this.turnIds.delete(sessionId);
          const record = this.sessions.find((entry) => entry.sessionId === sessionId);
          if (record !== undefined) {
            record.turns += 1;
            if (record.title === '(session)' && text.trim() !== '') record.title = text.trim();
          }
          this.reply(id, { stopReason: stop, ...(record ? this.profile.promptResult(record) : {}) });
        }
        return;
      }
      default:
        this.errorReply(id, -32601, `Method not found: ${method}`);
    }
  }

  /** What `session/new`, `session/resume` and `session/load` answer with.
   *  `withId` is false for the two that continue a conversation the client
   *  named (ACP does not repeat its id). */
  private sessionState(sessionId: string, withId = true): Record<string, unknown> {
    const record = this.sessions.find((entry) => entry.sessionId === sessionId);
    return {
      ...(withId ? { sessionId } : {}),
      configOptions: this.options,
      ...(this.modes !== null ? { modes: this.modes } : {}),
      // Qwen Code also summarises the model beside the config options.
      ...(record !== undefined && this.profile.list === 'by-cwd' ? { models: this.qwenModels() } : {}),
    };
  }

  private qwenModels(): Record<string, unknown> {
    const option = asRecord(this.options.find((entry) => asRecord(entry).id === 'model'));
    const entries = Array.isArray(option.options) ? option.options : [];
    return {
      currentModelId: typeof option.currentValue === 'string' ? option.currentValue : '',
      availableModels: entries.flatMap((entry) => {
        const model = asRecord(entry);
        return typeof model.value === 'string'
          ? [{ modelId: model.value, name: typeof model.name === 'string' ? model.name : model.value, description: null }]
          : [];
      }),
    };
  }

  private readonly turnIds = new Map<string, number | string>();

  /** Answer the `session/new` held by `holdNextNewSession`, as an agent that
   *  was merely slow does. */
  answerNewSession(): void {
    const held = this.heldNew;
    if (!held) return;
    this.heldNew = undefined;
    this.newSessions.push(held.params);
    const sessionId = `s${this.newSessions.length}`;
    this.sessions.push({ sessionId, cwd: String(held.params.cwd ?? ''), closed: false, title: '(session)', turns: 0 });
    this.reply(held.id, this.sessionState(sessionId));
  }

  /** Finish the turn running in `sessionId`, as an agent does for a cancelled
   *  prompt. */
  resolveTurn(sessionId: string, reason: string): void {
    const id = this.turnIds.get(sessionId);
    if (id === undefined) return;
    this.turnIds.delete(sessionId);
    this.reply(id, { stopReason: reason });
  }

  // --- messages to the client ---

  send(method: string, params: unknown): void {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** One `session/update` notification. */
  update(sessionId: string, update: unknown): void {
    this.send('session/update', { sessionId, update });
  }

  /** One agent message chunk, as an agent derives it from a committed
   *  assistant message. */
  message(sessionId: string, text: string): void {
    this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  }

  thought(sessionId: string, text: string): void {
    this.update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  }

  /** One started tool call, in this agent's shape: the harness names the tool
   *  as the update's title; Qwen Code keeps it in `_meta.toolName` and sends
   *  the arguments in a second update. */
  toolCall(sessionId: string, toolCallId: string, name: string, rawInput: Record<string, unknown> = {}): void {
    this.callFacts.set(toolCallId, { name, input: rawInput });
    for (const update of this.profile.toolCall(sessionId, toolCallId, name, rawInput)) {
      this.update(sessionId, update);
    }
  }

  toolResult(sessionId: string, toolCallId: string, text: string, failed = false): void {
    this.update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: failed ? 'failed' : 'completed',
      content: text === '' ? [] : [{ type: 'content', content: { type: 'text', text } }],
    });
  }

  usage(sessionId: string, used: number, size: number): void {
    this.update(sessionId, { sessionUpdate: 'usage_update', used, size });
  }

  /** Ask the client to allow one tool call, as an agent does, and answer with
   *  what it decided. */
  askPermission(
    sessionId: string,
    toolCallId: string,
    options?: unknown[],
  ): Promise<{ outcome: string; optionId?: string } | undefined> {
    const ask = this.profile.permissionAsk(toolCallId, this.callFacts.get(toolCallId), options);
    return this.requestPermission({ sessionId, ...ask }).then((result) => {
      const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
      return outcome === undefined ? undefined : { outcome: outcome.outcome ?? '', ...(outcome.optionId ? { optionId: outcome.optionId } : {}) };
    });
  }

  /** Ask the client to allow a tool call, as an agent does, with the whole
   *  request spelled out (the tool call's arguments, its content, its
   *  `_meta`), and answer with the client's whole reply — so a test can see
   *  what travelled beside the outcome. */
  requestPermission(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = 9000 + this.nextId++;
    const message = new Promise<Sent>((resolve) => this.pending.set(id, resolve));
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params })}\n`);
    return message.then((answer) => (answer.result ?? {}) as Record<string, unknown>);
  }

  /** Send one extension request (a method ACP does not define) and answer
   *  with what the client replied. */
  extRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = 9500 + this.nextId++;
    const message = new Promise<Sent>((resolve) => this.pending.set(id, resolve));
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return message.then((answer) => answer as Record<string, unknown>);
  }

  /** Erase stdout/stderr support for a line that is not JSON-RPC at all. */
  raw(line: string): void {
    this.child.stdout.write(line);
  }

  private reply(id: number | string, result: unknown): void {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private errorReply(id: number | string, code: number, message: string): void {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  private rawErrorReply(id: number | string, error: { code: number; message: string; data: unknown }): void {
    this.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  }
}
