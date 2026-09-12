//! Optimistic session delete with a 4 s undo window. Port of the pure control
//! logic in `apps/mobile/src/core/deleteController.ts` — the store mutations,
//! the timer, the toast and the `close-session` send are all [`DeleteEffect`]s
//! the runtime carries out.
//!
//! `request_delete` snapshots the `SessionView`, then emits: dismiss
//! (resurrection shield) + remove it locally NOW, clear its unread dot,
//! deselect it if selected, arm the undo timer, show the toast. `undo` inside
//! the window emits `ClearUndoTimer` + `RestoreSnapshot` (the exact snapshot
//! back) + `HideUndoToast`. When the timer fires — or a second `request_delete`
//! lands while one is pending — the pending delete COMMITS: exactly one
//! `close-session` per committed delete, never a lost one.
//!
//! Transcript rows are not touched here: the `close-session-ack` handler
//! removes them when the bridge confirms.

use crate::stores::machines::SessionView;

pub const UNDO_DELAY_MS: u64 = 4_000;

/// What a delete / undo / timer step asks the runtime to do.
#[derive(Debug, Clone, PartialEq)]
pub enum DeleteEffect {
    /// Dismiss the session locally (heartbeat-resurrection shield), stamped `now`.
    DismissSession { session_id: String, now: u64 },
    /// Remove the session row from the machines store now.
    RemoveSession { machine: String, session_id: String },
    /// Clear any unread dot for the session (undo does not resurrect dots).
    ClearSessionUnread { machine: String, session_id: String },
    /// Deselect the session — the runtime applies this only if it is the
    /// current selection (mirrors the TS `selectedMachine`/`selectedSession`
    /// guard, which the pure FSM cannot see).
    DeselectSession { machine: String, session_id: String },
    /// (Re)arm the undo-window timer. Fire [`DeleteController::timer_fired`]
    /// when it elapses.
    ArmUndoTimer { ms: u64 },
    /// Cancel a pending undo-window timer.
    ClearUndoTimer,
    ShowUndoToast {
        machine: String,
        session_id: String,
        label: String,
    },
    HideUndoToast,
    /// Commit the delete: send `close-session` to the bridge.
    SendCloseSession { machine: String, session_id: String },
    /// Undo: put the exact snapshot back (`restore_session` un-dismisses AND
    /// re-inserts it; the next heartbeat merges over it normally).
    RestoreSnapshot {
        machine: String,
        snapshot: Box<SessionView>,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct PendingDelete {
    machine: String,
    session_id: String,
    snapshot: Box<SessionView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteController {
    pending: Option<PendingDelete>,
    pub undo_delay_ms: u64,
}

impl Default for DeleteController {
    fn default() -> Self {
        Self {
            pending: None,
            undo_delay_ms: UNDO_DELAY_MS,
        }
    }
}

impl DeleteController {
    pub fn with_delay(undo_delay_ms: u64) -> Self {
        Self {
            undo_delay_ms,
            ..Self::default()
        }
    }

    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Commit any pending delete: clear its timer, send `close-session`, drop
    /// the toast. A no-op with nothing pending.
    fn commit(&mut self) -> Vec<DeleteEffect> {
        match self.pending.take() {
            None => vec![],
            Some(p) => vec![
                DeleteEffect::ClearUndoTimer,
                DeleteEffect::SendCloseSession {
                    machine: p.machine,
                    session_id: p.session_id,
                },
                DeleteEffect::HideUndoToast,
            ],
        }
    }

    /// Optimistically delete `session_id`. `snapshot` is its current
    /// `SessionView` — `None` means it is already gone (a double fire), a
    /// harmless no-op after any prior pending delete is committed. `label` is
    /// the undo-toast text; it falls back to the session title, then the slug,
    /// then `"Session"`.
    pub fn request_delete(
        &mut self,
        machine: &str,
        session_id: &str,
        snapshot: Option<SessionView>,
        label: Option<&str>,
        now: u64,
    ) -> Vec<DeleteEffect> {
        // A second delete while one is pending commits the pending one NOW.
        let mut effects = self.commit();

        let Some(snapshot) = snapshot else {
            return effects;
        };

        let toast_label = match label {
            Some(l) => l.to_string(),
            None => match snapshot.info.title.as_deref() {
                Some(t) if !t.is_empty() => t.to_string(),
                _ if !snapshot.info.slug.is_empty() => snapshot.info.slug.clone(),
                _ => "Session".to_string(),
            },
        };

        effects.push(DeleteEffect::DismissSession {
            session_id: session_id.to_string(),
            now,
        });
        effects.push(DeleteEffect::RemoveSession {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
        });
        effects.push(DeleteEffect::ClearSessionUnread {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
        });
        effects.push(DeleteEffect::DeselectSession {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
        });

        self.pending = Some(PendingDelete {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
            snapshot: Box::new(snapshot),
        });

        effects.push(DeleteEffect::ArmUndoTimer {
            ms: self.undo_delay_ms,
        });
        effects.push(DeleteEffect::ShowUndoToast {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
            label: toast_label,
        });
        effects
    }

    /// The undo window elapsed — commit the delete.
    pub fn timer_fired(&mut self) -> Vec<DeleteEffect> {
        self.commit()
    }

    /// Cancel the pending delete and restore the exact snapshot. No-op when
    /// nothing is pending (the toast is gone by then anyway).
    pub fn undo(&mut self) -> Vec<DeleteEffect> {
        match self.pending.take() {
            None => vec![],
            Some(p) => vec![
                DeleteEffect::ClearUndoTimer,
                DeleteEffect::RestoreSnapshot {
                    machine: p.machine,
                    snapshot: p.snapshot,
                },
                DeleteEffect::HideUndoToast,
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::machines::ListingPresence;
    use protocol::common::RemoteSessionInfo;
    use DeleteEffect as E;

    fn info(id: &str) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: id.into(),
            slug: format!("slug-{id}"),
            cwd: "/work".into(),
            last_activity: "1970-01-01T00:00:00.000Z".into(),
            line_count: 0,
            title: None,
            project: "proj".into(),
            permission_mode: None,
            effort_level: None,
            model: None,
            context_window: None,
            context_percentage: None,
            committed: None,
            state: None,
            seq_high: None,
            provider_id: None,
            provider_label: None,
        }
    }

    fn view(id: &str, title: Option<&str>) -> SessionView {
        SessionView::listed(
            RemoteSessionInfo {
                title: title.map(str::to_string),
                ..info(id)
            },
            ListingPresence::Live,
            1_000,
        )
    }

    #[test]
    fn request_delete_removes_locally_arms_the_timer_and_shows_the_toast() {
        let mut c = DeleteController::default();
        let e = c.request_delete("m", "s1", Some(view("s1", Some("One"))), Some("One"), 1_000);
        assert_eq!(
            e,
            vec![
                E::DismissSession { session_id: "s1".into(), now: 1_000 },
                E::RemoveSession { machine: "m".into(), session_id: "s1".into() },
                E::ClearSessionUnread { machine: "m".into(), session_id: "s1".into() },
                E::DeselectSession { machine: "m".into(), session_id: "s1".into() },
                E::ArmUndoTimer { ms: UNDO_DELAY_MS },
                E::ShowUndoToast { machine: "m".into(), session_id: "s1".into(), label: "One".into() },
            ]
        );
        assert!(c.is_pending());
    }

    #[test]
    fn undo_clears_the_timer_restores_the_exact_snapshot_and_hides_the_toast() {
        let mut c = DeleteController::default();
        let snap = view("s1", Some("One"));
        c.request_delete("m", "s1", Some(snap.clone()), None, 1_000);

        let e = c.undo();
        assert_eq!(
            e,
            vec![
                E::ClearUndoTimer,
                E::RestoreSnapshot { machine: "m".into(), snapshot: Box::new(snap) },
                E::HideUndoToast,
            ]
        );
        assert!(!c.is_pending());
        assert!(c.undo().is_empty()); // a second undo is a no-op
    }

    #[test]
    fn the_timer_fires_exactly_one_close_session() {
        let mut c = DeleteController::default();
        c.request_delete("m", "s1", Some(view("s1", None)), None, 1_000);

        let e = c.timer_fired();
        assert_eq!(
            e,
            vec![
                E::ClearUndoTimer,
                E::SendCloseSession { machine: "m".into(), session_id: "s1".into() },
                E::HideUndoToast,
            ]
        );
        assert!(c.timer_fired().is_empty()); // nothing pending → no second send
        assert!(c.undo().is_empty());
    }

    #[test]
    fn a_second_delete_while_one_is_pending_commits_the_first_immediately() {
        let mut c = DeleteController::default();
        c.request_delete("m", "s1", Some(view("s1", None)), Some("First"), 1_000);

        let e = c.request_delete("m", "s2", Some(view("s2", None)), Some("Second"), 2_000);
        // first commits NOW (not at its 4 s mark), then the second is set up
        assert_eq!(e[0], E::ClearUndoTimer);
        assert_eq!(
            e[1],
            E::SendCloseSession { machine: "m".into(), session_id: "s1".into() }
        );
        assert_eq!(e[2], E::HideUndoToast);
        assert_eq!(
            e.last(),
            Some(&E::ShowUndoToast {
                machine: "m".into(),
                session_id: "s2".into(),
                label: "Second".into()
            })
        );

        // undo now only rescues the second delete
        let u = c.undo();
        assert_eq!(
            u[1],
            E::RestoreSnapshot { machine: "m".into(), snapshot: Box::new(view("s2", None)) }
        );
    }

    #[test]
    fn deleting_an_unknown_session_is_a_harmless_noop() {
        let mut c = DeleteController::default();
        assert!(c.request_delete("m", "ghost", None, None, 1_000).is_empty());
        assert!(!c.is_pending());
        assert!(c.timer_fired().is_empty());
    }

    #[test]
    fn toast_label_falls_back_to_title_then_slug_then_session() {
        let mut c = DeleteController::default();

        let e = c.request_delete("m", "s1", Some(view("s1", Some("Titled"))), None, 0);
        assert!(matches!(e.last(), Some(E::ShowUndoToast { label, .. }) if label == "Titled"));
        c.undo();

        // empty title → slug
        let e = c.request_delete("m", "s1", Some(view("s1", Some(""))), None, 0);
        assert!(matches!(e.last(), Some(E::ShowUndoToast { label, .. }) if label == "slug-s1"));
        c.undo();

        // no title and no slug → "Session"
        let mut blank = view("s1", None);
        blank.info.slug = String::new();
        let e = c.request_delete("m", "s1", Some(blank), None, 0);
        assert!(matches!(e.last(), Some(E::ShowUndoToast { label, .. }) if label == "Session"));
    }
}
