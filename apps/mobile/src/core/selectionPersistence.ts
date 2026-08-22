/**
 * CDX-054 — the selected session must survive a WebView reload.
 *
 * A configuration change the manifest does not handle (and any future OEM
 * recreation path, or process death during a fold) destroys the Android
 * activity, reloads the WebView, and resets every transient store — the user
 * lands back on the no-selection drawer mid-work. The primary fix is
 * `android:configChanges="…|density"` (AndroidManifest.xml); this module is
 * the belt-and-braces: the last session selection is persisted through the KV
 * port and restored on boot, but ONLY within a short TTL so a genuine cold
 * start (hours later) still opens on the drawer home surface.
 *
 * The timestamp is refreshed on every selection change AND on every
 * app-hide signal (an activity recreation always passes through onPause →
 * visibilitychange before the WebView dies), so a fold after ten minutes of
 * reading still restores: the hide that precedes the reload re-arms the TTL.
 */
import type { KV } from './ports';

export const LAST_SELECTION_KEY = 'client.lastSelection';

/** Recreation completes in seconds; a minute of slack covers slow devices
 *  without turning cold starts into session restores. */
export const SELECTION_RESTORE_TTL_MS = 60_000;

export interface PersistedSelection {
  machine: string;
  sessionId: string;
  /** ms timestamp of the last selection change or app-hide refresh. */
  at: number;
}

export function encodeSelection(sel: PersistedSelection): string {
  return JSON.stringify(sel);
}

export function decodeSelection(raw: string | undefined): PersistedSelection | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const sel = parsed as Record<string, unknown>;
  if (
    typeof sel['machine'] !== 'string' ||
    sel['machine'] === '' ||
    typeof sel['sessionId'] !== 'string' ||
    sel['sessionId'] === '' ||
    typeof sel['at'] !== 'number' ||
    !Number.isFinite(sel['at'])
  ) {
    return null;
  }
  return { machine: sel['machine'], sessionId: sel['sessionId'], at: sel['at'] };
}

/**
 * Fresh enough to be a reload, not a cold start.
 *
 * The window is bounded on BOTH sides. A negative age means the clock moved
 * backwards between the write and this read — the device RTC runs ahead at
 * boot and NTP corrects it seconds later, which is routine on Android — and an
 * unbounded `<= TTL` would call such a record fresh forever, so a selection
 * stamped with a future time would keep re-restoring on every cold start,
 * violating the 60 s invariant this module documents. A record from the future
 * is not fresh, it is untrustworthy: no restore, the drawer home wins.
 */
export function isRestorable(sel: PersistedSelection | null, now: number): boolean {
  if (sel === null) return false;
  const age = now - sel.at;
  return age >= 0 && age <= SELECTION_RESTORE_TTL_MS;
}

export async function loadPersistedSelection(kv: KV): Promise<PersistedSelection | null> {
  return decodeSelection(await kv.get(LAST_SELECTION_KEY));
}
