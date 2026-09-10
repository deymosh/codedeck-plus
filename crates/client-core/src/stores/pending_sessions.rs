//! `pending_sessions` store — the phone side of two-phase session creation.
//! Port of the pure half of `apps/mobile/src/core/stores/pendingSessions.ts`.
//!
//! The bridge publishes `session-pending` immediately on `create-session`, then
//! either `session-ready` (→ the session appears as a real session and the
//! placeholder is resolved) or `session-failed` (→ the placeholder flips to a
//! visible error card). Keeping the optimistic placeholders here lets the
//! sessions screen show "starting…" instantly and an honest error on failure.
//!
//! Not persisted: a placeholder that never resolves is meaningless after a
//! restart (the bridge's registry is the real list). `sweep` drops the ones the
//! bridge never answered (both the ready and failed events expired).

use std::collections::BTreeMap;

use serde::Serialize;

/// A placeholder still `Pending` after this long is swept — the bridge always
/// answers with ready or failed, so losing BOTH means the response event
/// expired off the relays.
pub const PENDING_SWEEP_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingSessionState {
    Pending,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionView {
    pub pending_id: String,
    /// Machine pubkey hex (`""` for a failure we saw no `session-pending` for).
    pub machine: String,
    /// Machine display name from the message (not the pubkey).
    pub machine_name: String,
    pub created_at: String,
    pub state: PendingSessionState,
    /// Set once `state == Failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// ms timestamp the placeholder appeared (sweep bookkeeping).
    pub seen_at: u64,
}

/// Pure state: `pending_id -> placeholder`. The runtime feeds `now` and routes
/// the decoded `session-pending` / `session-ready` / `session-failed` messages.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PendingSessionsState {
    pending: BTreeMap<String, PendingSessionView>,
}

impl PendingSessionsState {
    /// `session-pending` — record (or replace) the optimistic placeholder.
    pub fn apply_pending(
        &mut self,
        machine: &str,
        pending_id: &str,
        machine_name: &str,
        created_at: &str,
        now: u64,
    ) {
        self.pending.insert(
            pending_id.to_string(),
            PendingSessionView {
                pending_id: pending_id.to_string(),
                machine: machine.to_string(),
                machine_name: machine_name.to_string(),
                created_at: created_at.to_string(),
                state: PendingSessionState::Pending,
                reason: None,
                seen_at: now,
            },
        );
    }

    /// `session-ready`, or the session turning up in a list — drop the
    /// placeholder. Unknown id is a no-op.
    pub fn resolve(&mut self, pending_id: &str) {
        self.pending.remove(pending_id);
    }

    /// `session-failed` — flip the placeholder to a visible error. A failure for
    /// a pending we never saw still surfaces (an invisible failure is the old
    /// bug), with empty machine fields.
    pub fn apply_failed(&mut self, pending_id: &str, reason: &str, now: u64) {
        match self.pending.get_mut(pending_id) {
            Some(existing) => {
                existing.state = PendingSessionState::Failed;
                existing.reason = Some(reason.to_string());
            }
            None => {
                self.pending.insert(
                    pending_id.to_string(),
                    PendingSessionView {
                        pending_id: pending_id.to_string(),
                        machine: String::new(),
                        machine_name: String::new(),
                        created_at: String::new(),
                        state: PendingSessionState::Failed,
                        reason: Some(reason.to_string()),
                        seen_at: now,
                    },
                );
            }
        }
    }

    /// User dismisses a failed card.
    pub fn dismiss(&mut self, pending_id: &str) {
        self.pending.remove(pending_id);
    }

    /// Drop never-resolved `Pending` placeholders older than
    /// [`PENDING_SWEEP_MS`]. `Failed` cards stay until the user dismisses them.
    pub fn sweep(&mut self, now: u64) {
        let cutoff = now.saturating_sub(PENDING_SWEEP_MS);
        self.pending
            .retain(|_, v| !(v.state == PendingSessionState::Pending && v.seen_at < cutoff));
    }

    /// Placeholders for a machine, oldest first. Machine-less failures (the
    /// ghost case) show for every machine. Ties on `seen_at` break by
    /// `pending_id` (`BTreeMap` order) — deterministic, unlike the JS insertion
    /// order it replaces.
    pub fn pending_for(&self, machine: &str) -> Vec<&PendingSessionView> {
        let mut out: Vec<&PendingSessionView> = self
            .pending
            .values()
            .filter(|p| {
                p.machine == machine
                    || (p.machine.is_empty() && p.state == PendingSessionState::Failed)
            })
            .collect();
        out.sort_by_key(|p| p.seen_at);
        out
    }

    /// Test/inspection helper: total placeholder count.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACHINE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const CREATED_AT: &str = "2026-08-05T00:00:00.000Z";

    fn ids(views: &[&PendingSessionView]) -> Vec<String> {
        views.iter().map(|v| v.pending_id.clone()).collect()
    }

    #[test]
    fn session_pending_makes_an_optimistic_placeholder_for_the_machine() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 1_000_000);
        let list = s.pending_for(MACHINE);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].pending_id, "p1");
        assert_eq!(list[0].machine, MACHINE);
        assert_eq!(list[0].machine_name, "devbox (cli)");
        assert_eq!(list[0].state, PendingSessionState::Pending);
        assert_eq!(list[0].reason, None);
    }

    #[test]
    fn session_ready_resolve_removes_the_placeholder_and_unknown_id_is_a_noop() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 1_000_000);
        s.resolve("p1");
        assert!(s.pending_for(MACHINE).is_empty());
        s.resolve("nope"); // no-op, no panic
    }

    #[test]
    fn session_failed_flips_the_placeholder_to_a_visible_error_with_reason() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 1_000_000);
        s.apply_failed("p1", "SDK session spawn failed", 1_000_000);
        let list = s.pending_for(MACHINE);
        assert_eq!(list[0].state, PendingSessionState::Failed);
        assert_eq!(list[0].reason.as_deref(), Some("SDK session spawn failed"));
    }

    #[test]
    fn a_failure_without_a_prior_pending_is_still_surfaced() {
        let mut s = PendingSessionsState::default();
        s.apply_failed("ghost", "reason", 1_000_000);
        let list = s.pending_for(MACHINE);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].pending_id, "ghost");
        assert_eq!(list[0].state, PendingSessionState::Failed);
    }

    #[test]
    fn dismiss_removes_a_failed_card_and_sweep_drops_only_stale_pending() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 1_000_000);
        s.apply_pending(MACHINE, "p2", "devbox (cli)", CREATED_AT, 1_000_000);
        s.apply_failed("p2", "boom", 1_000_000);

        s.sweep(1_000_000 + PENDING_SWEEP_MS + 1);
        // stale pending p1 swept; failed p2 stays until dismissed
        assert_eq!(ids(&s.pending_for(MACHINE)), vec!["p2"]);

        s.dismiss("p2");
        assert!(s.pending_for(MACHINE).is_empty());
    }

    #[test]
    fn a_fresh_pending_survives_the_sweep() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 1_000_000);
        s.sweep(1_000_000 + PENDING_SWEEP_MS - 1000);
        assert_eq!(s.pending_for(MACHINE).len(), 1);
    }

    #[test]
    fn ghost_failures_show_for_every_machine_and_placeholders_sort_oldest_first() {
        let mut s = PendingSessionsState::default();
        s.apply_pending(MACHINE, "p1", "devbox (cli)", CREATED_AT, 100);
        s.apply_pending(MACHINE, "p2", "devbox (cli)", CREATED_AT, 50);
        s.apply_failed("ghost", "reason", 10);
        assert_eq!(ids(&s.pending_for(MACHINE)), vec!["ghost", "p2", "p1"]);
        // the ghost failure also shows for an unrelated machine
        assert_eq!(ids(&s.pending_for("other")), vec!["ghost"]);
    }
}
