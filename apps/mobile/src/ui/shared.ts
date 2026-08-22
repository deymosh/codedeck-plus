/**
 * Class-name helpers over the shared primitives module: `cx` joiner plus the
 * dynamic badge maps (presence / session state) that JSX previously built via
 * template strings on global class names.
 */
import s from './shared.module.css';

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/** Presence badge (machine/session heartbeat): live / stale / offline. */
export function presenceBadge(presence: string): string {
  if (presence === 'live') return s.badgeLive!;
  if (presence === 'stale') return s.badgeStale!;
  return s.badgeOffline!;
}

/** Session-state badge: running is emphasized, waiting states warn. */
export function stateBadge(state: string): string {
  if (state === 'running') return s.badgeRunning!;
  if (state === 'waiting_permission' || state === 'waiting_question') return s.badgeWaiting!;
  return s.badge!;
}

export { s as shared };
