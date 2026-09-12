/**
 * nativePendingSessionsStore — proves the adapter presents the SAME
 * `PendingSessionsStoreState` shape `createPendingSessionsStore` does:
 * hydration from `pendingSessionsView()`, refresh on the pendingSessions
 * slice's `stateChanged`, `dismiss`'s dispatched `Intent`, every other
 * mutator being an inert no-op, and `pendingFor`'s filtering/ordering.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativePendingSessionsStore } from '../stores/nativePendingSessions';
import type { CoreEvent, Intent, PendingSessionsView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

function fakeCore(initialView: PendingSessionsView = { pending: {} }) {
  let view: PendingSessionsView = initialView;
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
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: vi.fn(async () => view),
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
    setView: (next: PendingSessionsView) => {
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
}

describe('createNativePendingSessionsStore', () => {
  it('hydrates from pendingSessionsView() on creation', async () => {
    const { core } = fakeCore({
      pending: { p1: { pendingId: 'p1', machine: 'm1', machineName: 'devbox', createdAt: 't', state: 'pending', seenAt: 100 } },
    });
    const store = createNativePendingSessionsStore({ core });
    await tick();

    expect(store.getState().pending.p1?.machineName).toBe('devbox');
  });

  it('dismiss dispatches dismissPendingSession', async () => {
    const { core, dispatched } = fakeCore();
    const store = createNativePendingSessionsStore({ core });
    await tick();

    store.getState().dismiss('p1');
    expect(dispatched).toEqual([{ dismissPendingSession: { pendingId: 'p1' } }]);
  });

  it('pendingFor filters by machine, includes machine-less failures for every machine, and sorts oldest first', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePendingSessionsStore({ core });
    await tick();

    setView({
      pending: {
        p1: { pendingId: 'p1', machine: 'm1', machineName: 'devbox', createdAt: 't', state: 'pending', seenAt: 100 },
        p2: { pendingId: 'p2', machine: 'm1', machineName: 'devbox', createdAt: 't', state: 'pending', seenAt: 50 },
        ghost: { pendingId: 'ghost', machine: '', machineName: '', createdAt: '', state: 'failed', reason: 'boom', seenAt: 10 },
        other: { pendingId: 'other', machine: 'm2', machineName: 'laptop', createdAt: 't', state: 'pending', seenAt: 5 },
      },
    });
    emitStateChanged('pendingSessions');
    await tick();

    expect(store.getState().pendingFor('m1').map((p) => p.pendingId)).toEqual(['ghost', 'p2', 'p1']);
    expect(store.getState().pendingFor('m2').map((p) => p.pendingId)).toEqual(['other', 'ghost']);
  });

  it('a stateChanged("pendingSessions") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePendingSessionsStore({ core });
    await tick();

    setView({ pending: { p1: { pendingId: 'p1', machine: 'm1', machineName: 'devbox', createdAt: 't', state: 'pending', seenAt: 1 } } });
    emitStateChanged('pendingSessions');
    await tick();

    expect(store.getState().pending.p1).toBeDefined();
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativePendingSessionsStore({ core });
    await tick();

    setView({ pending: { p1: { pendingId: 'p1', machine: 'm1', machineName: 'devbox', createdAt: 't', state: 'pending', seenAt: 1 } } });
    emitStateChanged('machines');
    await tick();

    expect(store.getState().pending.p1).toBeUndefined();
  });
});
