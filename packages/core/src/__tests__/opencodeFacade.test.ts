/**
 * Regression tests for the two message-queue hang bugs found in review of
 * OpenCodeSessionHandle: the queue must close (so messages()'s `for await`
 * terminates instead of hanging SessionRunner forever) both when the event
 * stream ends gracefully and when event.subscribe() itself rejects before
 * any session is even created.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Event, OpencodeClient, Session } from '@opencode-ai/sdk';

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from '@opencode-ai/sdk';
import { OpenCodeFacade } from '../sdk/opencodeFacade';
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

describe('OpenCodeFacade message-queue close', () => {
  it('closes the queue when the event stream ends gracefully (no throw)', async () => {
    async function* emptyStream(): AsyncGenerator<Event> {
      // Ends immediately with no yields and no throw — the "server closed
      // the connection cleanly" case.
    }
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: emptyStream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
        get: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());

    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => (m as { type?: string }).type === 'system')).toBe(true);
  });

  it('closes the queue when event.subscribe() rejects before any session exists', async () => {
    const client = {
      event: { subscribe: vi.fn().mockRejectedValue(new Error('connection refused')) },
      session: { create: vi.fn(), get: vi.fn() },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());

    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => (m as { type?: string }).type === 'opencode-error')).toBe(true);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

describe('OpenCodeFacade stream error propagation (up-to-2-restarts parity)', () => {
  it('a stream that throws mid-iteration makes messages() reject, not end cleanly', async () => {
    async function* throwingStream(): AsyncGenerator<Event> {
      // A real event first, so the queue has something to yield before the
      // error — asserts partial output survives, same as a real network blip.
      yield {
        type: 'session.idle',
        properties: { sessionID: 'ses_1' },
      } as unknown as Event;
      throw new Error('connection reset');
    }
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: throwingStream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
        get: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());

    const seen: SdkMessage[] = [];
    await expect(
      (async () => {
        for await (const msg of handle.messages()) seen.push(msg);
      })(),
    ).rejects.toThrow('connection reset');
    // The idle event that arrived before the throw was not lost.
    expect(seen.some((m) => (m as unknown as { subtype?: string }).subtype === 'session_state_changed')).toBe(true);
  });

  it('a stream that ends without throwing still ends messages() cleanly (no regression)', async () => {
    async function* cleanStream(): AsyncGenerator<Event> {
      yield { type: 'session.idle', properties: { sessionID: 'ses_1' } } as unknown as Event;
    }
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: cleanStream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
        get: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());

    await expect(collectWithTimeout(handle.messages())).resolves.not.toThrow();
  });
});

describe('OpenCodeFacade session.status → running/idle transitions', () => {
  it('a busy status pushes session_state_changed running', async () => {
    async function* stream(): AsyncGenerator<Event> {
      yield {
        type: 'session.status',
        properties: { sessionID: 'ses_1', status: { type: 'busy' } },
      } as unknown as Event;
    }
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: stream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
        get: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());
    const messages = await collectWithTimeout(handle.messages());
    const state = messages.find((m) => (m as unknown as { subtype?: string }).subtype === 'session_state_changed') as
      | { state?: string }
      | undefined;
    expect(state?.state).toBe('running');
  });
});

describe('OpenCodeFacade session.diff', () => {
  it('pushes an opencode-diff message unconditionally — gating happens in the adapter, not here', async () => {
    const fileDiff = { file: 'a.ts', before: 'x', after: 'y', additions: 1, deletions: 1 };
    async function* stream(): AsyncGenerator<Event> {
      yield {
        type: 'session.diff',
        properties: { sessionID: 'ses_1', diff: [fileDiff] },
      } as unknown as Event;
    }
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: stream() }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_1' } as Session, error: undefined }),
        get: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const handle = facade.createSession(baseOpts());
    const messages = await collectWithTimeout(handle.messages());
    const diffMsg = messages.find((m) => (m as { type?: string }).type === 'opencode-diff') as
      | { files?: unknown[] }
      | undefined;
    expect(diffMsg?.files).toEqual([fileDiff]);
  });
});

describe('OpenCodeFacade resume-lost notice', () => {
  it('a resume target the server no longer has pushes opencode-resume-lost before the init message', async () => {
    async function* emptyStream(): AsyncGenerator<Event> {}
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: emptyStream() }) },
      session: {
        get: vi.fn().mockResolvedValue({ data: undefined, error: { message: 'not found' } }),
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_new' } as Session, error: undefined }),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const opts = { ...baseOpts(), resume: 'ses_gone' };
    const handle = facade.createSession(opts);

    const messages = await collectWithTimeout(handle.messages());
    const types = messages.map((m) => (m as { type?: string }).type);
    expect(types.indexOf('opencode-resume-lost')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('opencode-resume-lost')).toBeLessThan(types.indexOf('system'));
    expect(client.session.create).toHaveBeenCalled();
  });

  it('a resume target the server still has does NOT push opencode-resume-lost', async () => {
    async function* emptyStream(): AsyncGenerator<Event> {}
    const client = {
      event: { subscribe: vi.fn().mockResolvedValue({ stream: emptyStream() }) },
      session: {
        get: vi.fn().mockResolvedValue({ data: { id: 'ses_gone' } as Session, error: undefined }),
        create: vi.fn(),
      },
    } as unknown as OpencodeClient;
    vi.mocked(createOpencodeClient).mockReturnValue(client);

    const facade = new OpenCodeFacade({ baseUrl: 'http://fake' });
    const opts = { ...baseOpts(), resume: 'ses_gone' };
    const handle = facade.createSession(opts);

    const messages = await collectWithTimeout(handle.messages());
    expect(messages.some((m) => (m as { type?: string }).type === 'opencode-resume-lost')).toBe(false);
    expect(client.session.create).not.toHaveBeenCalled();
  });
});
