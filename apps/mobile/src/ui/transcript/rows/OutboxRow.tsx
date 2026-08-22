/**
 * A user send that the transcript does not yet CONTAIN — rendered after the
 * transcript with its outbox lifecycle state (pending / published / delivered
 * / failed + retry). CDX-063: a row leaves this list only when a covering
 * user entry exists in the transcript (outboxCoverage), never on the mere
 * input-ack — the ack lands before the SDK echo authors the entry, and the
 * echo rides a droppable ephemeral. 'confirmed' therefore renders too, as
 * "delivered", until its echo (or a sync backfill) covers it.
 */
import type { OutboxItem } from '../../../core/stores/outbox';
import styles from './rows.module.css';
import { shared } from '../../shared';

export function OutboxRow({ item, onRetry }: { item: OutboxItem; onRetry: (id: string) => void }) {
  return (
    <div className={item.state === 'failed' ? styles.outboxFailed : styles.outbox} data-row="outbox">
      <div>{item.text}</div>
      <div className={styles.outboxStatus}>
        {item.state === 'pending' && 'sending…'}
        {item.state === 'published' && 'sent — waiting for bridge'}
        {item.state === 'confirmed' && 'delivered'}
        {item.state === 'failed' && `failed: ${item.error ?? 'unknown'}`}
        {item.state === 'failed' && (
          <button className={shared.btnSmall} onClick={() => onRetry(item.id)}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
