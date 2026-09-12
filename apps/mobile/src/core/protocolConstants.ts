/**
 * Wire-protocol constants and pure validators the phone still needs at
 * runtime — sourced from `crates/protocol` WITHOUT importing `@codedeck/protocol`:
 * production phone code depends on neither the bridge engine nor the TS wire
 * package now, matching `crypto.ts`'s own reasoning for reimplementing rather
 * than sharing.
 *
 * The values below start at a hand-written fallback (so a screen has
 * something to render before boot finishes, and so plain-browser dev / tests
 * without a `NativeCore` still work) and are OVERWRITTEN once at boot by
 * `applyProtocolDefaults`, called from `main.tsx` with `core.defaults()` —
 * the real `ProtocolDefaults` view `corebridge.rs`'s `core_defaults` computes
 * straight from `protocol::defaults::protocol_defaults()`. Every export here
 * is a `let`, not a `const`: ES module imports are live bindings, so
 * reassigning them inside this module is visible to every already-imported
 * consumer without needing a second indirection (a getter, a store, a
 * re-render) — the same "receive it from Rust, then just render it" shape
 * `nativeMachines.ts`/`nativeSettings.ts` already use for everything else,
 * applied to values that used to be hand-copied literals instead of a view.
 */
import type { EffortLevel, PermissionMode } from './nativeCoreTypes';

export let EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** `bypassPermissions` is intentionally absent — the bridge coerces it to `default`. */
export let PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * See `crates/protocol/src/capabilities.rs`'s doc comment for the three-tier
 * gate/marker/beacon distinction. Only the one string the phone UI actually
 * reads (`customProviders`, a hard gate) is given a key here; add more only
 * as a real call site needs them, keeping this from drifting into a second,
 * unused copy of the full set.
 */
export const CAPABILITIES: { customProviders: string } = {
  customProviders: 'custom-providers',
};

export let DEFAULT_RELAYS: string[] = [
  'wss://relay2.descendant.io',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
];

/** CDX-100: Marmot-only relays, added to the phone's default list only (the
 *  bridge speaks no MLS kind). */
export let MARMOT_RELAYS: string[] = ['wss://relay.us.whitenoise.chat', 'wss://relay.eu.whitenoise.chat'];

export let PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/** The shape `platform/nativeCore.ts`'s `core.defaults()` resolves to —
 *  structurally the generated `ProtocolDefaults` (`nativeCoreTypes.generated.ts`),
 *  named locally so this module doesn't need a runtime dependency on that
 *  export existing under one exact name. */
export interface ProtocolDefaultsShape {
  effortLevels: EffortLevel[];
  permissionModes: PermissionMode[];
  defaultRelays: string[];
  marmotRelays: string[];
  customProvidersCapability: string;
  providerBaseUrlError: string;
}

/** Called once at boot (`main.tsx`) with the real `core.defaults()` — replaces
 *  every hand-written fallback above with what Rust actually computed. */
export function applyProtocolDefaults(d: ProtocolDefaultsShape): void {
  EFFORT_LEVELS = d.effortLevels;
  PERMISSION_MODES = d.permissionModes;
  CAPABILITIES.customProviders = d.customProvidersCapability;
  DEFAULT_RELAYS = d.defaultRelays;
  MARMOT_RELAYS = d.marmotRelays;
  PROVIDER_BASE_URL_ERROR = d.providerBaseUrlError;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is `raw` an acceptable custom-provider base URL? Mirrors `crates/protocol/
 * src/common.rs`'s `is_valid_provider_base_url` — a pure predicate, not a
 * value, so there is no `core.defaults()` field for it to be replaced by;
 * Rust stays authoritative in the sense that matters: a profile actually
 * gets applied through `Intent::SetProviderProfile`, which re-validates
 * independently, so a drift here could only produce a confusing "Save"
 * click, never a bypass of the wire rule itself.
 */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}
