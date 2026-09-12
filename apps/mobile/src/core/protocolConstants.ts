/**
 * Wire-protocol constants and pure validators the phone still needs at
 * runtime — mirrored from `crates/protocol` WITHOUT importing `@codedeck/protocol`:
 * production phone code depends on neither the bridge engine nor the TS wire
 * package now, matching `crypto.ts`'s own reasoning for reimplementing rather
 * than sharing. `nativeCoreTypes.ts` already gets `EffortLevel`/`PermissionMode`
 * as TYPES from the Rust-generated bindings; this file supplies the small
 * amount of RUNTIME behavior around them (enumerate the values, validate one)
 * that a generated `type` alias can't carry on its own.
 *
 * Every value below has a Rust source of truth and is cross-checked there —
 * `crates/protocol/src/codec_conformance.rs`'s fixture corpus fails loudly if
 * `EffortLevel`/`PermissionMode`'s wire spelling ever drifts from
 * `packages/protocol`'s zod schemas, so a drift here would show up as a very
 * visible CI failure on the Rust side, not a silent phone-only bug.
 */
import type { EffortLevel, PermissionMode } from './nativeCoreTypes';

/** Mirrors `crates/protocol/src/common.rs`'s `EffortLevel` (`#[serde(rename_all
 *  = "lowercase")]`) / `packages/protocol/src/schemas/common.ts`'s
 *  `effortLevelSchema`. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Mirrors `crates/protocol/src/common.rs`'s `PermissionMode` /
 *  `packages/protocol/src/schemas/common.ts`'s `permissionModeSchema`.
 *  `bypassPermissions` is intentionally absent on both sides — the bridge
 *  coerces it to `default`. */
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Mirrors `crates/protocol/src/capabilities.rs` / `packages/protocol/src/
 * capabilities.ts`'s `CAPABILITIES` — see either file's own doc comment for
 * the three-tier gate/marker/beacon distinction. Only the two strings the
 * phone UI actually reads (`customProviders`, a hard gate) are given a key
 * here; add more only as a real call site needs them, keeping this list from
 * silently drifting into a second, unused copy of the full set.
 */
export const CAPABILITIES = {
  customProviders: 'custom-providers',
} as const;

/** Mirrors `crates/protocol/src/relays.rs` / `packages/protocol/src/relays.ts`. */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay2.descendant.io',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
];

/** CDX-100: Marmot-only relays, added to the phone's default list only (the
 *  bridge speaks no MLS kind) — same source as `DEFAULT_RELAYS` above. */
export const MARMOT_RELAYS: readonly string[] = [
  'wss://relay.us.whitenoise.chat',
  'wss://relay.eu.whitenoise.chat',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The message shown when a custom-provider base URL is rejected — mirrors
 *  `crates/protocol/src/common.rs`'s `PROVIDER_BASE_URL_ERROR` /
 *  `packages/protocol/src/schemas/common.ts`'s constant of the same name
 *  verbatim, so the phone renders the identical sentence the wire enforces. */
export const PROVIDER_BASE_URL_ERROR =
  'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])';

/**
 * Is `raw` an acceptable custom-provider base URL? Mirrors `crates/protocol/
 * src/common.rs`'s `is_valid_provider_base_url` (Rust is authoritative: a
 * profile actually gets applied through `Intent::SetProviderProfile`, which
 * re-validates independently — this is client-side pre-validation only, so a
 * drift here could produce a confusing "Save" click, never a bypass of the
 * wire rule itself).
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
