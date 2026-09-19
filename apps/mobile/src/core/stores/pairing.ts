/**
 * Pairing URL parsing (still TS's job — `main.tsx`'s deep-link handler and
 * `PairingScreen.tsx`'s QR/manual entry both parse before dispatching) plus
 * the shared pairing types the native adapter (`nativePairing.ts`) and the
 * UI (`coreContext.tsx`) need.
 *
 *   codedeck://pair?npub=<npub>&relays=<comma-separated-encoded>&machine=<name>
 *                  &token=<token>[&netid=<id>&meshadmin=<npub>]
 *
 * The pair-flow state machine itself (arm/disarm the CDX-040 ack deadline,
 * merge relays the ack carried, the manual-npub fallback) is Rust's job now
 * (`client_core::stores::pairing`) — only the URL parser and the shared
 * TYPES survive here.
 */
import type { StoreApi } from 'zustand/vanilla';
import { hexFromNpub } from '../crypto';

export interface ParsedPairingUrl {
  npub: string;
  pubkeyHex: string;
  relays: string[];
  machine: string;
  token: string;
  /** Active mesh network id (CDX-028 manual-join; pairs with meshAdmin). */
  netid?: string;
  /** Mesh admin device id (npub) for the engine's manual_add_network. */
  meshAdmin?: string;
}

export type ParsePairingResult =
  | { ok: true; parts: ParsedPairingUrl }
  | { ok: false; error: string };

const PAIRING_URL_PREFIX = 'codedeck://pair';

/** CDX-013: a pairing URL feeds its relay list into the GLOBAL relay set on
 *  success — cap it so one hostile link cannot flood settings with endpoints.
 *  Real bridge URLs carry 1-3 relays. */
export const MAX_PAIRING_RELAYS = 5;

/**
 * Parse + validate a pairing URL. Never throws — malformed input comes back as
 * `{ ok: false, error }` for the UI to show.
 *
 * NOTE: `relays` is split on ',' BEFORE percent-decoding (the builder encodes
 * each relay individually, so encoded relays contain no bare commas).
 */
export function parsePairingUrl(url: string): ParsePairingResult {
  const trimmed = url.trim();
  if (!trimmed.startsWith(PAIRING_URL_PREFIX)) {
    return { ok: false, error: 'not a codedeck://pair URL' };
  }
  const queryIndex = trimmed.indexOf('?');
  const rest = trimmed.slice(PAIRING_URL_PREFIX.length, queryIndex === -1 ? undefined : queryIndex);
  if (rest !== '' && rest !== '/') {
    return { ok: false, error: 'not a codedeck://pair URL' };
  }
  if (queryIndex === -1) {
    return { ok: false, error: 'missing query parameters' };
  }

  const params = new Map<string, string>();
  for (const pair of trimmed.slice(queryIndex + 1).split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    // Keep the RAW value — relays must be split before decoding.
    params.set(pair.slice(0, eq), pair.slice(eq + 1));
  }

  const decode = (raw: string, name: string): string | null => {
    try {
      return decodeURIComponent(raw);
    } catch {
      void name;
      return null;
    }
  };

  const npub = params.get('npub') ?? '';
  if (npub === '') return { ok: false, error: 'missing npub' };
  let pubkeyHex: string;
  try {
    pubkeyHex = hexFromNpub(npub);
  } catch {
    return { ok: false, error: 'invalid npub' };
  }

  const tokenRaw = params.get('token') ?? '';
  const token = tokenRaw === '' ? null : decode(tokenRaw, 'token');
  if (!token) return { ok: false, error: 'missing token' };

  const machineRaw = params.get('machine') ?? '';
  const machine = machineRaw === '' ? null : decode(machineRaw, 'machine');
  if (!machine) return { ok: false, error: 'missing machine name' };

  const relaysRaw = params.get('relays') ?? '';
  const relays: string[] = [];
  for (const enc of relaysRaw.split(',')) {
    if (enc === '') continue;
    const relay = decode(enc, 'relay');
    if (relay === null) return { ok: false, error: 'malformed relay list' };
    if (!/^wss?:\/\/.+/.test(relay)) {
      return { ok: false, error: `invalid relay URL: ${relay}` };
    }
    relays.push(relay);
  }
  if (relays.length === 0) return { ok: false, error: 'missing relays' };
  if (relays.length > MAX_PAIRING_RELAYS) {
    return { ok: false, error: `too many relays (max ${MAX_PAIRING_RELAYS})` };
  }

  const netidRaw = params.get('netid');
  const meshAdminRaw = params.get('meshadmin');
  const netid = netidRaw !== undefined ? decode(netidRaw, 'netid') : undefined;
  const meshAdmin = meshAdminRaw !== undefined ? decode(meshAdminRaw, 'meshadmin') : undefined;

  return {
    ok: true,
    parts: {
      npub,
      pubkeyHex,
      relays,
      machine,
      token,
      ...(netid ? { netid } : {}),
      ...(meshAdmin ? { meshAdmin } : {}),
    },
  };
}

// --- Pair-flow types ---

export type PairingPhase = 'idle' | 'awaiting-ack' | 'paired' | 'failed';

export interface PairingCandidate {
  pubkeyHex: string;
  npub: string;
  /** Machine name claimed by the URL ('(manual)' for the npub fallback) —
   *  display only until the pair-ack / first heartbeat carries the real name. */
  machine: string;
  relays: string[];
  token: string;
  /** Mesh manual-join info bundled in the pairing QR (one-QR mesh setup, 5d;
   *  CDX-028 shape) — handed to onPaired so the platform can dispatch
   *  manual_add_network. Both must be present for the join to fire. */
  netid?: string;
  meshAdmin?: string;
}

export interface PairingStoreState {
  phase: PairingPhase;
  candidate: PairingCandidate | null;
  error: string | null;
  /** CDX-040: this `failed` phase came from the phone's own deadline, not from
   *  a bridge nack. The candidate is still subscribed, so a late ack is still
   *  honoured — a slow relay must not leave the bridge paired and the phone
   *  not. Reset by every fresh attempt. */
  timedOut: boolean;
  /** CDX-013: a pairing URL that arrived WITHOUT direct user action (Android
   *  deep link — any web page can fire one). It is only displayed for
   *  confirmation; nothing is sent and no candidate is registered until the
   *  user explicitly confirms. QR scan / pasted link keep calling beginPair
   *  directly — there the user action IS the intent. */
  staged: ParsedPairingUrl | null;

  /** Start pairing from a parsed URL: registers the candidate (so ingest
   *  accepts the bridge's answer) and sends the pair-request. */
  beginPair(parts: ParsedPairingUrl, label: string): void;
  /** Stage a deep-link pairing URL for explicit user confirmation. */
  stagePair(parts: ParsedPairingUrl): void;
  /** User confirmed the staged deep link — run the normal beginPair flow. */
  confirmStaged(label: string): void;
  /** User dismissed the staged deep link. */
  dismissStaged(): void;
  /** Manual fallback: bridge npub + token typed by the user. */
  beginManualPair(npub: string, token: string, label: string): { ok: boolean; error?: string };
  /** Abandon/clear the flow (also after success, once the UI moved on). */
  reset(): void;
}

export type PairingStore = StoreApi<PairingStoreState>;
