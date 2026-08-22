/**
 * normalizeUsage — project the SDK's structured `/usage` response into the lean
 * `UsageData` we send over the wire (ported from the old bridge's
 * sdkSession.ts).
 *
 * The underlying SDK method is EXPERIMENTAL (see SdkSessionHandle.
 * getUsageSnapshot — its verbose name signals it may change or be removed), so
 * the facade hands us `unknown` and this module is defensive: a snapshot that
 * doesn't carry the expected shape yields null and the caller publishes
 * nothing (the phone keeps its last value). Tolerant of null/absent windows —
 * a window is only included when the SDK reports it; null inner values are
 * preserved so the phone can decide whether to render the row.
 */
import type { UsageData, UsageWindow } from '@codedeck/protocol';

/** The slice of SDKControlGetUsageResponse we consume (experimental shape). */
interface RawUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface RawUsageSnapshot {
  rate_limits_available: boolean;
  subscription_type?: string | null;
  rate_limits?: {
    five_hour?: RawUsageWindow | null;
    seven_day?: RawUsageWindow | null;
    seven_day_opus?: RawUsageWindow | null;
    seven_day_sonnet?: RawUsageWindow | null;
  } | null;
  session?: { total_cost_usd?: number } | null;
}

export function normalizeUsage(res: unknown, now: () => number = Date.now): UsageData | null {
  if (typeof res !== 'object' || res === null) return null;
  const snapshot = res as RawUsageSnapshot;
  if (typeof snapshot.rate_limits_available !== 'boolean') return null;

  const win = (w: RawUsageWindow | null | undefined): UsageWindow | undefined =>
    w ? { utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null } : undefined;

  const rl = snapshot.rate_limits;
  const fiveHour = win(rl?.five_hour);
  const sevenDay = win(rl?.seven_day);
  const sevenDayOpus = win(rl?.seven_day_opus);
  const sevenDaySonnet = win(rl?.seven_day_sonnet);
  const sessionCostUsd =
    typeof snapshot.session?.total_cost_usd === 'number'
      ? snapshot.session.total_cost_usd
      : undefined;

  return {
    available: snapshot.rate_limits_available,
    subscriptionType: snapshot.subscription_type ?? null,
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(sevenDayOpus !== undefined ? { sevenDayOpus } : {}),
    ...(sevenDaySonnet !== undefined ? { sevenDaySonnet } : {}),
    ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    fetchedAt: new Date(now()).toISOString(),
  };
}
