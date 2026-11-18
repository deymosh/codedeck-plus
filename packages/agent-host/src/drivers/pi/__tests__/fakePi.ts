/**
 * A scripted Pi RPC process for driver tests: the records of `pi --mode rpc`
 * that this driver reads, with no SDK, no model and no network.
 *
 * Verified against Pi 1.5.2 by driving the real CLI over RPC, and it states
 * only what was checked there:
 *
 * - a command is answered by `{type:"response", id, command, success, data}`;
 *   `get_state` carries `sessionId`, `sessionFile`, `model`, `thinkingLevel`;
 *   `prompt` answers `{disposition:"started"}` before any event;
 * - a run is `agent_start`, `turn_start`, `message_start`/`message_end`
 *   (user), the assistant's `message_start`, `message_update` deltas,
 *   `message_end` with the authoritative content, `tool_execution_start` /
 *   `extension_ui_request` / `tool_execution_end`, `turn_end`, `agent_end`
 *   and finally `agent_settled {aborted}`;
 * - the permission gate's dialog is an `extension_ui_request` with
 *   `method:"select"`, answered by `extension_ui_response` with `value` or
 *   `cancelled:true`; a blocked call ends with `isError:true` and the
 *   extension's reason as its result text;
 * - `agent_settled` does not arrive while such a dialog is unanswered;
 * - a failed request is an assistant `message_end` with `stopReason:
 *   "error"` and `errorMessage`, then `turn_end` and `agent_end`; next comes
 *   `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage}` when Pi
 *   retries it, `auto_retry_end {success:false, finalError}` when it gives
 *   up, or `agent_settled` at once for an error it does not retry — and a
 *   recovered retry ends with `auto_retry_end {success:true}` after the
 *   reply's `message_end` (recorded with a server answering 429).
 *
 * The child is a plain EventEmitter with the stdio surface `PiRpc` uses, so a
 * test can inject it through the driver's spawn seam.
 */
import { EventEmitter } from 'node:events';

interface FakeStdin extends EventEmitter {
  destroyed: boolean;
  write(chunk: string): boolean;
  end(chunk?: string): void;
}

export interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: FakeStdin;
  /** stdin, stdout, stderr and the provider token's pipe (fd 3). */
  stdio: [FakeStdin, EventEmitter, EventEmitter, FakeStdin];
  pid: number;
  kill(signal?: string): boolean;
}

export interface FakePiOptions {
  sessionId?: string;
  sessionFile?: string;
  model?: { provider: string; id: string; name?: string; contextWindow?: number };
  thinkingLevel?: string;
  /** Exits before answering anything, as a missing `--session` does. */
  exitOnStart?: { code: number; stderr: string };
}

/** A tool call a `/tool` prompt scripts. */
interface ScriptedCall {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** What the scripted 429 says, in Pi's own wording of one. */
const RATE_LIMITED = `429: ${JSON.stringify({
  message: 'rate limited (scripted)',
  type: 'rate_limit',
  // As long as a gateway's: one router's 429 carried hundreds of characters
  // of upstream detail in one line.
  attempts: Array.from({ length: 6 }, (_, i) => ({ provider: `upstream-${i}`, status: 429, message: 'Upstream request failed.' })),
})}`;

export class FakePi {
  readonly child: FakeChild;
  /** Every command the driver wrote, in order. */
  readonly commands: Array<Record<string, unknown>> = [];
  /** Every `extension_ui_response` the driver wrote. */
  readonly uiResponses: Array<Record<string, unknown>> = [];
  /** Dialogs answered by allow/deny, by their call id. */
  readonly answers = new Map<string, string>();
  /** What the driver wrote on the token pipe (fd 3), and whether it closed
   *  it — as the extension reads it, to the end. */
  token = '';
  tokenClosed = false;
  private readonly options: FakePiOptions;
  private nextCall = 0;
  private pendingDialog: { uiId: string; call: ScriptedCall } | undefined;

  constructor(options: FakePiOptions = {}) {
    this.options = options;
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let ended = false;
    // A real child emits `exit`, then `close` once its stdio is drained.
    const exit = (code: number | null, signal: string | null): void => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    };
    const stdin = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: (chunk: string): boolean => {
        this.read(chunk);
        return true;
      },
      end: (): void => {
        if (ended) return;
        ended = true;
        setTimeout(() => exit(0, null), 0);
      },
    }) as FakeStdin;
    child.stdin = stdin;
    const tokenPipe = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: (chunk: string): boolean => {
        this.token += chunk;
        return true;
      },
      end: (chunk?: string): void => {
        if (chunk !== undefined) this.token += chunk;
        this.tokenClosed = true;
      },
    }) as FakeStdin;
    child.stdio = [stdin, child.stdout, child.stderr, tokenPipe];
    child.pid = 4242;
    child.kill = (): boolean => {
      if (!ended) {
        ended = true;
        setTimeout(() => exit(null, 'SIGKILL'), 0);
      }
      return true;
    };
    this.child = child;
    if (options.exitOnStart) {
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from(`${options.exitOnStart!.stderr}\n`));
        exit(options.exitOnStart!.code, null);
      }, 5);
    }
  }

  /** Send one record to the driver, as Pi writes it on stdout. */
  emit(record: Record<string, unknown>): void {
    this.child.stdout.emit('data', Buffer.from(`${JSON.stringify(record)}\n`));
  }

  private respond(id: unknown, command: string, data?: unknown): void {
    this.emit({ ...(typeof id === 'string' ? { id } : {}), type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) });
  }

  private read(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      let command: Record<string, unknown>;
      try {
        command = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.commands.push(command);
      this.handle(command);
    }
  }

  private handle(command: Record<string, unknown>): void {
    // A missing conversation exits before Pi's RPC starts: it reads no
    // command at all.
    if (this.options.exitOnStart) return;
    const id = command.id;
    switch (command.type) {
      case 'get_state':
        this.respond(id, 'get_state', {
          model: this.options.model
            ? {
                id: this.options.model.id,
                name: this.options.model.name ?? this.options.model.id,
                provider: this.options.model.provider,
                contextWindow: this.options.model.contextWindow ?? 200_000,
              }
            : undefined,
          thinkingLevel: this.options.thinkingLevel ?? 'medium',
          isStreaming: false,
          sessionFile: this.options.sessionFile ?? '/pi/sessions/x.jsonl',
          sessionId: this.options.sessionId ?? 'pi-session-1',
          messageCount: 0,
        });
        return;
      case 'get_available_models':
        this.respond(id, 'get_available_models', {
          models: this.options.model
            ? [{ id: this.options.model.id, name: this.options.model.name ?? this.options.model.id, provider: this.options.model.provider }]
            : [],
        });
        return;
      case 'get_available_thinking_levels':
        this.respond(id, 'get_available_thinking_levels', { levels: ['off', 'minimal', 'low', 'medium', 'high'] });
        return;
      case 'get_commands':
        this.respond(id, 'get_commands', { commands: [{ name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' }] });
        return;
      case 'get_session_stats':
        this.respond(id, 'get_session_stats', { contextUsage: { tokens: 4_259, contextWindow: 200_000, percent: 2 } });
        return;
      case 'set_model': {
        const provider = typeof command.provider === 'string' ? command.provider : this.options.model?.provider;
        const modelId = typeof command.modelId === 'string' ? command.modelId : this.options.model?.id;
        this.respond(id, 'set_model', { id: modelId, provider, name: modelId });
        return;
      }
      case 'set_thinking_level':
        this.respond(id, 'set_thinking_level');
        return;
      case 'abort':
        this.respond(id, 'abort');
        this.settle(true);
        return;
      case 'prompt':
        this.respond(id, 'prompt', { disposition: 'started' });
        setTimeout(() => this.run(String(command.message ?? '')), 0);
        return;
      case 'steer':
        this.respond(id, 'steer', { disposition: 'queued' });
        return;
      case 'extension_ui_response':
        this.uiResponses.push(command);
        this.dialogAnswer(command);
        return;
      default:
        this.respond(id, String(command.type ?? 'unknown'), {});
        return;
    }
  }

  private run(text: string): void {
    if (text === '/tool') {
      this.runTool({ id: `call_${++this.nextCall}`, toolName: 'bash', args: { command: 'echo codedeck > file.txt' } });
      return;
    }
    if (text === '/read') {
      this.runTool({ id: `call_${++this.nextCall}`, toolName: 'read', args: { path: 'a.txt' } });
      return;
    }
    if (text === '/edit') {
      // Pi's edit tool's own argument shape (its tool schema in 1.5.2).
      this.runTool({ id: `call_${++this.nextCall}`, toolName: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] } });
      return;
    }
    if (text === '/retry') {
      // Two failed attempts, then the reply.
      this.failedAttempt(1);
      this.failedAttempt(2);
      this.say('recovered', { retried: 2 });
      return;
    }
    if (text === '/give-up') {
      this.failedAttempt(1);
      this.failedAttempt(2);
      this.failedAttempt(3);
      this.attemptError();
      this.emit({ type: 'turn_end', message: {}, toolResults: [] });
      this.emit({ type: 'agent_end', messages: [] });
      this.emit({ type: 'auto_retry_end', success: false, attempt: 3, finalError: RATE_LIMITED });
      this.emit({ type: 'agent_settled', aborted: false });
      return;
    }
    if (text === '/retry-wait') {
      // One failed attempt, then Pi waits before the retry (until aborted).
      this.failedAttempt(1);
      return;
    }
    if (text === '/bad-request') {
      // An error Pi does not retry: settled at once.
      this.emit({ type: 'agent_start' });
      this.attemptError('400: invalid request');
      this.settle(false);
      return;
    }
    this.say(`echo: ${text}`);
  }

  /** One failed request that Pi then retries. */
  private failedAttempt(attempt: number): void {
    if (attempt === 1) this.emit({ type: 'agent_start' });
    this.attemptError();
    this.emit({ type: 'turn_end', message: {}, toolResults: [] });
    this.emit({ type: 'agent_end', messages: [] });
    // Pi retries up to three times, each retry announced before it starts.
    this.emit({ type: 'auto_retry_start', attempt, maxAttempts: 3, delayMs: 2000 * attempt, errorMessage: RATE_LIMITED });
    this.emit({ type: 'agent_start' });
  }

  private attemptError(errorMessage = RATE_LIMITED): void {
    const message = { role: 'assistant', timestamp: Date.now(), content: [], stopReason: 'error', errorMessage };
    this.emit({ type: 'message_start', message });
    this.emit({ type: 'message_end', message });
  }

  private runTool(call: ScriptedCall): void {
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: call.toolName }] } });
    this.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: call.toolName }] } });
    const assistant = {
      role: 'assistant',
      timestamp: Date.now(),
      content: [{ type: 'toolCall', id: call.id, name: call.toolName, arguments: call.args }],
      stopReason: 'toolUse',
    };
    this.emit({ type: 'message_start', message: { ...assistant, content: [], stopReason: 'pending' } });
    this.emit({ type: 'message_end', message: assistant });
    this.emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.toolName, args: call.args });
    const uiId = `ui-${call.id}`;
    this.pendingDialog = { uiId, call };
    this.emit({
      type: 'extension_ui_request',
      id: uiId,
      method: 'select',
      title: `codedeck-permission:${call.id}`,
      options: ['allow', 'deny'],
    });
  }

  private dialogAnswer(response: Record<string, unknown>): void {
    const pending = this.pendingDialog;
    if (!pending || response.id !== pending.uiId) return;
    this.pendingDialog = undefined;
    const value = typeof response.value === 'string' ? response.value : response.cancelled === true ? 'deny' : 'deny';
    this.answers.set(pending.call.id, value);
    if (value === 'allow') {
      this.emit({
        type: 'tool_execution_end',
        toolCallId: pending.call.id,
        toolName: pending.call.toolName,
        result: { content: [{ type: 'text', text: 'ran it' }] },
        isError: false,
        durationMs: 1,
      });
      this.say('tool-finished');
      return;
    }
    this.emit({
      type: 'tool_execution_end',
      toolCallId: pending.call.id,
      toolName: pending.call.toolName,
      result: { content: [{ type: 'text', text: 'Denied by the user' }] },
      isError: true,
    });
    this.say('tool-finished: Denied by the user');
  }

  /** One assistant reply, streamed and then completed, followed by the end of
   *  the run. */
  private say(text: string, options: { retried?: number } = {}): void {
    const timestamp = Date.now();
    this.emit({
      type: 'message_start',
      message: {
        role: 'assistant',
        timestamp,
        content: [],
        stopReason: 'pending',
        provider: this.options.model?.provider,
        model: this.options.model?.id,
      },
    });
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
    this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text } });
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp,
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        provider: this.options.model?.provider,
        model: this.options.model?.id,
      },
    });
    if (options.retried !== undefined) this.emit({ type: 'auto_retry_end', success: true, attempt: options.retried });
    this.settle(false);
  }

  private settle(aborted: boolean): void {
    this.emit({ type: 'turn_start' });
    this.emit({ type: 'turn_end', message: {}, toolResults: [] });
    this.emit({ type: 'agent_end', messages: [] });
    this.emit({ type: 'agent_settled', aborted });
  }
}
