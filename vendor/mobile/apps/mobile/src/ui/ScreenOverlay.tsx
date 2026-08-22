/**
 * ScreenOverlay (Phase 2b) — the full-screen inline overlay the one-screen
 * shell uses for Settings / Pairing (extracted from App.tsx's Phase 2a inline
 * version): fixed inset-0 over the shell, --bg background, a header with the
 * title and a ✕ close, safe-area + keyboard insets consumed here (fixed
 * elements escape the app frame's padding, so the overlay pads itself).
 */
import type { ReactNode } from 'react';
import styles from './ScreenOverlay.module.css';

export function ScreenOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div className={styles.overlay} data-testid="screen-overlay">
      <div className={styles.header}>
        <button className={styles.close} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <h1 className={styles.title}>{title}</h1>
      </div>
      {children}
    </div>
  );
}
