/**
 * Stay-connected controller (Phase 5c): toggle → service start/stop, the
 * notification text mirrors the TRUE connection-FSM status, permission is
 * requested before the first start, and boot reconciles a persisted toggle.
 *
 * The connection FSM and the settings store both moved to Rust (F2b) —
 * `attachStayConnectedService` itself is untouched (it only reads
 * `ConnectionStoreState`/`SettingsStoreState`), so this drives it against
 * the native adapters + a tiny scripted fake `NativeCore` instead of the
 * retired local reducer-backed stores.
 */
import { describe, it, expect } from 'vitest';
import {
  attachStayConnectedService,
  serviceNotificationText,
  type StayConnectedServiceApi,
} from '../foregroundService';
import { createNativeConnectionStore } from '../../core/stores/nativeConnection';
import { createNativeSettingsStore } from '../../core/stores/nativeSettings';
import { createNativeMachinesStore } from '../../core/stores/nativeMachines';
import type { ConnectionStatus } from '../../core/stores/connection';
import type { NativeCore, NativeConnectionSnapshot } from '../nativeCore';
import type { SettingsView, CoreEvent } from '../../core/nativeCoreTypes';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const defaultSettingsView = (stayConnected: boolean): SettingsView => ({
  relays: [],
  uiScale: 1,
  stayConnected,
  torProxyEnabled: false,
  meshTestTarget: false,
  blossomServer: '',
  defaultMode: 'plan',
  defaultEffort: '',
  defaultModel: '',
  notificationsEnabled: true,
  showUsageBadge: true,
  showCommitBadge: true,
});

/** A scripted `NativeCore`: `setConnectionStatus`/`setStayConnected` push a
 *  new snapshot straight to whichever listeners are already subscribed —
 *  the same round trip the real Tauri event stream drives, just synchronous. */
function fakeNativeCore(stayConnected: boolean) {
  let status: ConnectionStatus = 'idle';
  let settings = defaultSettingsView(stayConnected);
  let onConnectionCb: ((s: NativeConnectionSnapshot) => void) | null = null;
  let onEventCb: ((e: CoreEvent) => void) | null = null;

  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setOnline: () => Promise.resolve(),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.resolve({ status, needsPairingCheck: false }),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: (cb) => {
      onConnectionCb = cb;
      return Promise.resolve(() => {
        onConnectionCb = null;
      });
    },
    onActionFailed: () => Promise.reject(new Error('unused')),
    dispatch: (intent) => {
      if (typeof intent === 'object' && 'setStayConnected' in intent) {
        settings = { ...settings, stayConnected: intent.setStayConnected };
        onEventCb?.({ stateChanged: { slice: 'settings' } });
      }
      return Promise.resolve();
    },
    machinesView: () => Promise.resolve({ machines: {} }),
    settingsView: () => Promise.resolve(settings),
    outboxView: () => Promise.resolve({ items: [] }),
    pairingView: () => Promise.resolve(null),
    dmView: () => Promise.resolve(null),
    marmotView: () => Promise.resolve(null),
    quickPromptsView: () => Promise.resolve({ prompts: [] }),
    pendingSessionsView: () => Promise.resolve({ pending: {} }),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: (cb) => {
      onEventCb = cb;
      return Promise.resolve(() => {
        onEventCb = null;
      });
    },
  };

  return {
    core,
    setConnectionStatus: (next: ConnectionStatus): void => {
      status = next;
      onConnectionCb?.({ status, needsPairingCheck: false });
    },
  };
}

function makeWorld(stayConnected: boolean) {
  const { core, setConnectionStatus } = fakeNativeCore(stayConnected);
  const machines = createNativeMachinesStore({ core });
  const settings = createNativeSettingsStore({ core });
  const connection = createNativeConnectionStore({ core, machines });
  const calls: string[] = [];
  const service: StayConnectedServiceApi = {
    start: async () => void calls.push('start'),
    stop: async () => void calls.push('stop'),
    isRunning: async () => calls.includes('start'),
    updateState: async (text) => void calls.push(`state:${text}`),
  };
  let permissionAsked = 0;
  const detach = attachStayConnectedService({
    settings,
    connection,
    service,
    requestPermission: async () => {
      permissionAsked++;
      return true;
    },
  });
  return { settings, connection, setConnectionStatus, calls, detach, permissionAsked: () => permissionAsked };
}

describe('serviceNotificationText — honest FSM words', () => {
  it('maps every status', () => {
    expect(serviceNotificationText('connected')).toBe('Connected to relays');
    expect(serviceNotificationText('connecting')).toBe('Connecting…');
    expect(serviceNotificationText('waiting-retry')).toBe('Reconnecting…');
    expect(serviceNotificationText('offline')).toBe('No network — waiting');
    expect(serviceNotificationText('idle')).toBe('Idle');
    expect(serviceNotificationText('stopped')).toBe('Idle');
  });
});

describe('attachStayConnectedService', () => {
  it('toggle ON → permission request, start, state push; OFF → stop', async () => {
    const w = makeWorld(false);
    await flush();
    expect(w.calls).toEqual([]); // toggle off at attach: nothing runs

    w.settings.getState().setStayConnected(true);
    await flush();
    expect(w.permissionAsked()).toBe(1);
    expect(w.calls).toEqual(['start', 'state:Idle']);

    w.settings.getState().setStayConnected(false);
    await flush();
    expect(w.calls).toEqual(['start', 'state:Idle', 'stop']);
    w.detach();
  });

  it('connection status changes push honest text while enabled', async () => {
    const w = makeWorld(false);
    w.settings.getState().setStayConnected(true);
    await flush();
    w.calls.length = 0;

    w.setConnectionStatus('connecting');
    await flush();
    expect(w.calls).toEqual(['state:Connecting…']);

    w.setConnectionStatus('connected');
    await flush();
    expect(w.calls).toEqual(['state:Connecting…', 'state:Connected to relays']);
    w.detach();
  });

  it('status changes while the toggle is off push nothing', async () => {
    const w = makeWorld(false);
    w.setConnectionStatus('connecting');
    await flush();
    expect(w.calls).toEqual([]);
    w.detach();
  });

  it('a persisted stayConnected=true starts the service at attach (boot reconcile)', async () => {
    const w = makeWorld(true);
    await flush();
    expect(w.calls[0]).toBe('start');
    w.detach();
  });
});
