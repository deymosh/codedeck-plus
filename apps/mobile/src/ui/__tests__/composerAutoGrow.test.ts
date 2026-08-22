/**
 * CDX-025 guard: the composers must never slice off a wrapped line.
 *
 * Device failure 2026-08-08 (comet, `wm size 720x1280` + `wm density 320`, UI
 * scale 140%): the session composer's `<textarea>` sat in a fixed 120 dp box
 * with two lines of content in it and the second line was cut in half by the
 * rounded bottom border.
 *
 * WHAT THIS FILE PROVES: the arithmetic of the sizing helper, and the CSS
 * *rules* that carry the fix — that the two-line floor exists, is scoped so it
 * outranks the shared `.input` primitive, is expressed in scale-relative units
 * so it tracks --ui-scale, cannot drift from the line-height it is derived
 * from, and that the shared primitive itself was left alone.
 *
 * WHAT IT DOES NOT PROVE: any rendered pixel. jsdom has no layout engine and
 * vitest runs with `css: false`, so a test asserting computed geometry here
 * would be theatre (same reasoning as sidebarRail.test.ts). The rendered box
 * is a device oracle — run-sheet §13, the 140% sweep.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoGrowHeightPx, autoGrowTextarea } from '../autoGrowTextarea';

const uiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sessionCss = readFileSync(path.join(uiDir, 'screens', 'SessionScreen.module.css'), 'utf8');
const dmCss = readFileSync(path.join(uiDir, 'dm', 'DmBottomBar.module.css'), 'utf8');
const sharedCss = readFileSync(path.join(uiDir, 'shared.module.css'), 'utf8');

/** A textarea stand-in: the three metrics the helper reads, plus a style bag. */
function fakeTextarea(m: { scrollHeight: number; offsetHeight: number; clientHeight: number }) {
  return { ...m, style: { height: '' } } as unknown as HTMLTextAreaElement;
}

/** The composer rule block from a module, e.g. `.textarea { … }`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} not found`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('autoGrowHeightPx (CDX-025)', () => {
  it('adds the border back, because border-box heights include it', () => {
    // scrollHeight is content+padding and excludes the border; `height` under
    // box-sizing: border-box includes it. Without the correction every grown
    // box is one border short and scrolls by 2px.
    expect(autoGrowHeightPx({ scrollHeight: 87, offsetHeight: 64, clientHeight: 62 })).toBe(89);
  });

  it('grows past a one-line box the moment the content needs two lines', () => {
    const oneLine = autoGrowHeightPx({ scrollHeight: 54, offsetHeight: 56, clientHeight: 54 });
    const twoLines = autoGrowHeightPx({ scrollHeight: 85, offsetHeight: 56, clientHeight: 54 });
    expect(oneLine).toBe(56);
    expect(twoLines).toBe(87);
    // The regression: a fixed floor answers the same height for both.
    expect(twoLines!).toBeGreaterThan(oneLine!);
  });

  it('leaves the height to CSS when there is no layout to measure', () => {
    // jsdom (and display:none) report 0 for everything — pinning the box to
    // 0px there would be worse than the bug.
    expect(autoGrowHeightPx({ scrollHeight: 0, offsetHeight: 0, clientHeight: 0 })).toBeNull();
  });

  it('never subtracts when clientHeight exceeds offsetHeight', () => {
    expect(autoGrowHeightPx({ scrollHeight: 40, offsetHeight: 10, clientHeight: 20 })).toBe(40);
  });
});

describe('autoGrowTextarea (CDX-025)', () => {
  it('writes the grown height in px', () => {
    const el = fakeTextarea({ scrollHeight: 87, offsetHeight: 64, clientHeight: 62 });
    autoGrowTextarea(el);
    expect(el.style.height).toBe('89px');
  });

  it('clears the inline height instead of collapsing when unmeasurable', () => {
    const el = fakeTextarea({ scrollHeight: 0, offsetHeight: 0, clientHeight: 0 });
    el.style.height = '120px';
    autoGrowTextarea(el);
    expect(el.style.height).toBe('');
  });

  it('tolerates a detached ref', () => {
    expect(() => autoGrowTextarea(null)).not.toThrow();
  });
});

describe('composer sizing rules (CDX-025)', () => {
  const composers: Array<[string, string, string]> = [
    ['session', sessionCss, '.inputbar .textarea'],
    ['dm', dmCss, '.bar .textarea'],
  ];

  it('the shared .input primitive is UNCHANGED — the fix is scoped to composers', () => {
    // Blast-radius guard: pairing token fields, the new-folder field and every
    // other `s.input` must keep the flat tap-target floor.
    expect(block(sharedCss, '.input')).toMatch(/min-height:\s*var\(--tap-min\)/);
  });

  it.each(composers)('%s composer floors at two lines, outranking .input', (_name, css, sel) => {
    // A descendant selector (0,2,0) beats the composed `.input` (0,1,0)
    // outright; a bare `.textarea` rule would tie and let stylesheet order
    // decide which min-height wins.
    expect(sel.split(' ')).toHaveLength(2);
    const floor = block(css, sel);
    expect(floor).toMatch(/min-height:\s*calc\(\s*2\s*\*\s*[\d.]+em/);
    // Scale-relative, never px: root font-size is 16px × --ui-scale, so a px
    // floor would fit two lines at 100% and one at 140% — the actual bug.
    expect(/min-height:\s*calc\([^;]*\d+px[^;]*\)/.test(floor)).toBe(true); // borders only
    expect(floor).not.toMatch(/min-height:\s*\d+px/);
  });

  it.each(composers)('%s floor cannot drift from the line-height it derives from', (_n, css, sel) => {
    const declared = /line-height:\s*([\d.]+)\s*;/.exec(block(css, '.textarea'));
    const used = /min-height:\s*calc\(\s*2\s*\*\s*([\d.]+)em/.exec(block(css, sel));
    expect(declared).not.toBeNull();
    expect(used).not.toBeNull();
    expect(used![1]).toBe(declared![1]);
  });

  it.each(composers)('%s floor includes the padding and borders it sits inside', (_n, css, sel) => {
    // box-sizing: border-box (styles/global.css) folds both into `height`, so
    // a floor of bare text lines is short by exactly this much.
    const floor = block(css, sel);
    expect(floor).toMatch(/2\s*\*\s*var\(--space-2\)/);
    expect(floor).toMatch(/\+\s*2px/);
  });

  it.each(composers)('%s scrolls past max-height rather than clipping', (_n, css) => {
    const ta = block(css, '.textarea');
    expect(ta).toMatch(/max-height:\s*8rem/);
    expect(ta).toMatch(/overflow-y:\s*auto/);
  });

  it.each(composers)('%s placeholder is one ellipsized line', (_n, css) => {
    // The placeholder is not content: it never reaches scrollHeight, so
    // auto-grow cannot see it wrap. Only CSS can stop it.
    const ph = block(css, '.textarea::placeholder');
    expect(ph).toMatch(/white-space:\s*nowrap/);
    expect(ph).toMatch(/overflow:\s*hidden/);
    expect(ph).toMatch(/text-overflow:\s*ellipsis/);
  });
});
