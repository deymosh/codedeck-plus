/**
 * CDX-011: usage-panel polish — the pure session-header formatting functions.
 */
import { describe, it, expect } from 'vitest';
import type { UsageData } from '../../core/nativeCoreTypes';
import { contextBadge, formatReset, formatTokens, usageBadges } from '../usageFormat';

describe('formatTokens', () => {
  it('compacts token counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(84_200)).toBe('84k');
    expect(formatTokens(200_000)).toBe('200k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(formatTokens(12_400_000)).toBe('12M');
    expect(formatTokens(-5)).toBe('?');
    expect(formatTokens(NaN)).toBe('?');
  });
});

describe('contextBadge', () => {
  it('percentage + used/total tokens when the SDK reported the window', () => {
    expect(contextBadge(42, 200_000)).toBe('42% · 84k/200k');
    // The 1M-beta window uses its real denominator (the point of contextWindow).
    expect(contextBadge(10, 1_000_000)).toBe('10% · 100k/1M');
  });
  it('percentage alone without a window; null without a percentage', () => {
    expect(contextBadge(42)).toBe('42%');
    expect(contextBadge(undefined, 200_000)).toBeNull();
    expect(contextBadge(undefined)).toBeNull();
  });
  it('clamps and rounds', () => {
    expect(contextBadge(101.7)).toBe('100%');
    expect(contextBadge(-3)).toBe('0%');
    expect(contextBadge(41.5, 100_000)).toBe('42% · 42k/100k');
  });
});

describe('formatReset', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  it('coarse countdown buckets (ported from the old UsagePanel)', () => {
    expect(formatReset('2026-08-06T15:12:30Z', now)).toBe('resets in 3h 12m');
    expect(formatReset('2026-08-06T12:07:00Z', now)).toBe('resets in 7m');
    expect(formatReset('2026-08-08T14:00:00Z', now)).toBe('resets in 2d 2h');
    expect(formatReset('2026-08-06T11:00:00Z', now)).toBe('resetting…');
    expect(formatReset(null, now)).toBeNull();
    expect(formatReset('garbage', now)).toBeNull();
  });
});

describe('usageBadges', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const base: UsageData = {
    available: true,
    subscriptionType: 'max',
    fetchedAt: '2026-08-06T11:59:00Z',
  };
  it('5h + 7d windows with reset tooltips; critical at ≥90', () => {
    const badges = usageBadges(
      {
        ...base,
        fiveHour: { utilization: 37.4, resetsAt: '2026-08-06T15:00:00Z' },
        sevenDay: { utilization: 92, resetsAt: null },
      },
      now,
    );
    expect(badges).toEqual([
      { text: '5h 37%', title: 'resets in 3h 0m', critical: false },
      { text: '7d 92%', critical: true },
    ]);
  });
  it('unavailable / missing / null-utilization windows yield nothing', () => {
    expect(usageBadges(undefined, now)).toEqual([]);
    expect(usageBadges({ ...base, available: false }, now)).toEqual([]);
    expect(usageBadges({ ...base, fiveHour: { utilization: null, resetsAt: null } }, now)).toEqual(
      [],
    );
  });
});
