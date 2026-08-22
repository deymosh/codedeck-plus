/**
 * settingsStore — user settings behind the KV port.
 *
 * Phase 3a scope: the relay list (manual add/remove — every component supports
 * it, plan §6) plus placeholders the later phases fill in (UI scale slider,
 * stay-connected foreground-service toggle).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  DEFAULT_RELAYS,
  MARMOT_RELAYS,
  effortLevelSchema,
  permissionModeSchema,
  type EffortLevel,
  type PermissionMode,
} from '@codedeck/protocol';
import type { KV, Logger } from '../ports';

export const SETTINGS_STORAGE_KEY = 'settings';

/** UI scale slider range (plan §5, locked decision #4). */
export const UI_SCALE_MIN = 0.85;
export const UI_SCALE_MAX = 1.4;
export const UI_SCALE_DEFAULT = 1;

const clampUiScale = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value))
    : UI_SCALE_DEFAULT;

export interface SettingsData {
  relays: string[];
  /** UI scale user multiplier (0.85–1.4 settings slider, Phase 5a). */
  uiScale: number;
  /** Foreground-service toggle placeholder (Phase 5c). */
  stayConnected: boolean;
  /** Per-device opt-in (Phase 5d): only when ON does CodeDeck auto-enable
   *  Wireless Debugging (expose adb over the mesh). OFF by default — only a
   *  device the user designates as a TEST TARGET should expose adb; a
   *  controller phone never opens an adb listener just by joining the mesh. */
  meshTestTarget: boolean;
  /** Blossom server for DM image attachments (CDX-011; ported old-app
   *  setting). Empty string = the built-in default. */
  blossomServer: string;
  /** Preferences (CDX-047): permission mode applied to NEW sessions. The
   *  bridge starts sessions in plan mode (packages/core runner default), so
   *  a non-plan preference is applied by sending a mode change on
   *  session-ready. */
  defaultMode: PermissionMode;
  /** Preferences (CDX-047): create-session `defaultEffort`. Empty string =
   *  unset (the bridge/SDK default, i.e. auto). */
  defaultEffort: EffortLevel | '';
  /** Preferences (CDX-047): create-session `model`. Empty string = the
   *  bridge default. */
  defaultModel: string;
  /** Master notifications toggle (CDX-048): gates BOTH OS notifications and
   *  the in-app ping chime (the coordinator seam in core/notifications). */
  notificationsEnabled: boolean;
  /** Show the 5h/7d subscription usage box in the session header (CDX-048). */
  showUsageBadge: boolean;
  /** Show the `committed` badge on sidebar session cards (CDX-048). */
  showCommitBadge: boolean;
}

/** CDX-021 → CDX-036: this list held wss://relay2.descendant.io while the
 *  CodeDeck relay was undeployed (CDX-007). The relay is LIVE since 2026-08-10
 *  (apps/relay deployed, RESTRICTED_WRITES="false", NIP-40 + the CDX-070/072
 *  caps verified on the wire), so the scrub is RETIRED — the list is kept empty
 *  as the mechanism (defaults, hydrate and addRelays all filter through it) for
 *  any future dead default. */
export const DEAD_DEFAULT_RELAYS: readonly string[] = [];

const withoutDeadRelays = (relays: readonly string[]): string[] =>
  relays.filter((r) => !DEAD_DEFAULT_RELAYS.includes(r));

/**
 * CDX-042: relay lists that were a SHIPPED DEFAULT at some point, and therefore
 * carry no user intent. An install that still holds one of these verbatim never
 * chose it — it just never touched Settings — so hydrate lifts it to the
 * current defaults instead of stranding it on the one relay the CDX-021 scrub
 * left behind. Any list that differs by even one entry is a customised list and
 * is passed through untouched.
 *
 * Compared AFTER the dead-relay scrub. CDX-036 emptied that scrub, so it no
 * longer normalises [relay2, primal] down to [primal] — every historical
 * shipped default must now be listed VERBATIM, in the exact order it shipped.
 *
 * CDX-081: **every time the shipped default changes, the OUTGOING default must
 * be appended here in the same commit.** Otherwise every install that simply
 * took the previous default is read as a customised list and stranded on the
 * relay we just removed — which is the precise failure this list exists to
 * prevent.
 */
const LEGACY_DEFAULT_RELAY_SETS: readonly (readonly string[])[] = [
  // pre-CDX-021: persisted verbatim, before the scrub existed
  ['wss://relay2.descendant.io', 'wss://relay.primal.net'],
  // post-CDX-021 scrub, pre-CDX-042
  ['wss://relay.primal.net'],
  // CDX-042 era as persisted while the scrub was active (0.9.0/0.9.1)
  ['wss://relay.primal.net', 'wss://relay.damus.io'],
  // CDX-081 era as persisted while the scrub was active — damus → oxtr. This is
  // the default EVERY currently-installed build carries, so without this entry
  // the CDX-036 retirement would strand all of them on [primal, oxtr] and they
  // would never gain relay2.
  ['wss://relay.primal.net', 'wss://nostr.oxtr.dev'],
  // CDX-100 outgoing default: what 0.9.2/0.9.3 shipped once CDX-036 emptied the
  // scrub. Every install that never touched Settings holds exactly this, and
  // without the entry none of them would ever gain the Marmot relays.
  ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'],
];

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const isUntouchedLegacyDefault = (relays: readonly string[]): boolean =>
  LEGACY_DEFAULT_RELAY_SETS.some((legacy) => sameList(relays, legacy));

export const defaultSettings = (): SettingsData => ({
  // CDX-100: transport relays + the Marmot island. The phone is the only side
  // that speaks MLS, so MARMOT_RELAYS is added here and not to DEFAULT_RELAYS.
  relays: withoutDeadRelays([...DEFAULT_RELAYS, ...MARMOT_RELAYS]),
  uiScale: 1,
  stayConnected: false,
  meshTestTarget: false,
  blossomServer: '',
  defaultMode: 'plan',
  defaultEffort: '',
  defaultModel: '',
  notificationsEnabled: true,
  showUsageBadge: true,
  showCommitBadge: true,
});

export function hydrateSettings(raw: string | undefined): SettingsData {
  const defaults = defaultSettings();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<SettingsData>;
    // CDX-021 hydrate-time migration: persisted lists from installs whose
    // defaults included the never-deployed relay get it scrubbed; an empty
    // result falls back to the (live) defaults.
    const persistedRelays = Array.isArray(parsed.relays)
      ? withoutDeadRelays(parsed.relays.filter((r): r is string => typeof r === 'string'))
      : [];
    // CDX-042: an untouched shipped default is upgraded to the current one;
    // a customised list (or anything else non-empty) survives verbatim.
    const relays =
      persistedRelays.length === 0 || isUntouchedLegacyDefault(persistedRelays)
        ? defaults.relays
        : persistedRelays;
    return {
      relays,
      uiScale:
        typeof parsed.uiScale === 'number' ? clampUiScale(parsed.uiScale) : defaults.uiScale,
      stayConnected:
        typeof parsed.stayConnected === 'boolean' ? parsed.stayConnected : defaults.stayConnected,
      meshTestTarget:
        typeof parsed.meshTestTarget === 'boolean'
          ? parsed.meshTestTarget
          : defaults.meshTestTarget,
      blossomServer:
        typeof parsed.blossomServer === 'string' ? parsed.blossomServer : defaults.blossomServer,
      defaultMode: permissionModeSchema.safeParse(parsed.defaultMode).success
        ? (parsed.defaultMode as PermissionMode)
        : defaults.defaultMode,
      defaultEffort: effortLevelSchema.safeParse(parsed.defaultEffort).success
        ? (parsed.defaultEffort as EffortLevel)
        : defaults.defaultEffort,
      defaultModel:
        typeof parsed.defaultModel === 'string' ? parsed.defaultModel : defaults.defaultModel,
      notificationsEnabled:
        typeof parsed.notificationsEnabled === 'boolean'
          ? parsed.notificationsEnabled
          : defaults.notificationsEnabled,
      showUsageBadge:
        typeof parsed.showUsageBadge === 'boolean'
          ? parsed.showUsageBadge
          : defaults.showUsageBadge,
      showCommitBadge:
        typeof parsed.showCommitBadge === 'boolean'
          ? parsed.showCommitBadge
          : defaults.showCommitBadge,
    };
  } catch {
    return defaults;
  }
}

export interface SettingsStoreState extends SettingsData {
  addRelay(url: string): void;
  removeRelay(url: string): void;
  /** Merge relays learned from a pairing URL. */
  addRelays(urls: readonly string[]): void;
  setUiScale(scale: number): void;
  setStayConnected(on: boolean): void;
  setMeshTestTarget(on: boolean): void;
  setBlossomServer(url: string): void;
  setDefaultMode(mode: PermissionMode): void;
  setDefaultEffort(level: EffortLevel | ''): void;
  setDefaultModel(model: string): void;
  setNotificationsEnabled(on: boolean): void;
  setShowUsageBadge(on: boolean): void;
  setShowCommitBadge(on: boolean): void;
}

export type SettingsStore = StoreApi<SettingsStoreState>;

export interface SettingsStoreDeps {
  kv: KV;
  /** The relay list changed — reconfigure the transport / reconnect. */
  onRelaysChanged?(relays: readonly string[]): void;
  storageKey?: string;
  log?: Logger;
}

export function createSettingsStore(
  deps: SettingsStoreDeps,
  initial: SettingsData = defaultSettings(),
): SettingsStore {
  const storageKey = deps.storageKey ?? SETTINGS_STORAGE_KEY;

  const store = createStore<SettingsStoreState>()((set, get) => {
    const persist = (): void => {
      const {
        relays,
        uiScale,
        stayConnected,
        meshTestTarget,
        blossomServer,
        defaultMode,
        defaultEffort,
        defaultModel,
        notificationsEnabled,
        showUsageBadge,
        showCommitBadge,
      } = get();
      void deps.kv
        .set(
          storageKey,
          JSON.stringify({
            relays,
            uiScale,
            stayConnected,
            meshTestTarget,
            blossomServer,
            defaultMode,
            defaultEffort,
            defaultModel,
            notificationsEnabled,
            showUsageBadge,
            showCommitBadge,
          }),
        )
        .catch((err) => deps.log?.(`[Settings] persist failed: ${err}`));
    };

    const setRelays = (relays: string[]): void => {
      set({ relays });
      persist();
      deps.onRelaysChanged?.(relays);
    };

    return {
      ...initial,

      addRelay: (url) => {
        const relays = get().relays;
        if (relays.includes(url)) return;
        setRelays([...relays, url]);
      },

      removeRelay: (url) => {
        const relays = get().relays;
        if (!relays.includes(url)) return;
        setRelays(relays.filter((r) => r !== url));
      },

      addRelays: (urls) => {
        const relays = get().relays;
        // CDX-042/CDX-036: automatic merges (fed by pairing URLs) obey the
        // dead-default scrub; `addRelay` (the user typing one in) deliberately
        // does not. The scrub list is EMPTY since CDX-036 — this stays as the
        // seam for any future dead default.
        const incoming = withoutDeadRelays(urls);
        const merged = [...relays, ...incoming.filter((u) => !relays.includes(u))];
        if (merged.length === relays.length) return;
        setRelays(merged);
      },

      setUiScale: (uiScale) => {
        set({ uiScale: clampUiScale(uiScale) });
        persist();
      },

      setStayConnected: (stayConnected) => {
        set({ stayConnected });
        persist();
      },

      setMeshTestTarget: (meshTestTarget) => {
        set({ meshTestTarget });
        persist();
      },

      setBlossomServer: (blossomServer) => {
        set({ blossomServer: blossomServer.trim() });
        persist();
      },

      setDefaultMode: (defaultMode) => {
        set({ defaultMode });
        persist();
      },

      setDefaultEffort: (defaultEffort) => {
        set({ defaultEffort });
        persist();
      },

      setDefaultModel: (defaultModel) => {
        set({ defaultModel: defaultModel.trim() });
        persist();
      },

      setNotificationsEnabled: (notificationsEnabled) => {
        set({ notificationsEnabled });
        persist();
      },

      setShowUsageBadge: (showUsageBadge) => {
        set({ showUsageBadge });
        persist();
      },

      setShowCommitBadge: (showCommitBadge) => {
        set({ showCommitBadge });
        persist();
      },
    };
  });

  return store;
}

export async function loadPersistedSettings(
  kv: KV,
  storageKey: string = SETTINGS_STORAGE_KEY,
): Promise<SettingsData> {
  return hydrateSettings(await kv.get(storageKey));
}
