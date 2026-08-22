/**
 * Usage formatting (CDX-011: "usage panel polish") — pure functions for the
 * session-header badges. Data comes from what core already wires (5c/CDX-005):
 * per-session `contextPercentage` + `contextWindow` (SDK-authoritative, real
 * denominator incl. the 1M beta window) and the `usage` snapshot (subscription
 * rate-limit windows). Tasteful on tokens: whole-number %, compact token
 * counts, reset countdowns as tooltips — no redesign.
 */
import type { UsageData } from '@codedeck/protocol';

/** Compact token count: 950 → "950", 84_200 → "84k", 1_240_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/**
 * The context badge: percentage plus, when the SDK reported the real window,
 * used/total tokens. Null without a percentage (nothing to show).
 *   (42, 200000) → "42% · 84k/200k";  (42, undefined) → "42%"
 *
 * CDX-087 dropped the "ctx " prefix: the model tag now leads the badge
 * ("O5 · 42% · 84k/200k"), which is what the old app's header rectangle read
 * and what labels the percentage well enough on its own. The prefix was also
 * costing width in a header row that is tight on a phone.
 */
export function contextBadge(
  contextPercentage?: number,
  contextWindow?: number,
): string | null {
  if (contextPercentage === undefined || !Number.isFinite(contextPercentage)) return null;
  const pct = Math.max(0, Math.min(100, Math.round(contextPercentage)));
  if (contextWindow === undefined || contextWindow <= 0) return `${pct}%`;
  const used = Math.round((pct / 100) * contextWindow);
  return `${pct}% · ${formatTokens(used)}/${formatTokens(contextWindow)}`;
}

/** Coarse reset countdown (ported from the old UsagePanel): "resets in 3h 12m". */
export function formatReset(resetsAt: string | null | undefined, nowMs: number): string | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const diffMs = target - nowMs;
  if (diffMs <= 0) return 'resetting…';
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

export interface UsageBadge {
  /** Badge text, e.g. "5h 37%". */
  text: string;
  /** Tooltip: reset countdown when the window reported one. */
  title?: string;
  /** ≥90 utilization — render with the danger accent. */
  critical: boolean;
}

/**
 * Subscription-usage badges from the snapshot: the 5-hour window and (when
 * reported) the 7-day window. Unavailable/empty snapshots yield []. Percent is
 * clamped + rounded; reset countdown rides the tooltip, not the header.
 */
export function usageBadges(usage: UsageData | undefined, nowMs: number): UsageBadge[] {
  if (!usage?.available) return [];
  const badges: UsageBadge[] = [];
  const windows: Array<[string, { utilization: number | null; resetsAt: string | null } | undefined]> = [
    ['5h', usage.fiveHour],
    ['7d', usage.sevenDay],
  ];
  for (const [label, w] of windows) {
    if (!w || w.utilization === null || !Number.isFinite(w.utilization)) continue;
    const pct = Math.max(0, Math.min(100, Math.round(w.utilization)));
    const reset = formatReset(w.resetsAt, nowMs);
    badges.push({
      text: `${label} ${pct}%`,
      ...(reset ? { title: reset } : {}),
      critical: pct >= 90,
    });
  }
  return badges;
}
