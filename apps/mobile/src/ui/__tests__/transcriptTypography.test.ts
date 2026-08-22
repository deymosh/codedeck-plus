/**
 * CDX-088 guard: the chat window's type scale is the old app's, and markdown
 * elements are actually styled.
 *
 * The founder's report was "the font and text size in the chat window … is kinda
 * bloated". Three causes compounded, and the biggest was invisible in code
 * review: react-markdown gets no `components` override and no class, so every
 * heading, paragraph and list fell through to the browser's UA stylesheet. UA
 * `h1` is 2em with 0.67em margins and UA `p` margin is 1em top AND bottom —
 * and because the row has padding, those margins cannot collapse out of it.
 *
 * jsdom has no layout engine and vitest runs with `css: false`, so the honest
 * host-side check is static, over the stylesheets — the same technique as
 * sidebarRail.test.ts and layering.test.ts. The rendered result is a device
 * oracle.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tokensCss = readFileSync(path.join(uiDir, '..', 'styles', 'tokens.css'), 'utf8');
const rowsCss = readFileSync(
  path.join(uiDir, 'transcript', 'rows', 'rows.module.css'),
  'utf8',
);

const tokenValue = (name: string): string => {
  const decl = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
  expect(decl, `${name} is not declared in tokens.css`).not.toBeNull();
  return decl![1]!.trim();
};

describe('type tokens are the old app ramp and do not auto-scale (CDX-088)', () => {
  it('every --text-* token is px × --text-scale, never a bare rem', () => {
    const expected: Record<string, string> = {
      '--text-xs': '12px',
      '--text-sm': '13px',
      '--text-md': '14px',
      '--text-lg': '16px',
      '--text-xl': '20px',
    };
    for (const [token, px] of Object.entries(expected)) {
      const value = tokenValue(token);
      expect(value, `${token} should be ${px} × --text-scale`).toBe(
        `calc(${px} * var(--text-scale))`,
      );
      // A rem font-size is multiplied by root font-size = 16px × --ui-scale,
      // which is exactly the coupling this change removes.
      expect(value, `${token} must not be rem-based`).not.toMatch(/\d\s*r?em/);
    }
  });

  it('--text-scale is declared and independent of --ui-scale', () => {
    expect(tokenValue('--text-scale')).toBe('1');
    // The auto factor must not leak back in through the token itself.
    expect(tokenValue('--text-md')).not.toContain('--ui-scale');
  });

  it('spacing and tap targets still ride --ui-scale — only text was decoupled', () => {
    // The auto factor exists to keep controls reachable on big screens; the
    // founder explicitly kept that half.
    expect(tokenValue('--space-3')).toMatch(/rem$/);
    expect(tokenValue('--tap-min')).toContain('rem');
  });
});

describe('markdown elements are styled rather than inheriting UA defaults', () => {
  /**
   * All declarations that apply to a selector, concatenated — a selector can be
   * declared across several blocks (e.g. the shared h1–h6 `font-weight` plus
   * h1's own `font-size`), and the cascade is what the browser sees.
   */
  const rule = (selector: string): string => {
    const stripped = rowsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks: string[] = [];
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const selectors = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
      if (selectors.includes(selector)) blocks.push(m[2]!);
    }
    expect(blocks.length, `no rule found for ${selector}`).toBeGreaterThan(0);
    return blocks.join('\n');
  };

  it('prose containers set an explicit font-size, so nothing inherits the root', () => {
    // Root is 16px × --ui-scale = 20.8px on a Fold. Both of these were unset.
    expect(rule('.assistant')).toContain('font-size: var(--text-md)');
    expect(rule('.userBubble')).toContain('font-size: var(--text-md)');
  });

  it('paragraph margins are specified — the UA 1em top+bottom is what bloated rows', () => {
    expect(rule('.assistant p')).toMatch(/margin:\s*0 0 0\.571em/);
    expect(rule('.assistant p:last-child')).toMatch(/margin:\s*0/);
    // The single loudest one: a one-line user message was ~42px taller than its
    // own text because this rule did not exist.
    expect(rule('.userBubble p')).toMatch(/margin:\s*0/);
  });

  it('headings are sized off the tokens, never left at the UA em multiples', () => {
    for (const h of ['.assistant h1', '.assistant h2', '.assistant h3']) {
      expect(rule(h)).toMatch(/font-size: var\(--text-(?:md|lg)\)/);
    }
    // UA h1 is 2em — against a 20.8px body that is a 41.6px heading.
    expect(rowsCss).not.toMatch(/\.assistant h1\s*\{[^}]*font-size:\s*2em/);
  });

  it('lists use the old 24px indent, not the UA flat 40px', () => {
    for (const l of ['.assistant ul', '.assistant ol']) {
      expect(rule(l)).toContain('padding-left: 1.714em');
    }
  });

  it('every element react-markdown can emit has a rule', () => {
    // react-markdown + remark-gfm produce all of these; any one left unstyled
    // silently reverts to a UA default with em-based margins.
    for (const selector of [
      '.assistant p',
      '.assistant h1',
      '.assistant h4',
      '.assistant ul',
      '.assistant li',
      '.assistant blockquote',
      '.assistant hr',
      '.assistant table',
      '.assistant th',
      '.assistant pre',
      '.assistant code',
    ]) {
      expect(rowsCss, `${selector} is unstyled`).toContain(selector);
    }
  });

  it('the collapsed group header kept the old app’s 12px mono face', () => {
    const header = rule('.groupHeader');
    expect(header).toContain('font-family: var(--font-mono)');
    expect(header).toContain('font-size: var(--text-xs)');
  });
});
