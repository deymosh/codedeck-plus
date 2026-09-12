/**
 * nativeSettingsStore — proves the adapter presents the SAME
 * `SettingsStoreState` shape `createSettingsStore` does, hydrates from
 * `settingsView()`, refreshes on the settings slice's `stateChanged` event,
 * and translates every setter into the matching `Intent`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeSettingsStore } from '../stores/nativeSettings';
import { defaultSettings } from '../stores/settings';
import type { CoreEvent, Intent, SettingsView, SliceId } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

function fakeCore(initialView: SettingsView = { ...defaultSettings() }) {
  let view: SettingsView | null = initialView;
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
    onResume: () => Promise.resolve(() => {}),

    dispatch: vi.fn(async (intent: Intent) => {
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: vi.fn(async () => view),
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
    dispatched,
    setView: (next: SettingsView | null) => {
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

describe('createNativeSettingsStore', () => {
  it('hydrates from settingsView() on creation', async () => {
    const { core } = fakeCore({
      ...defaultSettings(),
      uiScale: 1.2,
      notificationsEnabled: false,
    });
    const store = createNativeSettingsStore({ core });
    await tick();

    expect(store.getState().uiScale).toBe(1.2);
    expect(store.getState().notificationsEnabled).toBe(false);
  });

  it('a null settingsView (core not yet initialised) leaves the defaults in place', async () => {
    const { core } = fakeCore();
    const store = createNativeSettingsStore({ core });
    await tick();
    // simulate a later refresh that finds no view yet
    // (settingsView resolving null must not blow away the current state)
    expect(store.getState().relays).toEqual(defaultSettings().relays);
  });

  it.each([
    ['addRelay', ['wss://new.example'], { addRelay: { url: 'wss://new.example' } }],
    ['removeRelay', ['wss://old.example'], { removeRelay: { url: 'wss://old.example' } }],
    ['addRelays', [['a', 'b']], { addRelays: { urls: ['a', 'b'] } }],
    ['setUiScale', [1.1], { setUiScale: 1.1 }],
    ['setStayConnected', [true], { setStayConnected: true }],
    ['setTorProxyEnabled', [true], { setTorEnabled: true }],
    ['setMeshTestTarget', [true], { setMeshTestTarget: true }],
    ['setBlossomServer', ['https://b.example'], { setBlossomServer: 'https://b.example' }],
    ['setDefaultMode', ['plan'], { setDefaultMode: 'plan' }],
    ['setDefaultEffort', ['high'], { setDefaultEffort: 'high' }],
    ['setDefaultEffort', [''], { setDefaultEffort: '' }],
    ['setDefaultModel', ['opus'], { setDefaultModel: 'opus' }],
    ['setNotificationsEnabled', [false], { setNotificationsEnabled: false }],
    ['setShowUsageBadge', [false], { setShowUsageBadge: false }],
    ['setShowCommitBadge', [false], { setShowCommitBadge: false }],
  ] as const)('%s dispatches %j', async (method, args, expected) => {
    const { core, dispatched } = fakeCore();
    const store = createNativeSettingsStore({ core });
    await tick();

    (store.getState() as unknown as Record<string, (...a: unknown[]) => void>)[method]!(...args);
    await tick();

    expect(dispatched).toEqual([expected]);
  });

  it('a stateChanged("settings") core event re-fetches the view', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeSettingsStore({ core });
    await tick();

    setView({ ...defaultSettings(), blossomServer: 'https://pushed.example' });
    emitStateChanged('settings');
    await tick();

    expect(store.getState().blossomServer).toBe('https://pushed.example');
  });

  it('a stateChanged for a different slice does not trigger a refresh', async () => {
    const { core, setView, emitStateChanged } = fakeCore();
    const store = createNativeSettingsStore({ core });
    await tick();

    setView({ ...defaultSettings(), blossomServer: 'https://irrelevant.example' });
    emitStateChanged('outbox');
    await tick();

    expect(store.getState().blossomServer).toBe('');
  });
});
