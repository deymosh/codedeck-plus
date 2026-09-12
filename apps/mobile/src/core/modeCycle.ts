/**
 * Mode cycle controller (CDX-046) — the tappable PLAN → YOLO → EDITS button's
 * behavior, ported from the legacy `codedeck/src/components/InputBar.tsx` mode
 * button and kept framework-free (same seam discipline as deleteController):
 *
 * - tap cycles plan → default → acceptEdits → plan and SENDS the mode change
 *   (the bridge answers `mode-confirmed`, which lands in the machines store via
 *   createPhoneCore's onModeConfirmed → updateSessionInfo);
 * - a 600ms cooldown between taps (legacy: `modeCooldown`);
 * - while awaiting confirmation the button shows the REQUESTED mode in a
 *   "pending" pulse (legacy: `setting-pending`);
 * - if no confirmation arrives within ~8s the display reverts to the last
 *   CONFIRMED mode — the request may have been lost, so the button must not
 *   lie about the session's mode.
 *
 * Timers and the clock are injected (`Timers` port / `now`) so every timing
 * rule runs on virtual time in tests.
 */
import type { PermissionMode } from './nativeCoreTypes';
import type { Timers } from './ports';

/** Legacy cycle order (InputBar.tsx MODE_CYCLE). */
export const MODE_CYCLE: readonly PermissionMode[] = ['plan', 'default', 'acceptEdits'];

/** Legacy display labels (InputBar.tsx MODE_LABELS, compacted for the box). */
export const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'PLAN',
  default: 'YOLO',
  acceptEdits: 'EDITS',
};

export const MODE_TAP_COOLDOWN_MS = 600;
export const MODE_CONFIRM_TIMEOUT_MS = 8_000;

export interface ModeCycleDeps {
  /** Fire the mode command at the bridge (BridgeApi.modeChange). */
  send(mode: PermissionMode): void;
  /** The last CONFIRMED mode — the machines store's session permissionMode. */
  confirmed(): PermissionMode | undefined;
  /** Display state changed (pending set/cleared/reverted) — re-render seam. */
  onChange?(): void;
  timers: Timers;
  now(): number;
  cooldownMs?: number;
  confirmTimeoutMs?: number;
}

export interface ModeCycleController {
  /** What the button shows: the pending request, else the confirmed mode. */
  displayed(): PermissionMode;
  /** A request is in flight (pending pulse style). */
  isPending(): boolean;
  /** Cycle to the next mode and send it (no-op inside the tap cooldown). */
  tap(): void;
  /** The store's confirmed mode may have changed — reconcile pending state. */
  noteConfirmed(): void;
  /** Clear the revert timer (component unmount). */
  dispose(): void;
}

export function createModeCycle(deps: ModeCycleDeps): ModeCycleController {
  const cooldownMs = deps.cooldownMs ?? MODE_TAP_COOLDOWN_MS;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? MODE_CONFIRM_TIMEOUT_MS;

  let pending: PermissionMode | null = null;
  let revertTimer: unknown = null;
  let lastTapAt = Number.NEGATIVE_INFINITY;

  const clearRevertTimer = (): void => {
    if (revertTimer !== null) {
      deps.timers.clear(revertTimer);
      revertTimer = null;
    }
  };

  const displayed = (): PermissionMode => pending ?? deps.confirmed() ?? 'plan';

  return {
    displayed,
    isPending: () => pending !== null,

    tap: () => {
      const at = deps.now();
      if (at - lastTapAt < cooldownMs) return;
      lastTapAt = at;
      const idx = MODE_CYCLE.indexOf(displayed());
      const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!;
      pending = next;
      // Restart the revert window: only the LATEST request's confirmation
      // (or its absence) decides what the button ends up showing.
      clearRevertTimer();
      revertTimer = deps.timers.set(() => {
        revertTimer = null;
        if (pending === null) return;
        pending = null; // revert display to the last confirmed mode
        deps.onChange?.();
      }, confirmTimeoutMs);
      deps.send(next);
      deps.onChange?.();
    },

    noteConfirmed: () => {
      // Only the matching confirmation settles the pending request — a stale
      // confirmation for an earlier tap must not clear a newer pending one.
      if (pending !== null && deps.confirmed() === pending) {
        pending = null;
        clearRevertTimer();
        deps.onChange?.();
      }
    },

    dispose: () => {
      clearRevertTimer();
    },
  };
}
