/**
 * Stay-connected controller (Phase 5c): toggle → service start/stop, the
 * notification text mirrors the TRUE connection-FSM status, permission is
 * requested before the first start, and boot reconciles a persisted toggle.
 */
import { describe, it, expect } from 'vitest';
import {
  attachStayConnectedService,
  serviceNotificationText,
  type StayConnectedServiceApi,
} from '../foregroundService';
import { createConnectionStore } from '../../core/stores/connection';
import { createSettingsStore, defaultSettings } from '../../core/stores/settings';
import { memoryKV, type Timers } from '../../core/ports';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const noopTimers: Timers = { set: () => 0, clear: () => {} };

function makeWorld(stayConnected: boolean) {
  const settings = createSettingsStore(
    { kv: memoryKV() },
    { ...defaultSettings(), stayConnected },
  );
  const connection = createConnectionStore({
    timers: noopTimers,
    now: () => 0,
    random: () => 0,
    handlers: { openSocket: () => {}, closeSocket: () => {}, refreshAndReconcile: () => {} },
  });
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
  return { settings, connection, calls, detach, permissionAsked: () => permissionAsked };
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

    w.connection.getState().dispatch({ type: 'connect-requested' });
    await flush();
    expect(w.calls).toEqual(['state:Connecting…']);

    w.connection.getState().dispatch({ type: 'socket-open', at: 1 });
    await flush();
    expect(w.calls).toEqual(['state:Connecting…', 'state:Connected to relays']);
    w.detach();
  });

  it('status changes while the toggle is off push nothing', async () => {
    const w = makeWorld(false);
    w.connection.getState().dispatch({ type: 'connect-requested' });
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
