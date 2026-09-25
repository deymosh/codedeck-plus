/**
 * OpenCodeSession against a fake v2 client: how the session ends (it must
 * never hang), how OpenCode's event stream becomes session events, and how
 * its permission asks and questions reach the bridge.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Event, OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeDriver, toQuestionAnswers } from '../drivers/opencode/driver';
import type { StartSession } from '../types';
import { recordingContext, type Handlers } from './context';

type FakeClient = OpencodeClient & {
  permission: { reply: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
  question: { reply: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> };
};

/** A client whose event stream yields `events`, then stays open briefly so
 *  the ask → reply chains settle before the stream ends. */
function clientWith(events: unknown[]): FakeClient {
  async function* stream(): AsyncGenerator<Event> {
    for (const e of events) yield e as Event;
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    event: { subscribe: vi.fn().mockResolvedValue({ stream: stream() }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
      get: vi.fn(),
      abort: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    },
    permission: {
      reply: vi.fn().mockResolvedValue({ data: true, error: undefined }),
      respond: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    },
    question: {
      reply: vi.fn().mockResolvedValue({ data: true, error: undefined }),
      reject: vi.fn().mockResolvedValue({ data: true, error: undefined }),
    },
  } as unknown as FakeClient;
}

function start(client: FakeClient, overrides: Partial<StartSession> = {}, handlers: Handlers = {}) {
  const ctx = recordingContext(handlers);
  OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp', ...overrides }, ctx);
  return ctx;
}

describe('OpenCode session lifecycle', () => {
  it('reports its conversation id, becomes ready, and ends normally when the stream closes', async () => {
    const ctx = start(clientWith([]));
    expect(await ctx.ended()).toEqual({ type: 'ended' });
    expect(ctx.events).toContainEqual({ type: 'info', nativeSessionId: 'ses_1', mode: 'ask' });
    expect(ctx.events.findIndex((e) => e.type === 'ready')).toBeLessThan(ctx.events.findIndex((e) => e.type === 'ended'));
  });

  it('ends with the error when event.subscribe() rejects before any session exists', async () => {
    const client = clientWith([]);
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection refused'));
    const ctx = start(client);
    expect(await ctx.ended()).toEqual({ type: 'ended', error: 'connection refused' });
    expect(ctx.events.some((e) => e.type === 'ready')).toBe(false);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it('a stream that throws mid-iteration ends with an error, keeping what arrived first', async () => {
    async function* throwingStream(): AsyncGenerator<Event> {
      yield { type: 'session.idle', properties: { sessionID: 'ses_1' } } as unknown as Event;
      throw new Error('connection reset');
    }
    const client = clientWith([]);
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ stream: throwingStream() });
    const ctx = start(client);
    expect(await ctx.ended()).toEqual({ type: 'ended', error: 'connection reset' });
    expect(ctx.entries().some((e) => e.entryType === 'turn_complete')).toBe(true);
  });

  it('a busy status starts a turn and idle ends it', async () => {
    const ctx = start(clientWith([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    ]));
    await ctx.ended();
    expect(ctx.events.filter((e) => e.type === 'turn')).toEqual([
      { type: 'turn', state: 'running' },
      { type: 'turn', state: 'idle' },
    ]);
  });

  it('end() stops the session without reporting it ended', async () => {
    const client = clientWith([]);
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(client).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await ctx.waitFor((e) => e.type === 'ready');
    await session.end();
    await new Promise((r) => setTimeout(r, 40));
    expect(ctx.events.some((e) => e.type === 'ended')).toBe(false);
    expect(client.session.abort).toHaveBeenCalled();
  });
});

describe('OpenCode session.diff', () => {
  const diff = (patch: string) => ({ file: 'a.ts', patch, additions: 1, deletions: 1, status: 'modified' });
  const diffEntries = (ctx: ReturnType<typeof start>) => ctx.entries().filter((e) => e.entryType === 'diff');

  it('shows a changed file once — a repeat of the same diff is not a new card', async () => {
    const ev = (d: unknown) => ({ type: 'session.diff', properties: { sessionID: 'ses_1', diff: [d] } });
    const ctx = start(clientWith([ev(diff('@@ -1 +1 @@\n-x\n+y')), ev(diff('@@ -1 +1 @@\n-x\n+y')), ev(diff('@@ -1 +1 @@\n-x\n+z'))]));
    await ctx.ended();
    expect(diffEntries(ctx)).toHaveLength(2);
  });

  it('drops the session.diff change a completed edit already showed, but not a later change to that file', async () => {
    const edit = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'edit',
          state: {
            status: 'completed', input: { filePath: '/tmp/src/a.ts', oldString: 'x', newString: 'y' },
            output: 'ok', title: 'src/a.ts', metadata: {}, time: { start: 1, end: 2 },
          },
        },
      },
    };
    const ev = (d: unknown) => ({ type: 'session.diff', properties: { sessionID: 'ses_1', diff: [d] } });
    const byEdit = { file: 'src/a.ts', patch: '@@ -1 +1 @@\n-x\n+y', additions: 1, deletions: 1, status: 'modified' };
    const byShell = { file: 'src/a.ts', patch: '@@ -1 +1 @@\n-y\n+w', additions: 1, deletions: 1, status: 'modified' };
    const ctx = start(clientWith([edit, ev(byEdit), ev(byShell)]));
    await ctx.ended();
    // One card from the edit call itself, one from the later shell change.
    expect(diffEntries(ctx).map((e) => e.entryType === 'diff' && e.callId)).toEqual(['call_1', undefined]);
  });
});

describe('OpenCode permission asks', () => {
  const pendingRead = {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'read',
        state: { status: 'pending', input: { filePath: '/etc/hosts' }, raw: '' },
      },
    },
  };
  const ask = {
    type: 'permission.asked',
    properties: {
      id: 'per_1', sessionID: 'ses_1', permission: 'external_directory', patterns: ['/etc/*'],
      metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' },
    },
  };

  it('shows the tool call before the card, and describes the rule being asked about', async () => {
    const client = clientWith([pendingRead, ask]);
    const ctx = start(client);
    await ctx.ended();
    const call = ctx.entries().find((e) => e.entryType === 'tool_call');
    expect(call).toMatchObject({ callId: 'call_1', toolName: 'read', kind: 'read' });
    expect(ctx.permissions).toEqual([
      expect.objectContaining({
        requestId: 'call_1',
        toolName: 'read',
        title: '/etc/hosts',
        description: 'Access outside the project: /etc/*',
        options: [expect.objectContaining({ id: 'allow' }), expect.objectContaining({ id: 'deny' })],
      }),
    ]);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_1', directory: '/tmp', reply: 'reject' });
  });

  it('an allowed ask is replied once', async () => {
    const client = clientWith([pendingRead, ask]);
    const ctx = start(client, {}, { permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
    await ctx.ended();
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_1', directory: '/tmp', reply: 'once' });
  });

  it('the auto-approve mode allows without asking', async () => {
    const client = clientWith([pendingRead, ask]);
    const ctx = start(client, { mode: 'default' });
    await ctx.ended();
    expect(ctx.permissions).toEqual([]);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_1', directory: '/tmp', reply: 'once' });
  });

  it('a test session refuses secret paths even in the auto-approve mode', async () => {
    const secretRead = {
      ...pendingRead,
      properties: { part: { ...pendingRead.properties.part, state: { status: 'pending', input: { filePath: '/w/release.jks' }, raw: '' } } },
    };
    const client = clientWith([secretRead, ask]);
    const ctx = start(client, { mode: 'default', denySecretPaths: true });
    await ctx.ended();
    expect(ctx.permissions).toEqual([]);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_1', directory: '/tmp', reply: 'reject' });
  });

  it('the real running update after the card is not a second tool row', async () => {
    const running = {
      type: 'message.part.updated',
      properties: {
        part: { ...pendingRead.properties.part, state: { status: 'running', input: { filePath: '/etc/hosts' }, time: { start: 1 } } },
      },
    };
    const ctx = start(clientWith([pendingRead, ask, running]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'tool_call')).toHaveLength(1);
  });

  it('asks for a different session are ignored', async () => {
    const ctx = start(clientWith([{ ...ask, properties: { ...ask.properties, sessionID: 'ses_other' } }]));
    await ctx.ended();
    expect(ctx.permissions).toEqual([]);
  });

  it('a legacy permission.updated is answered on the per-session endpoint', async () => {
    const client = clientWith([{
      type: 'permission.updated',
      properties: { id: 'per_2', type: 'edit', sessionID: 'ses_1', title: 'Edit a.ts', metadata: {} },
    }]);
    const ctx = start(client, {}, { permission: () => ({ outcome: 'selected', optionId: 'allow' }) });
    await ctx.ended();
    expect(client.permission.respond).toHaveBeenCalledWith({
      sessionID: 'ses_1', permissionID: 'per_2', directory: '/tmp', response: 'once',
    });
    expect(client.permission.reply).not.toHaveBeenCalled();
  });
});

describe('OpenCode questions', () => {
  const questions = [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
    { question: 'Which sizes?', header: 'Size', multiple: true, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }] },
  ];
  const asked = {
    type: 'question.asked',
    properties: { id: 'que_1', sessionID: 'ses_1', questions, tool: { messageID: 'msg_1', callID: 'call_q' } },
  };

  it('asks the bridge and replies with the answers', async () => {
    const client = clientWith([asked]);
    const ctx = start(client, {}, { question: () => ({ outcome: 'answered', answers: ['Blue', 'S, M'] }) });
    await ctx.ended();
    expect(ctx.questions).toEqual([{
      requestId: 'call_q',
      questions: [
        { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
        { question: 'Which sizes?', header: 'Size', options: [{ label: 'S' }, { label: 'M' }], multiSelect: true },
      ],
    }]);
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'que_1', directory: '/tmp', answers: [['Blue'], ['S', 'M']],
    });
  });

  it('a cancelled question is rejected, never left waiting', async () => {
    const client = clientWith([asked]);
    const ctx = start(client, {}, { question: () => ({ outcome: 'cancelled', reason: 'Timed out' }) });
    await ctx.ended();
    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'que_1', directory: '/tmp' });
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it('the question tool call is not a generic tool row, and neither is its result', async () => {
    const part = (status: string, extra: object) => ({
      type: 'message.part.updated',
      properties: {
        part: { id: 'prt_q', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_q', tool: 'question', state: { status, input: {}, ...extra } },
      },
    });
    const ctx = start(clientWith([part('running', { time: { start: 1 } }), part('completed', { output: 'ok', title: '', metadata: {}, time: { start: 1, end: 2 } })]));
    await ctx.ended();
    expect(ctx.entries().filter((e) => e.entryType === 'tool_call' || e.entryType === 'tool_result')).toEqual([]);
  });

  it('a typed answer to a multi-select question is kept whole', () => {
    expect(toQuestionAnswers(questions, ['Green', 'XL, huge'])).toEqual([['Green'], ['XL, huge']]);
  });
});

describe('OpenCode resume', () => {
  it('a conversation the server no longer has is replaced, with a notice ahead of the start', async () => {
    const client = clientWith([]);
    (client.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: undefined, error: { message: 'not found' } });
    (client.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'ses_new' } as Session, error: undefined });
    const ctx = start(client, { resume: 'ses_gone' });
    await ctx.ended();
    const kinds = ctx.entries().map((e) => e.entryType);
    expect(kinds.indexOf('notice')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('notice')).toBeLessThan(kinds.indexOf('status'));
    expect(ctx.events).toContainEqual(expect.objectContaining({ type: 'info', nativeSessionId: 'ses_new' }));
  });

  it('a conversation the server still has is continued', async () => {
    const client = clientWith([]);
    (client.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'ses_gone' } as Session, error: undefined });
    const ctx = start(client, { resume: 'ses_gone' });
    await ctx.ended();
    expect(ctx.entries().some((e) => e.entryType === 'notice')).toBe(false);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

describe('OpenCode options', () => {
  it('accepts its modes and provider/model ids, refuses effort', async () => {
    const ctx = recordingContext();
    const session = OpenCodeDriver.withClient(clientWith([])).startSession({ sessionId: 's1', agent: 'opencode', cwd: '/tmp' }, ctx);
    await session.setOption('mode', 'default');
    await session.setOption('model', 'anthropic/claude-sonnet-5');
    await expect(session.setOption('mode', 'plan')).rejects.toThrow(/no mode/);
    await expect(session.setOption('model', 'sonnet')).rejects.toThrow(/provider\/model/);
    await expect(session.setOption('effort', 'high')).rejects.toThrow(/no effort/);
    await session.end();
  });
});
