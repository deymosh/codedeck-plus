/**
 * pendingSessionsStore — the phone side of two-phase session creation.
 *
 * The bridge publishes `session-pending` immediately on create-session, then
 * either `session-ready` (the runner's SDK init confirmed — the session shows
 * up as a real RemoteSessionInfo) or `session-failed` (reason surfaced to the
 * user). This slice keeps the optimistic placeholders so the sessions screen
 * can show "starting…" cards instantly and honest error cards on failure —
 * previously these handlers were validated-but-unrouted (3a note).
 *
 * Not persisted: a pending session that never resolves is meaningless after a
 * restart (the real list is the bridge's registry); stale entries are swept by
 * `sweep()` on the periodic tick.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

export type PendingSessionState = 'pending' | 'failed';

export interface PendingSessionView {
  pendingId: string;
  machine: string;
  /** Machine display name from the message (not the pubkey). */
  machineName: string;
  createdAt: string;
  state: PendingSessionState;
  /** Set when state === 'failed'. */
  reason?: string;
  /** ms timestamp the placeholder appeared (sweep bookkeeping). */
  seenAt: number;
}

/** A placeholder still 'pending' after this long is swept (the bridge always
 *  answers with ready/failed; losing BOTH means the response event expired). */
export const PENDING_SWEEP_MS = 10 * 60 * 1000;

export interface PendingSessionsStoreState {
  pending: Record<string, PendingSessionView>;

  applyPending(machine: string, msg: { pendingId: string; machine: string; createdAt: string }): void;
  /** session-ready (or the session appearing in a list) resolves the placeholder. */
  resolve(pendingId: string): void;
  applyFailed(pendingId: string, reason: string): void;
  /** User dismisses a failed card. */
  dismiss(pendingId: string): void;
  /** Drop never-resolved placeholders older than PENDING_SWEEP_MS. */
  sweep(): void;

  pendingFor(machine: string): PendingSessionView[];
}

export type PendingSessionsStore = StoreApi<PendingSessionsStoreState>;

export function createPendingSessionsStore(deps: { now(): number }): PendingSessionsStore {
  return createStore<PendingSessionsStoreState>()((set, get) => ({
    pending: {},

    applyPending: (machine, msg) => {
      set({
        pending: {
          ...get().pending,
          [msg.pendingId]: {
            pendingId: msg.pendingId,
            machine,
            machineName: msg.machine,
            createdAt: msg.createdAt,
            state: 'pending',
            seenAt: deps.now(),
          },
        },
      });
    },

    resolve: (pendingId) => {
      if (!get().pending[pendingId]) return;
      const pending = { ...get().pending };
      delete pending[pendingId];
      set({ pending });
    },

    applyFailed: (pendingId, reason) => {
      const existing = get().pending[pendingId];
      set({
        pending: {
          ...get().pending,
          [pendingId]: existing
            ? { ...existing, state: 'failed', reason }
            : {
                // Failure for a pending we never saw (missed ephemeral?) —
                // still surface it; an invisible failure is the old bug.
                pendingId,
                machine: '',
                machineName: '',
                createdAt: '',
                state: 'failed',
                reason,
                seenAt: deps.now(),
              },
        },
      });
    },

    dismiss: (pendingId) => {
      const pending = { ...get().pending };
      delete pending[pendingId];
      set({ pending });
    },

    sweep: () => {
      const cutoff = deps.now() - PENDING_SWEEP_MS;
      const pending = { ...get().pending };
      let changed = false;
      for (const [id, view] of Object.entries(pending)) {
        if (view.state === 'pending' && view.seenAt < cutoff) {
          delete pending[id];
          changed = true;
        }
      }
      if (changed) set({ pending });
    },

    pendingFor: (machine) =>
      Object.values(get().pending)
        .filter((p) => p.machine === machine || (p.machine === '' && p.state === 'failed'))
        .sort((a, b) => a.seenAt - b.seenAt),
  }));
}
