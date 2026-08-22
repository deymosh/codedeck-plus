/**
 * Compact "time ago" for session cards and DM tiles (ported ~verbatim from the
 * old app's utils/relativeTime.ts). Accepts an ISO string
 * (RemoteSessionInfo.lastActivity) or a ms timestamp (DM lastMessageAt) —
 * Phase 2b folded the DM list's ms-based twin into this one function.
 */
export function relativeTime(at: string | number, now: number = Date.now()): string {
  const diff = now - new Date(at).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
