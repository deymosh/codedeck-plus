/**
 * OpenCodeSessionHandle against a fake v2 client: message-queue close/error
 * semantics (the runner must never hang on messages()), and how OpenCode's
 * permission asks, questions and diffs reach the runner.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Event, OpencodeClient, Session } from '@opencode-ai/sdk/v2/client';

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { OpenCodeFacade, toQuestionAnswers } from '../sdk/opencodeFacade';
import type { SdkMessage, SdkSessionOptions } from '../sdk/facade';

function baseOpts(): SdkSessionOptions {
  return {
    sessionId: 's1',
    cwd: '/tmp',
    permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'allow' }),
  } as SdkSessionOptions;
}

/** Fails the test (rather than hanging the suite) if the queue never closes. */
async function collectWithTimeout(iterable: AsyncIterable<SdkMessage>, timeoutMs = 2000): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out — message queue never closed')), timeoutMs);
  });
  const drain = (async () => {
    for await (const item of iterable) out.push(item);
    return out;
  })();
  try {
    return await Promise.race([drain, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

type FakeClient = OpencodeClient & {
  permission: { reply: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
  question: { reply: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> };
};

/** A client whose event stream yields `events`, then stays open briefly so
 *  the canUseTool → reply promise chains settle before the queue closes. */
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

function start(client: FakeClient, overrides: Partial<SdkSessionOptions> = {}) {
  vi.mocked(createOpencodeClient).mockReturnValue(client);
  return new OpenCodeFacade({ baseUrl: 'http://fake' }).createSession({ ...baseOpts(), ...overrides });
}

const typeOf = (m: SdkMessage) => (m as { type?: string }).type;

describe('OpenCodeFacade message-queue close', () => {
  it('closes the queue when the event stream ends gracefully (no throw)', async () => {
    const handle = start(clientWith([]));
    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => typeOf(m) === 'system')).toBe(true);
  });

  it('closes the queue when event.subscribe() rejects before any session exists', async () => {
    const client = clientWith([]);
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection refused'));
    const handle = start(client);

    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => typeOf(m) === 'opencode-error')).toBe(true);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

describe('OpenCodeFacade stream error propagation (up-to-2-restarts parity)', () => {
  it('a stream that throws mid-iteration makes messages() reject, not end cleanly', async () => {
    async function* throwingStream(): AsyncGenerator<Event> {
      // A real event first, so the queue has something to yield before the
      // error — asserts partial output survives, same as a real network blip.
      yield { type: 'session.idle', properties: { sessionID: 'ses_1' } } as unknown as Event;
      throw new Error('connection reset');
    }
    const client = clientWith([]);
    (client.event.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ stream: throwingStream() });
    const handle = start(client);

    const seen: SdkMessage[] = [];
    await expect(
      (async () => {
        for await (const msg of handle.messages()) seen.push(msg);
      })(),
    ).rejects.toThrow('connection reset');
    // The idle event that arrived before the throw was not lost.
    expect(seen.some((m) => (m as unknown as { subtype?: string }).subtype === 'session_state_changed')).toBe(true);
  });
});

describe('OpenCodeFacade session.status → running/idle transitions', () => {
  it('a busy status pushes session_state_changed running', async () => {
    const handle = start(clientWith([
      { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    ]));
    const messages = await collectWithTimeout(handle.messages());
    const state = messages.find((m) => (m as unknown as { subtype?: string }).subtype === 'session_state_changed') as
      | { state?: string }
      | undefined;
    expect(state?.state).toBe('running');
  });
});

describe('OpenCodeFacade session.diff', () => {
  const diff = (patch: string) => ({ file: 'a.ts', patch, additions: 1, deletions: 1, status: 'modified' });

  it('pushes a changed file once — a repeat of the same diff is not a new card', async () => {
    const first = diff('@@ -1 +1 @@\n-x\n+y');
    const second = diff('@@ -1 +1 @@\n-x\n+z');
    const ev = (d: unknown) => ({ type: 'session.diff', properties: { sessionID: 'ses_1', diff: [d] } });
    const handle = start(clientWith([ev(first), ev(first), ev(second)]));
    const diffs = (await collectWithTimeout(handle.messages())).filter((m) => typeOf(m) === 'opencode-diff') as unknown as Array<{
      files: unknown[];
    }>;
    expect(diffs.map((d) => d.files)).toEqual([[first], [second]]);
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
    const byEdit = { file: 'src/a.ts', additions: 1, deletions: 1, status: 'modified' };
    const byShell = { file: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' };
    const handle = start(clientWith([edit, ev(byEdit), ev(byShell)]));
    const diffs = (await collectWithTimeout(handle.messages())).filter((m) => typeOf(m) === 'opencode-diff') as unknown as Array<{
      files: unknown[];
    }>;
    expect(diffs.map((d) => d.files)).toEqual([[byShell]]);
  });
});

describe('OpenCodeFacade permission asks', () => {
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

  it('shows the tool call before the card, and labels the card with that tool', async () => {
    const client = clientWith([pendingRead, ask]);
    const order: string[] = [];
    const canUseTool = vi.fn(async () => {
      order.push('card');
      return { behavior: 'deny' as const, message: 'no' };
    });
    const handle = start(client, { canUseTool });
    const messages = await collectWithTimeout(handle.messages());

    const call = messages.find((m) => typeOf(m) === 'opencode-part') as unknown as {
      part: { tool: string; state: { status: string; input: unknown } };
    };
    expect(call.part.tool).toBe('read');
    expect(call.part.state).toMatchObject({ status: 'running', input: { filePath: '/etc/hosts' } });
    expect(canUseTool).toHaveBeenCalledWith(
      'read',
      { filePath: '/etc/hosts' },
      expect.objectContaining({
        toolUseID: 'call_1',
        requestId: 'per_1',
        description: 'Access outside the project: /etc/*',
      }),
    );
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_1', directory: '/tmp', reply: 'reject' });
    expect(client.permission.respond).not.toHaveBeenCalled();
  });

  it('the real running update after approval is not a second tool row', async () => {
    const running = {
      type: 'message.part.updated',
      properties: {
        part: { ...pendingRead.properties.part, state: { status: 'running', input: { filePath: '/etc/hosts' }, time: { start: 1 } } },
      },
    };
    const handle = start(clientWith([pendingRead, ask, running]));
    const parts = (await collectWithTimeout(handle.messages())).filter((m) => typeOf(m) === 'opencode-part');
    expect(parts).toHaveLength(1);
  });

  it('asks for a different session are ignored', async () => {
    const client = clientWith([{ ...ask, properties: { ...ask.properties, sessionID: 'ses_other' } }]);
    const canUseTool = vi.fn();
    const handle = start(client, { canUseTool });
    await collectWithTimeout(handle.messages());
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('a legacy permission.updated is answered on the per-session endpoint', async () => {
    const client = clientWith([{
      type: 'permission.updated',
      properties: { id: 'per_2', type: 'edit', sessionID: 'ses_1', title: 'Edit a.ts', metadata: {} },
    }]);
    const handle = start(client);
    await collectWithTimeout(handle.messages());
    expect(client.permission.respond).toHaveBeenCalledWith({
      sessionID: 'ses_1', permissionID: 'per_2', directory: '/tmp', response: 'once',
    });
    expect(client.permission.reply).not.toHaveBeenCalled();
  });
});

describe('OpenCodeFacade questions', () => {
  const questions = [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
    { question: 'Which sizes?', header: 'Size', multiple: true, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }] },
  ];
  const asked = {
    type: 'question.asked',
    properties: { id: 'que_1', sessionID: 'ses_1', questions, tool: { messageID: 'msg_1', callID: 'call_q' } },
  };

  it('renders a question card and replies with the answers', async () => {
    const client = clientWith([asked]);
    const canUseTool = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: { answers: { 'Which color?': 'Blue', 'Which sizes?': 'S, M' } },
    }));
    const handle = start(client, { canUseTool });
    const messages = await collectWithTimeout(handle.messages());

    const card = messages.find((m) => typeOf(m) === 'opencode-question') as unknown as {
      toolUseId: string;
      questions: Array<{ question: string; multiSelect: boolean }>;
    };
    expect(card.toolUseId).toBe('call_q');
    expect(card.questions.map((q) => q.multiSelect)).toEqual([false, true]);
    expect(canUseTool).toHaveBeenCalledWith(
      'AskUserQuestion',
      { questions: card.questions },
      expect.objectContaining({ toolUseID: 'call_q', requestId: 'que_1' }),
    );
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: 'que_1', directory: '/tmp', answers: [['Blue'], ['S', 'M']],
    });
  });

  it('a denied or timed-out question is rejected, never left waiting', async () => {
    const client = clientWith([asked]);
    const handle = start(client, { canUseTool: vi.fn(async () => ({ behavior: 'deny' as const, message: 'timed out' })) });
    await collectWithTimeout(handle.messages());
    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'que_1', directory: '/tmp' });
    expect(client.question.reply).not.toHaveBeenCalled();
  });

  it('the question tool call is not a generic tool row; its result still arrives', async () => {
    const part = (status: string, extra: object) => ({
      type: 'message.part.updated',
      properties: {
        part: { id: 'prt_q', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_q', tool: 'question', state: { status, input: {}, ...extra } },
      },
    });
    const handle = start(clientWith([part('running', { time: { start: 1 } }), part('completed', { output: 'ok', title: '', metadata: {}, time: { start: 1, end: 2 } })]));
    const parts = (await collectWithTimeout(handle.messages())).filter((m) => typeOf(m) === 'opencode-part') as unknown as Array<{
      part: { state: { status: string } };
    }>;
    expect(parts.map((p) => p.part.state.status)).toEqual(['completed']);
  });

  it('a typed answer to a multi-select question is kept whole', () => {
    expect(toQuestionAnswers(questions, { 'Which color?': 'Green', 'Which sizes?': 'XL, huge' })).toEqual([
      ['Green'],
      ['XL, huge'],
    ]);
  });
});

describe('OpenCodeFacade resume-lost notice', () => {
  it('a resume target the server no longer has pushes opencode-resume-lost before the init message', async () => {
    const client = clientWith([]);
    (client.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: undefined, error: { message: 'not found' } });
    (client.session.create as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'ses_new' } as Session, error: undefined });
    const handle = start(client, { resume: 'ses_gone' });

    const types = (await collectWithTimeout(handle.messages())).map(typeOf);
    expect(types.indexOf('opencode-resume-lost')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('opencode-resume-lost')).toBeLessThan(types.indexOf('system'));
    expect(client.session.create).toHaveBeenCalled();
  });

  it('a resume target the server still has does NOT push opencode-resume-lost', async () => {
    const client = clientWith([]);
    (client.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { id: 'ses_gone' } as Session, error: undefined });
    const handle = start(client, { resume: 'ses_gone' });

    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => typeOf(m) === 'opencode-resume-lost')).toBe(false);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});
