/**
 * GSD phase status → the Discuss / Plan / Execute stage triple + strip lines.
 *
 * Ported from the old app's utils/gsdStages.ts (CD-052), retyped on the v10
 * @codedeck/protocol GsdState/GsdPhase. The vocabulary is GSD's own
 * (gsd-core/workflows/manager.md renders the same three columns) — phone and
 * desktop must describe a phase identically.
 *
 * The three marks read left→right as Discuss, Plan, Execute:
 *   ✓ done · ◆ in flight / needs you · ○ ready to start · · not reached yet
 *
 * NOTE (memory: codedeck-gsd-stage-strip): all of this renders bridge-computed
 * state from gsd-tools — the phone never parses .planning/ markdown.
 */
import type { GsdAction, GsdPhase, GsdState } from '../../core/nativeCoreTypes';

export type StageMark = '✓' | '◆' | '○' | '·';

export interface PhaseStages {
  /** [Discuss, Plan, Execute] */
  marks: [StageMark, StageMark, StageMark];
  label: string;
}

const STAGES: Record<string, PhaseStages> = {
  complete: { marks: ['✓', '✓', '✓'], label: 'Complete' },
  executed: { marks: ['✓', '✓', '◆'], label: 'Verification required' },
  partial: { marks: ['✓', '✓', '◆'], label: 'Executing…' },
  planned: { marks: ['✓', '✓', '○'], label: 'Ready to execute' },
  discussed: { marks: ['✓', '○', '·'], label: 'Ready to plan' },
  researched: { marks: ['✓', '○', '·'], label: 'Ready to plan' },
  empty: { marks: ['·', '·', '·'], label: 'Up next' },
};

const UNKNOWN: PhaseStages = { marks: ['·', '·', '·'], label: 'Up next' };

export function phaseStages(phase: GsdPhase): PhaseStages {
  const base = STAGES[phase.diskStatus] ?? UNKNOWN;
  // A phase GSD has an action for is reachable now — say so, not "Up next".
  if (base === UNKNOWN && phase.action) {
    return { marks: ['·', '·', '·'], label: `Ready to ${phase.action}` };
  }
  return base;
}

/** Human label for `GsdState.situation`, for the collapsed one-liner. */
const SITUATIONS: Record<string, string> = {
  'no-project': 'No project',
  'needs-first-phase': 'Plan first phase',
  planning: 'Planning',
  executing: 'Executing',
  'verify-pending': 'Verify',
  'verify-failed': 'Verify failed',
  paused: 'Paused',
  blocked: 'Blocked',
  'idle-stranded': 'Idle',
  complete: 'Complete',
  unknown: 'GSD',
};

export function situationLabel(situation: string): string {
  return SITUATIONS[situation] ?? 'GSD';
}

/**
 * The one-line summary shown in the collapsed strip, e.g.
 * `v1.0 — MVP · Phase 2/3 · Executing · 50%`. Unresolved parts are dropped
 * rather than rendered as "null" or "0".
 */
export function stripSummary(gsd: GsdState): string {
  const parts: string[] = [];
  if (gsd.milestone) parts.push(gsd.milestone);

  const total = gsd.totalPhases ?? (gsd.phases.length || null);
  if (gsd.currentPhase && total) parts.push(`Phase ${gsd.currentPhase}/${total}`);
  else if (gsd.currentPhase) parts.push(`Phase ${gsd.currentPhase}`);
  else if (total) parts.push(`${total} phases`);

  parts.push(situationLabel(gsd.situation));
  parts.push(`${gsd.percent}%`);
  return parts.join(' · ');
}

/** The action the strip offers as a tappable chip, or null. */
export function recommendedAction(gsd: GsdState): GsdAction | null {
  if (gsd.actions.length === 0) return null;
  return (
    gsd.actions.find((a) => a.id === gsd.recommended) ??
    gsd.actions.find((a) => a.recommended) ??
    gsd.actions[0] ??
    null
  );
}

/**
 * The live line shown while a phase is executing, e.g.
 * `Phase 2 · plan 1/2 · task 2/3 · cover the build step`. Exists because the
 * ordinary readout is FROZEN during an execute (parallel-wave state writes are
 * batched after the merge). Null when there's nothing real to report.
 */
export function executionLine(gsd: GsdState): string | null {
  const e = gsd.execution;
  if (!e) return null;

  const parts = [`Phase ${e.phase}`];
  if (e.plansTotal > 0) {
    parts.push(`plan ${Math.min(e.plansDone + 1, e.plansTotal)}/${e.plansTotal}`);
  }
  if (e.tasksTotal) parts.push(`task ${e.tasksDone}/${e.tasksTotal}`);
  else if (e.tasksDone > 0) parts.push(`task ${e.tasksDone}`);
  if (e.lastTask) parts.push(e.lastTask);
  return parts.join(' · ');
}

export interface RecoveryChip {
  id: string;
  label: string;
  command: string;
}

/** Recovery states are first-class in GSD; each gets a visible way out. */
export function recoveryChips(gsd: GsdState): RecoveryChip[] {
  const chips: RecoveryChip[] = [];
  if (gsd.paused) chips.push({ id: 'resume', label: 'Resume', command: '/gsd-resume-work' });
  if (gsd.verifyFailed) {
    chips.push({ id: 'reverify', label: 'Re-verify', command: '/gsd-verify-work' });
  }
  if (gsd.blockers.length > 0) {
    chips.push({
      id: 'debug',
      label: gsd.blockers.length > 1 ? `${gsd.blockers.length} blockers` : 'Blocked',
      command: '/gsd-debug',
    });
  }
  return chips;
}
