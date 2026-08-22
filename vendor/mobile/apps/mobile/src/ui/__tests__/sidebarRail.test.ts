/**
 * CDX-043 guard: the session sidebar rail is the old app's FIXED 260px
 * (codedeck/src/styles/global.css `--sidebar-width`) and must not grow with
 * --ui-scale.
 *
 * jsdom has no layout engine and vitest runs with `css: false`, so the only
 * honest host-side check is a static one over the stylesheets (same technique
 * as layering.test.ts): the token is declared in px, both rail sites consume
 * it, and the drawer's parked position is derived from the same variable so
 * open/closed can never drift apart. The rendered pixel width itself is a
 * device oracle (run-sheet §13 step 16).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tokensCss = readFileSync(path.join(uiDir, '..', 'styles', 'tokens.css'), 'utf8');
const appCss = readFileSync(path.join(uiDir, 'App.module.css'), 'utf8');

describe('sidebar rail width (CDX-043)', () => {
  it('tokens declare --sidebar-width as 260px — px, so --ui-scale cannot widen it', () => {
    const decl = /--sidebar-width:\s*([^;]+);/.exec(tokensCss);
    expect(decl).not.toBeNull();
    expect(decl![1]!.trim()).toBe('260px');
    // A rem/em rail is the bug this guards: root font-size is 16px × --ui-scale.
    expect(decl![1]).not.toMatch(/r?em/);
  });

  it('both rail sites consume the token instead of hardcoding a width', () => {
    // The pre-fix value: 17.5rem = 280px at scale 1, ~392px at --ui-scale 1.4.
    expect(appCss).not.toContain('17.5rem');
    const rail = appCss.match(/var\(--sidebar-width\)/g) ?? [];
    expect(rail.length).toBeGreaterThanOrEqual(3); // .sidebarWide + .drawer width + .drawer left
  });

  it('the drawer parks exactly one rail-width off-screen', () => {
    // Same variable on both sides => the closed position always matches the
    // open width; a literal here would silently desync from the width.
    expect(appCss).toMatch(/left:\s*calc\(-1\s*\*\s*var\(--sidebar-width\)\)/);
  });
});
