/** Session lifecycle marker (special='session_restart'): a centered divider line. */
import type { OutputEntry } from '../../../core/nativeCoreTypes';
import styles from './rows.module.css';

export function LifecycleRow({ entry }: { entry: OutputEntry }) {
  return (
    <div className={styles.lifecycle} data-row="lifecycle">
      <span>{entry.content}</span>
    </div>
  );
}
