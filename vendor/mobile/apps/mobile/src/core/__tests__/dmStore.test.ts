/**
 * dmStore (NIP-17, Phase 5b) — gift-wrap round-trips (peer + self-copy),
 * structural dedup, persistence round-trip, unread/read markers, the 48h
 * catch-up window math, the kind-10050 advertisement, and the CD-001
 * regression: undecryptable/malformed 1059s are COUNTED and dropped, never
 * silently swallowed, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { verifyEvent } from 'nostr-tools/pure';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import * as nip19 from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { generateKeypair, type Keypair } from '../crypto';
import {
  memoryKV,
  type PhoneTransport,
  type TransportSubscriptionParams,
} from '../ports';
import {
  buildDmFilter,
  createDmStore,
  dmSinceCursor,
  GIFT_WRAP_KIND,
  GIFT_WRAP_SINCE_GRACE_SECONDS,
  DM_RELAY_LIST_KIND,
  DM_RUMOR_KIND,
  loadPersistedDm,
  orderedConversations,
  parsePeerInput,
  type DmConversation,
  type DmMessage,
  type DmStore,
} from '../stores/dm';

// --- Harness ---

interface FakeSub {
  filter: Filter;
  params: TransportSubscriptionParams;
  closed: boolean;
}

function fakeTransport(opts: { publishOk?: boolean } = {}) {
  const published: NostrEvent[] = [];
  const subs: FakeSub[] = [];
  let publishOk = opts.publishOk ?? true;
  const transport: PhoneTransport = {
    subscribe(filter, params) {
      const sub: FakeSub = { filter, params, closed: false };
      subs.push(sub);
      return {
        close: () => {
          sub.closed = true;
        },
      };
    },
    publish: async (event) => {
      published.push(event);
      return publishOk;
    },
  };
  return {
    transport,
    published,
    subs,
    setPublishOk: (ok: boolean) => {
      publishOk = ok;
    },
    /** Deliver an event to the LIVE (latest, unclosed) subscription. */
    deliver: (event: NostrEvent) => {
      const live = [...subs].reverse().find((s) => !s.closed);
      live?.params.onEvent(event);
    },
  };
}

function makeStore(over: {
  keypair?: Keypair;
  kv?: ReturnType<typeof memoryKV>;
  publishOk?: boolean;
  relays?: string[];
  now?: () => number;
} = {}) {
  const keypair = over.keypair ?? generateKeypair();
  const kv = over.kv ?? memoryKV();
  const t = fakeTransport({ publishOk: over.publishOk ?? true });
  const store: DmStore = createDmStore({
    kv,
    transport: t.transport,
    keypair: () => keypair,
    relays: () => over.relays ?? ['wss://relay.test'],
    ...(over.now ? { now: over.now } : {}),
  });
  return { store, keypair, kv, ...t };
}

/** The wrap addressed to `pubkey` among published events. */
const wrapFor = (published: NostrEvent[], pubkey: string): NostrEvent | undefined =>
  published.find(
    (e) => e.kind === GIFT_WRAP_KIND && e.tags.some((t) => t[0] === 'p' && t[1] === pubkey),
  );

// --- Pure helpers ---

describe('dm catch-up window math', () => {
  it('no local history → undefined (fetch everything)', () => {
    expect(dmSinceCursor({})).toBeUndefined();
    expect(dmSinceCursor({ peer: [] })).toBeUndefined();
  });

  it('cursor = newest message (seconds) minus the 48h gift-wrap randomization window', () => {
    const atMs = 1_700_000_000_000;
    const messages = {
      a: [{ at: atMs - 60_000 } as DmMessage],
      b: [{ at: atMs } as DmMessage, { at: atMs - 999_000 } as DmMessage],
    };
    expect(dmSinceCursor(messages)).toBe(
      Math.floor(atMs / 1000) - GIFT_WRAP_SINCE_GRACE_SECONDS,
    );
    expect(GIFT_WRAP_SINCE_GRACE_SECONDS).toBe(172_800); // NIP-59: up to −2 days
  });

  it('buildDmFilter: 1059 addressed to us, since only when a cursor exists', () => {
    expect(buildDmFilter('ab'.repeat(32))).toEqual({
      kinds: [GIFT_WRAP_KIND],
      '#p': ['ab'.repeat(32)],
    });
    expect(buildDmFilter('ab'.repeat(32), 12345)).toEqual({
      kinds: [GIFT_WRAP_KIND],
      '#p': ['ab'.repeat(32)],
      since: 12345,
    });
  });
});

describe('peer input parsing', () => {
  it('accepts npub and hex, rejects garbage', () => {
    const kp = generateKeypair();
    expect(parsePeerInput(kp.npub)).toBe(kp.pubkeyHex);
    expect(parsePeerInput(` ${kp.pubkeyHex.toUpperCase()} `)).toBe(kp.pubkeyHex);
    expect(parsePeerInput('npub1notvalid')).toBeNull();
    expect(parsePeerInput('deadbeef')).toBeNull();
    expect(parsePeerInput(nip19.nsecEncode(kp.secretKey))).toBeNull();
  });
});

describe('conversation ordering', () => {
  it('newest activity first', () => {
    const conv = (peer: string, lastMessageAt: number): DmConversation => ({
      peerPubkey: peer,
      protocol: 'nip17',
      lastMessageAt,
      unreadCount: 0,
      lastPreview: '',
    });
    const ordered = orderedConversations({
      a: conv('a', 100),
      b: conv('b', 300),
      c: conv('c', 200),
    });
    expect(ordered.map((c) => c.peerPubkey)).toEqual(['b', 'c', 'a']);
  });
});

// --- Send path ---

describe('dm send', () => {
  it('publishes TWO gift wraps (recipient + self-copy) sharing one rumor id', async () => {
    const peer = generateKeypair();
    const { store, keypair, published } = makeStore();

    const msg = await store.getState().send(peer.pubkeyHex, 'hello over nostr');

    const wraps = published.filter((e) => e.kind === GIFT_WRAP_KIND);
    expect(wraps).toHaveLength(2);
    const toPeer = wrapFor(published, peer.pubkeyHex);
    const toSelf = wrapFor(published, keypair.pubkeyHex);
    expect(toPeer).toBeDefined();
    expect(toSelf).toBeDefined();
    // Ephemeral wrap keys: neither wrap is signed by our identity.
    expect(toPeer!.pubkey).not.toBe(keypair.pubkeyHex);
    expect(toSelf!.pubkey).not.toBe(keypair.pubkeyHex);

    expect(msg.status).toBe('sent');
    expect(msg.senderPubkey).toBe(keypair.pubkeyHex);
    const state = store.getState();
    expect(state.messages[peer.pubkeyHex]).toHaveLength(1);
    expect(state.messages[peer.pubkeyHex]![0]!.id).toBe(msg.id);
    expect(state.conversations[peer.pubkeyHex]).toMatchObject({
      protocol: 'nip17',
      lastPreview: 'hello over nostr',
      unreadCount: 0,
    });
  });

  it('publish rejected by all relays → visible failed message', async () => {
    const peer = generateKeypair();
    const { store } = makeStore({ publishOk: false });
    const msg = await store.getState().send(peer.pubkeyHex, 'doomed');
    expect(msg.status).toBe('failed');
    expect(store.getState().messages[peer.pubkeyHex]![0]!.status).toBe('failed');
  });

  it('retry replaces the failed entry once the resend is accepted', async () => {
    const peer = generateKeypair();
    const t = makeStore({ publishOk: false });
    const failed = await t.store.getState().send(peer.pubkeyHex, 'try again');
    expect(t.store.getState().messages[peer.pubkeyHex]).toHaveLength(1);

    t.setPublishOk(true);
    await t.store.getState().retry(peer.pubkeyHex, failed.id);

    const list = t.store.getState().messages[peer.pubkeyHex]!;
    // Content-dedup would block an identical re-add — the failed entry must
    // be gone and exactly one 'sent' copy remain.
    expect(list.filter((m) => m.content === 'try again')).toHaveLength(1);
    expect(list[0]!.status).toBe('sent');
  });
});

// --- Receive path / round-trips ---

describe('dm receive round-trip', () => {
  it('peer round-trip: A sends, B unwraps A’s wrap into a delivered message', async () => {
    const a = makeStore();
    const b = makeStore();

    await a.store.getState().send(b.keypair.pubkeyHex, 'hi B');
    const wrap = wrapFor(a.published, b.keypair.pubkeyHex)!;

    b.store.getState().start();
    b.deliver(wrap);

    const msgs = b.store.getState().messages[a.keypair.pubkeyHex]!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      senderPubkey: a.keypair.pubkeyHex,
      content: 'hi B',
      status: 'delivered',
    });
    // Same rumor id on both ends — the dedup key is shared.
    expect(msgs[0]!.id).toBe(a.store.getState().messages[b.keypair.pubkeyHex]![0]!.id);
  });

  it('self-copy restores own sends on a fresh install (restart survival)', async () => {
    const peer = generateKeypair();
    const a1 = makeStore();
    await a1.store.getState().send(peer.pubkeyHex, 'from my old phone');
    const selfWrap = wrapFor(a1.published, a1.keypair.pubkeyHex)!;

    // Fresh store, SAME identity, empty state — catch-up delivers the self wrap.
    const a2 = makeStore({ keypair: a1.keypair });
    a2.store.getState().start();
    a2.deliver(selfWrap);

    const msgs = a2.store.getState().messages[peer.pubkeyHex]!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      senderPubkey: a1.keypair.pubkeyHex,
      peerPubkey: peer.pubkeyHex,
      content: 'from my old phone',
    });
    // Own restored messages never count as unread.
    expect(a2.store.getState().conversations[peer.pubkeyHex]!.unreadCount).toBe(0);
  });

  it('the self-wrap echo of a live send is deduped by rumor id', async () => {
    const peer = generateKeypair();
    const a = makeStore();
    a.store.getState().start();
    await a.store.getState().send(peer.pubkeyHex, 'echo me');
    a.deliver(wrapFor(a.published, a.keypair.pubkeyHex)!);
    expect(a.store.getState().messages[peer.pubkeyHex]).toHaveLength(1);
  });

  it('replayed wrap (overlapping since window) is deduped; different-id same-content within 60s is content-deduped', async () => {
    const a = makeStore();
    const b = makeStore();
    b.store.getState().start();

    await a.store.getState().send(b.keypair.pubkeyHex, 'once only');
    const wrap = wrapFor(a.published, b.keypair.pubkeyHex)!;
    b.deliver(wrap);
    b.deliver(wrap); // relay replay
    expect(b.store.getState().messages[a.keypair.pubkeyHex]).toHaveLength(1);

    // Another client wrapping the same content again → new rumor id, same
    // sender + content within the window → content-dedup.
    const rumor2 = createRumor(
      { kind: DM_RUMOR_KIND, content: 'once only', tags: [['p', b.keypair.pubkeyHex]] },
      a.keypair.secretKey,
    );
    const wrap2 = createWrap(
      createSeal(rumor2, a.keypair.secretKey, b.keypair.pubkeyHex),
      b.keypair.pubkeyHex,
    );
    b.deliver(wrap2);
    expect(b.store.getState().messages[a.keypair.pubkeyHex]).toHaveLength(1);
  });
});

// --- CD-001 regression ---

describe('CD-001: undecryptable/malformed 1059s are counted, never silent, never fatal', () => {
  it('a wrap for someone else fails to unwrap → unwrapFailures++, nothing stored, no throw', async () => {
    const a = makeStore();
    const b = makeStore();
    const c = makeStore(); // innocent bystander receives a misaddressed wrap
    await a.store.getState().send(b.keypair.pubkeyHex, 'not for C');
    const wrap = wrapFor(a.published, b.keypair.pubkeyHex)!;

    c.store.getState().start();
    expect(() => c.deliver(wrap)).not.toThrow();

    const d = c.store.getState().diagnostics;
    expect(d.eventsReceived).toBe(1);
    expect(d.unwrapFailures).toBe(1);
    expect(Object.keys(c.store.getState().messages)).toHaveLength(0);
  });

  it('garbage 1059 content → unwrapFailures++, dropped', () => {
    const b = makeStore();
    b.store.getState().start();
    const garbage: NostrEvent = {
      id: 'f'.repeat(64),
      pubkey: 'a'.repeat(64),
      kind: GIFT_WRAP_KIND,
      content: 'not-nip44-at-all',
      created_at: 1_700_000_000,
      tags: [['p', b.keypair.pubkeyHex]],
      sig: '0'.repeat(128),
    };
    expect(() => b.deliver(garbage)).not.toThrow();
    expect(b.store.getState().diagnostics.unwrapFailures).toBe(1);
  });

  it('a valid wrap around a non-DM rumor (kind ≠ 14) → invalidRumors++, dropped', () => {
    const a = generateKeypair();
    const b = makeStore();
    b.store.getState().start();

    const rumor = createRumor(
      { kind: 1, content: 'a note, not a DM', tags: [] },
      a.secretKey,
    );
    const wrap = createWrap(
      createSeal(rumor, a.secretKey, b.keypair.pubkeyHex),
      b.keypair.pubkeyHex,
    );
    expect(() => b.deliver(wrap)).not.toThrow();

    const d = b.store.getState().diagnostics;
    expect(d.invalidRumors).toBe(1);
    expect(d.unwrapFailures).toBe(0);
    expect(Object.keys(b.store.getState().messages)).toHaveLength(0);
  });
});

// --- Unread / read markers ---

describe('unread + read markers', () => {
  it('incoming while the conversation is NOT open counts unread; markRead clears; open conversation never counts', async () => {
    const a = makeStore();
    const b = makeStore();
    b.store.getState().start();

    await a.store.getState().send(b.keypair.pubkeyHex, 'one');
    b.deliver(wrapFor(a.published, b.keypair.pubkeyHex)!);
    expect(b.store.getState().conversations[a.keypair.pubkeyHex]!.unreadCount).toBe(1);

    b.store.getState().markRead(a.keypair.pubkeyHex);
    expect(b.store.getState().conversations[a.keypair.pubkeyHex]!.unreadCount).toBe(0);

    // Conversation open → incoming stays read.
    b.store.getState().setActivePeer(a.keypair.pubkeyHex);
    a.published.length = 0;
    await a.store.getState().send(b.keypair.pubkeyHex, 'two');
    b.deliver(wrapFor(a.published, b.keypair.pubkeyHex)!);
    expect(b.store.getState().conversations[a.keypair.pubkeyHex]!.unreadCount).toBe(0);

    // setActivePeer(peer) also marks read (ported).
    b.store.getState().setActivePeer(null);
    a.published.length = 0;
    await a.store.getState().send(b.keypair.pubkeyHex, 'three');
    b.deliver(wrapFor(a.published, b.keypair.pubkeyHex)!);
    expect(b.store.getState().conversations[a.keypair.pubkeyHex]!.unreadCount).toBe(1);
    b.store.getState().setActivePeer(a.keypair.pubkeyHex);
    expect(b.store.getState().conversations[a.keypair.pubkeyHex]!.unreadCount).toBe(0);
  });
});

// --- Persistence ---

describe('dm persistence round-trip', () => {
  it('messages, conversations and unread counts survive a store rebuild from KV', async () => {
    const a = makeStore();
    const kv = memoryKV();
    const b = makeStore({ kv });
    b.store.getState().start();

    await a.store.getState().send(b.keypair.pubkeyHex, 'persist me');
    b.deliver(wrapFor(a.published, b.keypair.pubkeyHex)!);
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget persist land

    const persisted = await loadPersistedDm(kv);
    const rebuilt = createDmStore(
      {
        kv,
        transport: fakeTransport().transport,
        keypair: () => b.keypair,
        relays: () => [],
      },
      persisted,
    );
    const conv = rebuilt.getState().conversations[a.keypair.pubkeyHex]!;
    expect(conv.unreadCount).toBe(1);
    expect(conv.lastPreview).toBe('persist me');
    expect(rebuilt.getState().messages[a.keypair.pubkeyHex]).toEqual(
      b.store.getState().messages[a.keypair.pubkeyHex],
    );
  });

  it('corrupt persisted JSON hydrates to an empty store', async () => {
    const kv = memoryKV({ dm: '{not json' });
    expect(await loadPersistedDm(kv)).toEqual({ conversations: {}, messages: {}, profiles: {} });
  });
});

// --- Subscription lifecycle + 10050 ---

describe('dm subscription lifecycle', () => {
  it('start() subscribes with the catch-up cursor; a later start() uses the advanced cursor', async () => {
    const a = makeStore();
    const b = makeStore();

    b.store.getState().start();
    expect(b.subs).toHaveLength(1);
    expect(b.subs[0]!.filter).toEqual(buildDmFilter(b.keypair.pubkeyHex)); // no history → no since

    await a.store.getState().send(b.keypair.pubkeyHex, 'advance the cursor');
    b.deliver(wrapFor(a.published, b.keypair.pubkeyHex)!);

    b.store.getState().start(); // reconnect
    expect(b.subs).toHaveLength(2);
    expect(b.subs[0]!.closed).toBe(true); // previous epoch torn down
    const expected = dmSinceCursor(b.store.getState().messages);
    expect(expected).toBeDefined();
    expect(b.subs[1]!.filter.since).toBe(expected);
  });

  it('stop() tears down silently; events on the superseded sub are ignored (epoch guard)', async () => {
    const a = makeStore();
    const b = makeStore();
    b.store.getState().start();
    const sub = b.subs[0]!;
    b.store.getState().stop();
    expect(sub.closed).toBe(true);
    expect(b.store.getState().subscribed).toBe(false);

    await a.store.getState().send(b.keypair.pubkeyHex, 'late event');
    sub.params.onEvent(wrapFor(a.published, b.keypair.pubkeyHex)!); // straggler
    expect(Object.keys(b.store.getState().messages)).toHaveLength(0);
    expect(b.store.getState().diagnostics.eventsReceived).toBe(0);
  });

  it('start() publishes a signed kind-10050 relay list once, republished only when relays change', () => {
    let relays = ['wss://one.test', 'wss://two.test'];
    const keypair = generateKeypair();
    const kv = memoryKV();
    const t = fakeTransport();
    const store = createDmStore({
      kv,
      transport: t.transport,
      keypair: () => keypair,
      relays: () => relays,
    });

    store.getState().start();
    const lists = () => t.published.filter((e) => e.kind === DM_RELAY_LIST_KIND);
    expect(lists()).toHaveLength(1);
    const event = lists()[0]!;
    expect(event.pubkey).toBe(keypair.pubkeyHex);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual([
      ['relay', 'wss://one.test'],
      ['relay', 'wss://two.test'],
    ]);

    store.getState().start(); // same relays → no republish
    expect(lists()).toHaveLength(1);

    relays = ['wss://three.test'];
    store.getState().start();
    expect(lists()).toHaveLength(2);
    expect(lists()[1]!.tags).toEqual([['relay', 'wss://three.test']]);
  });
});

// --- createPhoneCore wiring: FSM drives the DM subscription lifecycle ---

describe('createPhoneCore DM wiring', () => {
  it('connect opens the 1059 subscription (+10050 publish); stop tears it down', async () => {
    const { createPhoneCore } = await import('../createPhoneCore');
    const t = fakeTransport();
    const core = await createPhoneCore({ kv: memoryKV(), transport: t.transport });

    expect(t.subs).toHaveLength(0);
    core.start(); // FSM connect-requested → open-socket → dm.start()
    const dmSubs = t.subs.filter((s) => (s.filter.kinds ?? []).includes(GIFT_WRAP_KIND));
    expect(dmSubs).toHaveLength(1);
    expect(dmSubs[0]!.filter['#p']).toEqual([core.identity.getState().pubkeyHex]);
    expect(core.dm.getState().subscribed).toBe(true);
    expect(
      t.published.filter((e) => e.kind === DM_RELAY_LIST_KIND),
    ).toHaveLength(1);

    await core.stop(); // disconnect-requested → close-socket → dm.stop()
    expect(dmSubs[0]!.closed).toBe(true);
    expect(core.dm.getState().subscribed).toBe(false);
  });
});

// --- startConversation ---

describe('startConversation', () => {
  it('creates once, activates, and rejects invalid input', () => {
    const peer = generateKeypair();
    const { store } = makeStore();

    expect(store.getState().startConversation('garbage')).toBeNull();
    expect(Object.keys(store.getState().conversations)).toHaveLength(0);

    const hex = store.getState().startConversation(peer.npub);
    expect(hex).toBe(peer.pubkeyHex);
    expect(store.getState().conversations[peer.pubkeyHex]).toMatchObject({
      protocol: 'nip17',
      unreadCount: 0,
    });
    expect(store.getState().activePeer).toBe(peer.pubkeyHex);

    // Idempotent — a second start with the hex form reuses the conversation.
    store.getState().startConversation(peer.pubkeyHex);
    expect(Object.keys(store.getState().conversations)).toHaveLength(1);
  });
});

// --- Phase 6 (CDX-012): the Marmot welcome router on the shared 1059 sub ---

describe('onWrappedRumor: non-DM rumors route to the Phase-6 handler', () => {
  const wrapOfKind = (kind: number, to: Keypair, from: Keypair): NostrEvent =>
    createWrap(
      createSeal(
        createRumor({ kind, content: 'marmot welcome payload', tags: [] }, from.secretKey),
        from.secretKey,
        to.pubkeyHex,
      ),
      to.pubkeyHex,
    );

  it('a claimed rumor (handler returns true) is NOT counted invalid; the handler gets the ORIGINAL 1059', () => {
    const sender = generateKeypair();
    const keypair = generateKeypair();
    const routed: Array<{ kind: number; eventKind: number }> = [];
    const store = createDmStore({
      kv: memoryKV(),
      transport: fakeTransport().transport,
      keypair: () => keypair,
      relays: () => [],
      onWrappedRumor: (event, rumorKind) => {
        routed.push({ kind: rumorKind, eventKind: event.kind });
        return rumorKind === 444;
      },
    });

    store.getState().ingest(wrapOfKind(444, keypair, sender));
    expect(routed).toEqual([{ kind: 444, eventKind: GIFT_WRAP_KIND }]);
    expect(store.getState().diagnostics.invalidRumors).toBe(0);

    // An UNclaimed rumor kind still counts invalid (old behavior preserved).
    store.getState().ingest(wrapOfKind(1, keypair, sender));
    expect(store.getState().diagnostics.invalidRumors).toBe(1);
  });

  it('without the handler, non-DM rumors keep counting invalid (5b behavior)', () => {
    const sender = generateKeypair();
    const b = makeStore();
    b.store.getState().start();
    b.deliver(wrapOfKind(444, b.keypair, sender));
    expect(b.store.getState().diagnostics.invalidRumors).toBe(1);
  });
});
