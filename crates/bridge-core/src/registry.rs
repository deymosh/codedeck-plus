//! The session registry: what the bridge remembers about each session across
//! restarts, and how it tells the phone a session is gone.
//!
//! - Every session the phone has seen (from `session-ready` on) has a
//!   [`SessionRecord`]; the whole registry is one stored document, rewritten
//!   when anything in it changes. On start every record is resumed, so a
//!   bridge restart forgets nothing.
//! - A session leaves the phone only through an explicit tombstone in the
//!   heartbeat's `removedSessions`. Absence from the list never deletes, so
//!   a heartbeat that happens to be empty cannot wipe the phone.
//! - A tombstone is needed once per phone, not on every heartbeat: a client
//!   that is present applies it from the next one. So the shared heartbeat
//!   carries only the tombstones of the last [`TOMBSTONE_RECENT_MS`], and a
//!   client coming back (whose heartbeat is its own) gets every one kept —
//!   the last [`TOMBSTONE_CAP`], for at most [`TOMBSTONE_KEEP_MS`].

use std::collections::VecDeque;

use protocol::common::{RemoteSessionInfo, SessionState};
use serde::{Deserialize, Serialize};

pub const TOMBSTONE_CAP: usize = 100;
/// How long a tombstone rides every heartbeat: far longer than any present
/// client goes without one.
pub const TOMBSTONE_RECENT_MS: u64 = 24 * 3600 * 1000;
/// How long a tombstone is kept for a client that was away. A phone away
/// longer than this keeps the session, shown stale, until removed by hand.
pub const TOMBSTONE_KEEP_MS: u64 = 30 * 24 * 3600 * 1000;

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    /// The agent this session runs on; a restart reattaches it to the same
    /// agent.
    pub agent: String,
    pub cwd: String,
    /// The agent's own conversation id — what a restart resumes. Absent
    /// until the agent reports one (it creates its conversation on the
    /// first turn).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    /// The last conversation id dropped because the agent could not find it.
    /// Never resumed automatically; kept so a wrong drop stays diagnosable
    /// and the conversation recoverable by hand — `native_session_id` is the
    /// only pointer to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The custom provider profile this session is bound to for life.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// The persona the session runs as (agents with `supports.personas`),
    /// once its agent has reported one. Absent until then: a requested one
    /// the agent does not have leaves it on the agent's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    pub title: Option<String>,
    pub project: String,
    pub created_at: String,
    pub last_activity: String,
    /// A commit landed in the session's directory since it started.
    #[serde(default, skip_serializing_if = "is_false")]
    pub committed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_percentage: Option<f64>,
}

impl SessionRecord {
    /// The phone's view of this record.
    pub fn remote_info(&self, seq_high: u64, state: SessionState, provider_label: Option<String>) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: self.session_id.clone(),
            agent: self.agent.clone(),
            slug: self.session_id.chars().take(8).collect(),
            cwd: self.cwd.clone(),
            last_activity: self.last_activity.clone(),
            line_count: seq_high,
            title: self.title.clone(),
            project: self.project.clone(),
            mode: self.mode.clone(),
            effort: self.effort.clone(),
            model: self.model.clone(),
            persona: self.persona.clone(),
            context_window: self.context_window,
            context_percentage: self.context_percentage,
            committed: self.committed.then_some(true),
            state: Some(state),
            seq_high: Some(seq_high),
            provider_id: self.provider_id.clone(),
            provider_label,
            turn_started_at: None,
        }
    }
}

/// A removed session's id, and when it was removed (ms).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub id: String,
    pub removed_at: u64,
}

/// The stored registry document.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDoc {
    pub sessions: Vec<SessionRecord>,
    pub removed_sessions: Vec<Tombstone>,
}

impl RegistryDoc {
    /// Parse a stored registry. A record that does not parse is skipped (and
    /// logged) rather than losing every other one; an unreadable document
    /// starts empty — a corrupt registry must never stop the bridge.
    pub fn load(json: &str) -> Self {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            #[serde(default)]
            sessions: Vec<serde_json::Value>,
            #[serde(default)]
            removed_sessions: Vec<serde_json::Value>,
        }
        let raw: Raw = match serde_json::from_str(json) {
            Ok(raw) => raw,
            Err(err) => {
                log::warn!("[Registry] Stored registry is unreadable ({err}) — starting empty");
                return Self::default();
            }
        };
        let sessions = raw
            .sessions
            .into_iter()
            .filter_map(|v| match serde_json::from_value::<SessionRecord>(v) {
                Ok(rec) if !rec.session_id.is_empty() && !rec.agent.is_empty() => Some(rec),
                Ok(rec) => {
                    log::warn!("[Registry] Skipping session {:?}: no id or agent", rec.session_id);
                    None
                }
                Err(err) => {
                    log::warn!("[Registry] Skipping an unreadable session record: {err}");
                    None
                }
            })
            .collect();
        // An entry that is not a tombstone is skipped like an unreadable
        // record.
        let mut removed: Vec<Tombstone> =
            raw.removed_sessions.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect();
        let excess = removed.len().saturating_sub(TOMBSTONE_CAP);
        removed.drain(..excess);
        Self { sessions, removed_sessions: removed }
    }
}

/// Removed sessions, oldest first, capped at [`TOMBSTONE_CAP`].
#[derive(Debug, Default)]
pub struct Tombstones(VecDeque<Tombstone>);

impl Tombstones {
    pub fn new(stored: Vec<Tombstone>) -> Self {
        let mut t = Self::default();
        for stone in stored {
            t.add(&stone.id, stone.removed_at);
        }
        t
    }

    /// `id` was removed at `now` (ms). A second removal keeps the first.
    pub fn add(&mut self, id: &str, now: u64) {
        if self.0.iter().any(|t| t.id == id) {
            return;
        }
        self.0.push_back(Tombstone { id: id.to_string(), removed_at: now });
        while self.0.len() > TOMBSTONE_CAP {
            self.0.pop_front();
        }
    }

    /// Drop tombstones older than [`TOMBSTONE_KEEP_MS`]; whether any went.
    pub fn prune(&mut self, now: u64) -> bool {
        let before = self.0.len();
        self.0.retain(|t| now.saturating_sub(t.removed_at) < TOMBSTONE_KEEP_MS);
        self.0.len() != before
    }

    /// Every id kept: what a client coming back may have missed.
    pub fn ids(&self) -> Vec<String> {
        self.0.iter().map(|t| t.id.clone()).collect()
    }

    /// The ids removed within [`TOMBSTONE_RECENT_MS`] of `now`: what the
    /// shared heartbeat carries.
    pub fn recent_ids(&self, now: u64) -> Vec<String> {
        self.0.iter().filter(|t| now.saturating_sub(t.removed_at) < TOMBSTONE_RECENT_MS).map(|t| t.id.clone()).collect()
    }

    /// Whether every tombstone kept is a recent one, so the shared
    /// heartbeat carries them all.
    pub fn all_recent(&self, now: u64) -> bool {
        self.0.iter().all(|t| now.saturating_sub(t.removed_at) < TOMBSTONE_RECENT_MS)
    }

    /// The stored form.
    pub fn stored(&self) -> Vec<Tombstone> {
        self.0.iter().cloned().collect()
    }
}

/// The project name shown for a working directory: its last path segment.
pub fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: &str) -> SessionRecord {
        SessionRecord {
            session_id: id.into(),
            agent: "claude-code".into(),
            cwd: "/w/app".into(),
            native_session_id: None,
            previous_native_session_id: None,
            model: None,
            provider_id: None,
            effort: None,
            mode: Some("plan".into()),
            persona: None,
            title: None,
            project: "app".into(),
            created_at: "t0".into(),
            last_activity: "t1".into(),
            committed: false,
            context_window: None,
            context_percentage: None,
        }
    }

    #[test]
    fn a_registry_round_trips_through_its_stored_form() {
        let stone = Tombstone { id: "x".into(), removed_at: 7 };
        let doc = RegistryDoc { sessions: vec![record("a"), record("b")], removed_sessions: vec![stone.clone()] };
        let back = RegistryDoc::load(&serde_json::to_string(&doc).unwrap());
        assert_eq!(back.sessions, doc.sessions);
        assert_eq!(back.removed_sessions, [stone]);
    }

    #[test]
    fn a_record_without_an_agent_is_skipped_and_the_rest_load() {
        let json = json!({"sessions":[
            {"sessionId":"old","cwd":"/w","title":null,"project":"w","createdAt":"t","lastActivity":"t"},
            serde_json::to_value(record("good")).unwrap(),
        ],"removedSessions":[]});
        let doc = RegistryDoc::load(&json.to_string());
        assert_eq!(doc.sessions.len(), 1);
        assert_eq!(doc.sessions[0].session_id, "good");
    }

    #[test]
    fn a_corrupt_registry_starts_empty() {
        let doc = RegistryDoc::load("{ torn");
        assert!(doc.sessions.is_empty() && doc.removed_sessions.is_empty());
    }

    #[test]
    fn tombstones_cap_at_100_fifo_without_duplicates() {
        let mut t = Tombstones::default();
        for i in 0..105 {
            t.add(&format!("s{i}"), i);
        }
        t.add("s104", 999);
        let ids = t.ids();
        assert_eq!(ids.len(), TOMBSTONE_CAP);
        assert_eq!(ids[0], "s5");
        assert_eq!(ids.last().unwrap(), "s104");
    }

    #[test]
    fn the_shared_heartbeat_carries_a_day_and_a_client_back_a_month() {
        const DAY: u64 = 24 * 3600 * 1000;
        let mut t = Tombstones::default();
        t.add("old", 0);
        t.add("new", 40 * DAY);
        let now = 40 * DAY + DAY / 2;
        assert_eq!(t.recent_ids(now), ["new"]);
        assert_eq!(t.ids(), ["old", "new"]);
        assert!(t.prune(now), "a tombstone past the keep window goes");
        assert_eq!(t.ids(), ["new"]);
        assert!(!t.prune(now));
    }

    #[test]
    fn remote_info_maps_the_record() {
        let mut rec = record("0123456789ab");
        rec.committed = true;
        rec.provider_id = Some("kimi".into());
        rec.persona = Some("review".into());
        let info = rec.remote_info(42, SessionState::Running, Some("Kimi".into()));
        assert_eq!(info.slug, "01234567");
        assert_eq!((info.line_count, info.seq_high), (42, Some(42)));
        assert_eq!(info.committed, Some(true));
        assert_eq!(info.persona.as_deref(), Some("review"));
        assert_eq!(info.state, Some(SessionState::Running));
        assert_eq!(info.provider_label.as_deref(), Some("Kimi"));
        assert_eq!(record("x").remote_info(0, SessionState::Idle, None).committed, None);
    }

    #[test]
    fn project_is_the_last_path_segment() {
        assert_eq!(project_of("/home/me/app"), "app");
        assert_eq!(project_of("/home/me/app/"), "app");
        assert_eq!(project_of(r"C:\work\site"), "site");
        assert_eq!(project_of("/"), "/");
    }
}
