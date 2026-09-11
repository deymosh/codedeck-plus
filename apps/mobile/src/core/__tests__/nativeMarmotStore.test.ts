/**
 * nativeMarmotStore — proves the adapter presents the SAME `MarmotStoreState`
 * shape `createMarmotStore` does: hydration from `marmotView()` (including
 * `available` and `pendingWelcomes`), refresh on the marmot slice's
 * `stateChanged`, each mutator's dispatched `Intent`, and the best-effort
 * inference `startChat`/`acceptWelcome` do from a post-dispatch refresh.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeMarmotStore } from '../stores/nativeMarmot';
import { generateKeypair } from '../crypto';
import type { CoreEvent, Intent, MarmotView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

const peer = generateKeypair().pubkeyHex;

const emptyView = (): MarmotView => ({
  available: false,
  conversations: [],
  messages: {},
  activeGroup: null,
  eventsReceived: 0,
  ignored: 0,
  errors: 0,
  buffered: 0,
  pendingWelcomes: {},
});

function fakeCore(initialView: MarmotView | null = emptyView()) {
  let view: MarmotView | null = initialView;
  const dispatched: Intent[] = [];
  let coreEventListener: ((e: CoreEvent) => void) | null = null;

  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: vi.fn(async () => view),
    onCoreEvent: vi.fn(async (cb: (e: CoreEvent) => void) => {
      coreEventListener = cb;
      return () => {
        coreEventListener = null;
      };
    }),
  };

  return {
    core,
    dispatched,
    setView: (next: MarmotView | null) => {
      view = next;
    },
    emitStateChanged: (slice: SliceId) => {
      coreEventListener?.({ stateChanged: { slice } });
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createNativeMarmotStore', () => {
  it('hydrates available/conversations/messages/pendingWelcomes/diagnostics from marmotView()', async () => {
    const { core } = fakeCore({
      available: true,
      conversations: [{ groupId: 'g1', hTag: 'h1', peerPubkey: peer, name: '', memberCount: 2, lastMessageAt: 5, unreadCount: 1, lastPreview: 'hi' }],
      messages: { g1: [{ id: 'm1', groupId: 'g1', senderPubkey: peer, content: 'hi', at: 5, status: 'delivered' }] },
      activeGroup: 'g1',
      eventsReceived: 2,
      ignored: 1,
      errors: 0,
      buffered: 3,
      pendingWelcomes: { w1: { welcomeId: 'w1', wrapperId: 'wrap1', groupId: 'g2', hTag: 'h2', name: '', welcomer: peer, memberCount: 2 } },
    });
    const store = createNativeMarmotStore({ core });
    await tick();

    expect(store.getState().available).toBe(true);
    expect(store.getState().conversations.g1?.unreadCount).toBe(1);
    expect(store.getState().messages.g1?.[0]?.content).toBe('hi');
    expect(store.getState().activeGroup).toBe('g1');
    expect(store.getState().diagnostics).toEqual({ eventsReceived: 2, ignored: 1, errors: 0 });
    expect(store.getState().pendingWelcomes.w1?.welcomer).toBe(peer);
  });

  it('start/stop/ingestGiftWrap/ingestGroupMessage are no-ops', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    store.getState().start();
    store.getState().stop();
    store.getState().ingestGiftWrap({} as never);
    store.getState().ingestGroupMessage({} as never);
    expect(dispatched).toEqual([]);
    expect(store.getState().subscribed).toBe(true);
  });

  it('send dispatches sendMarmotMessage, refreshes, and returns the newest message', async () => {
    const { core, dispatched, setView } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    setView({
      ...emptyView(),
      conversations: [{ groupId: 'g1', hTag: 'h1', peerPubkey: peer, name: '', memberCount: 2, lastMessageAt: 10, unreadCount: 0, lastPreview: 'hello' }],
      messages: { g1: [{ id: 'm1', groupId: 'g1', senderPubkey: 'me', content: 'hello', at: 10, status: 'sent' }] },
    });

    const msg = await store.getState().send('g1', 'hello');
    expect(dispatched).toEqual([{ sendMarmotMessage: { groupId: 'g1', text: 'hello' } }]);
    expect(msg?.id).toBe('m1');
  });

  it('retry re-dispatches sendMarmotMessage with the failed content and is a no-op when nothing matches', async () => {
    const { core, dispatched, setView } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    await store.getState().retry('g1', 'nope');
    expect(dispatched).toEqual([]);

    setView({ ...emptyView(), messages: { g1: [{ id: 'm1', groupId: 'g1', senderPubkey: 'me', content: 'oops', at: 1, status: 'failed' }] } });
    await store.getState().send('g1', 'unrelated');
    dispatched.length = 0;

    await store.getState().retry('g1', 'm1');
    expect(dispatched).toEqual([{ sendMarmotMessage: { groupId: 'g1', text: 'oops' } }]);
  });

  it('startChat fails fast as unavailable without dispatching when the engine is not available', async () => {
    const { core, dispatched } = fakeCore({ ...emptyView(), available: false });
    const store = createNativeMarmotStore({ core });
    await tick();

    const result = await store.getState().startChat(peer);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(dispatched).toEqual([]);
  });

  it('startChat reuses an existing conversation for the peer without dispatching', async () => {
    const { core, dispatched } = fakeCore({
      ...emptyView(),
      available: true,
      conversations: [{ groupId: 'g1', hTag: 'h1', peerPubkey: peer, name: '', memberCount: 2, lastMessageAt: 1, unreadCount: 0, lastPreview: '' }],
    });
    const store = createNativeMarmotStore({ core });
    await tick();

    const result = await store.getState().startChat(peer);
    expect(result).toEqual({ ok: true, groupId: 'g1' });
    expect(dispatched).toEqual([]);
  });

  it('startChat dispatches startMarmotChat and reports failed when no conversation appears after refresh', async () => {
    const { core, dispatched } = fakeCore({ ...emptyView(), available: true });
    const store = createNativeMarmotStore({ core });
    await tick();

    const result = await store.getState().startChat(peer);
    expect(dispatched).toEqual([{ startMarmotChat: { peerPubkey: peer } }]);
    expect(result).toEqual({ ok: false, reason: 'failed' });
  });

  it('startChat reports ok once the refreshed view shows the new conversation', async () => {
    const { core, setView } = fakeCore({ ...emptyView(), available: true });
    const store = createNativeMarmotStore({ core });
    await tick();

    // Simulate the engine having created the group by the time dispatch()
    // resolves and this adapter's post-dispatch refresh runs.
    setView({
      ...emptyView(),
      available: true,
      conversations: [{ groupId: 'g-new', hTag: 'h-new', peerPubkey: peer, name: '', memberCount: 2, lastMessageAt: 1, unreadCount: 0, lastPreview: '' }],
    });

    const result = await store.getState().startChat(peer);
    expect(result).toEqual({ ok: true, groupId: 'g-new' });
  });

  it('acceptWelcome dispatches acceptMarmotWelcome and reports true once the welcome clears', async () => {
    const { core, dispatched, setView } = fakeCore({
      ...emptyView(),
      pendingWelcomes: { w1: { welcomeId: 'w1', wrapperId: 'wrap1', groupId: 'g1', hTag: 'h1', name: '', welcomer: peer, memberCount: 2 } },
    });
    const store = createNativeMarmotStore({ core });
    await tick();

    setView({ ...emptyView(), pendingWelcomes: {} }); // simulate the accept having landed
    const ok = await store.getState().acceptWelcome('w1');
    expect(dispatched).toEqual([{ acceptMarmotWelcome: { welcomeId: 'w1' } }]);
    expect(ok).toBe(true);
  });

  it('acceptWelcome reports false when the welcome is still pending after the refresh', async () => {
    const { core } = fakeCore({
      ...emptyView(),
      pendingWelcomes: { w1: { welcomeId: 'w1', wrapperId: 'wrap1', groupId: 'g1', hTag: 'h1', name: '', welcomer: peer, memberCount: 2 } },
    });
    const store = createNativeMarmotStore({ core });
    await tick();

    const ok = await store.getState().acceptWelcome('w1');
    expect(ok).toBe(false);
  });

  it('setActiveGroup sets state optimistically and dispatches selectMarmotGroup', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    store.getState().setActiveGroup('g1');
    expect(store.getState().activeGroup).toBe('g1');
    expect(dispatched).toEqual([{ selectMarmotGroup: { groupId: 'g1' } }]);
  });

  it('markRead dispatches markMarmotRead', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    store.getState().markRead('g1');
    expect(dispatched).toEqual([{ markMarmotRead: { groupId: 'g1' } }]);
  });

  it('a stateChanged("marmot") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    setView({ ...emptyView(), available: true });
    emitStateChanged('marmot');
    await tick();

    expect(store.getState().available).toBe(true);
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeMarmotStore({ core });
    await tick();

    setView({ ...emptyView(), available: true });
    emitStateChanged('dm');
    await tick();

    expect(store.getState().available).toBe(false);
  });
});
