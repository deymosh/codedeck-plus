/**
 * relayTransport unit tests — everything testable without sockets:
 * subscription bookkeeping, deliberate-close suppression (the pool.destroy
 * fires-onclose trap), publish any-success semantics, relay-list swaps.
 * The real-relay smoke is covered by the device-test phases (run sheet in
 * TODO.md).
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { createRelayTransport, type PoolLike } from '../relayTransport';

interface FakeSub {
  relays: string[];
  filter: Filter;
  params: {
    onevent: (event: NostrEvent) => void;
    oneose?: () => void;
    onclose?: (reasons: Array<{ url: string; reason: string }>) => void;
  };
  closedByCaller: boolean;
}

function fakePool(publishResults: Array<Promise<string>> = []): PoolLike & {
  subs: FakeSub[];
  destroyed: boolean;
  publishes: Array<{ relays: string[]; event: NostrEvent }>;
} {
  const subs: FakeSub[] = [];
  const publishes: Array<{ relays: string[]; event: NostrEvent }> = [];
  const pool = {
    subs,
    publishes,
    destroyed: false,
    subscribe(relays: string[], filter: Filter, params: FakeSub['params']) {
      const sub: FakeSub = { relays, filter, params, closedByCaller: false };
      subs.push(sub);
      return {
        close: () => {
          sub.closedByCaller = true;
          // nostr-tools fires onclose on deliberate close too — the trap.
          sub.params.onclose?.([{ url: relays[0] ?? 'wss://x', reason: 'closed by caller' }]);
        },
      };
    },
    publish(relays: string[], event: NostrEvent) {
      publishes.push({ relays, event });
      return [...publishResults];
    },
    destroy() {
      pool.destroyed = true;
      // destroy() also fires every live subscription's onclose (the trap).
      for (const sub of subs) {
        if (!sub.closedByCaller) sub.params.onclose?.([{ url: 'wss://x', reason: 'relay connection closed' }]);
      }
    },
  };
  return pool;
}

const event = (id: string): NostrEvent =>
  ({ id, kind: 24515, pubkey: 'p', created_at: 1, tags: [], content: '', sig: 's' }) as NostrEvent;

describe('createRelayTransport', () => {
  it('routes events and eose to the subscription params', () => {
    const pool = fakePool();
    const transport = createRelayTransport({ relays: ['wss://a', 'wss://b'], pool });
    const got: string[] = [];
    let eose = 0;
    transport.subscribe({ kinds: [24515] }, {
      onEvent: (e) => got.push(e.id),
      onEose: () => eose++,
    });
    expect(pool.subs).toHaveLength(1);
    expect(pool.subs[0]!.relays).toEqual(['wss://a', 'wss://b']);
    pool.subs[0]!.params.onevent(event('e1'));
    pool.subs[0]!.params.oneose?.();
    expect(got).toEqual(['e1']);
    expect(eose).toBe(1);
    expect(transport.openSubscriptionCount).toBe(1);
  });

  it('an unexpected pool-side close surfaces exactly once and clears bookkeeping', () => {
    const pool = fakePool();
    const transport = createRelayTransport({ relays: ['wss://a'], pool });
    let closes = 0;
    transport.subscribe({ kinds: [30515] }, { onEvent: () => {}, onClose: () => closes++ });
    pool.subs[0]!.params.onclose?.([{ url: 'wss://a', reason: 'relay connection errored' }]);
    pool.subs[0]!.params.onclose?.([{ url: 'wss://a', reason: 'again' }]);
    expect(closes).toBe(1);
    expect(transport.openSubscriptionCount).toBe(0);
  });

  it('deliberate sub.close() NEVER surfaces as onClose, and is idempotent', () => {
    const pool = fakePool();
    const transport = createRelayTransport({ relays: ['wss://a'], pool });
    let closes = 0;
    const sub = transport.subscribe({ kinds: [4516] }, {
      onEvent: () => {},
      onClose: () => closes++,
    });
    sub.close();
    sub.close();
    expect(pool.subs[0]!.closedByCaller).toBe(true);
    expect(closes).toBe(0);
    expect(transport.openSubscriptionCount).toBe(0);
    // Late events after close are dropped too.
    pool.subs[0]!.params.onevent(event('late'));
  });

  it('transport.close() destroys the pool without leaking onClose (the destroy trap), and is idempotent', () => {
    const pool = fakePool();
    const transport = createRelayTransport({ relays: ['wss://a'], pool });
    let closes = 0;
    transport.subscribe({ kinds: [24515] }, { onEvent: () => {}, onClose: () => closes++ });
    transport.subscribe({ kinds: [30515] }, { onEvent: () => {}, onClose: () => closes++ });
    transport.close?.();
    transport.close?.();
    expect(pool.destroyed).toBe(true);
    expect(closes).toBe(0);
    expect(transport.openSubscriptionCount).toBe(0);
    // Subscribing after close is inert.
    const sub = transport.subscribe({ kinds: [1] }, { onEvent: () => {} });
    sub.close();
    expect(pool.subs).toHaveLength(2);
  });

  it('publish resolves true when at least one relay accepts', async () => {
    const ok = Promise.resolve('ok');
    const bad = Promise.reject(new Error('blocked'));
    const pool = fakePool([bad, ok]);
    const transport = createRelayTransport({ relays: ['wss://a', 'wss://b'], pool });
    await expect(transport.publish(event('e'))).resolves.toBe(true);
  });

  it('publish resolves false when every relay rejects (or none configured)', async () => {
    const pool = fakePool([Promise.reject(new Error('no')), Promise.reject(new Error('nope'))]);
    const transport = createRelayTransport({ relays: ['wss://a'], pool });
    await expect(transport.publish(event('e'))).resolves.toBe(false);

    const empty = fakePool([]);
    const emptyTransport = createRelayTransport({ relays: [], pool: empty });
    await expect(emptyTransport.publish(event('e'))).resolves.toBe(false);
  });

  it('setRelays affects future subscribes and publishes (existing subs untouched)', async () => {
    const pool = fakePool([Promise.resolve('ok')]);
    const transport = createRelayTransport({ relays: ['wss://old'], pool });
    transport.subscribe({ kinds: [30515] }, { onEvent: () => {} });
    transport.setRelays?.(['wss://new1', 'wss://new2']);
    transport.subscribe({ kinds: [30515] }, { onEvent: () => {} });
    await transport.publish(event('e'));
    expect(pool.subs[0]!.relays).toEqual(['wss://old']);
    expect(pool.subs[1]!.relays).toEqual(['wss://new1', 'wss://new2']);
    expect(pool.publishes[0]!.relays).toEqual(['wss://new1', 'wss://new2']);
  });
});
