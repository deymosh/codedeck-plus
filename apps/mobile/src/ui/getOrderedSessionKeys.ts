/**
 * Shared sidebar ⇄ swipe-carousel session ordering (Phase 8).
 *
 * The swipe carousel navigates the EXACT list the sidebar displays — if the
 * two orders ever diverged, a swipe would land somewhere the eye didn't
 * predict. So both consumers import these functions: the Sidebar renders
 * `orderedMachines` × `orderedSessions`, and the carousel flattens the same
 * pair via `getOrderedSessionKeys`. Order can then never diverge by
 * construction (plus a render-parity guard test).
 *
 * Order (matching the old app's getOrderedSessionIds semantics):
 * - machines sorted by name asc (the Sidebar's machineList)
 * - per machine, sessions sorted by lastActivity desc
 * - pending sessions excluded — structurally: pendings live in the
 *   pendingSessions store, never in machine.sessions.
 */
import type { MachineView, SessionView } from '../core/stores/machines';

export interface SessionKey {
  machine: string;
  sessionId: string;
}

/** Machine display order — name asc (ties broken by pubkey for stability). */
export function orderedMachines(machines: Record<string, MachineView>): MachineView[] {
  return Object.values(machines).sort(
    (a, b) => a.name.localeCompare(b.name) || a.pubkeyHex.localeCompare(b.pubkeyHex),
  );
}

/** Per-machine session display order — lastActivity desc (the Sidebar's cards). */
export function orderedSessions(machine: MachineView): SessionView[] {
  return Object.values(machine.sessions).sort((a, b) =>
    (b.info.lastActivity || '').localeCompare(a.info.lastActivity || ''),
  );
}

/** Flat `{machine, sessionId}` list in the sidebar's visual order. */
export function getOrderedSessionKeys(machines: Record<string, MachineView>): SessionKey[] {
  const keys: SessionKey[] = [];
  for (const machine of orderedMachines(machines)) {
    for (const session of orderedSessions(machine)) {
      keys.push({ machine: machine.pubkeyHex, sessionId: session.info.id });
    }
  }
  return keys;
}
