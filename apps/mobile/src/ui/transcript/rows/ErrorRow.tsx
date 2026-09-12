/**
 * Error entries — generic result errors plus the runner's lifecycle specials
 * (session_died / session_failed / auth_error), labelled so a dead session is
 * unmistakable in the scrollback.
 */
import type { OutputEntry } from '../../../core/nativeCoreTypes';
import styles from './rows.module.css';

const LABELS: Record<string, string> = {
  session_died: 'Session died',
  session_failed: 'Session failed',
  auth_error: 'Authentication error',
};

export function ErrorRow({ entry }: { entry: OutputEntry }) {
  const special = entry.metadata?.special as string | undefined;
  const label = special ? LABELS[special] : undefined;
  return (
    <div className={styles.error} data-row="error">
      {label && <div className={styles.errorLabel}>{label}</div>}
      {entry.content}
    </div>
  );
}
