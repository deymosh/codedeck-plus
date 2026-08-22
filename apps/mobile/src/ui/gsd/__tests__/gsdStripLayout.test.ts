/**
 * CDX-058 guard: the GSD strip's summary must keep its intrinsic width down
 * to the trailing percentage even when an action chip is present.
 *
 * jsdom has no layout engine and vitest runs with `css: false`, so (same
 * technique as sidebarRail.test.ts / layering.test.ts) the honest host-side
 * check is static over the stylesheet: the bar wraps — an oversized chip
 * drops to its own row instead of squeezing the flexible summary — and the
 * chip itself is width-capped with its own ellipsis for the row it lands on.
 * The rendered one-line/two-row behaviour is a device oracle
 * (docs/MORNING-DEVICE-RUN.md check 32).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'GsdStrip.module.css'),
  'utf8',
);

/** The full declaration block of one top-level class. */
function blockOf(className: string): string {
  const m = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `.${className} block present`).not.toBeNull();
  return m![1]!;
}

describe('GSD strip layout (CDX-058)', () => {
  it('the bar wraps: a chip that does not fit gets its own row instead of squeezing the summary', () => {
    expect(blockOf('bar')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the chip is width-capped and ellipsizes itself (never unbounded nowrap)', () => {
    const chip = blockOf('chip');
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).toMatch(/overflow:\s*hidden/);
    expect(chip).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('the summary keeps its shrink-with-ellipsis behaviour (regression guard)', () => {
    const summary = blockOf('summary');
    expect(summary).toMatch(/text-overflow:\s*ellipsis/);
    expect(summary).toMatch(/min-width:\s*0/);
  });
});
