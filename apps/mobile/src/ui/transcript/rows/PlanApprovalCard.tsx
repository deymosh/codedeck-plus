/**
 * Plan approval card — v10 handles plan approval via the keypress command with
 * context 'plan-approval' (the runner resolves the pending ExitPlanMode and
 * flips the mode; there is no separate 'exit-plan' context in v10 — the old
 * app's hasPlan=false "Exit plan mode?" variant also goes through
 * 'plan-approval', where key 1/2 approve with a mode and key 3 declines).
 *
 * Options ported from the old PlanApprovalEntry:
 *   1 — approve, acceptEdits mode
 *   2 — approve, default (YOLO) mode
 *   3 — revise: deny ExitPlanMode, stay in plan mode, type feedback next
 */
import type { PlanApprovalDisplay } from '../displayEntries';
import type { CardActions } from './types';
import styles from './cards.module.css';

export const PLAN_APPROVAL_LABELS: Record<string, string> = {
  '1': 'Plan approved — Accept Edits',
  '2': 'Plan approved — YOLO',
  '3': 'Revising — type your feedback below',
};

export function PlanApprovalCard({
  item,
  sessionId,
  responded,
  choice,
  actions,
}: {
  item: PlanApprovalDisplay;
  sessionId: string;
  responded: boolean;
  /** The locally-remembered option key ('1'|'2'|'3'), for the resolved label. */
  choice: string | undefined;
  actions: CardActions;
}) {
  const cardId = item.toolUseId;

  if (item.answered !== undefined || responded) {
    const label = choice ? PLAN_APPROVAL_LABELS[choice] : item.answered ?? 'Response sent…';
    return (
      <div className={styles.cardAnswered} data-row="plan-approval">
        <div className={styles.outcome}>{label}</div>
      </div>
    );
  }

  const respond = (key: '1' | '2' | '3'): void => {
    if (cardId) {
      actions.markResponded(cardId);
      actions.setPlanChoice(cardId, key);
    }
    actions.sendCommand({ type: 'keypress', sessionId, key, context: 'plan-approval' });
  };

  return (
    <div className={styles.card} data-row="plan-approval" aria-live="polite">
      <div className={styles.title}>{item.hasPlan ? 'Approve this plan?' : 'Exit plan mode?'}</div>
      <div className={styles.options}>
        <button className={styles.optionPrimary} onClick={() => respond('1')}>
          <span className={styles.optionLabel}>Approve — mode EDITS</span>
          <span className={styles.optionDesc}>Auto-accepts file edits, prompts for Bash/Web</span>
        </button>
        <button className={styles.optionPrimary} onClick={() => respond('2')}>
          <span className={styles.optionLabel}>Approve — mode YOLO</span>
          <span className={styles.optionDesc}>Auto-approves all tool actions</span>
        </button>
        <button className={styles.option} onClick={() => respond('3')}>
          <span className={styles.optionLabel}>Revise plan</span>
          <span className={styles.optionDesc}>Stay in plan mode and type feedback</span>
        </button>
      </div>
    </div>
  );
}
