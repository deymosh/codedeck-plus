/**
 * OPENCODE_STYLE, as the OpenCode driver reports it: the spinner it spins,
 * the glyphs its tool rows wear, the two-tone wordmark, and the mode colours.
 *
 * These are the invariants the phone relies on when it draws the style: a
 * spinner with frames and a positive interval, tool glyph keys that are wire
 * `ToolKind` names, wordmark lines all one cell wide with a split below that
 * width, and a mode colour only for a mode the agent offers, as `#RRGGBB`.
 */
import { describe, it, expect } from 'vitest';
import type { OpenCodeClient } from '@opencode/client';
import { OpenCodeDriver } from '../driver';
import { OPENCODE_STYLE } from '../style';

/** Every `ToolKind` wire name (crates/agent-protocol), `other` included. */
const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'agent', 'other'];

describe('OpenCode style', () => {
  const info = OpenCodeDriver.withClient({} as OpenCodeClient).info();

  it('reports a style', () => {
    expect(info.style).toBe(OPENCODE_STYLE);
  });

  it('spins frames on a positive interval', () => {
    const spinner = info.style?.spinner;
    expect(spinner?.frames.length).toBeGreaterThan(0);
    expect(spinner?.intervalMs).toBeGreaterThan(0);
  });

  it('marks tools only with wire ToolKind names', () => {
    const keys = Object.keys(info.style?.toolGlyphs ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(TOOL_KINDS).toContain(key);
  });

  it('draws every wordmark line at one width', () => {
    const lines = info.style?.wordmark ?? [];
    expect(lines.length).toBeGreaterThan(0);
    const width = Array.from(lines[0] ?? '').length;
    for (const line of lines) expect(Array.from(line).length).toBe(width);
    expect(info.style?.wordmarkSplit ?? 0).toBeLessThan(width);
  });

  it('colours only modes it offers, with #RRGGBB', () => {
    const modes = new Set((info.modes ?? []).map((mode) => mode.id));
    for (const [id, colour] of Object.entries(info.style?.modeColors ?? {})) {
      expect(modes).toContain(id);
      expect(colour).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});
