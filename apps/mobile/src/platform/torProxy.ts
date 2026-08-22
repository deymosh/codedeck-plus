/**
 * Orbot SOCKS5 routing controller (tauri-plugin-tor-proxy).
 *
 * JS owns policy (the settings toggle); the plugin only configures
 * androidx.webkit.ProxyController — a process-wide override that affects
 * every WebView network request, including the relay WebSockets
 * platform/relayTransport.ts opens (see the plugin's lib.rs for why this
 * can't be a per-connection JS option the way it is for the bridge's `ws`).
 *
 * setProxyOverride only affects connections opened AFTER it resolves, so the
 * boot-time enable in main.tsx runs BEFORE the relay transport is
 * constructed. Toggling live (attachTorProxy below) reconfigures future
 * connections but does not retroactively re-route sockets already open —
 * an in-session toggle is best-effort until the next reconnect/app restart.
 */
import type { SettingsStore } from '../core/stores/settings';
import type { Logger } from '../core/ports';

export const ORBOT_DEFAULT_HOST = '127.0.0.1';
export const ORBOT_DEFAULT_PORT = 9050;

/** The Tauri command surface of the tor-proxy plugin. */
export interface TorProxyApi {
  /** Resolves false when the device's WebView provider doesn't support
   *  PROXY_OVERRIDE (old WebView) — the caller should surface that rather
   *  than silently proxying nothing. */
  enable(host: string, port: number): Promise<boolean>;
  disable(): Promise<void>;
}

/** Production impl: the plugin's commands (desktop: built-in no-ops). */
export function tauriTorProxyApi(log?: Logger): TorProxyApi {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => {
    try {
      const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
      return await tauriInvoke<T>(`plugin:tor-proxy|${cmd}`, args);
    } catch (err) {
      log?.(`[TorProxy] ${cmd} failed: ${err}`);
      return null;
    }
  };
  return {
    enable: async (host, port) =>
      (await invoke<{ supported: boolean }>('enable', { request: { host, port } }))?.supported ?? false,
    disable: async () => void (await invoke('disable')),
  };
}

export interface TorProxyDeps {
  settings: SettingsStore;
  proxy: TorProxyApi;
  log?: Logger;
}

/**
 * Wire the live settings toggle to the plugin (reconnect/restart still
 * needed for it to take full effect — see the module doc). Boot-time
 * application happens separately in main.tsx, before the transport is
 * constructed; this only reacts to CHANGES made while the app is running.
 */
export function attachTorProxy(deps: TorProxyDeps): () => void {
  let desired = deps.settings.getState().torProxyEnabled;

  const unsubscribe = deps.settings.subscribe((state) => {
    if (state.torProxyEnabled === desired) return;
    desired = state.torProxyEnabled;
    if (desired) {
      void deps.proxy.enable(ORBOT_DEFAULT_HOST, ORBOT_DEFAULT_PORT).then((supported) => {
        if (!supported) deps.log?.('[TorProxy] enabled, but this WebView does not support PROXY_OVERRIDE');
      });
    } else {
      void deps.proxy.disable();
    }
  });

  return unsubscribe;
}
