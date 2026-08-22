/**
 * Sync-gap placeholder — visible "fetching missed output…" while a sync cycle
 * is in flight for ranges the phone knows it is missing. Honest state instead
 * of a silently truncated transcript.
 */
import styles from './rows.module.css';

export function SyncGapRow({ state }: { state: 'requested' | 'syncing' | 'failed' }) {
  return (
    <div className={styles.syncgap} data-row="sync-gap">
      {state === 'failed'
        ? 'Some output could not be fetched yet — retrying…'
        : 'Fetching missed output…'}
    </div>
  );
}
