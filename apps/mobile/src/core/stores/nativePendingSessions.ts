/**
 * A native-backed `PendingSessionsStore` (migration F2b) — same family as the
 * other native adapters: exposes the SAME `PendingSessionsStoreState` shape
 * `createPendingSessionsStore` (`./pendingSessions.ts`) does, backed by a
 * cached `NativeCore.pendingSessionsView()`, refreshed on the
 * `pendingSessions` slice's `stateChanged` event.
 *
 * `PendingSessionsStoreState` carries no apply/sweep methods: the Rust
 * Router applies every `session-pending`/`session-ready`/`session-failed`
 * bridge message directly, and its own periodic sweep runs alongside — there
 * is no ingest path left in TS to drive any of that from.
 *
 * `dismiss` is the one user-facing mutator (a failed card's dismiss button)
 * and dispatches `Intent::DismissPendingSession`.
 */
import { createStore } from 'zustand/vanilla';
import { hydrateFromCore } from './nativeHydration';
import type { NativeCore } from '../../platform/nativeCore';
import type { PendingSessionsStore, PendingSessionsStoreState, PendingSessionView } from './pendingSessions';

export interface NativePendingSessionsStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativePendingSessionsStore(deps: NativePendingSessionsStoreDeps): PendingSessionsStore {
  const store = createStore<PendingSessionsStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      const view = await deps.core.pendingSessionsView();
      // `reason` is a skip_serializing_if field — specta types it
      // conservatively as `string | null`, but it's only ever actually
      // omitted on the wire; `./pendingSessions.ts`'s shape predates that
      // and spells "no reason" as `undefined` only.
      const pending: PendingSessionsStoreState['pending'] = {};
      for (const [id, p] of Object.entries(view.pending)) {
        pending[id] = { ...p, ...(p.reason != null ? { reason: p.reason } : { reason: undefined }) };
      }
      set({ pending });
    };

    void hydrateFromCore(
      () =>
        deps.core.onCoreEvent((event) => {
          if (typeof event === 'object' && event.stateChanged?.slice === 'pendingSessions') {
            void refresh().catch((err) => deps.log?.(`[nativePendingSessions] view refresh failed: ${err}`));
          }
        }),
      refresh,
      deps.core.onResume,
      'nativePendingSessions',
      deps.log,
    );

    return {
      pending: {},

      dismiss: (pendingId) => {
        deps.core
          .dispatch({ dismissPendingSession: { pendingId } })
          .catch((err) => deps.log?.(`[nativePendingSessions] dispatch failed: ${err}`));
      },

      // Same predicate + ordering as pendingSessions.ts's own selector: a
      // machine-less failure (no matching session-pending was ever seen)
      // shows for every machine rather than nowhere.
      pendingFor: (machine): PendingSessionView[] =>
        Object.values(get().pending)
          .filter((p) => p.machine === machine || (p.machine === '' && p.state === 'failed'))
          .sort((a, b) => a.seenAt - b.seenAt),
    };
  });

  return store;
}
