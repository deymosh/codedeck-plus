/**
 * Composer auto-grow (CDX-025) — the ONE sizing rule both composers share.
 *
 * The session and DM composers compose the shared `.input` primitive, whose
 * `min-height: var(--tap-min)` is a FIXED floor: it never grows when the text
 * wraps, so the second line was sliced off by the field's rounded bottom
 * border (device sweep 2026-08-08, `wm size 720x1280` + `wm density 320`, UI
 * scale 140%). The stylesheets give each composer a two-line floor derived
 * from its own type metrics; this grows the box past that floor up to the
 * `max-height` the stylesheet sets, after which `overflow-y: auto` scrolls
 * instead of clipping.
 *
 * Deliberately split into a pure function + a DOM applier: jsdom has no layout
 * engine, so every metric below reads 0 under test. The pure function is where
 * the arithmetic can be proven; the applier's only extra job is reading those
 * three numbers off a real element.
 */
import { useEffect, useLayoutEffect, type RefObject } from 'react';

export interface TextareaMetrics {
  /** Content height including padding, measured with `height: auto`. */
  scrollHeight: number;
  /** Border-box height as laid out. */
  offsetHeight: number;
  /** Padding-box height as laid out — excludes borders. */
  clientHeight: number;
}

/**
 * The inline height (px) that shows all of the content, or `null` when there
 * is no layout to size from (jsdom, `display: none`) and CSS must keep owning
 * the height — pinning the box to `0px` there would be worse than the bug.
 *
 * `scrollHeight` excludes the border, but `box-sizing: border-box`
 * (styles/global.css) makes `height` INCLUDE it, so the border is added back;
 * otherwise every grown box would be one border short and scroll by 2px.
 */
export function autoGrowHeightPx(m: TextareaMetrics): number | null {
  if (!(m.scrollHeight > 0)) return null;
  const borderY = Math.max(0, m.offsetHeight - m.clientHeight);
  return m.scrollHeight + borderY;
}

/** Apply {@link autoGrowHeightPx} to a live textarea. */
export function autoGrowTextarea(el: HTMLTextAreaElement | null | undefined): void {
  if (!el) return;
  // Shrink first: scrollHeight can only ever report growth, never that text
  // was deleted, so a box measured while tall stays tall without this.
  el.style.height = 'auto';
  const px = autoGrowHeightPx(el);
  el.style.height = px === null ? '' : `${px}px`;
}

/**
 * Keep a composer textarea sized to its content.
 *
 * Re-measures on every draft change AND whenever the geometry that governs
 * wrapping moves: a window resize (rotation, split-screen, desktop) and a
 * `--ui-scale` change. The scale hook is the only writer of that variable and
 * writes it onto the root element's `style` attribute, so a MutationObserver
 * on that attribute is the cheapest exact trigger — an inline px height
 * computed at 100% is wrong at 140%, which is precisely the scale the defect
 * was found at.
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    autoGrowTextarea(ref.current);
  }, [ref, value]);

  useEffect(() => {
    const grow = (): void => autoGrowTextarea(ref.current);
    window.addEventListener('resize', grow);
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(grow) : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
    return () => {
      window.removeEventListener('resize', grow);
      observer?.disconnect();
    };
  }, [ref]);
}
