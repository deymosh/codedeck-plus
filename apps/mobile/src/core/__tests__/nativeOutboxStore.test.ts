/**
 * nativeOutboxStore — proves the adapter presents the SAME `OutboxStoreState`
 * shape `createOutboxStore` does, but drives every mutation through
 * `NativeCore.dispatch` and refreshes from `outboxView()` on the outbox
 * slice's `stateChanged` event, never mutating local state on its own.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeOutboxStore } from '../stores/nativeOutbox';
import type { CoreEvent, Intent, OutboxView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

/** A minimal, scriptable `NativeCore` double — only the methods this store
 *  touches need real behavior; everything else throws if called. */
function fakeCore(initialView: OutboxView = { items: [] }) {
  let view = initialView;
  const dispatched: Intent[] = [];
  let coreEventListener: ((e: CoreEvent) => void) | null = null;

  const core: NativeCore = {
    defaults: () => Promise.reject(new Error('unused')),
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: vi.fn(async () => view),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
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
    setView: (next: OutboxView) => {
      view = next;
    },
    emitStateChanged: (slice: SliceId) => {
      coreEventListener?.({ stateChanged: { slice } });
    },
  };
}

/** Let the store's fire-and-forget `refresh()`/`onCoreEvent()` promises settle. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createNativeOutboxStore', () => {
  it('hydrates from outboxView() on creation', async () => {
    const { core } = fakeCore({
      items: [
        {
          id: 'in-1',
          machine: 'm1',
          sessionId: 's1',
          text: 'hi',
          state: 'confirmed',
          createdAt: 1000,
          publishedAt: 1001,
          confirmedAt: 1002,
          failedAt: null,
          error: null,
          attempts: 1,
        },
      ],
    });
    const store = createNativeOutboxStore({ core });
    await tick();

    expect(store.getState().item('in-1')).toEqual({
      id: 'in-1',
      machine: 'm1',
      sessionId: 's1',
      text: 'hi',
      state: 'confirmed',
      createdAt: 1000,
      publishedAt: 1001,
      confirmedAt: 1002,
      failedAt: null,
      error: null,
      attempts: 1,
    });
  });

  it('send dispatches sendInput with a fresh id and refreshes from the view', async () => {
    const { core, dispatched, setView } = fakeCore();
    const store = createNativeOutboxStore({ core, newId: () => 'in-fresh' });
    await tick();

    setView({
      items: [
        {
          id: 'in-fresh',
          machine: 'm1',
          sessionId: 's1',
          text: 'do the thing',
          state: 'published',
          createdAt: 2000,
          publishedAt: 2001,
          confirmedAt: null,
          failedAt: null,
          error: null,
          attempts: 1,
        },
      ],
    });
    const item = await store.getState().send('m1', 's1', 'do the thing');

    expect(dispatched).toEqual([
      { sendInput: { machine: 'm1', sessionId: 's1', text: 'do the thing', inputId: 'in-fresh' } },
    ]);
    expect(item.state).toBe('published');
    expect(store.getState().item('in-fresh')?.state).toBe('published');
  });

  it('retry dispatches retryOutboxItem for a known item and no-ops for an unknown one', async () => {
    const { core, dispatched } = fakeCore({
      items: [
        {
          id: 'in-1',
          machine: 'm1',
          sessionId: 's1',
          text: 'x',
          state: 'failed',
          createdAt: 1,
          publishedAt: null,
          confirmedAt: null,
          failedAt: 2,
          error: 'boom',
          attempts: 1,
        },
      ],
    });
    const store = createNativeOutboxStore({ core });
    await tick();

    expect(await store.getState().retry('missing')).toBeUndefined();
    await store.getState().retry('in-1');
    expect(dispatched).toEqual([{ retryOutboxItem: { machine: 'm1', id: 'in-1' } }]);
  });

  it('sweep is a no-op — the Rust Router owns the confirm-timeout transition', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativeOutboxStore({ core });
    await tick();

    store.getState().sweep();
    expect(dispatched).toEqual([]);
  });

  it('a stateChanged("outbox") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeOutboxStore({ core });
    await tick();
    expect(store.getState().items).toEqual({});

    setView({
      items: [
        {
          id: 'in-2',
          machine: 'm1',
          sessionId: 's1',
          text: 'pushed by the bridge',
          state: 'confirmed',
          createdAt: 3000,
          publishedAt: 3001,
          confirmedAt: 3002,
          failedAt: null,
          error: null,
          attempts: 1,
        },
      ],
    });
    emitStateChanged('outbox');
    await tick();

    expect(store.getState().item('in-2')?.text).toBe('pushed by the bridge');
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeOutboxStore({ core });
    await tick();

    setView({
      items: [
        {
          id: 'in-3',
          machine: 'm1',
          sessionId: 's1',
          text: 'irrelevant',
          state: 'pending',
          createdAt: 1,
          publishedAt: null,
          confirmedAt: null,
          failedAt: null,
          error: null,
          attempts: 1,
        },
      ],
    });
    emitStateChanged('machines');
    await tick();

    expect(store.getState().items).toEqual({});
  });

  it('itemsFor / unresolved filter as expected', async () => {
    const { core } = fakeCore({
      items: [
        { id: 'a', machine: 'm1', sessionId: 's1', text: '1', state: 'pending', createdAt: 1, publishedAt: null, confirmedAt: null, failedAt: null, error: null, attempts: 1 },
        { id: 'b', machine: 'm1', sessionId: 's1', text: '2', state: 'confirmed', createdAt: 2, publishedAt: 3, confirmedAt: 4, failedAt: null, error: null, attempts: 1 },
        { id: 'c', machine: 'm1', sessionId: 's2', text: '3', state: 'published', createdAt: 5, publishedAt: 6, confirmedAt: null, failedAt: null, error: null, attempts: 1 },
      ],
    });
    const store = createNativeOutboxStore({ core });
    await tick();

    expect(store.getState().itemsFor('m1', 's1').map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(store.getState().unresolved().map((i) => i.id).sort()).toEqual(['a', 'c']);
  });
});
