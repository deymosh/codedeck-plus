/**
 * A native-backed `PendingSessionsStore` (migration F2b) — same family as the
 * other native adapters: exposes the SAME `PendingSessionsStoreState` shape
 * `createPendingSessionsStore` (`./pendingSessions.ts`) does, backed by a
 * cached `NativeCore.pendingSessionsView()`, refreshed on the
 * `pendingSessions` slice's `stateChanged` event.
 *
 * `applyPending`/`resolve`/`applyFailed`/`sweep` are no-ops — the same
 * reasoning as `nativeMachines.ts`'s: these exist only to satisfy the
 * `PendingSessionsStoreState` interface for any code still typed against it.
 * In native mode the Rust Router applies every `session-pending`/
 * `session-ready`/`session-failed` bridge message directly, and its own
 * periodic sweep runs alongside — there is no ingest path left in TS to
 * drive any of these from.
 *
 * `dismiss` is the one user-facing mutator (a failed card's dismiss button)
 * and dispatches `Intent::DismissPendingSession`.
 */
import { createStore } from 'zustand/vanilla';
import type { NativeCore } from '../../platform/nativeCore';
import type { PendingSessionsStore, PendingSessionsStoreState, PendingSessionView } from './pendingSessions';

export interface NativePendingSessionsStoreDeps {
  core: NativeCore;
  log?(msg: string): void;
}

export function createNativePendingSessionsStore(deps: NativePendingSessionsStoreDeps): PendingSessionsStore {
  const store = createStore<PendingSessionsStoreState>()((set, get) => {
    const refresh = async (): Promise<void> => {
      try {
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
      } catch (err) {
        deps.log?.(`[nativePendingSessions] view refresh failed: ${err}`);
      }
    };

    void deps.core
      .onCoreEvent((event) => {
        if (typeof event === 'object' && event.stateChanged?.slice === 'pendingSessions') {
          void refresh();
        }
      })
      .catch((err) => deps.log?.(`[nativePendingSessions] onCoreEvent failed: ${err}`));
    void refresh();

    const noop = (): void => {};

    return {
      pending: {},

      applyPending: noop,
      resolve: noop,
      applyFailed: noop,
      sweep: noop,

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
