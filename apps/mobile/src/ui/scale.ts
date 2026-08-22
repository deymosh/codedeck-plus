/**
 * UI scale math (plan §5, locked decision #4) — pure and unit-tested.
 *
 * Root font-size = 16px × clamp(auto × user, HARD_MIN, HARD_MAX):
 * - auto factor: from the viewport SHORTEST side (rotation-stable), anchored
 *   at 1.0 on a ~400 CSS-px phone, gently rising to 1.3 on tablets/desktops
 *   (the "buttons too small on tablets" fix) and easing down to 0.9 on very
 *   small phones;
 * - user multiplier: the settings slider (0.85–1.4, persisted in
 *   settingsStore.uiScale, default 1).
 */
import { UI_SCALE_MAX, UI_SCALE_MIN } from '../core/stores/settings';

/** Absolute clamp on the combined factor — nothing ever renders outside this. */
export const HARD_MIN = 0.75;
export const HARD_MAX = 1.6;

/** Auto-factor anchors: 1.0 at PHONE_BASE shortest side, ±1 per SLOPE_PX. */
const PHONE_BASE_PX = 400;
const SLOPE_PX = 1000;
const AUTO_MIN = 0.9;
const AUTO_MAX = 1.3;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Auto scale factor from the viewport's shortest side in CSS px. */
export function computeAutoScale(shortestSidePx: number): number {
  if (!Number.isFinite(shortestSidePx) || shortestSidePx <= 0) return 1;
  return clamp(1 + (shortestSidePx - PHONE_BASE_PX) / SLOPE_PX, AUTO_MIN, AUTO_MAX);
}

/** Clamp a persisted/incoming user multiplier onto the slider range. */
export function clampUserScale(userScale: number): number {
  if (!Number.isFinite(userScale)) return 1;
  return clamp(userScale, UI_SCALE_MIN, UI_SCALE_MAX);
}

/** The combined --ui-scale value for a viewport + user multiplier. */
export function computeUiScale(
  viewportWidthPx: number,
  viewportHeightPx: number,
  userScale: number,
): number {
  const shortest = Math.min(viewportWidthPx, viewportHeightPx);
  const combined = computeAutoScale(shortest) * clampUserScale(userScale);
  // Round to 3 decimals: stable style writes, no sub-milli-px churn on resize.
  return Math.round(clamp(combined, HARD_MIN, HARD_MAX) * 1000) / 1000;
}
