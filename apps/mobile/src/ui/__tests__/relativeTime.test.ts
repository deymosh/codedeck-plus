import { describe, expect, it } from 'vitest';
import { relativeTime } from '../relativeTime';

const T0 = Date.parse('2026-08-08T12:00:00.000Z');
const ago = (ms: number): string => new Date(T0 - ms).toISOString();

describe('relativeTime', () => {
  it('under a minute → "now"', () => {
    expect(relativeTime(ago(0), T0)).toBe('now');
    expect(relativeTime(ago(59_000), T0)).toBe('now');
  });

  it('minutes / hours / days buckets', () => {
    expect(relativeTime(ago(60_000), T0)).toBe('1m');
    expect(relativeTime(ago(59 * 60_000), T0)).toBe('59m');
    expect(relativeTime(ago(60 * 60_000), T0)).toBe('1h');
    expect(relativeTime(ago(23 * 3_600_000), T0)).toBe('23h');
    expect(relativeTime(ago(24 * 3_600_000), T0)).toBe('1d');
    expect(relativeTime(ago(9 * 86_400_000), T0)).toBe('9d');
  });

  it('future timestamps clamp to "now" (clock skew must not render "-3m")', () => {
    expect(relativeTime(ago(-120_000), T0)).toBe('now');
  });
});
