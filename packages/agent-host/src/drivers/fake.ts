/**
 * A scripted agent for tests — no SDK, no network, deterministic. Enabled
 * with `CODEDECK_AGENT_HOST_DRIVERS=fake`. Each prompt is a command:
 *
 *   permission <title>   ask to allow a tool call, then report the choice
 *   question             ask one multiple-choice question, report the answer
 *   plan                 propose a plan and ask for approval; an approving
 *                        option switches the session to that mode
 *   tool <name> <json>   call a host tool and report its result
 *   crash                end with an error
 *   exit                 end normally
 *   anything else        echoed back
 *
 * Starting with `resume: "lost"` ends at once with `resumeLost`, like an
 * agent whose conversation is gone.
 */
import type { Driver, DriverSession, SessionContext } from '../driver';
import { now, PERMISSION_ALLOW, PERMISSION_DENY } from '../tools';
import type { AgentInfo, OutputEntry, SessionOption, StartSession, UsageData } from '../types';

export const FAKE_AGENT_ID = 'fake';

const MODES = [
  { id: 'default', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'auto', label: 'Auto' },
];

class FakeSession implements DriverSession {
  private turn = 0;
  private ended = false;
  private mode: string;

  constructor(private readonly ctx: SessionContext, params: StartSession) {
    this.mode = params.mode ?? 'default';
    if (params.resume === 'lost') {
      queueMicrotask(() => this.finish('the conversation to resume is gone', true));
      return;
    }
    ctx.emit({
      type: 'info',
      nativeSessionId: params.resume ?? `fake-${ctx.sessionId}`,
      model: params.model ?? 'fake-model',
      mode: this.mode,
    });
    ctx.emit({ type: 'ready' });
  }

  prompt(text: string): void {
    if (this.ended) return;
    void this.run(text.trim()).catch((err) => this.finish(String(err)));
  }

  private async run(text: string): Promise<void> {
    const turn = ++this.turn;
    this.ctx.emit({ type: 'turn', state: 'running' });
    const [command, ...rest] = text.split(' ');
    const arg = rest.join(' ');
    switch (command) {
      case 'permission': {
        const outcome = await this.ctx.requestPermission({
          requestId: `perm-${turn}`,
          toolName: 'Bash',
          kind: 'execute',
          title: arg || 'echo hi',
          locations: [],
          rawInput: { command: arg || 'echo hi' },
          options: [PERMISSION_ALLOW, PERMISSION_DENY],
        });
        this.say(outcome.outcome === 'selected' ? `permission: ${outcome.optionId}` : `permission cancelled: ${outcome.reason}`);
        break;
      }
      case 'question': {
        const outcome = await this.ctx.askQuestion(`question-${turn}`, [
          { header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
        ]);
        this.say(outcome.outcome === 'answered' ? `answer: ${outcome.answers.join(' | ')}` : `question cancelled: ${outcome.reason}`);
        break;
      }
      case 'plan': {
        this.entries([{ timestamp: now(), entryType: 'plan', text: '1. Do the thing\n2. Check it' }]);
        const outcome = await this.ctx.requestPlanApproval(`plan-${turn}`, [
          { id: 'auto', label: 'Approve' },
          { id: 'revise', label: 'Keep planning' },
        ]);
        if (outcome.outcome === 'selected' && outcome.optionId !== 'revise') {
          this.mode = outcome.optionId;
          this.ctx.emit({ type: 'info', mode: this.mode });
        }
        this.say(outcome.outcome === 'selected' ? `plan: ${outcome.optionId}` : `plan cancelled: ${outcome.reason}`);
        break;
      }
      case 'tool': {
        const [name, ...json] = rest;
        const args = json.length > 0 ? (JSON.parse(json.join(' ')) as Record<string, unknown>) : {};
        const result = await this.ctx.callHostTool(name ?? '', args);
        this.say(`tool ${name}: ${result.isError ? 'error: ' : ''}${result.text}`);
        break;
      }
      case 'crash':
        this.finish('fake crash');
        return;
      case 'exit':
        this.finish();
        return;
      default:
        this.say(`echo: ${text}`);
    }
    if (this.ended) return;
    this.entries([{ timestamp: now(), entryType: 'turn_complete' }]);
    this.ctx.emit({ type: 'turn', state: 'idle' });
  }

  private say(text: string): void {
    this.entries([{ timestamp: now(), entryType: 'text', role: 'agent', text }]);
  }

  private entries(entries: OutputEntry[]): void {
    if (!this.ended) this.ctx.emit({ type: 'entries', entries });
  }

  private finish(error?: string, resumeLost = false): void {
    if (this.ended) return;
    this.ended = true;
    this.ctx.emit({ type: 'ended', ...(error ? { error } : {}), ...(resumeLost ? { resumeLost } : {}) });
  }

  async interrupt(): Promise<void> {}

  async setOption(option: SessionOption, value: string): Promise<void> {
    if (value === 'invalid') throw new Error(`the fake agent refuses ${option} '${value}'`);
    if (option === 'mode') this.mode = value;
  }

  async getUsage(): Promise<UsageData | null> {
    return { available: true, windows: [{ label: '5h', utilization: 10, resetsAt: null }], fetchedAt: now() };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

export class FakeDriver implements Driver {
  info(): AgentInfo {
    return {
      id: FAKE_AGENT_ID,
      displayName: 'Fake agent',
      modes: MODES,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      defaultMode: 'default',
      supports: { models: true, usage: true, providers: false, gsd: false, interrupt: true },
      credentials: [{ id: 'fake_token', label: 'Fake token', envVar: 'FAKE_AGENT_TOKEN' }],
    };
  }

  startSession(params: StartSession, ctx: SessionContext): DriverSession {
    if (params.cwd === '') throw new Error('the fake agent needs a working directory');
    return new FakeSession(ctx, params);
  }

  async listModels() {
    return {
      models: [{ id: 'fake-model', label: 'Fake model' }, { id: 'fake-large' }],
      defaultModel: 'fake-model',
    };
  }

  async checkCredential(_credential: string, value: string): Promise<boolean | undefined> {
    if (value === 'valid') return true;
    if (value === 'invalid') return false;
    return undefined;
  }
}
