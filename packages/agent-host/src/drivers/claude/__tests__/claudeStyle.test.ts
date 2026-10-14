/**
 * CLAUDE_STYLE, as the Claude Code driver reports it: the spinner it spins,
 * the words it works by, the block mark it draws, and the glyphs its tool
 * rows wear.
 *
 * These are the invariants the phone relies on when it draws the style: a
 * spinner with frames and a positive interval, a non-empty word list with no
 * repeats, tool glyph keys that are wire `ToolKind` names, wordmark lines all
 * one cell wide with a split below that width, and a mode colour only for a
 * mode the agent offers, as `#RRGGBB`.
 */
import { describe, it, expect } from 'vitest';
import { ClaudeDriver } from '../driver';
import type { SdkFacade } from '../facade';
import { CLAUDE_STYLE } from '../style';

/** Every `ToolKind` wire name (crates/agent-protocol), `other` included. */
const TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'agent', 'other'];

describe('Claude Code style', () => {
  const info = new ClaudeDriver({ facade: {} as SdkFacade }).info();

  it('reports a style', () => {
    expect(info.style).toBe(CLAUDE_STYLE);
  });

  it('spins frames on a positive interval', () => {
    const spinner = info.style?.spinner;
    expect(spinner?.frames.length).toBeGreaterThan(0);
    expect(spinner?.intervalMs).toBeGreaterThan(0);
  });

  it('works by a non-empty word list with no duplicates', () => {
    const words = info.style?.workingWords ?? [];
    expect(words.length).toBeGreaterThan(0);
    expect(new Set(words).size).toBe(words.length);
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
