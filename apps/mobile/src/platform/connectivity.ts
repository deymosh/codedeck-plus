/**
 * connectivity — native event sources feeding the connection FSM (Phase 3b).
 *
 * Bridges the environment's signals to `connection.dispatch(...)`:
 * - CDX-027: a NATIVE connectivity source when available (the
 *   background-relay plugin's ConnectivityManager callback — Android WebView
 *   never fires window `online`/`offline`, so without it the FSM's `offline`
 *   state was unreachable and backoff burned against a dead radio),
 * - `navigator.onLine` + window `online`/`offline` events (browser dev
 *   fallback, and the pre-switch default until the native snapshot answers),
 * - `document.visibilitychange` (the FSM debounces hides itself and never
 *   tears down a healthy socket — we only report),
 * - Tauri `resume`/`focus` events (Android resume; desktop focus) → `resume`,
 * - a periodic tick driving `outbox.sweep()` + `transcript.retrySweep()`
 *   (respects the core's Timers port — device tests can drive virtual time),
 * - a daily tick invoking the injected `prune()` (SQLite retention, plan §5).
 *
 * Everything is injected (event targets, tauri listen, timers), so the wiring
 * is fully testable with fakes; `attach` returns a detach that removes every
 * listener and cancels every timer.
 */
import type { ConnectionEvent } from '../core/stores/connection';
import type { Timers } from '../core/ports';

/** addEventListener/removeEventListener surface of window/document. */
export interface MinimalEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Tauri's `listen` shape (injected; resolved lazily in main.tsx). */
export type TauriListen = (
  event: string,
  handler: () => void,
) => Promise<() => void>;

/** Boot snapshot from the native connectivity source. `supported: false`
 *  (desktop plugin no-op, command failure) keeps the browser fallback. */
export interface NativeConnectivitySnapshot {
  supported: boolean;
  online: boolean;
}

/** CDX-027: the platform's real connectivity source (Android
 *  ConnectivityManager behind the background-relay plugin; faked in tests).
 *  Both methods may reject — attach treats any failure as "unsupported". */
export interface NativeConnectivitySource {
  get(): Promise<NativeConnectivitySnapshot>;
  /** Subscribe to changes; resolves an unsubscribe. */
  watch(onChange: (online: boolean) => void): Promise<() => void>;
}

export interface ConnectivityDeps {
  dispatch(event: ConnectionEvent): void;
  windowTarget: MinimalEventTarget;
  documentTarget: MinimalEventTarget;
  /** Current visibility ('visible' | 'hidden'). */
  visibilityState(): string;
  /** Current navigator.onLine. */
  isOnline(): boolean;
  /** CDX-027: native connectivity (Tauri only). When its snapshot answers
   *  `supported`, it replaces the window online/offline listeners. */
  native?: NativeConnectivitySource;
  /** Present only under Tauri. */
  tauriListen?: TauriListen;
  /** Tauri event names mapped to the FSM's `resume` (resync-on-resume). */
  tauriResumeEvents?: readonly string[];
  timers: Timers;
  /** Periodic maintenance: outbox sweep + transcript retry sweep. */
  onTick(): void;
  tickIntervalMs?: number;
  /** Daily maintenance (SQLite prune). Optional: browser dev has none. */
  onDaily?(): void;
  dailyIntervalMs?: number;
}

export const DEFAULT_TICK_INTERVAL_MS = 30_000;
export const DEFAULT_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Android resume + desktop focus — both mean "the OS may have frozen us". */
export const DEFAULT_TAURI_RESUME_EVENTS = ['tauri://resume', 'tauri://focus'] as const;

export interface ConnectivityHandle {
  detach(): void;
}

export function attachConnectivity(deps: ConnectivityDeps): ConnectivityHandle {
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const dailyIntervalMs = deps.dailyIntervalMs ?? DEFAULT_DAILY_INTERVAL_MS;
  let detached = false;

  // --- network ---
  const onOnline = (): void => deps.dispatch({ type: 'online' });
  const onOffline = (): void => deps.dispatch({ type: 'offline' });
  deps.windowTarget.addEventListener('online', onOnline);
  deps.windowTarget.addEventListener('offline', onOffline);
  // Boot truth: if the OS already says offline, the FSM must know before its
  // first connect attempt.
  if (!deps.isOnline()) deps.dispatch({ type: 'offline' });

  // CDX-027: prefer the native source. The browser wiring above stays live
  // until the native snapshot proves itself (async), then hands over — on
  // Android the window events never fire anyway, so there is no overlap.
  let browserNetworkRemoved = false;
  let nativeUnwatch: (() => void) | null = null;
  const removeBrowserNetworkListeners = (): void => {
    if (browserNetworkRemoved) return;
    browserNetworkRemoved = true;
    deps.windowTarget.removeEventListener('online', onOnline);
    deps.windowTarget.removeEventListener('offline', onOffline);
  };
  if (deps.native) {
    const native = deps.native;
    void (async () => {
      try {
        const snapshot = await native.get();
        if (!snapshot.supported || detached) return;
        const unwatch = await native.watch((online) => {
          if (!detached) deps.dispatch({ type: online ? 'online' : 'offline' });
        });
        if (detached) {
          unwatch();
          return;
        }
        nativeUnwatch = unwatch;
        removeBrowserNetworkListeners();
        // The snapshot truth supersedes whatever navigator.onLine claimed.
        deps.dispatch({ type: snapshot.online ? 'online' : 'offline' });
      } catch {
        // Native source unavailable — the browser fallback stays attached.
      }
    })();
  }

  // --- visibility ---
  const onVisibility = (): void =>
    deps.dispatch({ type: 'visibility', visible: deps.visibilityState() === 'visible' });
  deps.documentTarget.addEventListener('visibilitychange', onVisibility);

  // --- Tauri resume/focus ---
  const unlistens: Array<() => void> = [];
  if (deps.tauriListen) {
    for (const name of deps.tauriResumeEvents ?? DEFAULT_TAURI_RESUME_EVENTS) {
      void deps
        .tauriListen(name, () => {
          if (!detached) deps.dispatch({ type: 'resume' });
        })
        .then((unlisten) => {
          if (detached) unlisten();
          else unlistens.push(unlisten);
        })
        .catch(() => {
          // Event not available on this platform — fine, visibility covers it.
        });
    }
  }

  // --- periodic ticks (chained one-shots on the Timers port) ---
  let tickHandle: unknown = null;
  const scheduleTick = (): void => {
    tickHandle = deps.timers.set(() => {
      deps.onTick();
      if (!detached) scheduleTick();
    }, tickIntervalMs);
  };
  scheduleTick();

  let dailyHandle: unknown = null;
  if (deps.onDaily) {
    const scheduleDaily = (): void => {
      dailyHandle = deps.timers.set(() => {
        deps.onDaily?.();
        if (!detached) scheduleDaily();
      }, dailyIntervalMs);
    };
    scheduleDaily();
  }

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      removeBrowserNetworkListeners();
      if (nativeUnwatch) {
        nativeUnwatch();
        nativeUnwatch = null;
      }
      deps.documentTarget.removeEventListener('visibilitychange', onVisibility);
      for (const unlisten of unlistens.splice(0)) unlisten();
      if (tickHandle !== null) deps.timers.clear(tickHandle);
      if (dailyHandle !== null) deps.timers.clear(dailyHandle);
    },
  };
}

/**
 * Production native source over the background-relay plugin (CDX-027):
 * `get_connectivity` for the boot snapshot, `watch_connectivity` streaming
 * changes over a Tauri channel. Desktop's plugin answers `supported: false`,
 * so attach keeps the browser fallback there; a failing command degrades the
 * same way. Only call under Tauri (lazy-imports @tauri-apps/api).
 */
export function tauriNativeConnectivity(log?: (msg: string) => void): NativeConnectivitySource {
  return {
    get: async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const snapshot = await invoke<{ supported?: boolean; online?: boolean }>(
          'plugin:background-relay|get_connectivity',
        );
        return { supported: snapshot?.supported === true, online: snapshot?.online !== false };
      } catch (err) {
        log?.(`[Connectivity] native snapshot unavailable: ${err}`);
        return { supported: false, online: true };
      }
    },
    watch: async (onChange) => {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<{ online?: boolean }>();
      channel.onmessage = (msg) => onChange(msg?.online !== false);
      await invoke('plugin:background-relay|watch_connectivity', { channel });
      log?.('[Connectivity] native source attached');
      return () => {
        void invoke('plugin:background-relay|unwatch_connectivity').catch(() => {});
      };
    },
  };
}
