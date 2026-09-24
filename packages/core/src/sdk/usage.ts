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

  const rl = snapshot.rate_limits;
  // Labelled windows in display order; a window is listed only when the SDK
  // reports it.
  const raw: Array<[string, RawUsageWindow | null | undefined]> = [
    ['5h', rl?.five_hour],
    ['7d', rl?.seven_day],
    ['7d Opus', rl?.seven_day_opus],
    ['7d Sonnet', rl?.seven_day_sonnet],
  ];
  const windows: UsageWindow[] = raw.flatMap(([label, w]) =>
    w ? [{ label, utilization: w.utilization ?? null, resetsAt: w.resets_at ?? null }] : [],
  );
  const sessionCostUsd =
    typeof snapshot.session?.total_cost_usd === 'number'
      ? snapshot.session.total_cost_usd
      : undefined;

  return {
    available: snapshot.rate_limits_available,
    ...(snapshot.subscription_type ? { plan: snapshot.subscription_type } : {}),
    windows,
    ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    fetchedAt: new Date(now()).toISOString(),
  };
}
