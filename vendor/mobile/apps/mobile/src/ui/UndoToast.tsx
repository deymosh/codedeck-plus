/**
 * UndoToast (Phase 3) — the fixed bottom "Deleted X — Undo" toast for a
 * pending session delete. State lives in the ui store (deleteController
 * writes it, and clears it when the 4s window commits or undo restores);
 * this component only renders and forwards the tap.
 */
import { usePhoneCore, useUi } from './coreContext';
import styles from './UndoToast.module.css';

export function UndoToast() {
  const core = usePhoneCore();
  const toast = useUi((s) => s.undoToast);

  if (!toast) return null;

  return (
    <div className={styles.toast} data-testid="undo-toast">
      <span className={styles.label}>Deleted &quot;{toast.label}&quot;</span>
      <button className={styles.btn} onClick={() => core.undoDelete()}>
        Undo
      </button>
    </div>
  );
}
