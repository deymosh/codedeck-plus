/**
 * A native-backed `DmStore` (migration F2b) — same family as the other
 * native adapters: exposes the SAME `DmStoreState` shape `createDmStore`
 * (`./dm.ts`) does, backed by a cached `NativeCore.dmView()` refreshed on
 * the dm slice's `stateChanged` event, with every mutation going through
 * `NativeCore.dispatch`.
 *
 * `start`/`stop`/`ingest` are no-ops: the TS store's per-conversation
 * gift-wrap subscription (its own epoch guard, its own since-cursor) is a
 * transport-level concern the connection FSM used to drive directly. In
 * native mode there is no separate "DM subscription" to open/close from TS —
 * `client-runtime` multiplexes every kind of traffic over one socket and
 * owns the 1059 subscription itself for as long as the core is running.
 * `subscribed` mirrors that: always `true` once this adapter is constructed
 * (there is nothing meaningful to toggle it false from here).
 *
 * Profile resolution (`resolveProfile`/`resolveAllProfiles`, backing the
 * `profiles`/`profileStatus` fields) is the one piece of `DmStoreState` this
 * adapter does NOT delegate to Rust: `client-runtime` has no Intent or view
 * for it yet (`client-core`'s `DmState` models the cache shape, but nothing
 * wires a kind-0 fetch to it). Since a display-name lookup is metadata
 * convenience, not wire protocol or crypto, this adapter keeps the exact
 * same cache logic `dm.ts` has today — same TTL, same injected
 * `ProfileFetcher` — as a small local slice layered on top of the
 * Rust-backed conversation state, rather than leaving the DM screens
 * permanently showing truncated pubkeys until that Rust surface exists.
 *
 * `retry` cannot remove the old failed row the way `dm.ts` does (native
 * message state lives in Rust, and there is no "delete this DM message"
 * Intent) — it re-dispatches `sendDm` with the same content and lets the
 * next view refresh reflect whatever the Rust store ends up holding.
 */
import { createStore } from 'zustand/vanilla';
import { parsePeerInput } from './dm';
import type { DmConversation, DmMessage, DmProfile, DmProfileStatus, DmStore, DmStoreState, ProfileFetcher } from './dm';
import type { NativeCore } from '../../platform/nativeCore';
import type { DmView as NativeDmView } from '../nativeCoreTypes';

/** Mirrors `dm.ts`'s own (private) `PROFILE_CACHE_TTL_MS`. */
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function toConversations(view: NativeDmView): Record<string, DmConversation> {
  const out: Record<string, DmConversation> = {};
  for (const c of view.conversations) out[c.peerPubkey] = c;
  return out;
}

export interface NativeDmStoreDeps {
  core: NativeCore;
  profileFetcher?: ProfileFetcher;
  now?(): number;
  log?(msg: string): void;
}

export function createNativeDmStore(deps: NativeDmStoreDeps): DmStore {
  const now = deps.now ?? Date.now;

  /** In-flight profile fetches (dedup concurrent callers) — same pattern as
   *  `dm.ts`'s own module-scoped map. */
  const profileInFlight = new Map<string, Promise<void>>();

  const store = createStore<DmStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      try {
        const view = await deps.core.dmView();
        if (!view) return;
        set({
          conversations: toConversations(view),
          messages: view.messages as Record<string, DmMessage[]>,
          activePeer: view.activePeer,
          diagnostics: {
            eventsReceived: view.eventsReceived,
            unwrapFailures: view.unwrapFailures,
            invalidRumors: view.invalidRumors,
          },
        });
      } catch (err) {
        deps.log?.(`[nativeDm] view refresh failed: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && 'stateChanged' in event && event.stateChanged.slice === 'dm') {
          void refresh();
        }
      })
      .catch((err) => deps.log?.(`[nativeDm] onCoreEvent failed: ${err}`));
    void refresh();

    const dispatch = (intent: Parameters<NativeCore['dispatch']>[0]): Promise<void> =>
      deps.core.dispatch(intent).catch((err) => deps.log?.(`[nativeDm] dispatch failed: ${err}`));

    return {
      conversations: {},
      messages: {},
      activePeer: null,
      subscribed: true,
      diagnostics: { eventsReceived: 0, unwrapFailures: 0, invalidRumors: 0 },
      profiles: {},
      profileStatus: {},

      start: () => {},
      stop: () => {},
      ingest: () => {},

      send: async (peerPubkey, content) => {
        await dispatch({ sendDm: { peer: peerPubkey, text: content } });
        await refresh();
        const list = get().messages[peerPubkey] ?? [];
        return (
          list[list.length - 1] ?? {
            id: globalThis.crypto.randomUUID(),
            peerPubkey,
            senderPubkey: '',
            content,
            at: now(),
            status: 'failed',
          }
        );
      },

      retry: async (peerPubkey, messageId) => {
        const failed = (get().messages[peerPubkey] ?? []).find(
          (m) => m.id === messageId && m.status === 'failed',
        );
        if (!failed) return;
        await dispatch({ sendDm: { peer: peerPubkey, text: failed.content } });
        await refresh();
      },

      startConversation: (peerInput) => {
        // Same synchronous format pre-check `beginManualPair` (nativePairing)
        // runs: only the FORMAT is knowable client-side, so this reuses
        // dm.ts's own pure parser rather than re-deriving it. The actual
        // registration is async, fired in the background.
        const peer = parsePeerInput(peerInput);
        if (peer === null) return null;
        void dispatch({ startDmConversation: { peerInput } }).then(refresh);
        return peer;
      },

      setActivePeer: (peerPubkey) => {
        // Optimistic — same reasoning as nativePairing's confirmStaged/reset:
        // the UI navigates immediately rather than waiting on a round trip.
        set({ activePeer: peerPubkey });
        void dispatch({ selectDmPeer: { peer: peerPubkey } });
      },

      markRead: (peerPubkey) => {
        void dispatch({ markDmRead: { peer: peerPubkey } });
      },

      resolveProfile: async (pubkeyHex, opts) => {
        const fetcher = deps.profileFetcher;
        if (!fetcher) return;

        const cached = get().profiles[pubkeyHex];
        if (
          !opts?.force &&
          cached &&
          cached.status === 'ok' &&
          now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS
        ) {
          set({ profileStatus: { ...get().profileStatus, [pubkeyHex]: 'ok' } });
          return;
        }

        const inFlight = profileInFlight.get(pubkeyHex);
        if (inFlight) return inFlight;

        set({ profileStatus: { ...get().profileStatus, [pubkeyHex]: 'loading' } });
        const task = (async (): Promise<void> => {
          const meta: DmProfile = await fetcher(pubkeyHex);
          const status: DmProfileStatus = meta.status === 'ok' ? 'ok' : 'error';
          set({
            profiles: { ...get().profiles, [pubkeyHex]: meta },
            profileStatus: { ...get().profileStatus, [pubkeyHex]: status },
          });
        })().finally(() => profileInFlight.delete(pubkeyHex));
        profileInFlight.set(pubkeyHex, task);
        return task;
      },

      resolveAllProfiles: () => {
        // Unlike dm.ts's own implementation, this never resolves "self" —
        // there is no identity view on the native core surface yet to learn
        // our own pubkey from, and no production screen renders our own
        // display name from this cache.
        for (const peer of Object.keys(get().conversations)) {
          void get().resolveProfile(peer);
        }
      },
    };
  });

  return store;
}
