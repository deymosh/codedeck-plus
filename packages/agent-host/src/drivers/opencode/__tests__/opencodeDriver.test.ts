/**
 * OpenCodeSession against a fake v2 client: how the session ends (it must
 * never hang), how OpenCode's event stream becomes session events, and how
 * its permission asks and its question forms reach the bridge.
 *
 * V2's stream is one event per thing that happens, with the payload flat on
 * `data`, and its client answers values (throwing on failure) rather than
 * `{ data, error }` envelopes — both are what these fakes stand in for.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodeDriver, openCodeContext, pickDefaultModel, reasoningLevels, toFormAnswer, toQuestionSpecs } from '../driver';
import type { StartSession } from '../../../sdk/types';
import { PARTIAL_INTERVAL_MS } from '../../../sdk/partial';
import { recordingContext, type Handlers } from '../../../sdk/__tests__/context';

type V2 = Record<string, unknown> & { type: string; data?: Record<string, unknown> };

/** The fake client's calls are mocks; the client type itself is the real
 *  one, so this is how a test scripts one of them. */
const asMock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>;

/** A client whose event stream yields `events`, then stays open briefly so
 *  the ask → reply chains settle before the stream ends. */
function clientWith(events: V2[], over: Record<string, unknown> = {}): OpenCodeClient {
  async function* stream(): AsyncGenerator<V2> {
    for (const e of events) yield e;
    await new Promise((r) => setTimeout(r, 20));
  }
  const client = {
    event: { subscribe: vi.fn(() => stream()) },
    session: {
      create: vi.fn(async () => ({ id: 'ses_1', projectID: 'p', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 }, location: { directory: '/tmp' } })),
      get: vi.fn(),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      switchAgent: vi.fn(async () => undefined),
      switchModel: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      prompt: vi.fn(async () => ({})),
      command: vi.fn(async () => undefined),
      compact: vi.fn(async () => ({})),
      diff: vi.fn(async () => []),
      revert: { stage: vi.fn(async () => ({})), clear: vi.fn(async () => undefined), commit: vi.fn(async () => undefined) },
      form: { reply: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    },
    permission: { reply: vi.fn(async () => undefined) },
    message: { list: vi.fn(async () => ({ data: [], cursor: {} })) },
    command: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    mcp: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    provider: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    model: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })), default: vi.fn(async () => ({ location: { directory: '/tmp' }, data: null })) },
    plugin: { list: vi.fn(async () => ({ location: { directory: '/tmp' }, data: [] })) },
    ...over,
  } as unknown as OpenCodeClient;
  return client;
}

function start(client: OpenCodeClient, overrides: Partial<StartSession> = {}, handlers: Handlers = {}) {
  const ctx = recordingContext(handlers);
  OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp', ...overrides }, ctx);
  return ctx;
}

/** The events v2 sends for one assistant turn: the execution starting, the
 *  model's text, and the turn ending. */
const turn = (text: string, sessionID = 'ses_1'): V2[] => [
  { type: 'session.execution.started', data: { sessionID } },
  { type: 'session.step.started', data: { sessionID, assistantMessageID: 'm1', agent: 'build', model: { providerID: 'opencode', id: 'exo-free' }, started: 0 } },
  { type: 'session.text.ended', data: { sessionID, assistantMessageID: 'm1', ordinal: 0, text } },
  { type: 'session.idle', data: { sessionID } },
];

describe('OpenCode session lifecycle', () => {
  it('reports its conversation id, becomes ready, and ends normally when the stream closes', async () => {
    const ctx = start(clientWith([]));
    expect(await ctx.ended()).toEqual({ type: 'ended' });
    expect(ctx.events).toContainEqual({ type: 'info', nativeSessionId: 'ses_1', mode: 'ask' });
    expect(ctx.events.findIndex((e) => e.type === 'ready')).toBeLessThan(ctx.events.findIndex((e) => e.type === 'ended'));
  });

  it('creates the session on the model and permission ruleset the mode implies', async () => {
    const client = clientWith([]);
    const ctx = start(client);
    await ctx.ended();
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { directory: '/tmp' },
        // Ask mode: v2's own default would allow everything and never ask.
        permissions: [{ action: '*', resource: '*', effect: 'ask' }],
      }),
    );
  });

  it('ends with the error when the stream rejects before any session exists', async () => {
    const client = clientWith([], {
      event: { subscribe: vi.fn(() => { throw new Error('connection refused'); }) },
    });
    const ctx = start(client);
    expect(await ctx.ended()).toEqual({ type: 'ended', error: 'connection refused' });
    expect(ctx.events.some((e) => e.type === 'ready')).toBe(false);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

describe('OpenCode turn reporting', () => {
  it('reports the model text, and the turn running then idle', async () => {
    const ctx = start(clientWith(turn('hello there')));
    await ctx.ended();
    expect(ctx.entries()).toContainEqual(expect.objectContaining({ entryType: 'text', role: 'agent', text: 'hello there' }));
    expect(ctx.events.filter((e) => e.type === 'turn')).toEqual([
      { type: 'turn', state: 'running' },
      { type: 'turn', state: 'idle' },
    ]);
    // `session.idle` also ends the turn, but a turn completes once.
    expect(ctx.entries().filter((e) => e.entryType === 'turn_complete')).toHaveLength(1);
  });

  it('says a provider retry rather than leaving the turn looking slow', async () => {
    const ctx = start(clientWith([
      { type: 'session.status', data: { sessionID: 'ses_1', status: { type: 'retry', attempt: 2, message: 'rate limited', next: Date.now() + 5_000 } } },
    ]));
    await ctx.ended();
    expect(ctx.entries().find((e) => e.entryType === 'status')).toMatchObject({ entryType: 'status' });
  });

  it('reports a failed step as an error, once', async () => {
    const ctx = start(clientWith([
      { type: 'session.step.failed', data: { sessionID: 'ses_1', assistantMessageID: 'm1', error: { type: 'api', message: 'boom' } } },
      { type: 'session.execution.failed', data: { sessionID: 'ses_1', error: { type: 'api', message: 'boom' } } },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'error')).toEqual([expect.objectContaining({ text: 'boom' })]);
  });

  it('ignores another session\'s events', async () => {
    const ctx = start(clientWith(turn('not mine', 'ses_other')));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'text')).toEqual([]);
  });
});

describe('OpenCode session titles', () => {
  it('reports the title OpenCode gives it, each new one once, never the placeholder', async () => {
    const named = (title: string, sessionID = 'ses_1') => ({ type: 'session.renamed', data: { sessionID, title } });
    const ctx = start(clientWith([
      named('New session - 2026-10-08T10:00:00.000Z'),
      named('Fix the login redirect'),
      named('Fix the login redirect'),
      named('Other session', 'ses_other'),
    ]));
    await ctx.ended();
    expect(ctx.events.filter((e) => e.type === 'info' && 'title' in e)).toEqual([{ type: 'info', title: 'Fix the login redirect' }]);
  });
});

describe('OpenCode permissions', () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    type: 'permission.asked',
    data: {
      id: 'per_1',
      sessionID: 'ses_1',
      action: 'shell',
      resources: ['git push origin main'],
      save: ['git push *'],
      source: { type: 'tool', messageID: 'm1', id: 'call_1' },
      ...over,
    },
  });

  it('reaches the bridge as a card, and an allow becomes OpenCode\'s `once`', async () => {
    const client = clientWith([ask()]);
    const ctx = start(client, {}, { permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
    await ctx.ended();
    expect(ctx.permissions[0]).toMatchObject({ toolName: 'shell', kind: 'execute' });
    expect(ctx.permissions[0]!.description).toContain('git push origin main');
    expect(client.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once' });
  });

  it('"always in this project" becomes `always` only when OpenCode offered to save the rule', async () => {
    const client = clientWith([ask()]);
    const ctx = start(client, {}, { permission: () => ({ outcome: 'selected', optionId: 'allow_always' }) });
    await ctx.ended();
    expect(client.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'always' });

    const without = clientWith([ask({ save: [] })]);
    const none = start(without, {}, { permission: () => ({ outcome: 'selected', optionId: 'allow_always' }) });
    await none.ended();
    expect(without.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'reject' });
  });

  it('a deny, and a cancelled card, both reject', async () => {
    const denied = clientWith([ask()]);
    const ctx = start(denied, {}, { permission: () => ({ outcome: 'selected', optionId: 'deny' }) });
    await ctx.ended();
    expect(denied.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'reject' });

    const cancelled = clientWith([ask()]);
    const other = start(cancelled, {}, { permission: () => ({ outcome: 'cancelled', reason: 'timeout' }) });
    await other.ended();
    expect(cancelled.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'reject' });
  });

  it('allows the question tool its own ask, so the form is the only card', async () => {
    // v2's question tool asks permission to ask before it raises the form —
    // the same call id, so a card for it would be answered and then reused as
    // the question's. The form's card is the ask the user acts on.
    const client = clientWith([ask({ action: 'question', resources: ['*'], source: { type: 'tool', messageID: 'm1', id: 'call_q' } })]);
    const ctx = start(client, { mode: 'ask' });
    await ctx.ended();
    expect(ctx.permissions).toEqual([]);
    expect(client.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once' });
  });

  it('the auto-approve mode answers without troubling the phone', async () => {
    const client = clientWith([ask()]);
    const ctx = start(client, { mode: 'default' });
    await ctx.ended();
    expect(ctx.permissions).toEqual([]);
    expect(client.permission.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once' });
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: [{ action: '*', resource: '*', effect: 'allow' }] }),
    );
  });
});

describe('OpenCode question forms', () => {
  const form = {
    type: 'form.created',
    data: {
      form: {
        id: 'frm_1',
        sessionID: 'ses_1',
        title: 'Questions',
        metadata: { kind: 'question', tool: { messageID: 'm1', id: 'call_q' } },
        fields: [
          { key: 'q0', type: 'string', title: 'Which colour?', options: [{ value: 'Red', label: 'Red' }, { value: 'Blue', label: 'Blue' }], custom: true },
        ],
      },
    },
  };

  it('becomes the bridge\'s question card, keyed by the question tool\'s call', async () => {
    const client = clientWith([form]);
    const ctx = start(client, {}, { question: () => ({ outcome: 'answered', answers: [{ type: 'selected', labels: ['Blue'] }] }) });
    await ctx.ended();
    expect(ctx.questions[0]!.requestId).toBe('call_q');
    expect(ctx.questions[0]!.questions[0]!.options?.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(client.session.form.reply).toHaveBeenCalledWith({ sessionID: 'ses_1', formID: 'frm_1', answer: { q0: 'Blue' } });
  });

  it('a card nobody answers cancels the form, so OpenCode never waits', async () => {
    const client = clientWith([form]);
    const ctx = start(client);
    await ctx.ended();
    expect(client.session.form.cancel).toHaveBeenCalledWith({ sessionID: 'ses_1', formID: 'frm_1' });
    expect(client.session.form.reply).not.toHaveBeenCalled();
  });

  it('ignores a form that is not a question', async () => {
    const other = { type: 'form.created', data: { form: { id: 'f2', sessionID: 'ses_1', title: 'Auth', metadata: { kind: 'auth' }, fields: [] } } };
    const ctx = start(clientWith([other]));
    await ctx.ended();
    expect(ctx.questions).toEqual([]);
  });
});

describe('OpenCode sub-agents', () => {
  it('reports a sub-agent the parent left running as a background task', async () => {
    const ctx = start(clientWith([
      { type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', name: 'subagent' } },
      { type: 'session.tool.called', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', input: { agent: 'explore', description: 'find things' }, executed: false } },
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', projectID: 'p', location: { directory: '/tmp' }, slug: 'child', title: 'Child session' } },
      { type: 'session.tool.success', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', content: [{ type: 'text', text: 'started' }], executed: false } },
    ]));
    await ctx.ended();
    expect(ctx.entries().find((e) => e.entryType === 'background_task')).toMatchObject({
      entryType: 'background_task',
      taskId: 'ses_child',
      title: 'find things',
      status: 'running',
      kind: 'agent',
    });
  });

  it('a sub-agent that ran to completion inside its call is not reported as a task', async () => {
    const ctx = start(clientWith([
      { type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', name: 'subagent' } },
      { type: 'session.tool.called', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', input: { agent: 'explore', description: 'find things' }, executed: false } },
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', projectID: 'p', location: { directory: '/tmp' }, slug: 'child', title: 'Child session' } },
      // The child finishes before the call that started it returns.
      { type: 'session.idle', data: { sessionID: 'ses_child' } },
      { type: 'session.tool.success', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', content: [{ type: 'text', text: 'done' }], executed: false } },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'background_task')).toEqual([]);
  });

  it("a failing sub-agent ends its own task, not the session's turn", async () => {
    const ctx = start(clientWith([
      { type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', name: 'subagent' } },
      { type: 'session.tool.called', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', input: { agent: 'explore', description: 'find things' }, executed: false } },
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', projectID: 'p', location: { directory: '/tmp' }, slug: 'child', title: 'Child session' } },
      { type: 'session.tool.success', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', content: [{ type: 'text', text: 'running' }], executed: false } },
      { type: 'session.execution.failed', data: { sessionID: 'ses_child', error: { type: 'api', message: 'child blew up' } } },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'background_task').at(-1)).toMatchObject({
      taskId: 'ses_child',
      status: 'failed',
    });
    // The sub-agent's failure is not the session's error.
    expect(ctx.entries().filter((e) => e.entryType === 'error')).toEqual([]);
  });
});

describe('OpenCode usage', () => {
  it("is the session's cost, none for a free session", async () => {
    const client = clientWith([]);
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    asMock(client.session.get).mockResolvedValue({ id: 'ses_1', cost: 0.0371 });
    expect(await session.getUsage!()).toMatchObject({ available: true, windows: [], sessionCostUsd: 0.0371 });
    asMock(client.session.get).mockResolvedValue({ id: 'ses_1', cost: 0 });
    expect(await session.getUsage!()).not.toHaveProperty('sessionCostUsd');
    expect(OpenCodeDriver.withClient(client).info().supports?.usage).toBe(true);
    await session.end();
  });

  const tokens = { input: 500, output: 100, reasoning: 0, cache: { read: 400, write: 0 } };
  const modelsWith = (limit: number) => ({
    model: {
      default: vi.fn(async () => ({ location: { directory: '/tmp' }, data: null })),
      list: vi.fn(async () => ({
        location: { directory: '/tmp' },
        data: [{ id: 'm1', modelID: 'm1', providerID: 'zen', name: 'M1', enabled: true, status: 'active', cost: [], variants: [], limit: { context: limit, output: 100 } }],
      })),
    },
  });

  it('reports how full the context is, over the window of the model that ran the step', async () => {
    const ctx = start(clientWith([
      { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'zen', id: 'm1' }, started: 0 } },
      { type: 'session.step.ended', data: { sessionID: 'ses_1', assistantMessageID: 'm1', finish: 'stop', cost: 0, tokens } },
    ], modelsWith(1_000)));
    await ctx.ended();
    // Everything the step read and wrote: 500 + 100 + 0 + 400 + 0.
    expect(ctx.events.find((e) => e.type === 'info' && 'contextPercentage' in e)).toMatchObject({
      type: 'info',
      contextPercentage: 100,
      contextWindow: 1_000,
    });
  });

  it('says nothing for a model whose provider declares no window', async () => {
    const ctx = start(clientWith([
      { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'zen', id: 'm1' }, started: 0 } },
      { type: 'session.step.ended', data: { sessionID: 'ses_1', assistantMessageID: 'm1', finish: 'stop', cost: 0, tokens } },
    ], modelsWith(0)));
    await ctx.ended();
    expect(ctx.events.filter((e) => e.type === 'info' && 'contextPercentage' in e)).toEqual([]);
  });

  it('carries the context into the usage it reports', async () => {
    const client = clientWith([
      { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'zen', id: 'm1' }, started: 0 } },
      { type: 'session.step.ended', data: { sessionID: 'ses_1', assistantMessageID: 'm1', finish: 'stop', cost: 0.02, tokens } },
    ], modelsWith(1_000));
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await ctx.waitFor((e) => e.type === 'info' && 'contextPercentage' in e);
    asMock(client.session.get).mockResolvedValue({ id: 'ses_1', cost: 0.02 });
    const usage = await session.getUsage!();
    expect(usage?.context?.usedTokens).toBe(1_000);
    expect(usage?.context?.windowTokens).toBe(1_000);
    await session.end();
  });

  it('measures the step, not the session totals the server reports beside it', async () => {
    // `session.usage.updated` carries the session's running totals — every
    // step, title and compaction it has ever paid for — and arrives right
    // after each step's own counters. Measuring the context from those pins
    // the meter at 100 % on a session whose context is barely used, and the
    // model keeps working, which is what the phone must never be told.
    const step = { input: 200, output: 50, reasoning: 0, cache: { read: 300, write: 0 } };
    const sessionTotals = { input: 9_000, output: 2_000, reasoning: 500, cache: { read: 12_000, write: 0 } };
    const client = clientWith([
      { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'zen', id: 'm1' }, started: 0 } },
      { type: 'session.step.ended', data: { sessionID: 'ses_1', assistantMessageID: 'm1', finish: 'stop', cost: 0, tokens: step } },
      { type: 'session.usage.updated', data: { sessionID: 'ses_1', cost: 0.5, tokens: sessionTotals } },
    ], modelsWith(1_000));
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await ctx.waitFor((e) => e.type === 'info' && 'contextPercentage' in e);
    // The step's own counters: 200 + 50 + 0 + 300 + 0.
    expect(ctx.events.filter((e) => e.type === 'info' && 'contextPercentage' in e)).toEqual([
      { type: 'info', contextPercentage: 55, contextWindow: 1_000 },
    ]);
    asMock(client.session.get).mockResolvedValue({ id: 'ses_1', cost: 0.5 });
    const usage = await session.getUsage!();
    expect(usage?.context?.usedTokens).toBe(550);
    await session.end();
  });

  it('a sub-agent step does not move the context meter', async () => {
    // A child session's step counters are its own; the meter measures this
    // session, and a sub-agent's step must not stand in for it.
    const client = clientWith([
      { type: 'session.tool.input.started', data: { sessionID: 'ses_1', id: 'call_1', name: 'subagent' } },
      { type: 'session.tool.called', data: { sessionID: 'ses_1', id: 'call_1', input: { prompt: 'look around', agent: 'explore' } } },
      { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', title: 'Child session' } },
      { type: 'session.step.started', data: { sessionID: 'ses_child', assistantMessageID: 'm2', agent: 'explore', model: { providerID: 'zen', id: 'm1' }, started: 0 } },
      { type: 'session.step.ended', data: { sessionID: 'ses_child', assistantMessageID: 'm2', finish: 'stop', cost: 0, tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 900, write: 0 } } } },
    ], modelsWith(1_000));
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await ctx.ended();
    expect(ctx.events.filter((e) => e.type === 'info' && 'contextPercentage' in e)).toEqual([]);
    asMock(client.session.get).mockResolvedValue({ id: 'ses_1', cost: 0 });
    expect((await session.getUsage!())?.context).toBeUndefined();
  });
});

describe('OpenCode compaction', () => {
  const stepStarted = { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'zen', id: 'm1' }, started: 0 } };

  it('says an automatic compaction happened, and that it made room', async () => {
    // Nothing else would tell the phone: the transcript keeps the turns the
    // summary replaced, and the context meter simply drops at the next step.
    const ctx = start(clientWith([
      stepStarted,
      { type: 'session.compaction.started', data: { sessionID: 'ses_1', reason: 'auto', recent: '' } },
      { type: 'session.compaction.delta', data: { sessionID: 'ses_1', text: '## Objective' } },
      { type: 'session.compaction.ended', data: { sessionID: 'ses_1', reason: 'auto', model: { providerID: 'zen', id: 'm1' }, text: '## Objective\n- x', recent: '', cost: 0 } },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'status').map((e) => (e as { text: string }).text)).toEqual([
      'OpenCode session started',
      'OpenCode is compacting the conversation to make room in the context.',
      'Compacted the conversation to make room: OpenCode continues from a summary of it.',
    ]);
  });

  it('says a compaction the user asked for by name only once it is done', async () => {
    // The `/compact` built-in already put its own line in the transcript; the
    // driver adds the outcome, which is the part the built-in cannot know.
    const ctx = start(clientWith([
      stepStarted,
      { type: 'session.compaction.started', data: { sessionID: 'ses_1', reason: 'manual', recent: '', inputID: 'msg_9' } },
      { type: 'session.compaction.ended', data: { sessionID: 'ses_1', reason: 'manual', model: { providerID: 'zen', id: 'm1' }, text: '## Objective\n- x', recent: '', cost: 0 } },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'status').map((e) => (e as { text: string }).text)).toEqual([
      'OpenCode session started',
      'Compacted the conversation: OpenCode continues from a summary of it.',
    ]);
  });

  it('reports a compaction that failed', async () => {
    const ctx = start(clientWith([
      stepStarted,
      {
        type: 'session.compaction.failed',
        data: { sessionID: 'ses_1', reason: 'manual', inputID: 'msg_9', error: { type: 'compaction.failed', message: 'Nothing to compact yet' } },
      },
    ]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'error').map((e) => (e as { text: string }).text)).toEqual([
      'OpenCode could not compact the conversation: Nothing to compact yet',
    ]);
  });
});

describe('OpenCode conversation delete', () => {
  it('deletes the session on the server', async () => {
    const client = clientWith([]);
    await OpenCodeDriver.withClient(client).deleteConversation('ses_1', '/w');
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_1' });
  });

  it('a session the server no longer knows is already deleted; another error is not', async () => {
    const gone = clientWith([]);
    asMock(gone.session.remove).mockRejectedValue({ name: 'SessionNotFoundError', message: 'gone' });
    await expect(OpenCodeDriver.withClient(gone).deleteConversation('ses_1', '/w')).resolves.toBeUndefined();

    const failed = clientWith([]);
    asMock(failed.session.remove).mockRejectedValue({ name: 'InvalidRequestError', message: 'nope' });
    await expect(OpenCodeDriver.withClient(failed).deleteConversation('ses_1', '/w')).rejects.toThrow(/could not delete session ses_1/);
  });
});

describe('OpenCode modes, models and effort', () => {
  const over = {
    model: {
      default: vi.fn(async () => ({ location: { directory: '/tmp' }, data: null })),
      list: vi.fn(async () => ({
        location: { directory: '/tmp' },
        data: [
          { id: 'm', modelID: 'm', providerID: 'ccr', name: 'M', enabled: true, status: 'active', cost: [], variants: [{ id: 'low' }, { id: 'high' }], limit: { context: 1000, output: 100 } },
        ],
      })),
    },
  };

  it('switches the session model, carrying the reasoning variant', async () => {
    const client = clientWith([], over);
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await session.setOption!('model', 'ccr/m');
    expect(client.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'ccr', id: 'm' } });
    await session.setOption!('effort', 'high');
    expect(client.session.switchModel).toHaveBeenLastCalledWith({ sessionID: 'ses_1', model: { providerID: 'ccr', id: 'm', variant: 'high' } });
    await session.end();
  });

  it('switches the session agent and its permission ruleset with the mode', async () => {
    const client = clientWith([]);
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await session.setOption!('mode', 'plan');
    expect(client.session.switchAgent).toHaveBeenCalledWith({ sessionID: 'ses_1', agent: 'plan' });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: 'ses_1', permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    await session.setOption!('mode', 'default');
    expect(client.session.update).toHaveBeenLastCalledWith({ sessionID: 'ses_1', permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    await session.end();
  });

  it('refuses a mode, a model and an effort the model does not offer', async () => {
    const client = clientWith([], over);
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await expect(session.setOption!('mode', 'nonsense')).rejects.toThrow(/no mode 'nonsense'/);
    await expect(session.setOption!('model', 'nope')).rejects.toThrow(/not an OpenCode provider\/model id/);
    await expect(session.setOption!('effort', 'nope')).rejects.toThrow(/reasoning level/);
    await session.end();
  });
});

describe('the pure helpers', () => {
  it('reads a model id into provider and model halves', () => {
    expect(pickDefaultModel(undefined, [])).toBeUndefined();
    expect(reasoningLevels([{ id: 'low' }, { id: 'high' }]).map((l) => l.id)).toEqual(['default', 'low', 'high']);
    expect(reasoningLevels([])).toEqual([]);
  });
  it('breaks a context window into what it holds', () => {
    const window = openCodeContext({ input: 100, output: 50, reasoning: 25, cache: { read: 1000, write: 5 } }, 10_000);
    expect(window?.usedTokens).toBe(1180);
    expect(window?.categories?.at(-1)).toEqual({ name: 'Free space', tokens: 8_820, kind: 'free' });
    expect(openCodeContext({ input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, undefined)).toBeUndefined();
  });

  it('reads a question into the wire shape, and the answers back into the form\'s own', () => {
    const fields = [{ key: 'q0', type: 'string', title: 'Which?', options: [{ value: 'a', label: 'A' }], custom: true }];
    expect(toQuestionSpecs(fields)).toEqual([{ question: 'Which?', options: [{ label: 'A' }] }]);
    expect(toFormAnswer(fields, [{ type: 'selected', labels: ['A'] }])).toEqual({ q0: 'A' });
    expect(toFormAnswer(fields, [{ type: 'text', text: 'mine' }])).toEqual({ q0: 'mine' });
    const multi = [{ key: 'q1', type: 'multiselect', title: 'Which ones?', options: [] }];
    expect(toQuestionSpecs(multi)[0]!.multiSelect).toBe(true);
    expect(toFormAnswer(multi, [{ type: 'selected', labels: ['A', 'B'] }])).toEqual({ q1: ['A', 'B'] });
  });
});

describe('OpenCode live reply text', () => {
  // Longer than one coalescing interval, so a held part would have been sent.
  const pastOneTick = () => new Promise((resolve) => setTimeout(resolve, PARTIAL_INTERVAL_MS + 150));
  const executionStarted = { type: 'session.execution.started', data: { sessionID: 'ses_1' } };
  const stepStarted = { type: 'session.step.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', agent: 'build', model: { providerID: 'opencode', id: 'exo-free' }, started: 0 } };

  /** A client whose stream yields `before`, waits for the returned release,
   *  then yields `after` — so a test can hold a turn open across a tick. */
  function gatedClient(before: V2[], after: V2[]): { client: OpenCodeClient; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* stream(): AsyncGenerator<V2> {
      for (const e of before) yield e;
      await gate;
      for (const e of after) yield e;
    }
    const client = clientWith([], { event: { subscribe: vi.fn(() => stream()) } });
    return { client, release };
  }

  it('coalesces reply deltas into partials, and the completed text names its part', async () => {
    const { client, release } = gatedClient(
      [
        executionStarted,
        stepStarted,
        { type: 'session.text.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0 } },
        { type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0, delta: 'Hel' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0, delta: 'lo' } },
      ],
      [
        { type: 'session.text.ended', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0, text: 'Hello' } },
        { type: 'session.idle', data: { sessionID: 'ses_1' } },
      ],
    );
    const ctx = start(client);
    await ctx.waitFor((e) => e.type === 'partial');
    // One event for the tick's whole text, not one per delta.
    expect(ctx.events.filter((e) => e.type === 'partial')).toEqual([
      { type: 'partial', key: 'm1:0', entryType: 'text', offset: 0, text: 'Hello' },
    ]);

    release();
    await ctx.waitFor((e) => e.type === 'entries' && e.entries.some((x) => x.entryType === 'text'));
    expect(ctx.entries().find((e) => e.entryType === 'text')).toMatchObject({ text: 'Hello', part: 'm1:0' });
  });

  it('streams no reasoning and no sub-agent text', async () => {
    const { client, release } = gatedClient(
      [
        executionStarted,
        stepStarted,
        { type: 'session.reasoning.delta', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0, delta: 'hmm' } },
        { type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', name: 'subagent' } },
        { type: 'session.tool.called', data: { sessionID: 'ses_1', assistantMessageID: 'm1', id: 'call_s', input: { agent: 'explore', description: 'find things' }, executed: false } },
        { type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_1', projectID: 'p', location: { directory: '/tmp' }, slug: 'child', title: 'Child session' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_child', assistantMessageID: 'm2', ordinal: 0, delta: 'inner' } },
      ],
      [{ type: 'session.idle', data: { sessionID: 'ses_1' } }],
    );
    const ctx = start(client);
    await ctx.waitFor((e) => e.type === 'ready');
    // A tick passes with the turn still open: a streamed part would be sent.
    await pastOneTick();
    expect(ctx.events.filter((e) => e.type === 'partial')).toEqual([]);
    release();
    await ctx.ended();
  });

  it('drops reply text a turn end caught before its interval elapsed', async () => {
    const { client, release } = gatedClient(
      [
        executionStarted,
        stepStarted,
        { type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'm1', ordinal: 0, delta: 'late' } },
      ],
      [{ type: 'session.idle', data: { sessionID: 'ses_1' } }],
    );
    const ctx = start(client);
    await ctx.waitFor((e) => e.type === 'ready');
    // The delta is held, then the turn ends before the interval elapses.
    await new Promise((resolve) => setTimeout(resolve, 80));
    release();
    await ctx.waitFor((e) => e.type === 'turn' && e.state === 'idle');
    await pastOneTick();
    expect(ctx.events.filter((e) => e.type === 'partial')).toEqual([]);
  });
});
