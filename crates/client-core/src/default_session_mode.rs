//! Default session mode applier (CDX-047). Port of
//! `apps/mobile/src/core/defaultSessionMode.ts`.
//!
//! The bridge starts every session in `plan` (`permissionMode ?? 'plan'`) and
//! `create-session` has no mode field, so a non-plan "default mode for new
//! sessions" preference is applied by sending a mode command when the session's
//! `session-ready` arrives — at most ONCE per session, and only when the
//! preference DIFFERS from the mode the session came up in.

use std::collections::BTreeSet;

use protocol::common::PermissionMode;

/// Tracks which `(machine, session)` pairs have already had the preference
/// applied.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DefaultModeApplier {
    applied: BTreeSet<String>,
}

impl DefaultModeApplier {
    /// On `session-ready`. Returns `Some(mode)` to send `mode`, or `None` (first
    /// application already done, or the preference already matches).
    pub fn apply(
        &mut self,
        machine: &str,
        session_id: &str,
        started_in: Option<PermissionMode>,
        want: PermissionMode,
    ) -> Option<PermissionMode> {
        let key = format!("{machine} {session_id}");
        if !self.applied.insert(key) {
            return None;
        }
        let started_in = started_in.unwrap_or(PermissionMode::Plan);
        (want != started_in).then_some(want)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_when_the_preference_differs_from_the_start_mode() {
        let mut a = DefaultModeApplier::default();
        assert_eq!(
            a.apply("m", "s1", Some(PermissionMode::Plan), PermissionMode::AcceptEdits),
            Some(PermissionMode::AcceptEdits)
        );
        // a null start mode is treated as plan
        assert_eq!(
            a.apply("m", "s2", None, PermissionMode::Default),
            Some(PermissionMode::Default)
        );
    }

    #[test]
    fn no_send_when_it_already_matches_and_never_twice_per_session() {
        let mut a = DefaultModeApplier::default();
        assert_eq!(a.apply("m", "s1", Some(PermissionMode::Plan), PermissionMode::Plan), None);
        // a replayed session-ready for s1 is a no-op even with a differing want
        assert_eq!(a.apply("m", "s1", Some(PermissionMode::Plan), PermissionMode::AcceptEdits), None);
    }
}
