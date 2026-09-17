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
