/**
 * Stay-connected foreground service controller (Phase 5c, plan §5).
 *
 * JS owns ALL policy; the Kotlin service only displays and holds locks:
 * - settingsStore.stayConnected drives start/stop (toggle → Tauri command),
 * - the connection FSM's status is pushed into the persistent notification
 *   via `update_state` so the text is always the TRUE state — the service
 *   never invents one,
 * - the notification permission is requested before the first start
 *   (Android 13+ POST_NOTIFICATIONS; the FGS notification is invisible
 *   without it — the service still runs either way).
 *
 * On desktop the plugin's commands are compiled to no-ops, so this controller
 * is safe to attach under any Tauri runtime; plain-browser dev never attaches
 * it (main.tsx gates on Tauri).
 */
import type { ConnectionStatus, ConnectionStore } from '../core/stores/connection';
import type { SettingsStore } from '../core/stores/settings';
import type { Logger } from '../core/ports';

/** The persistent notification's text per connection-FSM status — honest,
 *  human words for the FSM's exact state (pure; unit-tested). */
export function serviceNotificationText(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected to relays';
    case 'connecting':
      return 'Connecting…';
    case 'waiting-retry':
      return 'Reconnecting…';
    case 'offline':
      return 'No network — waiting';
    case 'idle':
    case 'stopped':
      return 'Idle';
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return 'Idle';
    }
  }
}

/** The Tauri command surface of the background-relay plugin. */
export interface StayConnectedServiceApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  updateState(text: string): Promise<void>;
}

/** Production impl: the plugin's commands (desktop: built-in no-ops). */
export function tauriServiceApi(log?: Logger): StayConnectedServiceApi {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => {
    try {
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      return await tauriInvoke<T>(`plugin:background-relay|${cmd}`, args);
    } catch (err) {
      log?.(`[StayConnected] ${cmd} failed: ${err}`);
      return null;
    }
  };
  return {
    start: async () => void (await invoke('start_service')),
    stop: async () => void (await invoke('stop_service')),
    isRunning: async () =>
      (await invoke<{ running: boolean }>('is_running'))?.running ?? false,
    updateState: async (text) => void (await invoke('update_state', { text })),
  };
}

export interface StayConnectedDeps {
  settings: SettingsStore;
  connection: ConnectionStore;
  service: StayConnectedServiceApi;
  /** POST_NOTIFICATIONS request before the first start (platform/notifier). */
  requestPermission(): Promise<boolean>;
  log?: Logger;
}

/**
 * Wire settings + connection stores to the service. Returns a detach fn.
 * Also reconciles at attach time: a persisted `stayConnected: true` restarts
 * the service on boot (the OS may have killed it — START_STICKY restarts the
 * service, but a fresh app start re-asserts the desired state either way).
 */
export function attachStayConnectedService(deps: StayConnectedDeps): () => void {
  let desired = deps.settings.getState().stayConnected;

  const start = async (): Promise<void> => {
    // Best-effort: a denied permission hides the notification but the
    // service (and its locks) still run — don't block on the answer.
    const granted = await deps.requestPermission();
    if (!granted) deps.log?.('[StayConnected] notifications not granted — service will be silent');
    await deps.service.start();
    await deps.service.updateState(
      serviceNotificationText(deps.connection.getState().status),
    );
  };

  const unsubSettings = deps.settings.subscribe((state) => {
    if (state.stayConnected === desired) return;
    desired = state.stayConnected;
    if (desired) void start();
    else void deps.service.stop();
  });

  let lastStatus = deps.connection.getState().status;
  const unsubConnection = deps.connection.subscribe((state) => {
    if (state.status === lastStatus) return;
    lastStatus = state.status;
    // Push unconditionally while enabled — the service ignores it when
    // stopped (it only remembers the text for the next start).
    if (desired) void deps.service.updateState(serviceNotificationText(state.status));
  });

  if (desired) void start();

  return () => {
    unsubSettings();
    unsubConnection();
  };
}
