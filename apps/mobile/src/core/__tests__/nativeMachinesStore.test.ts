/**
 * nativeMachinesStore — proves the adapter presents the SAME
 * `MachinesStoreState` read shape `createMachinesStore` does, hydrated from
 * `machinesView()` and refreshed on the machines slice's `stateChanged`; and
 * that every write method is an inert no-op (the Rust Router / delete+undo
 * intents own those transitions in native mode, not this store).
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeMachinesStore } from '../stores/nativeMachines';
import type { CoreEvent, MachinesView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

function fakeCore(initialView: MachinesView = { machines: {} }) {
  let view: MachinesView = initialView;
  let coreEventListener: ((e: CoreEvent) => void) | null = null;
  let resumeListener: (() => void) | null = null;

  const core: NativeCore = {
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
    onResume: (cb: () => void) => {
      resumeListener = cb;
      return Promise.resolve(() => {
        resumeListener = null;
      });
    },

    dispatch: vi.fn(async () => {}),
    machinesView: vi.fn(async () => view),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
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
    setView: (next: MachinesView) => {
      view = next;
    },
    emitStateChanged: (slice: SliceId) => {
      coreEventListener?.({ stateChanged: { slice } });
    },
    emitResume: () => {
      resumeListener?.();
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const machineView: MachinesView = {
  machines: {
    pk1: {
      pubkeyHex: 'pk1',
      name: 'laptop',
      host: 'cli',
      label: 'My Laptop',
      capabilities: ['images', 'diff'],
      folders: ['proj-a'],
      roots: ['/home/user'],
      protocolVersion: 10,
      machineOffline: false,
      lastHeartbeatAt: 1234,
      sessions: {
        s1: {
          info: { id: 's1', slug: 's1', title: 'Fix bug', cwd: '/home/user/proj-a', mode: 'default' } as never,
          presence: 'live',
          lastListedAt: 1000,
          usage: { inputTokens: 1, outputTokens: 2 } as never,
        },
      },
      models: [{ id: 'opus' }],
      defaultModel: 'opus',
      providerProfiles: [
        {
          id: 'prof1',
          label: 'Anthropic',
          baseUrl: 'https://api.example',
          models: [{ id: 'opus' }],
          hasToken: true,
        },
      ],
    },
  },
};

describe('createNativeMachinesStore', () => {
  it('hydrates from machinesView() on creation, mapping optional fields to the TS shape', async () => {
    const { core } = fakeCore(machineView);
    const store = createNativeMachinesStore({ core });
    await tick();

    const pk1 = store.getState().machine('pk1');
    expect(pk1?.name).toBe('laptop');
    expect(pk1?.protocolVersion).toBe(10);
    expect(pk1?.lastHeartbeatAt).toBe(1234);
    expect(pk1?.models).toEqual([{ id: 'opus' }]);
    expect(pk1?.providerProfiles?.[0]?.id).toBe('prof1');
    expect(store.getState().session('pk1', 's1')?.presence).toBe('live');
    expect(store.getState().machinePubkeys()).toEqual(['pk1']);
  });

  it('a machine with no protocolVersion/lastHeartbeatAt maps to null, not undefined', async () => {
    const { core } = fakeCore({
      machines: {
        pk2: {
          pubkeyHex: 'pk2',
          name: 'headless',
          capabilities: [],
          folders: [],
          roots: [],
          protocolVersion: null,
          machineOffline: true,
          lastHeartbeatAt: null,
          sessions: {},
        },
      },
    });
    const store = createNativeMachinesStore({ core });
    await tick();

    const pk2 = store.getState().machine('pk2');
    expect(pk2?.protocolVersion).toBeNull();
    expect(pk2?.lastHeartbeatAt).toBeNull();
    expect(pk2?.host).toBeUndefined();
    expect(pk2?.models).toBeUndefined();
    expect(pk2?.providerProfiles).toBeUndefined();
  });

  it('dismissedSessions is always empty — the Rust core owns delete/undo, not this store', async () => {
    const { core } = fakeCore();
    const store = createNativeMachinesStore({ core });
    await tick();
    expect(store.getState().dismissedSessions).toEqual({});
  });

  it('a stateChanged("machines") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeMachinesStore({ core });
    await tick();

    setView(machineView);
    emitStateChanged('machines');
    await tick();

    expect(store.getState().machinePubkeys()).toEqual(['pk1']);
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeMachinesStore({ core });
    await tick();

    setView(machineView);
    emitStateChanged('settings');
    await tick();

    expect(store.getState().machinePubkeys()).toEqual([]);
  });

  it('an OS resume re-fetches the view too, not just a stateChanged event', async () => {
    // CDX-060 sibling: Tauri's emit has no retry, and Android can suspend a
    // backgrounded WebView's JS long enough for a real stateChanged push to
    // be silently lost. onResume is the backstop that notices regardless.
    const { core, setView, emitResume } = fakeCore();
    const store = createNativeMachinesStore({ core });
    await tick();

    setView(machineView);
    emitResume();
    await tick();

    expect(store.getState().machinePubkeys()).toEqual(['pk1']);
  });

});
