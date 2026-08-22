/**
 * CDX-087: compact model tags for the header badge, ported from the old app's
 * `modelLabel` (codedeck/src/constants/models.ts:49-55).
 */
import { describe, expect, it } from 'vitest';
import { modelLabel } from '../modelLabel';

describe('modelLabel', () => {
  it('tags the known models the way the old app did', () => {
    expect(modelLabel('claude-opus-5')).toBe('O5');
    expect(modelLabel('claude-opus-4-8')).toBe('O4.8');
    expect(modelLabel('claude-sonnet-4-6')).toBe('S4.6');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('H4.5');
    expect(modelLabel('claude-fable-5')).toBe('F5');
  });

  it('strips the 1M-context marker before lookup', () => {
    // The old app had no row for these, so they fell through to the derived
    // branch and read `opus-5[1m]` in a badge with room for four characters.
    // The 1M window is already visible in the context figure beside the tag.
    expect(modelLabel('claude-opus-5[1m]')).toBe('O5');
    expect(modelLabel('claude-opus-4-8[1m]')).toBe('O4.8');
    expect(modelLabel('claude-opus-5-1m')).toBe('O5');
  });

  it('derives something usable for an unknown model', () => {
    // A new release, or a custom provider profile's id (CDX-062).
    expect(modelLabel('claude-opus-9')).toBe('opus-9');
    expect(modelLabel('claude-sonnet-7-20270101')).toBe('sonnet-7');
    expect(modelLabel('kimi-k3-turbo')).toBe('kimi-k3-turbo');
  });

  it('reports ? rather than guessing when no model is recorded', () => {
    expect(modelLabel(undefined)).toBe('?');
    expect(modelLabel('')).toBe('?');
  });
});
