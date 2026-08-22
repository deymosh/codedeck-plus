/**
 * UI scale math (Phase 5a) — the pure functions behind --ui-scale: auto
 * factor from the viewport shortest side, user multiplier clamping, and the
 * combined hard-clamped factor.
 */
import { describe, expect, it } from 'vitest';
import { UI_SCALE_MAX, UI_SCALE_MIN } from '../../core/stores/settings';
import {
  HARD_MAX,
  HARD_MIN,
  clampUserScale,
  computeAutoScale,
  computeUiScale,
} from '../scale';
import { attachUiScale } from '../useUiScale';

describe('computeAutoScale', () => {
  it('anchors 1.0 on a ~400px phone', () => {
    expect(computeAutoScale(400)).toBe(1);
  });

  it('small phone (320) eases down, floored at 0.9', () => {
    expect(computeAutoScale(320)).toBeCloseTo(0.92, 5);
    expect(computeAutoScale(280)).toBe(0.9);
    expect(computeAutoScale(100)).toBe(0.9); // never below the floor
  });

  it('typical phone (360-412) stays near 1', () => {
    expect(computeAutoScale(360)).toBeCloseTo(0.96, 5);
    expect(computeAutoScale(412)).toBeCloseTo(1.012, 5);
  });

  it('tablet-ish (800) hits the 1.3 ceiling — the buttons-too-small fix', () => {
    expect(computeAutoScale(700)).toBeCloseTo(1.3, 5);
    expect(computeAutoScale(800)).toBe(1.3);
  });

  it('desktop shortest side (1080) stays at the ceiling', () => {
    expect(computeAutoScale(1080)).toBe(1.3);
  });

  it('degenerate inputs fall back to 1', () => {
    expect(computeAutoScale(0)).toBe(1);
    expect(computeAutoScale(-5)).toBe(1);
    expect(computeAutoScale(Number.NaN)).toBe(1);
  });
});

describe('clampUserScale', () => {
  it('clamps onto the slider range', () => {
    expect(clampUserScale(1)).toBe(1);
    expect(clampUserScale(0.5)).toBe(UI_SCALE_MIN);
    expect(clampUserScale(3)).toBe(UI_SCALE_MAX);
    expect(clampUserScale(Number.NaN)).toBe(1);
  });
});

describe('computeUiScale', () => {
  it('uses the SHORTEST side — rotation-stable', () => {
    expect(computeUiScale(360, 800, 1)).toBe(computeUiScale(800, 360, 1));
    expect(computeUiScale(360, 800, 1)).toBeCloseTo(0.96, 5);
  });

  it('multiplies the user factor', () => {
    expect(computeUiScale(400, 800, 1.2)).toBeCloseTo(1.2, 5);
    expect(computeUiScale(400, 800, 0.85)).toBeCloseTo(0.85, 5);
  });

  it('hard-clamps the combined factor', () => {
    // tablet auto 1.3 × user 1.4 = 1.82 → HARD_MAX
    expect(computeUiScale(1600, 2560, 1.4)).toBe(HARD_MAX);
    // combined never drops below HARD_MIN either
    expect(computeUiScale(100, 100, 0.5)).toBeGreaterThanOrEqual(HARD_MIN);
  });

  it('breakpoint sweep: small phone < phone < tablet at the same user factor', () => {
    const small = computeUiScale(320, 640, 1);
    const phone = computeUiScale(412, 915, 1);
    const tablet = computeUiScale(800, 1280, 1);
    expect(small).toBeLessThan(phone);
    expect(phone).toBeLessThan(tablet);
  });
});

describe('attachUiScale', () => {
  function harness(initial: { width: number; height: number; user: number }) {
    const state = { ...initial };
    const applied: number[] = [];
    const appliedText: number[] = [];
    let viewportHandler: (() => void) | undefined;
    let userHandler: (() => void) | undefined;
    const detach = attachUiScale({
      viewport: () => ({ width: state.width, height: state.height }),
      onViewportChange: (h) => {
        viewportHandler = h;
        return () => {
          viewportHandler = undefined;
        };
      },
      userScale: () => state.user,
      onUserScaleChange: (h) => {
        userHandler = h;
        return () => {
          userHandler = undefined;
        };
      },
      apply: (scale) => applied.push(scale),
      applyTextScale: (scale) => appliedText.push(scale),
    });
    return {
      state,
      applied,
      appliedText,
      resize: () => viewportHandler?.(),
      settingsChange: () => userHandler?.(),
      detach,
      detached: () => viewportHandler === undefined && userHandler === undefined,
    };
  }

  it('applies immediately, on resize, and on settings change — deduped', () => {
    const h = harness({ width: 400, height: 800, user: 1 });
    expect(h.applied).toEqual([1]);

    h.resize(); // nothing changed → no re-apply
    expect(h.applied).toEqual([1]);

    h.state.width = 800;
    h.state.height = 1280;
    h.resize();
    expect(h.applied).toEqual([1, 1.3]);

    h.state.user = 1.2;
    h.settingsChange();
    expect(h.applied).toEqual([1, 1.3, 1.56]);

    h.detach();
    expect(h.detached()).toBe(true);
  });

  // CDX-088: type is decoupled from the auto factor. --text-scale carries the
  // slider alone, so a bigger screen must NOT enlarge text.
  it('--text-scale follows the slider only — a viewport change never moves it', () => {
    const h = harness({ width: 400, height: 800, user: 1 });
    expect(h.applied).toEqual([1]);
    expect(h.appliedText).toEqual([1]);

    // A Fold's inner display pins --ui-scale at AUTO_MAX…
    h.state.width = 852;
    h.state.height = 883;
    h.resize();
    expect(h.applied).toEqual([1, 1.3]);
    // …and text is untouched. This is the whole point of the split.
    expect(h.appliedText).toEqual([1]);

    // The slider still governs text, and is clamped to the slider range.
    h.state.user = 1.2;
    h.settingsChange();
    expect(h.appliedText).toEqual([1, 1.2]);

    h.state.user = 99;
    h.settingsChange();
    expect(h.appliedText).toEqual([1, 1.2, UI_SCALE_MAX]);
  });

  it('applyTextScale is optional — a caller that omits it still works', () => {
    const applied: number[] = [];
    const detach = attachUiScale({
      viewport: () => ({ width: 400, height: 800 }),
      onViewportChange: () => () => {},
      userScale: () => 1,
      onUserScaleChange: () => () => {},
      apply: (scale) => applied.push(scale),
    });
    expect(applied).toEqual([1]);
    detach();
  });
});
