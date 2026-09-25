/**
 * Single source of truth for "this session wants the user's attention now"
 * (ported from the old app's utils/sessionNeedsAttention.ts).
 *
 * True when the session is blocked on the user (permission approval or an
 * AskUserQuestion) OR has unread activity the user hasn't looked at.
 *
 * The waiting branch is deliberately independent of `isUnread`: the unread
 * mechanism skips the foreground/active session (the user is already looking
 * at it), but a session blocked on the user must light up even while it IS
 * the foreground session.
 */
import type { SessionState } from './nativeCoreTypes';

export function sessionNeedsAttention(
  state: SessionState | undefined,
  isUnread: boolean,
): boolean {
  return state === 'waiting_permission' || state === 'waiting_question' || isUnread;
}
