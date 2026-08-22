/**
 * GsdStrip (Phase 5c) — the GSD stage strip under the session header, ported
 * from the old GsdStageBar (CD-052) with light cleanup on the 5a tokens.
 *
 * GSD is command-driven — no hooks, no ambient UI — so driving a workflow from
 * a phone otherwise means remembering which phase you're on and typing
 * `/gsd-execute-phase 2` on a touch keyboard. The strip answers "where am I"
 * in one line and turns the next step into one tap.
 *
 * Light-cleanup deltas vs the old bar (deliberate):
 * - No setup mode / per-session opt-in: `gsd.available` (a real `.planning/`)
 *   is the ONE visibility gate — no state → no strip. Starting GSD on a fresh
 *   project stays a typed command; the old opt-in store carried its own bug
 *   surface (CD-056/058) for a flow the rebuild doesn't need yet.
 * - The old modal GsdStagePanel became an inline expand: tap the summary row
 *   to unfold the per-phase Discuss/Plan/Execute marks, tap again to fold.
 *
 * Ported guards:
 * - CD-055: while a turn is running (or waiting on you) a sent command is
 *   folded into the running turn and silently lost — chips are blocked.
 * - Refresh rides the existing gsd-request command path: unconditionally once
 *   on mount (CDX-032: the bridge only publishes gsd-state in reply, so the
 *   phone must always initiate), and on every expand (state only moves when
 *   commands finish).
 * - Commands go through the outbox (same path as typing) so a tap is never
 *   invisible: it renders in the stream like any other input.
 */
import { useEffect, useState } from 'react';
import { useMachines, usePhoneCore } from '../coreContext';
import {
  executionLine,
  phaseStages,
  recommendedAction,
  recoveryChips,
  stripSummary,
} from './gsdStages';
import { cx } from '../shared';
import styles from './GsdStrip.module.css';

export function GsdStrip({
  machinePubkey,
  sessionId,
}: {
  machinePubkey: string;
  sessionId: string;
}) {
  const core = usePhoneCore();
  const gsd = useMachines((s) => s.machines[machinePubkey]?.sessions[sessionId]?.gsd);
  const sessionState = useMachines(
    (s) => s.machines[machinePubkey]?.sessions[sessionId]?.info.state,
  );
  const [open, setOpen] = useState(false);

  const available = gsd?.available === true;

  // One request on mount, per session (CDX-032): the bridge only publishes
  // gsd-state in reply to gsd-request and the phone starts with none — gating
  // this on already-having state meant neither side ever initiated and the
  // strip could never render. Also refreshes stored state from a prior run.
  useEffect(() => {
    void core.api.gsdRequest(machinePubkey, sessionId);
  }, [core, machinePubkey, sessionId]);

  if (!gsd || !available) return null;

  // CD-055: a command sent during a running/blocked turn is folded into that
  // turn and lost. Block at the source instead of letting a tap lie.
  const waiting = sessionState === 'waiting_question' || sessionState === 'waiting_permission';
  const busy = sessionState === 'running' || waiting;

  const run = (command: string): void => {
    if (busy) return;
    // Same path as typing it — the command shows up in the stream.
    void core.outbox.getState().send(machinePubkey, sessionId, command);
    setOpen(false);
  };

  const exec = executionLine(gsd);
  const chips = recoveryChips(gsd);
  const action = recommendedAction(gsd);
  const pct = Math.max(0, Math.min(100, gsd.percent));
  // Mid-execute or blocked, the recommended action is stale or double-fires.
  const showAction = !busy && !exec && action !== null;
  const summary = waiting ? 'Waiting on you' : (exec ?? stripSummary(gsd));

  return (
    <div className={styles.wrap} data-testid="gsd-strip">
      <div className={cx(styles.bar, waiting && styles.barWaiting, exec !== null && styles.barRunning)}>
        <button
          className={styles.main}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) void core.api.gsdRequest(machinePubkey, sessionId);
          }}
          aria-label="Show GSD phases"
          aria-expanded={open}
        >
          <span className={styles.chevron} aria-hidden="true">
            {waiting ? '!' : exec ? '⟳' : open ? '▾' : '▸'}
          </span>
          <span className={styles.summary}>{summary}</span>
          {!waiting && (
            <span className={styles.meter} aria-hidden="true">
              <span className={styles.meterFill} style={{ width: `${pct}%` }} />
            </span>
          )}
        </button>

        {chips.map((c) => (
          <button
            key={c.id}
            className={cx(styles.chip, styles.chipRecovery)}
            onClick={() => run(c.command)}
            disabled={busy}
            title={busy ? 'Session is busy — wait for the current turn to finish' : c.command}
          >
            {c.label}
          </button>
        ))}

        {showAction && action && (
          <button className={styles.chip} onClick={() => run(action.command)} title={action.command}>
            {action.label}
          </button>
        )}
      </div>

      {open && (
        <div className={styles.phases}>
          {gsd.phases.map((phase) => {
            const stages = phaseStages(phase);
            const current = gsd.currentPhase !== null && phase.number === gsd.currentPhase;
            return (
              <div
                key={phase.number}
                className={cx(styles.phase, current && styles.phaseCurrent)}
                data-phase={phase.number}
                data-current={current || undefined}
              >
                <span className={styles.phaseMarks} aria-label={`Discuss ${stages.marks[0]}, Plan ${stages.marks[1]}, Execute ${stages.marks[2]}`}>
                  {stages.marks.join(' ')}
                </span>
                <span className={styles.phaseName}>
                  {phase.number}. {phase.name}
                </span>
                <span className={styles.phaseLabel}>{stages.label}</span>
              </div>
            );
          })}
          {gsd.phases.length === 0 && (
            <div className={styles.phase}>
              <span className={styles.phaseLabel}>No phases yet</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
