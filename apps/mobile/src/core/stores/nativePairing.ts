/**
 * A native-backed `PairingStore` (migration F2b) — same pattern as
 * `nativeOutbox.ts`/`nativeSettings.ts`: the SAME `PairingStoreState`
 * shape `createPairingStore` (`./pairing.ts`) exposes, backed by
 * `NativeCore.dispatch`/`pairingView()`/`onCoreEvent`.
 *
 * Two representational gaps between the TS and Rust sides, both resolved
 * the same way — the caller already had the data, so this adapter just
 * remembers it rather than needing the Rust view to carry it:
 *
 * - `beginPair`/`stagePair` take an ALREADY-PARSED `ParsedPairingUrl`, but
 *   `Intent::BeginPairing`/`StagePairing` need the raw `codedeck://pair`
 *   URL (the Rust store re-parses it itself, matching the TS parser's own
 *   "spec"). `buildPairingUrl` reconstructs it — mirrors
 *   `packages/core`'s pairing URL BUILDER byte for byte (relay/machine/
 *   token/mesh params individually `encodeURIComponent`'d, `npub` raw).
 * - The Rust `PairingView` reports `hasStaged: boolean`, not the staged
 *   URL's parsed details the confirm screen displays — `stagePair`'s
 *   caller already handed us the full `ParsedPairingUrl`, so it's cached
 *   locally and shown until the view reports `hasStaged: false`.
 *
 * `handlePairAck` is a no-op: the Rust `Router` folds a bridge pair-ack
 * into the pairing store directly, without this adapter's help.
 */
import { createStore } from 'zustand/vanilla';
import { hexFromNpub } from '../crypto';
import { hydrateFromCore } from './nativeHydration';
import type { NativeCore } from '../../platform/nativeCore';
import type { Intent, PairingCandidateView } from '../nativeCoreTypes';
import type { ParsedPairingUrl, PairingCandidate, PairingPhase, PairingStore, PairingStoreState } from './pairing';

function buildPairingUrl(parts: ParsedPairingUrl): string {
  const relaysParam = parts.relays.map((r) => encodeURIComponent(r)).join(',');
  const tokenParam = `&token=${encodeURIComponent(parts.token)}`;
  const meshParam =
    parts.netid && parts.meshAdmin
      ? `&netid=${encodeURIComponent(parts.netid)}&meshadmin=${encodeURIComponent(parts.meshAdmin)}`
      : '';
  return `codedeck://pair?npub=${parts.npub}&relays=${relaysParam}&machine=${encodeURIComponent(parts.machine)}${tokenParam}${meshParam}`;
}

function toCandidate(view: PairingCandidateView | null): PairingCandidate | null {
  if (!view) return null;
  // `token` is not part of the Rust view (nothing outside this store reads
  // a paired/awaiting candidate's token — see the module doc comment on
  // `PairingCandidate` for how it's used internally by the TS store only).
  return { pubkeyHex: view.pubkeyHex, npub: view.npub, machine: view.machine, relays: view.relays, token: '' };
}

export interface NativePairingStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativePairingStore(deps: NativePairingStoreDeps): PairingStore {
  const store = createStore<PairingStoreState>()((set) => {
    let stagedCache: ParsedPairingUrl | null = null;

    const refresh = async (): Promise<void> => {
      const view = await deps.core.pairingView();
      if (!view) return;
      if (!view.hasStaged) stagedCache = null;
      set({
        // `PairingView.phase` crosses the wire as a plain Rust `&'static
        // str`, not a literal-union type (specta has no way to see the
        // closed set `Core::phase_str` actually emits) — same trust the
        // hand-written type placed in this value before generation existed.
        phase: view.phase as PairingPhase,
        candidate: toCandidate(view.candidate),
        error: view.error,
        timedOut: view.timedOut,
        staged: view.hasStaged ? stagedCache : null,
      });
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'pairing') {
            void refresh().catch((err) => deps.log?.(`[nativePairing] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativePairing',
      deps.log,
    );

    const dispatch = (intent: Intent): void => {
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativePairing] dispatch failed: ${err}`));
    };

    return {
      phase: 'idle',
      candidate: null,
      error: null,
      timedOut: false,
      staged: null,

      stagePair: (parts) => {
        stagedCache = parts;
        set({ staged: parts });
        dispatch({ stagePairing: { url: buildPairingUrl(parts) } });
      },

      confirmStaged: (label) => {
        // Mirrors `pairing.ts`'s own `confirmStaged`: clear the staged
        // screen the instant the user confirms, rather than waiting for
        // the round trip through Rust and the next `stateChanged` refresh.
        stagedCache = null;
        set({ staged: null });
        dispatch({ confirmStagedPairing: { label } });
      },

      dismissStaged: () => {
        stagedCache = null;
        set({ staged: null });
        dispatch('dismissStagedPairing');
      },

      beginPair: (parts, label) => dispatch({ beginPairing: { url: buildPairingUrl(parts), label } }),

      beginManualPair: (npub, token, label) => {
        // Only the npub/token FORMAT is validated synchronously — same
        // contract the existing store has today (the bridge's actual
        // verdict always arrives later, as a phase change, never from this
        // return value). The Rust side re-derives the pubkey itself.
        try {
          hexFromNpub(npub.trim());
        } catch {
          return { ok: false, error: 'invalid npub' };
        }
        if (token.trim() === '') {
          return { ok: false, error: 'missing token' };
        }
        dispatch({ beginManualPairing: { npub: npub.trim(), token: token.trim(), label } });
        return { ok: true };
      },

      handlePairAck: () => {},

      reset: () => {
        // Mirrors `pairing.ts`'s own `reset`: clear synchronously, same
        // reasoning as `confirmStaged` above.
        stagedCache = null;
        set({ staged: null });
        dispatch('resetPairing');
      },
    };
  });

  return store;
}
