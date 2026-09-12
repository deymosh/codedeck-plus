//! The single "this session wants the user's attention now" predicate. Port of
//! `apps/mobile/src/core/sessionNeedsAttention.ts`.
//!
//! True when the session is blocked on the user (permission approval or an
//! AskUserQuestion) OR has unread activity the user hasn't looked at.
//!
//! The waiting branch is deliberately independent of `is_unread`: the unread
//! mechanism skips the foreground session (the user is already looking at it),
//! but a session blocked on the user must light up even while it IS the
//! foreground session.

use protocol::common::SessionState;

pub fn session_needs_attention(state: Option<SessionState>, is_unread: bool) -> bool {
    matches!(
        state,
        Some(SessionState::WaitingPermission) | Some(SessionState::WaitingQuestion)
    ) || is_unread
}

#[cfg(test)]
mod tests {
    use super::*;
    use SessionState::*;

    #[test]
    fn waiting_states_light_up_regardless_of_unread() {
        assert!(session_needs_attention(Some(WaitingPermission), false));
        assert!(session_needs_attention(Some(WaitingQuestion), false));
    }

    #[test]
    fn unread_lights_up_regardless_of_state() {
        assert!(session_needs_attention(Some(Running), true));
        assert!(session_needs_attention(None, true));
    }

    #[test]
    fn everything_else_is_quiet() {
        assert!(!session_needs_attention(Some(Running), false));
        assert!(!session_needs_attention(Some(Idle), false));
        assert!(!session_needs_attention(Some(Offline), false));
        assert!(!session_needs_attention(None, false));
    }
}
