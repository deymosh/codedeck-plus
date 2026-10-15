/**
 * A scripted ACP agent behind a driver's spawn seam: it answers the ACP
 * requests a session makes, in the shapes a real agent sends, so a driver
 * can be tested without the CLI, a credential or a network.
 *
 * The shapes are ACP's own: a session's option state, `tool_call` updates
 * carrying the tool name as their title, permission asks that name only the
 * tool call, and stop reasons rather than a synthetic end. A test sets
 * `options` to the option state its agent composes, and `onPrompt` to script
 * one turn — sending updates and asking for a permission — while everything
 * else is answered the way an agent would.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnFn } from '../runtime';

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
  /** The option state session/new and session/resume answer with. */
  options: unknown[] = [];
  /** Make `session/resume` fail the way a missing conversation does. */
  resumeError: string | undefined;
  /** Whether the agent accepts the values `set_config_option` is given. */
  acceptsOptions = true;
  /** Whether the connection advertises `session/resume`: `true` as `{}`,
   *  `false` by leaving the field out, `'null'` as an explicit `null`. */
  supportsResume: boolean | 'null' = true;
  /** Whether `session/new` succeeds. */
  newSessionError: string | undefined;
  /** Scripts one turn; the default completes at once. */
  onPrompt: ((sessionId: string, text: string, agent: FakeAgent) => Promise<string> | string) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number | string, (message: Sent) => void>();
  private readonly inbound: Sent[] = [];
  private buffer = '';

  constructor(readonly spawnFn: SpawnFn = (() => this.child) as unknown as SpawnFn) {
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
      if (message.method === 'session/cancel') {
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
          agentInfo: { name: 'fake-agent', version: '0.0.1' },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: {
              close: {},
              list: {},
              ...(this.supportsResume === true ? { resume: {} } : this.supportsResume === 'null' ? { resume: null } : {}),
            },
          },
          authMethods: [],
        });
        return;
      case 'session/new': {
        if (this.newSessionError !== undefined) {
          this.errorReply(id, -32602, `Invalid params: ${this.newSessionError}`);
          return;
        }
        this.newSessions.push(params);
        const sessionId = `s${this.newSessions.length}`;
        this.reply(id, { sessionId, configOptions: this.options });
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
        this.reply(id, { configOptions: this.options });
        return;
      }
      case 'session/set_config_option': {
        const configId = String(params.configId);
        const value = String(params.value);
        this.setOptions.push({ sessionId: String(params.sessionId), configId, value });
        // The agent answers a change with the complete, updated option
        // state — including a current value the change did not accept.
        const option = this.options.find(
          (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: string }).id === configId,
        ) as { options?: Array<{ value?: string; options?: Array<{ value?: string }> }> } | undefined;
        // A select option's values may be offered flat or grouped (an agent
        // groups its models by provider).
        const offered =
          option?.options?.some((entry) =>
            Array.isArray(entry.options)
              ? entry.options.some((inner) => inner.value === value)
              : entry.value === value,
          ) === true;
        if (!this.acceptsOptions || !offered) {
          this.errorReply(id, -32602, `Invalid params: unknown ${configId} option: ${value}`);
          return;
        }
        this.options = this.options.map((entry) => (entry === option ? { ...(entry as object), currentValue: value } : entry));
        this.reply(id, { configOptions: this.options });
        return;
      }
      case 'session/close': {
        this.closed.push(String(params.sessionId));
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
          this.reply(id, { stopReason: stop });
        }
        return;
      }
      default:
        this.errorReply(id, -32601, `Method not found: ${method}`);
    }
  }

  private readonly turnIds = new Map<string, number | string>();

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

  toolCall(sessionId: string, toolCallId: string, name: string, rawInput: unknown = {}): void {
    this.update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput });
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
    const id = 9000 + this.nextId++;
    const message = new Promise<Sent>((resolve) => this.pending.set(id, resolve));
    this.child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId },
          options:
            options ??
            [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
        },
      })}\n`,
    );
    return message.then((answer) => {
      const outcome = (
        answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined
      )?.outcome;
      return outcome === undefined ? undefined : { outcome: outcome.outcome ?? '', ...(outcome.optionId ? { optionId: outcome.optionId } : {}) };
    });
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
}
