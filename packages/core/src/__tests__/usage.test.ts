/**
 * normalizeUsage — ported from the old bridge's protocol.test.ts cases, plus
 * the defensive-shape cases the facade's `unknown` return demands.
 */
import { describe, it, expect } from 'vitest';
import { normalizeUsage } from '../sdk/usage';

const NOW = () => Date.parse('2026-08-05T12:00:00.000Z');

describe('normalizeUsage', () => {
  it('maps the SDK response into UsageData (subscription session)', () => {
    const res = {
      rate_limits_available: true,
      subscription_type: 'max',
      rate_limits: {
        five_hour: { utilization: 42, resets_at: '2026-08-05T15:00:00Z' },
        seven_day: { utilization: 10, resets_at: '2026-08-10T00:00:00Z' },
        seven_day_opus: { utilization: 5, resets_at: '2026-08-10T00:00:00Z' },
        seven_day_sonnet: null,
      },
      session: { total_cost_usd: 1.23 },
    };

    const u = normalizeUsage(res, NOW);
    expect(u).toEqual({
      available: true,
      subscriptionType: 'max',
      fiveHour: { utilization: 42, resetsAt: '2026-08-05T15:00:00Z' },
      sevenDay: { utilization: 10, resetsAt: '2026-08-10T00:00:00Z' },
      sevenDayOpus: { utilization: 5, resetsAt: '2026-08-10T00:00:00Z' },
      sessionCostUsd: 1.23,
      fetchedAt: '2026-08-05T12:00:00.000Z',
    });
    // Absent/null windows are omitted, not fabricated.
    expect(u).not.toHaveProperty('sevenDaySonnet');
  });

  it('handles a non-subscription (API-key) session', () => {
    const res = {
      rate_limits_available: false,
      subscription_type: null,
      rate_limits: null,
      session: {},
    };
    const u = normalizeUsage(res, NOW);
    expect(u).toEqual({
      available: false,
      subscriptionType: null,
      fetchedAt: '2026-08-05T12:00:00.000Z',
    });
  });

  it('preserves null inner window values so the phone decides whether to render', () => {
    const u = normalizeUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: null, resets_at: null } },
    }, NOW);
    expect(u?.fiveHour).toEqual({ utilization: null, resetsAt: null });
  });

  it('returns null for shapes the experimental SDK might no longer produce', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage('nope')).toBeNull();
    expect(normalizeUsage(42)).toBeNull();
    expect(normalizeUsage({})).toBeNull(); // no rate_limits_available boolean
    expect(normalizeUsage({ rate_limits_available: 'yes' })).toBeNull();
  });
});
