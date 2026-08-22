import { describe, expect, it } from 'vitest';
import { InMemoryRelay, type RelayEvent } from '../inMemoryRelay';
import { LIVE_KIND, COMMAND_KIND, SESSION_LIST_KIND } from '@codedeck/protocol';

let nextId = 0;
const ev = (partial: Partial<RelayEvent>): RelayEvent => ({
  id: `id-${nextId++}`,
  pubkey: 'aa'.repeat(32),
  kind: 1,
  created_at: 1000,
  tags: [],
  content: '{}',
  ...partial,
});

describe('InMemoryRelay', () => {
  it('stores regular events and serves them on EOSE snapshot', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    relay.publish(ev({ kind: COMMAND_KIND, created_at: 900 }));
    const got: RelayEvent[] = [];
    let eose = false;
    relay.subscribe([{ kinds: [COMMAND_KIND] }], (e) => got.push(e), () => (eose = true));
    expect(got).toHaveLength(1);
    expect(eose).toBe(true);
  });

  it('broadcasts ephemeral events to live subs but never stores them', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    const got: RelayEvent[] = [];
    relay.subscribe([{ kinds: [LIVE_KIND] }], (e) => got.push(e));
    relay.publish(ev({ kind: LIVE_KIND }));
    expect(got).toHaveLength(1);
    expect(relay.query([{ kinds: [LIVE_KIND] }])).toHaveLength(0);
  });

  it('replaceable session list keeps only the newest per (pubkey, d)', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    const d = (v: string): string[][] => [['d', v]];
    relay.publish(ev({ kind: SESSION_LIST_KIND, created_at: 1, tags: d('laptop') }));
    relay.publish(ev({ kind: SESSION_LIST_KIND, created_at: 2, tags: d('laptop') }));
    relay.publish(ev({ kind: SESSION_LIST_KIND, created_at: 9, tags: d('vps') }));
    const events = relay.query([{ kinds: [SESSION_LIST_KIND] }]);
    expect(events).toHaveLength(2);
    const laptop = events.find((e) => e.tags[0]?.[1] === 'laptop');
    expect(laptop?.created_at).toBe(2);
  });

  it('an OLDER replaceable publish never clobbers a newer one (stale-heartbeat guard)', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    relay.publish(ev({ kind: SESSION_LIST_KIND, created_at: 10, tags: [['d', 'm']], content: 'new' }));
    relay.publish(ev({ kind: SESSION_LIST_KIND, created_at: 5, tags: [['d', 'm']], content: 'old' }));
    const [only] = relay.query([{ kinds: [SESSION_LIST_KIND] }]);
    expect(only?.content).toBe('new');
  });

  it('filters by #p tag and authors — the bridge/phone subscription shapes', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    relay.publish(ev({ kind: COMMAND_KIND, pubkey: 'phone1', tags: [['p', 'bridge1']] }));
    relay.publish(ev({ kind: COMMAND_KIND, pubkey: 'phone2', tags: [['p', 'bridge2']] }));
    expect(relay.query([{ kinds: [COMMAND_KIND], '#p': ['bridge1'] }])).toHaveLength(1);
    expect(relay.query([{ kinds: [COMMAND_KIND], authors: ['phone2'] }])).toHaveLength(1);
  });

  it('since filter excludes older stored events (the old bug: session lists need NO since)', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    relay.publish(ev({ kind: COMMAND_KIND, created_at: 100 }));
    relay.publish(ev({ kind: COMMAND_KIND, created_at: 200 }));
    expect(relay.query([{ kinds: [COMMAND_KIND], since: 150 }])).toHaveLength(1);
  });

  it('NIP-40: refuses expired-on-arrival, hides expired from queries, purges', () => {
    let now = 1000;
    const relay = new InMemoryRelay({ now: () => now });
    expect(relay.publish(ev({ tags: [['expiration', '999']], kind: COMMAND_KIND }))).toBe(false);
    expect(relay.publish(ev({ tags: [['expiration', '1500']], kind: COMMAND_KIND }))).toBe(true);
    expect(relay.query([{ kinds: [COMMAND_KIND] }])).toHaveLength(1);
    now = 2000;
    expect(relay.query([{ kinds: [COMMAND_KIND] }])).toHaveLength(0);
    expect(relay.purgeExpired()).toBe(1);
  });

  it('live broadcast reaches only matching subscriptions and close() detaches', () => {
    const relay = new InMemoryRelay({ now: () => 1000 });
    const a: RelayEvent[] = [];
    const b: RelayEvent[] = [];
    const subA = relay.subscribe([{ kinds: [COMMAND_KIND] }], (e) => a.push(e));
    relay.subscribe([{ kinds: [SESSION_LIST_KIND] }], (e) => b.push(e));
    relay.publish(ev({ kind: COMMAND_KIND }));
    subA.close();
    relay.publish(ev({ kind: COMMAND_KIND }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});
