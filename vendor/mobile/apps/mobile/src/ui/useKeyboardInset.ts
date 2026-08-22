/**
 * useKeyboardInset (plan §5 Features) — the ONE owner of --keyboard-inset,
 * replacing the old App.tsx resize hack. The app frame pads its bottom by
 * this value so the on-screen keyboard never covers the input bar.
 *
 * Source of truth: window.visualViewport (supported by the Android System
 * WebView and WebKitGTK). When the keyboard opens, the visual viewport
 * shrinks while the layout viewport keeps its height — the difference (minus
 * any visual-viewport offset) is the keyboard's overlap. The controller is
 * event-source-pluggable so a future Tauri keyboard plugin can feed the same
 * seam; today visualViewport covers both Android and desktop.
 */
import { useEffect } from 'react';

export interface ViewportLike {
  /** Visual viewport height in CSS px. */
  height: number;
  /** Visual viewport top offset within the layout viewport. */
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', handler: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', handler: () => void): void;
}

/**
 * Keyboard overlap in CSS px: layout-viewport height minus the visible part
 * (visual height + its top offset). Negative rounding noise clamps to 0.
 */
export function computeKeyboardInset(
  layoutHeight: number,
  viewport: Pick<ViewportLike, 'height' | 'offsetTop'>,
): number {
  const inset = layoutHeight - viewport.height - viewport.offsetTop;
  // Ignore sub-2px noise (URL-bar/rounding jitter on some WebViews).
  return inset > 2 ? Math.round(inset) : 0;
}

export interface KeyboardInsetTargets {
  viewport: ViewportLike | null | undefined;
  /** Layout viewport height (window.innerHeight in prod). */
  layoutHeight(): number;
  /** Write the inset (px) — documentElement custom property in prod. */
  apply(insetPx: number): void;
}

/** Framework-free controller — exported for direct unit testing. */
export function attachKeyboardInset(targets: KeyboardInsetTargets): () => void {
  const viewport = targets.viewport;
  if (!viewport) {
    targets.apply(0); // no visualViewport (old engine): never a stale inset
    return () => {};
  }
  let last = -1;
  const update = (): void => {
    const inset = computeKeyboardInset(targets.layoutHeight(), viewport);
    if (inset === last) return;
    last = inset;
    targets.apply(inset);
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const root = document.documentElement;
    const detach = attachKeyboardInset({
      viewport: window.visualViewport,
      layoutHeight: () => window.innerHeight,
      apply: (inset) => {
        root.style.setProperty('--keyboard-inset', `${inset}px`);
        // Boolean twin for pure-CSS reactions (Phase 2b: the sidebar DM
        // section collapses while the keyboard covers a non-DM surface).
        root.setAttribute('data-keyboard-open', String(inset > 0));
      },
    });
    return () => {
      detach();
      root.style.removeProperty('--keyboard-inset');
      root.removeAttribute('data-keyboard-open');
    };
  }, []);
}
