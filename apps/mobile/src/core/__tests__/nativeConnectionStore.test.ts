/**
 * nativeConnectionStore — proves the adapter presents the SAME
 * `ConnectionStoreState` shape `createConnectionStore` does for the two
 * fields production UI actually reads (`status`, `needsPairingCheck`),
 * hydration + live updates via `connectionStatus()`/`onConnection`,
 * `dispatch`'s mapping to the F1 lifecycle methods, and `presence()` sourced
 * from the machines adapter's cached heartbeats.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeConnectionStore } from '../stores/nativeConnection';
import { createNativeMachinesStore } from '../stores/nativeMachines';
import type { MachinesStore } from '../stores/machines';
import type { MachinesView } from '../nativeCoreTypes';
import type { NativeConnectionSnapshot, NativeCore } from '../../platform/nativeCore';

/** A real `createNativeMachinesStore`, hydrated once from a canned view —
 *  exercising the actual adapter beats hand-faking `MachinesStore`'s shape. */
function fakeMachines(lastHeartbeatAt: number | null): MachinesStore {
  const view: MachinesView = lastHeartbeatAt === null
    ? { machines: {} }
    : {
        machines: {
          m1: {
            pubkeyHex: 'm1',
            name: 'devbox',
            capabilities: [],
            folders: [],
            roots: [],
            protocolVersion: null,
            machineOffline: false,
            lastHeartbeatAt,
            sessions: {},
          },
        },
      };
  const machinesCore: NativeCore = {
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
    dispatch: () => Promise.resolve(),
    machinesView: () => Promise.resolve(view),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: () => Promise.resolve(() => {}),
  };
  return createNativeMachinesStore({ core: machinesCore });
}

function fakeCore(initial: NativeConnectionSnapshot = { status: 'idle', needsPairingCheck: false, connectedRelays: [] }) {
  const calls: string[] = [];
  let onConnectionCb: ((s: NativeConnectionSnapshot) => void) | null = null;

  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => {
      calls.push('start');
      return Promise.resolve();
    },
    stop: () => {
      calls.push('stop');
      return Promise.resolve();
    },
    pause: () => {
      calls.push('pause');
      return Promise.resolve();
    },
    resume: () => {
      calls.push('resume');
      return Promise.resolve();
    },
    setOnline: (online) => {
      calls.push(`setOnline(${online})`);
      return Promise.resolve();
    },
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.resolve(initial),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: (cb) => {
      onConnectionCb = cb;
      return Promise.resolve(() => {
        onConnectionCb = null;
      });
    },
    onActionFailed: () => Promise.reject(new Error('unused')),
    dispatch: () => Promise.reject(new Error('unused')),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: () => Promise.resolve(() => {}),
  };

  return {
    core,
    calls,
    pushConnection: (snapshot: NativeConnectionSnapshot) => onConnectionCb?.(snapshot),
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createNativeConnectionStore', () => {
  it('hydrates status/needsPairingCheck from connectionStatus() on creation', async () => {
    const { core } = fakeCore({ status: 'connecting', needsPairingCheck: true, connectedRelays: [] });
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    expect(store.getState().status).toBe('connecting');
    expect(store.getState().needsPairingCheck).toBe(true);
  });

  it('onConnection pushes live status updates', async () => {
    const { core, pushConnection } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    pushConnection({ status: 'connected', needsPairingCheck: false, connectedRelays: [] });
    expect(store.getState().status).toBe('connected');
  });

  it.each([
    ['connect-requested', 'start'],
    ['disconnect-requested', 'stop'],
    ['online', 'setOnline(true)'],
    ['offline', 'setOnline(false)'],
    ['resume', 'resume'],
  ] as const)('dispatch({type: %s}) calls core.%s', async (type, expected) => {
    const { core, calls } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    store.getState().dispatch({ type });
    await tick();
    expect(calls).toEqual([expected]);
  });

  it('dispatch({type: visibility}) maps visible to resume and hidden to pause', async () => {
    const { core, calls } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    store.getState().dispatch({ type: 'visibility', visible: false });
    store.getState().dispatch({ type: 'visibility', visible: true });
    await tick();
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('dispatch of an FSM-internal event forwards nothing', async () => {
    const { core, calls } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    store.getState().dispatch({ type: 'socket-open', at: 1 });
    store.getState().dispatch({ type: 'retry-due' });
    store.getState().dispatch({ type: 'decrypt-failure' });
    await tick();
    expect(calls).toEqual([]);
  });

  it('presence reflects the connected status and the machines adapter heartbeat', async () => {
    const { core, pushConnection } = fakeCore();
    const store = createNativeConnectionStore({
      core,
      machines: fakeMachines(1_000),
      now: () => 1_000,
    });
    await tick();

    // Not connected yet — offline regardless of heartbeat freshness.
    expect(store.getState().presence('m1')).toBe('offline');

    pushConnection({ status: 'connected', needsPairingCheck: false, connectedRelays: [] });
    expect(store.getState().presence('m1')).toBe('live');
  });

  it('presence is offline for an unknown machine even while connected', async () => {
    const { core, pushConnection } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();
    pushConnection({ status: 'connected', needsPairingCheck: false, connectedRelays: [] });

    expect(store.getState().presence('never-seen')).toBe('offline');
  });

  it('checkHeartbeats is an inert no-op', async () => {
    const { core, calls } = fakeCore();
    const store = createNativeConnectionStore({ core, machines: fakeMachines(null) });
    await tick();

    expect(() => store.getState().checkHeartbeats()).not.toThrow();
    expect(calls).toEqual([]);
  });
});
