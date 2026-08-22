/** User input echoed by the SDK (text entry, metadata.role === 'user'). */
import type { OutputEntry } from '@codedeck/protocol';
import { Markdown } from './Markdown';
import styles from './rows.module.css';

export function UserMessageRow({ entry }: { entry: OutputEntry }) {
  return (
    <div className={styles.user} data-row="user">
      <div className={styles.userBubble}>
        <Markdown>{entry.content}</Markdown>
      </div>
    </div>
  );
}
