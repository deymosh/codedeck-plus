/**
 * pairingStore — pairing URL parsing + the pair-flow state machine.
 *
 * URL format (see @codedeck/core pairing.ts — the builder; this is the parser):
 *   codedeck://pair?npub=<npub>&relays=<comma-separated-encoded>&machine=<name>
 *                  &token=<token>[&netid=<id>&meshadmin=<npub>]
 *
 * Flow: parse URL (QR scan / pasted link) → beginPair sends a pair-request
 * carrying the one-time token → the bridge answers pair-ack → paired (machine
 * registered) or failed (bad-token / window-closed / timeout). Manual fallback:
 * the user types the bridge npub + token from the bridge's pairing screen.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BridgeHostKind, PairAckMessage, PhoneToBridgeMessage } from '@codedeck/protocol';
import { hexFromNpub } from '../crypto';
import type { Logger, Timers } from '../ports';

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
 * CDX-040: how long the phone waits for a pair-ack before calling it.
 *
 * The bridge's own window is 600s, so the phone has nothing to key off: a
 * mistyped token, an already-expired window, or a phone and bridge that share
 * no relay all produce silence, and the overlay used to sit on a bare title +
 * Cancel forever (device-found: ~4 minutes before the tester gave up). The
 * bridge cannot even nack a request it never subscribed for, so the phone must
 * own its own bound. 60s is ~3x the observed happy path (~22s, including the
 * candidate resubscribe and the relay round trip).
 */
export const PAIR_ACK_TIMEOUT_MS = 60_000;

/** The failure text the overlay shows on a CDX-040 timeout. Names the three
 *  real causes — silence alone cannot tell them apart. */
export const pairTimeoutError = (ms: number): string =>
  `no answer from the bridge within ${Math.round(ms / 1000)}s — its pairing ` +
  'window may have closed, the one-time token may be mistyped, or the phone ' +
  'and the bridge may not share a relay';

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

// --- Pair-flow state machine ---

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
  /** pair-ack arrived (routed by bridgeApi). */
  handlePairAck(machinePubkey: string, msg: PairAckMessage): void;
  /** Abandon/clear the flow (also after success, once the UI moved on). */
  reset(): void;
}

export type PairingStore = StoreApi<PairingStoreState>;

export interface PairingStoreDeps {
  /** Make the flow's bridge candidate visible to the subscription layer BEFORE
   *  the request goes out (the ack must pass the authors filter). */
  onCandidate(candidate: PairingCandidate): void;
  /** Send one phone→bridge message to the candidate. */
  send(machinePubkey: string, msg: PhoneToBridgeMessage): void;
  /** Pairing succeeded: persist the machine (+ its relays; the candidate's
   *  relay list already includes any relays the pair-ack carried). */
  onPaired(candidate: PairingCandidate, machineName: string, host?: BridgeHostKind): void;
  /** Phone identity for the pair-request payload. */
  identity(): { npub: string; pubkeyHex: string };
  /** CDX-040: the pair-ack deadline runs on this seam, so it is virtual time
   *  in tests. (No `now()` here — the deadline is a single one-shot timer with
   *  no elapsed-time arithmetic to do, unlike modeCycle's tap cooldown.) */
  timers: Timers;
  /** Deadline override — tests and any future per-flow tuning. */
  pairTimeoutMs?: number;
  log?: Logger;
}

export function createPairingStore(deps: PairingStoreDeps): PairingStore {
  const timeoutMs = deps.pairTimeoutMs ?? PAIR_ACK_TIMEOUT_MS;

  // CDX-040: exactly one deadline is ever armed — a new attempt supersedes the
  // previous one, and every exit from `awaiting-ack` disarms it.
  let deadline: unknown = null;
  const disarm = (): void => {
    if (deadline !== null) {
      deps.timers.clear(deadline);
      deadline = null;
    }
  };

  return createStore<PairingStoreState>()((set, get) => ({
    phase: 'idle',
    candidate: null,
    error: null,
    timedOut: false,
    staged: null,

    stagePair: (parts) => {
      set({ staged: parts });
    },

    confirmStaged: (label) => {
      const staged = get().staged;
      if (!staged) return;
      set({ staged: null });
      get().beginPair(staged, label);
    },

    dismissStaged: () => set({ staged: null }),

    beginPair: (parts, label) => {
      const candidate: PairingCandidate = {
        pubkeyHex: parts.pubkeyHex,
        npub: parts.npub,
        machine: parts.machine,
        relays: parts.relays,
        token: parts.token,
        // CDX-028: BOTH mesh params must survive into the candidate — the old
        // code dropped netid here, starving the post-pair mesh join.
        ...(parts.netid ? { netid: parts.netid } : {}),
        ...(parts.meshAdmin ? { meshAdmin: parts.meshAdmin } : {}),
      };
      set({ phase: 'awaiting-ack', candidate, error: null, timedOut: false });
      // CDX-040: arm the deadline before the request goes out, so even a send
      // that never reaches a relay resolves into a real failure message.
      disarm();
      deadline = deps.timers.set(() => {
        deadline = null;
        if (get().phase !== 'awaiting-ack') return;
        deps.log?.(`[Pairing] no pair-ack within ${timeoutMs}ms — giving up on this attempt`);
        set({ phase: 'failed', error: pairTimeoutError(timeoutMs), timedOut: true });
      }, timeoutMs);
      deps.onCandidate(candidate);
      const me = deps.identity();
      deps.send(candidate.pubkeyHex, {
        type: 'pair-request',
        npub: me.npub,
        pubkeyHex: me.pubkeyHex,
        label,
        token: parts.token,
      });
    },

    beginManualPair: (npub, token, label) => {
      let pubkeyHex: string;
      try {
        pubkeyHex = hexFromNpub(npub.trim());
      } catch {
        return { ok: false, error: 'invalid npub' };
      }
      if (token.trim() === '') {
        return { ok: false, error: 'missing token' };
      }
      get().beginPair(
        {
          npub: npub.trim(),
          pubkeyHex,
          relays: [],
          machine: '(manual)',
          token: token.trim(),
        },
        label,
      );
      return { ok: true };
    },

    handlePairAck: (machinePubkey, msg) => {
      const { phase, candidate, timedOut } = get();
      // CDX-040: a LATE ack (after our own deadline fired) is still honoured —
      // the candidate is still in the subscription filter, and a slow relay
      // must never leave the bridge paired while the phone says it failed.
      // A bridge NACK ('bad-token') is terminal, so `timedOut` gates this.
      const acceptable = phase === 'awaiting-ack' || (phase === 'failed' && timedOut);
      if (!acceptable || !candidate || candidate.pubkeyHex !== machinePubkey) {
        deps.log?.(`[Pairing] unexpected pair-ack from ${machinePubkey.slice(0, 8)}… ignored`);
        return;
      }
      disarm();
      if (!msg.ok) {
        set({ phase: 'failed', error: msg.reason ?? 'rejected', timedOut: false });
        return;
      }
      // Merge relays the ack carried into the candidate's list (deduped) —
      // this is how a manual-npub pairing (URL had no relays) learns where
      // the bridge actually lives.
      const relays = [
        ...candidate.relays,
        ...(msg.relays ?? []).filter((r) => !candidate.relays.includes(r)),
      ];
      // CDX-041: the ack is also where a MANUAL pairing learns the machine's
      // real name — the URL-less flow only had the '(manual)' placeholder, so
      // the confirmation rendered "Paired with (manual)." while the sidebar
      // (fed by onPaired → registerMachine) already showed the true name.
      // Settle the candidate the UI reads from, not just the machines store.
      const paired: PairingCandidate = {
        ...candidate,
        relays,
        machine: msg.machine || candidate.machine,
      };
      set({ phase: 'paired', error: null, timedOut: false, candidate: paired });
      deps.onPaired(paired, paired.machine, msg.host);
    },

    reset: () => {
      disarm(); // CDX-040: Cancel / "Go to machines" must not leave a timer armed
      set({ phase: 'idle', candidate: null, error: null, timedOut: false, staged: null });
    },
  }));
}
