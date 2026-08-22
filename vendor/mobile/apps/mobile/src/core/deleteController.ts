/**
 * deleteController — optimistic session delete with a 4s undo window
 * (Phase 3; the old app's deleteRemoteSession/undoDeleteSession, extracted
 * into a pure factory over injected timers/now).
 *
 * requestDelete: snapshot the SessionView, dismiss (resurrection shield) +
 * remove it locally NOW, show the undo toast, and only after the window
 * passes send close-session to the bridge. undo() inside the window cancels
 * the send and puts the exact snapshot back. A second requestDelete while one
 * is pending COMMITS the pending one immediately — exactly one close-session
 * per committed delete, never a lost one.
 *
 * Transcript rows are NOT touched here: the close-session-ack handler in
 * createPhoneCore already removes them (and re-runs userRemoveSession, which
 * is idempotent) when the bridge confirms.
 */
import type { MachinesStore, SessionView } from './stores/machines';
import type { UiStore } from './stores/ui';
import type { Logger, Timers } from './ports';

export const UNDO_DELAY_MS = 4_000;

export interface DeleteControllerDeps {
  machines: MachinesStore;
  ui: UiStore;
  /** The close-session sender (BridgeApi.closeSession, structurally typed). */
  closeSession(machine: string, sessionId: string): Promise<boolean>;
  timers: Timers;
  now(): number;
  /** Undo window override (tests). Default UNDO_DELAY_MS. */
  undoDelayMs?: number;
  log?: Logger;
}

export interface DeleteController {
  /** Optimistically delete; label is what the undo toast shows. */
  requestDelete(machine: string, sessionId: string, label?: string): void;
  /** Cancel the pending delete and restore the snapshot. No-op when nothing
   *  is pending (the toast is gone by then anyway). */
  undo(): void;
}

interface PendingDelete {
  machine: string;
  sessionId: string;
  snapshot: SessionView;
  timer: unknown;
}

export function createDeleteController(deps: DeleteControllerDeps): DeleteController {
  const undoDelayMs = deps.undoDelayMs ?? UNDO_DELAY_MS;
  let pending: PendingDelete | null = null;

  /** Send close-session for the pending delete and clear the toast. Safe to
   *  call with nothing pending, and from the timer it armed. */
  const commit = (): void => {
    if (!pending) return;
    const { machine, sessionId, timer } = pending;
    pending = null;
    deps.timers.clear(timer);
    void deps.closeSession(machine, sessionId).catch((err) => {
      // The bridge missed it — its next heartbeat still lists the session,
      // but the dismissed shield keeps the card gone until the TTL passes.
      deps.log?.(`[Delete] close-session send failed: ${err}`);
    });
    deps.ui.getState().setUndoToast(null);
  };

  return {
    requestDelete: (machine, sessionId, label) => {
      // A second delete while one is pending commits the pending one NOW.
      commit();

      const snapshot = deps.machines.getState().session(machine, sessionId);
      if (!snapshot) return; // already gone (double fire) — nothing to do

      // Optimistic removal + heartbeat-resurrection shield.
      deps.machines.getState().dismissSession(sessionId, deps.now());
      deps.machines.getState().userRemoveSession(machine, sessionId);

      // The deleted session must not stay selected (the panel would point at
      // a void); its unread dot dies with it (undo does not resurrect dots —
      // old-app semantics).
      const ui = deps.ui.getState();
      ui.clearSessionUnread(machine, sessionId);
      if (ui.selectedMachine === machine && ui.selectedSession === sessionId) {
        ui.selectSession(machine, null);
      }

      pending = {
        machine,
        sessionId,
        snapshot,
        timer: deps.timers.set(commit, undoDelayMs),
      };
      deps.ui.getState().setUndoToast({
        machine,
        sessionId,
        label: label ?? (snapshot.info.title || snapshot.info.slug || 'Session'),
      });
    },

    undo: () => {
      if (!pending) return;
      const { machine, snapshot, timer } = pending;
      pending = null;
      deps.timers.clear(timer);
      // restoreSession un-dismisses AND re-inserts the exact snapshot; the
      // next heartbeat merges over it normally.
      deps.machines.getState().restoreSession(machine, snapshot);
      deps.ui.getState().setUndoToast(null);
    },
  };
}
