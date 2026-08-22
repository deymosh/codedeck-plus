/**
 * marmotStore (Phase 6, CDX-012) — the JS half of Marmot MLS DMs over a FAKE
 * engine seam (the real one is Rust/MDK behind Tauri commands, loopback-tested
 * with `cargo test` in src-tauri). Covered here: the unified conversation
 * list (both protocols, ordering, tags), the welcome → accept → conversation
 * lifecycle incl. the VEIL-029 buffer-and-re-feed of early 445s, the send
 * path publishing EXACTLY what the engine returned, KP + kind-10051 publish
 * at start, the KeyPackage-driven start-chat flow, unread gating, dedup of
 * the relay echo, and persistence hydration.
 */
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { generateKeypair, type Keypair } from '../crypto';
import {
  memoryKV,
  type PhoneTransport,
  type TransportSubscriptionParams,
} from '../ports';
import type { DmConversation } from '../stores/dm';
import {
  buildGroupMessageFilter,
  buildKpRelayListEvent,
  createMarmotStore,
  fetchKeyPackage,
  GROUP_MESSAGE_KIND,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_ROTATION_MS,
  KP_RELAY_LIST_KIND,
  hydrateMarmot,
  loadPersistedMarmot,
  marmotSinceCursor,
  peerOfGroup,
  shouldMintKeyPackage,
  unifiedConversations,
  type MarmotGroupInfo,
  type MarmotIngested,
  type MarmotPlatform,
  type MarmotStore,
  type MarmotWelcomeInfo,
  type PublishedKeyPackage,
} from '../stores/marmot';

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
    deliver: (event: NostrEvent) => {
      const live = [...subs].reverse().find((s) => !s.closed);
      live?.params.onEvent(event);
    },
  };
}

const fakeEvent = (kind: number, tags: string[][] = [], id = 'e'.repeat(64)): NostrEvent => ({
  id,
  kind,
  pubkey: 'f'.repeat(64),
  created_at: Math.floor(Date.now() / 1000),
  content: '',
  tags,
  sig: '0'.repeat(128),
});

const WELCOME: MarmotWelcomeInfo = {
  welcomeId: 'w1',
  wrapperId: '1'.repeat(64),
  groupId: 'g1',
  hTag: 'h1',
  name: 'CodeDeck DM',
  welcomer: 'a'.repeat(64),
  memberCount: 2,
};

/** A scriptable fake of the Rust engine. */
function fakeSeam(me: Keypair) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const state = {
    groups: [] as MarmotGroupInfo[],
    pending: [] as MarmotWelcomeInfo[],
    /** Scripted ingest results, consumed in order per event kind. */
    ingestScript: [] as MarmotIngested[],
    sendCounter: 0,
  };
  const seam: MarmotPlatform = {
    init: async (secretHex) => {
      record('init', [secretHex]);
      return me.pubkeyHex;
    },
    publishKeyPackage: async (relays) => {
      record('publishKeyPackage', [relays]);
      return fakeEvent(KEY_PACKAGE_KIND, [['d', 'kp']]);
    },
    createGroup: async (peerPubkey, kp, relays) => {
      record('createGroup', [peerPubkey, kp, relays]);
      state.groups.push({
        groupId: 'g-new',
        hTag: 'h-new',
        name: 'CodeDeck DM',
        members: [me.pubkeyHex, peerPubkey],
        admins: [me.pubkeyHex, peerPubkey],
        active: true,
      });
      return {
        groupId: 'g-new',
        hTag: 'h-new',
        welcomeEvent: fakeEvent(1059, [['p', peerPubkey]], '2'.repeat(64)),
      };
    },
    send: async (groupId, text) => {
      record('send', [groupId, text]);
      state.sendCounter++;
      return {
        event: fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], `${state.sendCounter}`.padStart(64, '0')),
        rumorId: `rumor-${state.sendCounter}`,
        createdAt: Math.floor(Date.now() / 1000),
      };
    },
    ingest: async (event) => {
      record('ingest', [event]);
      const next = state.ingestScript.shift();
      return next ?? { type: 'none' };
    },
    pendingWelcomes: async () => state.pending,
    acceptWelcome: async (welcomeId) => {
      record('acceptWelcome', [welcomeId]);
      const group: MarmotGroupInfo = {
        groupId: WELCOME.groupId,
        hTag: WELCOME.hTag,
        name: WELCOME.name,
        members: [me.pubkeyHex, WELCOME.welcomer],
        admins: [me.pubkeyHex, WELCOME.welcomer],
        active: true,
      };
      state.groups.push(group);
      state.pending = state.pending.filter((w) => w.welcomeId !== welcomeId);
      return group;
    },
    listGroups: async () => state.groups,
  };
  return { seam, calls, state };
}

function makeStore(over: {
  keypair?: Keypair;
  kv?: ReturnType<typeof memoryKV>;
  transport?: ReturnType<typeof fakeTransport>;
  seam?: MarmotPlatform | null;
  relays?: string[];
  now?: () => number;
  initial?: Parameters<typeof createMarmotStore>[1];
  onIncoming?: (msg: { groupId: string; content: string }, countsUnread: boolean) => void;
} = {}): {
  store: MarmotStore;
  keypair: Keypair;
  kv: ReturnType<typeof memoryKV>;
  t: ReturnType<typeof fakeTransport>;
} {
  const keypair = over.keypair ?? generateKeypair();
  const kv = over.kv ?? memoryKV();
  const t = over.transport ?? fakeTransport();
  const store = createMarmotStore(
    {
      kv,
      transport: t.transport,
      marmot: over.seam === undefined ? null : over.seam,
      keypair: () => keypair,
      relays: () => over.relays ?? ['wss://relay.example.com'],
      kpFetchTimeoutMs: 30,
      ...(over.now ? { now: over.now } : {}),
      ...(over.onIncoming ? { onIncoming: over.onIncoming } : {}),
    },
    over.initial,
  );
  return { store, keypair, kv, t };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// --- Pure helpers ---

describe('unified conversation list', () => {
  it('merges both protocols newest-first with protocol tags and routing keys', () => {
    const nip17: Record<string, DmConversation> = {
      p1: { peerPubkey: 'p1', protocol: 'nip17', lastMessageAt: 100, unreadCount: 1, lastPreview: 'old nip17' },
      p2: { peerPubkey: 'p2', protocol: 'nip17', lastMessageAt: 300, unreadCount: 0, lastPreview: 'new nip17' },
    };
    const marmot = {
      g1: { groupId: 'g1', hTag: 'h1', peerPubkey: 'p3', name: '', memberCount: 2, lastMessageAt: 200, unreadCount: 2, lastPreview: 'mls' },
    };
    const merged = unifiedConversations(nip17, marmot);
    expect(merged.map((c) => c.key)).toEqual(['p2', 'g1', 'p1']);
    expect(merged.map((c) => c.protocol)).toEqual(['nip17', 'marmot', 'nip17']);
    expect(merged[1]!.peerPubkey).toBe('p3');
    expect(merged[1]!.unreadCount).toBe(2);
  });
});

describe('pure helpers', () => {
  it('peerOfGroup picks the other member; empty when alone', () => {
    expect(peerOfGroup(['me', 'them'], 'me')).toBe('them');
    expect(peerOfGroup(['me'], 'me')).toBe('');
  });

  it('marmotSinceCursor = newest − grace; undefined without history', () => {
    expect(marmotSinceCursor({})).toBeUndefined();
    const at = 1_700_000_000_000;
    const cursor = marmotSinceCursor({
      g1: [{ id: 'a', groupId: 'g1', senderPubkey: 'x', content: 'x', at, status: 'sent' }],
    });
    expect(cursor).toBe(Math.floor(at / 1000) - 3600);
  });

  it('buildGroupMessageFilter routes by h tags', () => {
    expect(buildGroupMessageFilter(['h1', 'h2'], 123)).toEqual({
      kinds: [GROUP_MESSAGE_KIND],
      '#h': ['h1', 'h2'],
      since: 123,
    });
  });

  it('buildKpRelayListEvent is a signed kind-10051 with one relay tag each', () => {
    const kp = generateKeypair();
    const ev = buildKpRelayListEvent(kp, ['wss://a', 'wss://b'], 1000);
    expect(ev.kind).toBe(KP_RELAY_LIST_KIND);
    expect(ev.tags).toEqual([['relay', 'wss://a'], ['relay', 'wss://b']]);
    expect(ev.pubkey).toBe(kp.pubkeyHex);
  });
});

describe('fetchKeyPackage', () => {
  it('resolves the newest 30443 on EOSE and null on timeout', async () => {
    const t = fakeTransport();
    const peer = 'a'.repeat(64);
    const promise = fetchKeyPackage(t.transport, peer, 1000);
    const sub = t.subs[0]!;
    expect(sub.filter).toEqual({ kinds: [KEY_PACKAGE_KIND], authors: [peer] });
    const older = { ...fakeEvent(KEY_PACKAGE_KIND), pubkey: peer, created_at: 10, id: 'a'.repeat(64) };
    const newer = { ...fakeEvent(KEY_PACKAGE_KIND), pubkey: peer, created_at: 20, id: 'b'.repeat(64) };
    sub.params.onEvent(older);
    sub.params.onEvent(newer);
    sub.params.onEose?.();
    const got = await promise;
    expect(got?.id).toBe(newer.id);
    expect(sub.closed).toBe(true);

    const empty = await fetchKeyPackage(t.transport, peer, 20);
    expect(empty).toBeNull();
  });
});

// --- Store ---

describe('marmotStore start()', () => {
  it('without a seam: stays unavailable, no subscriptions, no publishes', async () => {
    const { store, t } = makeStore({ seam: null });
    store.getState().start();
    await settle();
    expect(store.getState().available).toBe(false);
    expect(t.subs).toHaveLength(0);
    expect(t.published).toHaveLength(0);
  });

  it('inits the engine with the identity secret, publishes KP + 10051 once, reconciles groups + welcomes, subscribes 445 by h tag', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    fake.state.groups.push({
      groupId: 'g1',
      hTag: 'h1',
      name: 'CodeDeck DM',
      members: [keypair.pubkeyHex, 'b'.repeat(64)],
      admins: [],
      active: true,
    });
    fake.state.pending.push(WELCOME);
    const { store, t } = makeStore({ keypair, seam: fake.seam });

    store.getState().start();
    await settle();

    expect(store.getState().available).toBe(true);
    // Secret reached the engine; never logged is Rust's contract.
    expect(fake.calls['init']).toHaveLength(1);

    // Conversation reconciled from the engine group list, peer resolved.
    const conv = store.getState().conversations['g1']!;
    expect(conv.hTag).toBe('h1');
    expect(conv.peerPubkey).toBe('b'.repeat(64));

    // Pending welcome surfaced.
    expect(store.getState().pendingWelcomes['w1']).toEqual(WELCOME);

    // KP (30443) + relay list (10051) published.
    expect(t.published.map((e) => e.kind).sort()).toEqual([KP_RELAY_LIST_KIND, KEY_PACKAGE_KIND].sort());

    // 445 subscription filtered on our group's h tag.
    const live = t.subs.find((s) => !s.closed)!;
    expect(live.filter.kinds).toEqual([GROUP_MESSAGE_KIND]);
    expect(live.filter['#h']).toEqual(['h1']);
    expect(store.getState().subscribed).toBe(true);

    // A second start() must not republish the KP for the same relay set.
    store.getState().start();
    await settle();
    expect(t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
  });
});

describe('welcome → accept → conversation lifecycle (with VEIL-029 re-feed)', () => {
  it('runs the full flow: early 445 buffered, welcome accepted, buffer re-fed, message lands', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const { store, t } = makeStore({ keypair, seam: fake.seam });
    store.getState().start();
    await settle();

    // The creator's first message races ahead of the welcome: not_joined.
    const early445 = fakeEvent(GROUP_MESSAGE_KIND, [['h', WELCOME.hTag]], '3'.repeat(64));
    fake.state.ingestScript.push({ type: 'not_joined', hTag: WELCOME.hTag });
    store.getState().ingestGroupMessage(early445);
    await settle();
    expect(store.getState().conversations[WELCOME.groupId]).toBeUndefined();

    // The gift-wrapped welcome arrives (routed from the dm store's 1059 sub).
    fake.state.ingestScript.push({ type: 'welcome', welcome: WELCOME });
    store.getState().ingestGiftWrap(fakeEvent(1059, [['p', keypair.pubkeyHex]], '4'.repeat(64)));
    await settle();
    expect(store.getState().pendingWelcomes['w1']).toBeTruthy();

    // Accept: group joined; the buffered 445 is re-fed and now decrypts.
    fake.state.ingestScript.push({
      type: 'message',
      groupId: WELCOME.groupId,
      id: 'r1',
      sender: WELCOME.welcomer,
      kind: 9,
      content: 'raced ahead',
      createdAt: Math.floor(Date.now() / 1000),
    });
    const ok = await store.getState().acceptWelcome('w1');
    await settle();
    expect(ok).toBe(true);
    expect(store.getState().pendingWelcomes['w1']).toBeUndefined();

    const conv = store.getState().conversations[WELCOME.groupId]!;
    expect(conv.peerPubkey).toBe(WELCOME.welcomer);
    expect(conv.unreadCount).toBe(1);
    expect(conv.lastPreview).toBe('raced ahead');
    expect(store.getState().messages[WELCOME.groupId]!.map((m) => m.content)).toEqual([
      'raced ahead',
    ]);

    // The 445 subscription now covers the joined group's h tag.
    const live = t.subs.filter((s) => !s.closed).find((s) => s.filter.kinds?.includes(GROUP_MESSAGE_KIND))!;
    expect(live.filter['#h']).toContain(WELCOME.hTag);
  });

  it('a dead welcome (accept throws) drops the card instead of retrying forever', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    fake.seam.acceptWelcome = async () => {
      throw new Error('welcome previously failed');
    };
    fake.state.pending.push(WELCOME);
    const { store } = makeStore({ keypair, seam: fake.seam });
    store.getState().start();
    await settle();
    expect(store.getState().pendingWelcomes['w1']).toBeTruthy();
    const ok = await store.getState().acceptWelcome('w1');
    expect(ok).toBe(false);
    expect(store.getState().pendingWelcomes['w1']).toBeUndefined();
  });
});

describe('send path', () => {
  it('publishes EXACTLY the engine event, echoes optimistically under the rumor id, dedups the relay echo', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const { store, t } = makeStore({ keypair, seam: fake.seam });
    store.getState().start();
    await settle();

    const msg = await store.getState().send('g1', 'hello mls');
    expect(msg?.status).toBe('sent');
    expect(msg?.id).toBe('rumor-1');
    const published445 = t.published.find((e) => e.kind === GROUP_MESSAGE_KIND)!;
    expect(published445.tags).toEqual([['h', 'h1']]); // the engine's event, untouched

    // The relay echoes our own 445 back — the engine resolves it to the SAME
    // rumor id, and the store must not duplicate it.
    fake.state.ingestScript.push({
      type: 'message',
      groupId: 'g1',
      id: 'rumor-1',
      sender: keypair.pubkeyHex,
      kind: 9,
      content: 'hello mls',
      createdAt: Math.floor(Date.now() / 1000),
    });
    store.getState().ingestGroupMessage(published445);
    await settle();
    expect(store.getState().messages['g1']).toHaveLength(1);
    // Own echo never counts unread.
    expect(store.getState().conversations['g1']!.unreadCount).toBe(0);
  });

  it('publish rejection → failed status; retry replaces the failed entry', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const { store, t } = makeStore({ keypair, seam: fake.seam });
    t.setPublishOk(false);
    const failed = await store.getState().send('g1', 'wont go');
    expect(failed?.status).toBe('failed');
    expect(store.getState().messages['g1']).toHaveLength(1);

    t.setPublishOk(true);
    await store.getState().retry('g1', failed!.id);
    const after = store.getState().messages['g1']!;
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('sent');
    expect(after[0]!.content).toBe('wont go');
    expect(after[0]!.id).not.toBe(failed!.id); // fresh rumor
  });

  it('engine failure (seam send throws) still surfaces a failed message', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    fake.seam.send = async () => {
      throw new Error('mls says no');
    };
    const { store } = makeStore({ keypair, seam: fake.seam });
    const msg = await store.getState().send('g1', 'doomed');
    expect(msg?.status).toBe('failed');
    expect(store.getState().diagnostics.errors).toBe(1);
  });
});

describe('startChat flow', () => {
  it('no published KeyPackage → no-key-package (and no group created)', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const { store } = makeStore({ keypair, seam: fake.seam });
    store.getState().start();
    await settle();
    const result = await store.getState().startChat('c'.repeat(64));
    expect(result).toEqual({ ok: false, reason: 'no-key-package' });
    expect(fake.calls['createGroup']).toBeUndefined();
  });

  it('fetches the peer KP, creates the group, publishes the wrapped welcome, opens the conversation', async () => {
    const keypair = generateKeypair();
    const peer = 'c'.repeat(64);
    const fake = fakeSeam(keypair);
    const { store, t } = makeStore({ keypair, seam: fake.seam });
    store.getState().start();
    await settle();

    const promise = store.getState().startChat(peer);
    await settle();
    // Answer the KP lookup subscription.
    const kpSub = t.subs.find((s) => !s.closed && s.filter.kinds?.includes(KEY_PACKAGE_KIND))!;
    const kpEvent = { ...fakeEvent(KEY_PACKAGE_KIND, [['d', 'kp']]), pubkey: peer };
    kpSub.params.onEvent(kpEvent);
    kpSub.params.onEose?.();

    const result = await promise;
    expect(result).toEqual({ ok: true, groupId: 'g-new' });
    expect(fake.calls['createGroup']![0]![0]).toBe(peer);
    // The gift-wrapped welcome was published.
    expect(t.published.some((e) => e.kind === 1059)).toBe(true);
    const conv = store.getState().conversations['g-new']!;
    expect(conv.peerPubkey).toBe(peer);
    expect(conv.hTag).toBe('h-new');

    // Starting again with the same peer opens the SAME group (no dup).
    const again = await store.getState().startChat(peer);
    expect(again).toEqual({ ok: true, groupId: 'g-new' });
    expect(fake.calls['createGroup']).toHaveLength(1);
  });
});

describe('unread gating + notifications seam', () => {
  it('onIncoming fires with countsUnread=false while the group is active', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const incoming: Array<{ content: string; countsUnread: boolean }> = [];
    const { store } = makeStore({
      keypair,
      seam: fake.seam,
      onIncoming: (msg, countsUnread) => incoming.push({ content: msg.content, countsUnread }),
    });

    store.getState().setActiveGroup('g1');
    fake.state.ingestScript.push({
      type: 'message', groupId: 'g1', id: 'r10', sender: 'd'.repeat(64), kind: 9,
      content: 'seen live', createdAt: Math.floor(Date.now() / 1000),
    });
    store.getState().ingestGroupMessage(fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], '5'.repeat(64)));
    await settle();

    store.getState().setActiveGroup(null);
    fake.state.ingestScript.push({
      type: 'message', groupId: 'g1', id: 'r11', sender: 'd'.repeat(64), kind: 9,
      content: 'unread', createdAt: Math.floor(Date.now() / 1000),
    });
    store.getState().ingestGroupMessage(fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], '6'.repeat(64)));
    await settle();

    expect(incoming).toEqual([
      { content: 'seen live', countsUnread: false },
      { content: 'unread', countsUnread: true },
    ]);
    expect(store.getState().conversations['g1']!.unreadCount).toBe(1);
    store.getState().markRead('g1');
    expect(store.getState().conversations['g1']!.unreadCount).toBe(0);
  });

  it('non-chat rumors (reactions etc.) decrypt but are not rendered as messages', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const { store } = makeStore({ keypair, seam: fake.seam });
    fake.state.ingestScript.push({
      type: 'message', groupId: 'g1', id: 'r12', sender: 'd'.repeat(64), kind: 7,
      content: '👍', createdAt: Math.floor(Date.now() / 1000),
    });
    store.getState().ingestGroupMessage(fakeEvent(GROUP_MESSAGE_KIND, [['h', 'h1']], '7'.repeat(64)));
    await settle();
    expect(store.getState().messages['g1']).toBeUndefined();
  });
});

describe('persistence', () => {
  it('conversations + messages survive a store rebuild via KV', async () => {
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const kv = memoryKV();
    const { store } = makeStore({ keypair, seam: fake.seam, kv });
    await store.getState().send('g1', 'persist me');
    await settle();

    const persisted = await loadPersistedMarmot(kv);
    expect(persisted.messages['g1']![0]!.content).toBe('persist me');

    const { store: rebuilt } = makeStore({ keypair, seam: fake.seam, kv });
    // A fresh store hydrates from the same KV via createMarmotStore(initial).
    const rebuiltStore = createMarmotStore(
      {
        kv,
        transport: fakeTransport().transport,
        marmot: fake.seam,
        keypair: () => keypair,
        relays: () => [],
      },
      persisted,
    );
    expect(rebuiltStore.getState().messages['g1']![0]!.content).toBe('persist me');
    expect(rebuilt.getState().messages['g1']).toBeUndefined(); // no initial passed
    expect(store.getState().conversations['g1']!.lastPreview).toBe('persist me');
  });

  it('hydrate tolerates garbage', async () => {
    const kv = memoryKV({ marmot: 'not json' });
    const persisted = await loadPersistedMarmot(kv);
    expect(persisted).toEqual({ conversations: {}, messages: {}, keyPackage: null });
  });
});

// --- CDX-030: KeyPackage mint-once (persisted across app starts) ---

describe('KeyPackage mint-once (CDX-030)', () => {
  const RELAYS = ['wss://relay.example.com'];
  const PAYLOAD = JSON.stringify(RELAYS);

  /** Simulate one app start against a shared KV; returns its transport. */
  async function appStart(
    kv: ReturnType<typeof memoryKV>,
    keypair: Keypair,
    opts: { now?: () => number; relays?: string[] } = {},
  ) {
    const fake = fakeSeam(keypair);
    const t = fakeTransport();
    const initial = await loadPersistedMarmot(kv);
    const { store } = makeStore({
      keypair,
      kv,
      transport: t,
      seam: fake.seam,
      initial,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.relays ? { relays: opts.relays } : {}),
    });
    store.getState().start();
    await settle();
    return { store, t, fake };
  }

  it('shouldMintKeyPackage: none / consumed / relay change / rotation mint; fresh does not', () => {
    const fresh: PublishedKeyPackage = {
      id: 'e'.repeat(64),
      dTag: 'kp',
      relaysPayload: PAYLOAD,
      publishedAt: 1_000,
      consumed: false,
    };
    expect(shouldMintKeyPackage(null, PAYLOAD, 2_000)).toBe(true);
    expect(shouldMintKeyPackage(undefined, PAYLOAD, 2_000)).toBe(true);
    expect(shouldMintKeyPackage(fresh, PAYLOAD, 2_000)).toBe(false);
    expect(shouldMintKeyPackage({ ...fresh, consumed: true }, PAYLOAD, 2_000)).toBe(true);
    expect(shouldMintKeyPackage(fresh, JSON.stringify(['wss://other']), 2_000)).toBe(true);
    expect(shouldMintKeyPackage(fresh, PAYLOAD, 1_000 + KEY_PACKAGE_ROTATION_MS)).toBe(true);
    expect(shouldMintKeyPackage(fresh, PAYLOAD, 999 + KEY_PACKAGE_ROTATION_MS)).toBe(false);
  });

  it('two consecutive app starts publish exactly one KP (the run-sheet oracle)', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();

    const first = await appStart(kv, keypair);
    expect(first.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
    expect(first.fake.calls['publishKeyPackage']).toHaveLength(1);

    const second = await appStart(kv, keypair);
    // The persisted KP identity suppresses the re-mint entirely: the engine
    // is never even asked for a new KP.
    expect(second.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(0);
    expect(second.fake.calls['publishKeyPackage']).toBeUndefined();
    // The replaceable kind-10051 keeps its per-run publish (unchanged).
    expect(second.t.published.filter((e) => e.kind === KP_RELAY_LIST_KIND)).toHaveLength(1);
  });

  it('a welcome consumes the stored KP → the next start republishes', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();

    const first = await appStart(kv, keypair);
    // A peer invites us — one of our one-shot KPs was consumed.
    first.fake.state.ingestScript.push({ type: 'welcome', welcome: WELCOME });
    first.store.getState().ingestGiftWrap(fakeEvent(1059, [['p', keypair.pubkeyHex]], '5'.repeat(64)));
    await settle();
    expect(first.store.getState().publishedKeyPackage?.consumed).toBe(true);

    const second = await appStart(kv, keypair);
    expect(second.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
    expect(second.store.getState().publishedKeyPackage?.consumed).toBe(false);
  });

  it('rotation: a KP older than 30 days republishes; a younger one does not', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();
    const t0 = 1_700_000_000_000;

    await appStart(kv, keypair, { now: () => t0 });

    const young = await appStart(kv, keypair, { now: () => t0 + 24 * 60 * 60 * 1000 });
    expect(young.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(0);

    const old = await appStart(kv, keypair, { now: () => t0 + KEY_PACKAGE_ROTATION_MS + 1 });
    expect(old.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
    expect(old.store.getState().publishedKeyPackage?.publishedAt).toBe(
      t0 + KEY_PACKAGE_ROTATION_MS + 1,
    );
  });

  it('a changed relay set republishes so the new relays carry a KP', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();
    await appStart(kv, keypair);
    const moved = await appStart(kv, keypair, { relays: ['wss://new.example.com'] });
    expect(moved.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
  });

  it('a rejected KP publish stores nothing — the next start retries', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();
    const fake = fakeSeam(keypair);
    const t = fakeTransport({ publishOk: false });
    const { store } = makeStore({ keypair, kv, transport: t, seam: fake.seam });
    store.getState().start();
    await settle();
    expect(store.getState().publishedKeyPackage).toBeNull();

    const retry = await appStart(kv, keypair);
    expect(retry.t.published.filter((e) => e.kind === KEY_PACKAGE_KIND)).toHaveLength(1);
  });

  it('the KP record round-trips through persistence (id, d tag, payload, timestamps)', async () => {
    const kv = memoryKV();
    const keypair = generateKeypair();
    const t0 = 1_700_000_000_000;
    await appStart(kv, keypair, { now: () => t0 });

    const persisted = await loadPersistedMarmot(kv);
    expect(persisted.keyPackage).toEqual({
      id: 'e'.repeat(64),
      dTag: 'kp',
      relaysPayload: PAYLOAD,
      publishedAt: t0,
      consumed: false,
    });

    // Garbage KP records hydrate to null, not a crash.
    expect(
      hydrateMarmot(JSON.stringify({ conversations: {}, messages: {}, keyPackage: { id: 42 } }))
        .keyPackage,
    ).toBeNull();
    expect(
      hydrateMarmot(JSON.stringify({ conversations: {}, messages: {}, keyPackage: 'nope' }))
        .keyPackage,
    ).toBeNull();
  });
});
