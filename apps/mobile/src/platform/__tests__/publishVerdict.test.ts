/**
 * CDX-086: publish verdicts.
 *
 * The boolean these replace collapsed two OPPOSITE outcomes into `false` and got
 * one of them backwards. Both halves are the founder's stuck upload:
 *
 *  - a relay OK arriving after nostr-tools' 4.4 s publishTimeout rejected with
 *    `publish timed out`, so the phone concluded failure and re-uploaded a 3 MB
 *    photo as ~115 relay chunks the bridge had already received;
 *  - `ensureRelay` failing RESOLVES with the string `"connection failure: …"`
 *    rather than rejecting, so `allSettled(...).some(fulfilled)` reported a
 *    completely unreachable publish as SUCCESS.
 *
 * Each test below fails on the pre-CDX-086 implementation.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { createRelayTransport, type PoolLike } from '../relayTransport';

const EVENT = { id: 'ev1', kind: 4515, tags: [], content: '', created_at: 0, pubkey: 'p', sig: 's' } as unknown as NostrEvent;

/** A pool whose publish() yields FRESH promises per call (retries need that). */
function pool(perCall: Array<Array<Promise<string>>>): PoolLike & {
  calls: Array<{ relays: string[]; event: NostrEvent }>;
} {
  const calls: Array<{ relays: string[]; event: NostrEvent }> = [];
  let n = 0;
  return {
    calls,
    subscribe: (_r: string[], _f: Filter) => ({ close: () => {} }),
    publish(relays: string[], event: NostrEvent) {
      calls.push({ relays, event });
      return perCall[Math.min(n++, perCall.length - 1)] ?? [];
    },
    destroy() {},
  };
}

const transport = (p: PoolLike) =>
  createRelayTransport({ relays: ['wss://a', 'wss://b'], pool: p });

const never = (): Promise<string> => new Promise<string>(() => {});
const timedOut = (): Promise<string> => Promise.reject(new Error('publish timed out'));
const rateLimited = (): Promise<string> =>
  Promise.reject(new Error('rate-limited: you are noting too much'));
const connFailure = (): Promise<string> =>
  Promise.resolve('connection failure: getaddrinfo ENOTFOUND');

describe('publishConfirmed verdicts', () => {
  it('resolves accepted on the FIRST OK without waiting for a stuck relay', async () => {
    // allSettled made every publish pay the slowest relay. With 115 chunks that
    // is the difference between seconds and minutes.
    const p = pool([[never(), Promise.resolve('')]]);
    const result = await transport(p).publishConfirmed!(EVENT, { attempts: 1 });
    expect(result.verdict).toBe('accepted');
  });

  it('a late OK is unconfirmed, NOT rejected — the founder`s bug', async () => {
    const p = pool([[timedOut(), timedOut()]]);
    const result = await transport(p).publishConfirmed!(EVENT, { attempts: 1 });
    expect(result.verdict).toBe('unconfirmed');
    expect(result.detail).toMatch(/timed out/);
  });

  it('an unreachable relay is NOT success — publish() reports false', async () => {
    // nostr-tools resolves this with a string, so the old `.some(fulfilled)`
    // said true and the caller believed the event was delivered.
    const p = pool([[connFailure(), connFailure()]]);
    const t = transport(p);
    expect((await t.publishConfirmed!(EVENT, { attempts: 1 })).verdict).toBe('unreachable');
    expect(await t.publish(EVENT)).toBe(false);
  });

  it('a hard refusal is rejected, and retrying it does not help', async () => {
    const p = pool([[rateLimited(), rateLimited()]]);
    const result = await transport(p).publishConfirmed!(EVENT, { attempts: 2 });
    expect(result.verdict).toBe('rejected');
    expect(result.detail).toMatch(/rate-limited/);
    // It DID retry within budget — a rate limit can lift between attempts.
    expect(p.calls).toHaveLength(2);
  });

  it('the softest verdict wins across relays: a timeout beats a refusal', async () => {
    const p = pool([[rateLimited(), timedOut()]]);
    const result = await transport(p).publishConfirmed!(EVENT, { attempts: 1 });
    // One relay wrote the frame; that outranks another relay refusing it.
    expect(result.verdict).toBe('unconfirmed');
  });

  it('a retry republishes the IDENTICAL event id', async () => {
    // The whole reason the retry lives in the transport: the bridge dedupes by
    // event id, so republishing the same signed event is idempotent. Rebuilding
    // it higher up would yield a new id and inject the image twice.
    const p = pool([[rateLimited()], [Promise.resolve('')]]);
    const result = await transport(p).publishConfirmed!(EVENT, { attempts: 2 });
    expect(result.verdict).toBe('accepted');
    expect(p.calls).toHaveLength(2);
    expect(p.calls.map((c) => c.event.id)).toEqual(['ev1', 'ev1']);
  });

  it('a pre-aborted signal publishes nothing', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const p = pool([[Promise.resolve('')]]);
    await transport(p).publishConfirmed!(EVENT, { signal: ctl.signal });
    expect(p.calls).toHaveLength(0);
  });

  it('an early acceptance leaves no unhandled rejection behind', async () => {
    // Resolving on the first OK abandons the siblings; an abandoned rejection is
    // the CDX-060 trap and vitest fails the whole run on it. The assertion is
    // that this test file completes.
    const slowReject = new Promise<string>((_res, rej) =>
      setTimeout(() => rej(new Error('rate-limited: late')), 5),
    );
    const p = pool([[Promise.resolve(''), slowReject]]);
    expect((await transport(p).publishConfirmed!(EVENT, { attempts: 1 })).verdict).toBe('accepted');
    await new Promise((r) => setTimeout(r, 20));
  });

  it('a closed transport reports unreachable rather than throwing', async () => {
    const p = pool([[Promise.resolve('')]]);
    const t = transport(p);
    t.close?.();
    expect((await t.publishConfirmed!(EVENT)).verdict).toBe('unreachable');
    expect(await t.publish(EVENT)).toBe(false);
  });
});
