/**
 * nativeDmStore — proves the adapter presents the SAME `DmStoreState` shape
 * `createDmStore` does: hydration from `dmView()`, refresh on the dm slice's
 * `stateChanged`, each mutator's dispatched `Intent`, the sync format
 * pre-check on `startConversation`, and the locally-cached profile
 * resolution layered on top (no Rust view backs it yet).
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeDmStore } from '../stores/nativeDm';
import { generateKeypair } from '../crypto';
import type { CoreEvent, DmView, Intent, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';
import type { DmProfile, ProfileFetcher } from '../stores/dm';

const peer = generateKeypair().pubkeyHex;

function fakeCore(initialView: DmView | null = { conversations: [], messages: {}, activePeer: null, eventsReceived: 0, unwrapFailures: 0, invalidRumors: 0 }) {
  let view: DmView | null = initialView;
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
    dmView: vi.fn(async () => view),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
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
    setView: (next: DmView | null) => {
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

describe('createNativeDmStore', () => {
  it('hydrates conversations/messages/activePeer/diagnostics from dmView() on creation', async () => {
    const { core } = fakeCore({
      conversations: [{ peerPubkey: peer, protocol: 'nip17', lastMessageAt: 5, unreadCount: 2, lastPreview: 'hi' }],
      messages: { [peer]: [{ id: 'm1', peerPubkey: peer, senderPubkey: peer, content: 'hi', at: 5, status: 'delivered' }] },
      activePeer: peer,
      eventsReceived: 3,
      unwrapFailures: 1,
      invalidRumors: 0,
    });
    const store = createNativeDmStore({ core });
    await tick();

    expect(store.getState().conversations[peer]?.unreadCount).toBe(2);
    expect(store.getState().messages[peer]?.[0]?.content).toBe('hi');
    expect(store.getState().activePeer).toBe(peer);
    expect(store.getState().diagnostics).toEqual({ eventsReceived: 3, unwrapFailures: 1, invalidRumors: 0 });
  });

  it('start/stop/ingest are no-ops — client-runtime owns the 1059 subscription', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    store.getState().start();
    store.getState().stop();
    store.getState().ingest({} as never);
    expect(dispatched).toEqual([]);
    expect(store.getState().subscribed).toBe(true);
  });

  it('send dispatches sendDm, refreshes, and returns the newest message for that peer', async () => {
    const { core, dispatched, setView } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    setView({
      conversations: [{ peerPubkey: peer, protocol: 'nip17', lastMessageAt: 10, unreadCount: 0, lastPreview: 'hello' }],
      messages: { [peer]: [{ id: 'm1', peerPubkey: peer, senderPubkey: 'me', content: 'hello', at: 10, status: 'sent' }] },
      activePeer: null,
      eventsReceived: 0,
      unwrapFailures: 0,
      invalidRumors: 0,
    });

    const msg = await store.getState().send(peer, 'hello');
    expect(dispatched).toEqual([{ sendDm: { peer, text: 'hello' } }]);
    expect(msg.content).toBe('hello');
    expect(msg.id).toBe('m1');
  });

  it('retry re-dispatches sendDm with the failed message content and is a no-op when nothing matches', async () => {
    const { core, dispatched, setView } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    // Nothing failed yet — no-op.
    await store.getState().retry(peer, 'nope');
    expect(dispatched).toEqual([]);

    setView({
      conversations: [],
      messages: { [peer]: [{ id: 'm1', peerPubkey: peer, senderPubkey: 'me', content: 'oops', at: 1, status: 'failed' }] },
      activePeer: null,
      eventsReceived: 0,
      unwrapFailures: 0,
      invalidRumors: 0,
    });
    // Force the store to see the failed message before retrying.
    await store.getState().send(peer, 'unrelated'); // triggers a refresh as a side effect
    dispatched.length = 0;

    await store.getState().retry(peer, 'm1');
    expect(dispatched).toEqual([{ sendDm: { peer, text: 'oops' } }]);
  });

  it('startConversation validates the format synchronously and dispatches in the background', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    expect(store.getState().startConversation('not-valid')).toBeNull();
    expect(store.getState().startConversation(peer)).toBe(peer);
    await tick();
    expect(dispatched).toEqual([{ startDmConversation: { peerInput: peer } }]);
  });

  it('setActivePeer sets state optimistically and dispatches selectDmPeer', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    store.getState().setActivePeer(peer);
    expect(store.getState().activePeer).toBe(peer);
    expect(dispatched).toEqual([{ selectDmPeer: { peer } }]);

    store.getState().setActivePeer(null);
    expect(store.getState().activePeer).toBeNull();
    expect(dispatched.at(-1)).toEqual({ selectDmPeer: { peer: null } });
  });

  it('markRead dispatches markDmRead', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    store.getState().markRead(peer);
    expect(dispatched).toEqual([{ markDmRead: { peer } }]);
  });

  it('a stateChanged("dm") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    setView({
      conversations: [{ peerPubkey: peer, protocol: 'nip17', lastMessageAt: 1, unreadCount: 1, lastPreview: 'x' }],
      messages: {},
      activePeer: null,
      eventsReceived: 0,
      unwrapFailures: 0,
      invalidRumors: 0,
    });
    emitStateChanged('dm');
    await tick();

    expect(store.getState().conversations[peer]).toBeDefined();
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();

    setView({
      conversations: [{ peerPubkey: peer, protocol: 'nip17', lastMessageAt: 1, unreadCount: 1, lastPreview: 'x' }],
      messages: {},
      activePeer: null,
      eventsReceived: 0,
      unwrapFailures: 0,
      invalidRumors: 0,
    });
    emitStateChanged('marmot');
    await tick();

    expect(store.getState().conversations[peer]).toBeUndefined();
  });

  it('resolveProfile fetches, caches, and skips a re-fetch inside the TTL unless forced', async () => {
    const { core } = fakeCore();
    const okProfile: DmProfile = { name: 'Alice', fetchedAt: Date.now(), status: 'ok' };
    const fetcher: ProfileFetcher = vi.fn(async () => okProfile);
    const store = createNativeDmStore({ core, profileFetcher: fetcher });
    await tick();

    await store.getState().resolveProfile(peer);
    expect(store.getState().profiles[peer]).toEqual(okProfile);
    expect(store.getState().profileStatus[peer]).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(1);

    await store.getState().resolveProfile(peer);
    expect(fetcher).toHaveBeenCalledTimes(1); // cached, within TTL

    await store.getState().resolveProfile(peer, { force: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resolveProfile is a no-op with no fetcher configured', async () => {
    const { core } = fakeCore();
    const store = createNativeDmStore({ core });
    await tick();
    await store.getState().resolveProfile(peer);
    expect(store.getState().profiles[peer]).toBeUndefined();
  });

  it('resolveAllProfiles resolves every conversation peer', async () => {
    const other = generateKeypair().pubkeyHex;
    const { core, setView } = fakeCore();
    const fetcher: ProfileFetcher = vi.fn(async (pk) => ({ name: pk.slice(0, 4), fetchedAt: Date.now(), status: 'ok' as const }));
    const store = createNativeDmStore({ core, profileFetcher: fetcher });
    await tick();

    setView({
      conversations: [
        { peerPubkey: peer, protocol: 'nip17', lastMessageAt: 1, unreadCount: 0, lastPreview: '' },
        { peerPubkey: other, protocol: 'nip17', lastMessageAt: 2, unreadCount: 0, lastPreview: '' },
      ],
      messages: {},
      activePeer: null,
      eventsReceived: 0,
      unwrapFailures: 0,
      invalidRumors: 0,
    });
    await store.getState().send(peer, 'x'); // triggers a refresh so conversations populate
    await tick();

    store.getState().resolveAllProfiles();
    await tick();

    expect(fetcher).toHaveBeenCalledWith(peer);
    expect(fetcher).toHaveBeenCalledWith(other);
  });
});
