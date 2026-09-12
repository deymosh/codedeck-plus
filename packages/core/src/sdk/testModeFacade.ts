/**
 * Test-mode `SdkFacade` — `codedeck-bridge run --test-mode`. No real Claude
 * Code subprocess, no API key needed: `pushInput()` recognizes a handful of
 * `/test-*` commands and plays back a canned exchange through the SAME
 * `canUseTool` callback and `SdkMessage` shapes the real SDK produces, so
 * everything downstream (the adapter, the permission broker, the phone UI)
 * runs its real, unmocked code — only the Claude subprocess itself is fake.
 * A command this doesn't recognize gets a plain text reply naming the ones
 * it does, rather than silently doing nothing.
 */
import type {
  SdkContextUsage,
  SdkFacade,
  SdkMessage,
  SdkModelDescriptor,
  SdkSessionHandle,
  SdkSessionOptions,
} from './facade';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${++counter}`;

const HELP =
  'test-mode commands: /test-message [text], /test-tool, /test-plan, ' +
  '/test-question, /test-question-multiple';

class TestModeSession implements SdkSessionHandle {
  private readonly queue: SdkMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  constructor(private readonly opts: SdkSessionOptions) {}

  private push(msg: SdkMessage): void {
    this.queue.push(msg);
    this.wake?.();
  }

  private assistantText(text: string): void {
    this.push({
      type: 'assistant',
      message: {
        id: nextId('msg'),
        type: 'message',
        role: 'assistant',
        model: this.opts.model ?? 'test-mode',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: nextId('uuid'),
      session_id: this.opts.sessionId,
    } as unknown as SdkMessage);
  }

  /** Emits the assistant tool_use block and returns its id (for the matching canUseTool call). */
  private assistantToolUse(name: string, input: Record<string, unknown>): string {
    const id = nextId('tool');
    this.push({
      type: 'assistant',
      message: {
        id: nextId('msg'),
        type: 'message',
        role: 'assistant',
        model: this.opts.model ?? 'test-mode',
        content: [{ type: 'tool_use', id, name, input }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: nextId('uuid'),
      session_id: this.opts.sessionId,
    } as unknown as SdkMessage);
    return id;
  }

  /** The full `CanUseTool` third-argument shape — only `toolUseID` varies per
   *  call, but `signal`/`requestId` are non-optional on the real SDK type. */
  private callOptions(toolUseID: string): Parameters<SdkSessionOptions['canUseTool']>[2] {
    return { signal: new AbortController().signal, toolUseID, requestId: nextId('req') };
  }

  private idle(): void {
    this.push({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: nextId('uuid'),
      session_id: this.opts.sessionId,
    } as unknown as SdkMessage);
  }

  pushInput(text: string): void {
    this.handle(text.trim()).catch(() => this.assistantText('test-mode: internal error handling that command'));
  }

  private async handle(text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd) {
      case '/test-message':
        this.assistantText(rest.join(' ') || 'hello from Bridge (test-mode)');
        break;

      case '/test-tool': {
        const input = { file_path: '/example/test-mode.txt' };
        const id = this.assistantToolUse('Read', input);
        const result = await this.opts.canUseTool('Read', input, this.callOptions(id));
        this.assistantText(
          result?.behavior === 'allow' ? 'Read the file — nothing interesting in it.' : 'Tool call was denied.',
        );
        break;
      }

      case '/test-plan': {
        const plan =
          '## Example plan\n\n1. Do the example thing\n2. Verify it worked\n3. Report back';
        const id = this.assistantToolUse('ExitPlanMode', { plan });
        const result = await this.opts.canUseTool('ExitPlanMode', { plan }, this.callOptions(id));
        this.assistantText(
          result?.behavior === 'allow' ? "Plan approved — I'll get started." : 'Plan rejected — staying in plan mode.',
        );
        break;
      }

      case '/test-question':
      case '/test-question-multiple': {
        const questions =
          cmd === '/test-question'
            ? [
                {
                  question: 'Which approach do you want?',
                  header: 'Approach',
                  options: [{ label: 'Fast' }, { label: 'Careful' }, { label: 'Balanced' }],
                },
              ]
            : [
                {
                  question: 'Which language?',
                  header: 'Language',
                  options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Both' }],
                },
                {
                  question: 'Which environment?',
                  header: 'Env',
                  options: [{ label: 'Dev' }, { label: 'Prod' }],
                },
              ];
        const id = this.assistantToolUse('AskUserQuestion', { questions });
        const result = await this.opts.canUseTool('AskUserQuestion', { questions }, this.callOptions(id));
        const answers = (result as { updatedInput?: { answers?: Record<string, string> } }).updatedInput
          ?.answers ?? {};
        const received = Object.values(answers);
        this.assistantText(received.length > 0 ? `received ${received.join(', ')}` : 'received (no answer)');
        break;
      }

      default:
        this.assistantText(cmd ? `test-mode: unknown command "${cmd}". ${HELP}` : HELP);
    }
    this.idle();
  }

  async *messages(): AsyncIterable<SdkMessage> {
    while (!this.ended) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }

  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async interrupt(): Promise<void> {}
  /** No real subprocess to probe — always "ready" immediately. */
  async probeReady(): Promise<void> {}
  async getContextUsage(): Promise<SdkContextUsage | null> {
    return null;
  }
  async getUsageSnapshot(): Promise<unknown | null> {
    return null;
  }
  async end(): Promise<void> {
    this.ended = true;
    this.wake?.();
  }
}

export class TestModeSdkFacade implements SdkFacade {
  createSession(opts: SdkSessionOptions): SdkSessionHandle {
    return new TestModeSession(opts);
  }
  async supportedModels(): Promise<SdkModelDescriptor[]> {
    return [{ id: 'test-mode', label: 'Test Mode' }];
  }
}
