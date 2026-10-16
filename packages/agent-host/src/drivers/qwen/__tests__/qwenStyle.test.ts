/**
 * QWEN_STYLE, as the Qwen Code driver reports it.
 *
 * These are the invariants the phone relies on: every wordmark line one cell
 * wide, every cell a block element it can draw as quarters (or a blank), and
 * a colour for a mode only under an id the driver actually offers — a mode
 * colour keyed by anything else is never worn.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { QwenDriver } from '../driver';
import { QwenRuntime } from '../runtime';
import { QWEN_STYLE } from '../style';

/** The block elements the phone's wordmark draws (Wordmark.kt), and a blank. */
const DRAWN = new Set([' ', '█', '▀', '▄', '▌', '▐', '▛', '▜', '▙', '▟', '▘', '▝', '▖', '▗']);

describe('Qwen Code style', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'codedeck-qwen-style-'));
  const runtime = new QwenRuntime({
    home,
    cacheDir: path.join(home, 'agents'),
    installQwen: async () => '/fake/qwen/cli-entry.js',
    log: () => {},
  });
  const info = QwenDriver.create({ runtime, home, baseEnv: {} as NodeJS.ProcessEnv, log: () => {} }).info();

  it('reports a style', () => {
    expect(info.style).toBe(QWEN_STYLE);
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
  });

  it('colours only modes the driver offers', () => {
    const modes = new Set((info.modes ?? []).map((mode) => mode.id));
    for (const mode of Object.keys(info.style?.modeColors ?? {})) expect(modes).toContain(mode);
  });
});
