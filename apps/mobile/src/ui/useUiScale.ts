/**
 * useUiScale — applies the computed --ui-scale to :root and keeps it current
 * against window resizes (rotation, split-screen, desktop resize) and
 * settings changes (the slider). The ONE writer of --ui-scale.
 *
 * CDX-088: it is also the ONE writer of --text-scale, which carries the user
 * multiplier WITHOUT the auto factor. Both come out of the same update so they
 * can never disagree about the slider's value.
 */
import { useEffect } from 'react';
import { usePhoneCore } from './coreContext';
import { clampUserScale, computeUiScale } from './scale';

export interface UiScaleTargets {
  /** Read the current viewport size (window in prod, fake in tests). */
  viewport(): { width: number; height: number };
  /** Subscribe to viewport changes; returns detach. */
  onViewportChange(handler: () => void): () => void;
  /** Read the current user multiplier (settings store in prod). */
  userScale(): number;
  /** Subscribe to user-multiplier changes; returns detach. */
  onUserScaleChange(handler: () => void): () => void;
  /** Write the computed factor (documentElement style in prod). */
  apply(scale: number): void;
  /**
   * Write the type factor — the slider alone, no auto component (CDX-088).
   * Optional so existing callers/tests that only assert --ui-scale still work.
   */
  applyTextScale?(scale: number): void;
}

/** Framework-free controller — exported for direct unit testing. */
export function attachUiScale(targets: UiScaleTargets): () => void {
  let last = -1;
  let lastText = -1;
  const update = (): void => {
    const { width, height } = targets.viewport();
    const user = targets.userScale();
    const text = clampUserScale(user);
    if (text !== lastText) {
      lastText = text;
      targets.applyTextScale?.(text);
    }
    const scale = computeUiScale(width, height, user);
    if (scale === last) return;
    last = scale;
    targets.apply(scale);
  };
  update();
  const offViewport = targets.onViewportChange(update);
  const offSettings = targets.onUserScaleChange(update);
  return () => {
    offViewport();
    offSettings();
  };
}

export function useUiScale(): void {
  const core = usePhoneCore();
  useEffect(() => {
    const root = document.documentElement;
    const detach = attachUiScale({
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      onViewportChange: (handler) => {
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
      },
      userScale: () => core.settings.getState().uiScale,
      onUserScaleChange: (handler) =>
        core.settings.subscribe((state, prev) => {
          if (state.uiScale !== prev.uiScale) handler();
        }),
      apply: (scale) => root.style.setProperty('--ui-scale', String(scale)),
      applyTextScale: (scale) => root.style.setProperty('--text-scale', String(scale)),
    });
    return () => {
      detach();
      root.style.removeProperty('--ui-scale');
      root.style.removeProperty('--text-scale');
    };
  }, [core]);
}
