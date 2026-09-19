/**
 * Assistant text (markdown). `isPlan` marks a special='plan' entry — the plan
 * body stays readable after approval, visually framed as a plan document.
 */
import type { OutputEntry } from '../../../core/nativeCoreTypes';
import { Markdown } from './Markdown';
import styles from './rows.module.css';

export function AssistantTextRow({ entry, isPlan }: { entry: OutputEntry; isPlan?: boolean }) {
  return (
    <div className={isPlan ? styles.plan : styles.assistant} data-row={isPlan ? 'plan' : 'assistant'}>
      {isPlan && <div className={styles.planLabel}>Plan</div>}
      <Markdown>{entry.content}</Markdown>
    </div>
  );
}
