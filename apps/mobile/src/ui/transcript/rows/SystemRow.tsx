/** Plain status/system line (init banners etc. are filtered upstream). */
import type { OutputEntry } from '../../../core/nativeCoreTypes';
import styles from './rows.module.css';

export function SystemRow({ entry }: { entry: OutputEntry }) {
  if (!entry.content) return null;
  return (
    <div className={styles.system} data-row="system">
      {entry.content}
    </div>
  );
}
