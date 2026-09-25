/**
 * A native-backed `SettingsStore` (migration F2b) — same pattern as
 * `nativeOutbox.ts`: the SAME public `SettingsStoreState` shape
 * `createSettingsStore` (`./settings.ts`) exposes, but every mutation is a
 * fire-and-forget `NativeCore.dispatch` and every read comes from a cached
 * `settingsView()`, refreshed on the settings slice's `stateChanged` event.
 *
 * The setters return `void`, not a promise (matching the existing store's
 * own signatures — no UI code awaits them today), so a dispatch failure
 * surfaces only as the state never advancing past what `settingsView()`
 * last reported — same "the next event wins" model as `nativeOutbox.ts`.
 */
import { createStore } from 'zustand/vanilla';
import { hydrateFromCore } from './nativeHydration';
import type { EffortLevel, PermissionMode } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';
import type { SettingsView as NativeSettingsView } from '../nativeCoreTypes';
import type { SettingsData, SettingsStore, SettingsStoreState } from './settings';
import { defaultSettings, UI_SCALE_DEFAULT } from './settings';

function toSettingsData(view: NativeSettingsView): SettingsData {
  return {
    relays: view.relays,
    // `f64` serializes as `null` on the wire for NaN/Infinity, so specta
    // types every plain (non-`Option`) float as nullable — `clamp_ui_scale`
    // (Rust) already guarantees a real, in-range value here, but the
    // fallback keeps this store honest against the wire schema regardless.
    uiScale: view.uiScale ?? UI_SCALE_DEFAULT,
    stayConnected: view.stayConnected,
    torProxyEnabled: view.torProxyEnabled,
    meshTestTarget: view.meshTestTarget,
    blossomServer: view.blossomServer,
    defaultMode: view.defaultMode,
    // The Rust view keeps this a plain string (`""` = unset); the TS store
    // narrows to `EffortLevel | ''` — trusted here, same as `nativeCore.ts`'s
    // documented "no phone-side re-validation at this seam" policy.
    defaultEffort: view.defaultEffort as EffortLevel | '',
    defaultModel: view.defaultModel,
    notificationsEnabled: view.notificationsEnabled,
    showUsageBadge: view.showUsageBadge,
    showCommitBadge: view.showCommitBadge,
  };
}

export interface NativeSettingsStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativeSettingsStore(deps: NativeSettingsStoreDeps): SettingsStore {
  const store = createStore<SettingsStoreState>()((set) => {
    const refresh = async (): Promise<void> => {
      const view = await deps.core.settingsView();
      if (view) set(toSettingsData(view));
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'settings') {
            void refresh().catch((err) => deps.log?.(`[nativeSettings] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativeSettings',
      deps.log,
    );

    const dispatch = (intent: Parameters<NativeCore['dispatch']>[0]): void => {
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativeSettings] dispatch failed: ${err}`));
    };

    return {
      ...defaultSettings(),

      addRelay: (url) => dispatch({ addRelay: { url } }),
      removeRelay: (url) => dispatch({ removeRelay: { url } }),
      addRelays: (urls) => dispatch({ addRelays: { urls: [...urls] } }),
      setUiScale: (scale) => dispatch({ setUiScale: scale }),
      setStayConnected: (on) => dispatch({ setStayConnected: on }),
      setTorProxyEnabled: (on) => dispatch({ setTorEnabled: on }),
      setMeshTestTarget: (on) => dispatch({ setMeshTestTarget: on }),
      setBlossomServer: (url) => dispatch({ setBlossomServer: url }),
      setDefaultMode: (mode: PermissionMode) => dispatch({ setDefaultMode: mode }),
      setDefaultEffort: (level) => dispatch({ setDefaultEffort: level }),
      setDefaultModel: (model) => dispatch({ setDefaultModel: model }),
      setNotificationsEnabled: (on) => dispatch({ setNotificationsEnabled: on }),
      setShowUsageBadge: (on) => dispatch({ setShowUsageBadge: on }),
      setShowCommitBadge: (on) => dispatch({ setShowCommitBadge: on }),
    };
  });

  return store;
}
