/**
 * DEEPSEEK_STYLE, as the DeepSeek Harness driver reports it: a one-tone
 * wordmark and nothing else, since the harness has no terminal UI to mirror.
 *
 * These are the invariants the phone relies on when it draws the wordmark:
 * every line one cell wide, and every cell a block element it can draw as
 * quarters (or a blank).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DeepSeekDriver } from '../driver';
import { DeepSeekRuntime } from '../runtime';
import { DEEPSEEK_STYLE } from '../style';

/** The block elements the phone's wordmark draws (Wordmark.kt), and a blank. */
const DRAWN = new Set([' ', '█', '▀', '▄', '▌', '▐', '▛', '▜', '▙', '▟', '▘', '▝', '▖', '▗']);

describe('DeepSeek Harness style', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-dsh-style-'));
  const runtime = new DeepSeekRuntime({
    home,
    cacheDir: path.join(home, 'agents'),
    installDsh: async () => '/fake/dsh/lib/bin.js',
    log: () => {},
  });
  const info = DeepSeekDriver.create({ runtime, home, baseEnv: {} as NodeJS.ProcessEnv, log: () => {} }).info();

  it('reports a style', () => {
    expect(info.style).toBe(DEEPSEEK_STYLE);
  });

  it('draws every wordmark line at one width, in one tone', () => {
    const lines = info.style?.wordmark ?? [];
    expect(lines.length).toBeGreaterThan(0);
    const width = Array.from(lines[0] ?? '').length;
    for (const line of lines) {
      expect(Array.from(line).length).toBe(width);
      for (const cell of line) expect(DRAWN).toContain(cell);
    }
    expect(info.style?.wordmarkSplit ?? 0).toBe(0);
    expect(info.style?.accent).toBeUndefined();
  });
});
