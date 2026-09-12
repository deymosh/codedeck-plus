/**
 * TestModeSdkFacade — proves each /test-* command drives the SAME
 * PermissionBroker a real session would, and that pushInput() ultimately
 * reports back through the message stream.
 */
import { describe, it, expect } from 'vitest';
import { TestModeSdkFacade } from '../testModeFacade';
import { PermissionBroker, type PermissionContext } from '../../session/permissions';
import type { SdkMessage } from '../facade';

function makeBroker(): PermissionBroker {
  return new PermissionBroker({
    onPermissionCard: () => {},
    onQuestionCard: () => {},
    onPlanCard: () => {},
    onAutoModeChange: () => {},
    log: () => {},
  });
}

const ctx = (mode: PermissionContext['permissionMode']): PermissionContext => ({
  sessionId: 's1',
  permissionMode: mode,
});

/** Pull messages off the stream until the turn-ending idle marker, or `max` is hit. */
async function drain(messages: AsyncIterable<SdkMessage>, max = 10): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const msg of messages) {
    out.push(msg);
    if ((msg as { subtype?: string }).subtype === 'session_state_changed') break;
    if (out.length >= max) break;
  }
  return out;
}

function textOf(msgs: SdkMessage[]): string[] {
  return msgs
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => (m as { message: { content: Array<{ type: string; text?: string }> } }).message.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text!);
}

function toolUseOf(msgs: SdkMessage[]): Array<{ name: string; input: Record<string, unknown>; id: string }> {
  return msgs
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => (m as { message: { content: Array<{ type: string; name?: string; input?: unknown; id?: string }> } }).message.content)
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name!, input: b.input as Record<string, unknown>, id: b.id! }));
}

describe('TestModeSdkFacade', () => {
  it('/test-message echoes the given text, or a default', async () => {
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'plan', canUseTool: async () => null,
    });
    handle.pushInput('/test-message hi there');
    expect(textOf(await drain(handle.messages()))).toEqual(['hi there']);

    const handle2 = facade.createSession({
      sessionId: 's2', cwd: '/tmp', permissionMode: 'plan', canUseTool: async () => null,
    });
    handle2.pushInput('/test-message');
    expect(textOf(await drain(handle2.messages()))).toEqual(['hello from Bridge (test-mode)']);
  });

  it('/test-tool asks canUseTool for a real tool and reports the verdict', async () => {
    const broker = makeBroker();
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'default',
      canUseTool: (name, input, opts) => broker.handleCanUseTool(ctx('default'), name, input, opts),
    });
    handle.pushInput('/test-tool');
    const msgs = await drain(handle.messages());
    expect(toolUseOf(msgs)[0]!.name).toBe('Read');
    // permissionMode 'default' is YOLO — the broker auto-allows.
    expect(textOf(msgs)).toEqual(['Read the file — nothing interesting in it.']);
  });

  it('/test-plan drives the real ExitPlanMode flow through to a plan card', async () => {
    const broker = makeBroker();
    const plans: string[] = [];
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'plan',
      canUseTool: (name, input, opts) => broker.handleCanUseTool(ctx('plan'), name, input, opts),
    });
    handle.pushInput('/test-plan');
    const msgs = await drain(handle.messages(), 1); // just the ExitPlanMode tool_use — canUseTool blocks on the card
    const plan = toolUseOf(msgs)[0]!;
    expect(plan.name).toBe('ExitPlanMode');
    plans.push(plan.input.plan as string);
    expect(plans[0]).toContain('Example plan');

    // Approve it — same call a real plan-approval tap makes.
    const toolUseId = broker.findPendingPermission('s1', 'ExitPlanMode')!;
    broker.resolvePermission(toolUseId, true);
    const rest = await drain(handle.messages(), 3);
    expect(textOf(rest)).toEqual(["Plan approved — I'll get started."]);
  });

  it('/test-question resolves through answerQuestion and reports "received X"', async () => {
    const broker = makeBroker();
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'plan',
      canUseTool: (name, input, opts) => broker.handleCanUseTool(ctx('plan'), name, input, opts),
    });
    handle.pushInput('/test-question');
    await drain(handle.messages(), 1); // the AskUserQuestion tool_use

    expect(broker.answerQuestion('s1', { keypress: '2' })).toBe(true); // 'Careful'
    const rest = await drain(handle.messages(), 3);
    expect(textOf(rest)).toEqual(['received Careful']);
  });

  it('/test-question-multiple collects both answers before replying', async () => {
    const broker = makeBroker();
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'plan',
      canUseTool: (name, input, opts) => broker.handleCanUseTool(ctx('plan'), name, input, opts),
    });
    handle.pushInput('/test-question-multiple');
    await drain(handle.messages(), 1);

    expect(broker.answerQuestion('s1', { keypress: '2' })).toBe(true); // 'Rust'
    expect(broker.answerQuestion('s1', { keypress: '1' })).toBe(true); // 'Dev'
    const rest = await drain(handle.messages(), 3);
    expect(textOf(rest)).toEqual(['received Rust, Dev']);
  });

  it('an unrecognized command replies with the command list instead of doing nothing', async () => {
    const facade = new TestModeSdkFacade();
    const handle = facade.createSession({
      sessionId: 's1', cwd: '/tmp', permissionMode: 'plan', canUseTool: async () => null,
    });
    handle.pushInput('/test-nonsense');
    expect(textOf(await drain(handle.messages()))[0]).toContain('unknown command');
  });

  it('supportedModels reports a placeholder model, never empty', async () => {
    const facade = new TestModeSdkFacade();
    expect(await facade.supportedModels()).toEqual([{ id: 'test-mode', label: 'Test Mode' }]);
  });
});
