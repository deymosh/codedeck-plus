//! The session registry: what the bridge remembers about each session across
//! restarts, and how it tells the phone a session is gone.
//!
//! - Every session the phone has seen (from `session-ready` on) has a
//!   [`SessionRecord`]; the whole registry is one stored document, rewritten
//!   when anything in it changes. On start every record is resumed, so a
//!   bridge restart forgets nothing.
//! - A session leaves the phone only through an explicit tombstone in the
//!   heartbeat's `removedSessions` (the last [`TOMBSTONE_CAP`] ids). Absence
//!   from the list never deletes, so a heartbeat that happens to be empty
//!   cannot wipe the phone.

use std::collections::VecDeque;

use protocol::common::{RemoteSessionInfo, SessionState};
use serde::{Deserialize, Serialize};

pub const TOMBSTONE_CAP: usize = 100;

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
    /// A device-test session: its agent gets the device tools and may never
    /// touch signing keys or secret files. Persisted so a resumed session
    /// keeps that boundary.
    #[serde(default, skip_serializing_if = "is_false")]
    pub test_session: bool,
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
            context_window: self.context_window,
            context_percentage: self.context_percentage,
            committed: self.committed.then_some(true),
            state: Some(state),
            seq_high: Some(seq_high),
            provider_id: self.provider_id.clone(),
            provider_label,
        }
    }
}

/// The stored registry document.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDoc {
    pub sessions: Vec<SessionRecord>,
    pub removed_sessions: Vec<String>,
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
        let mut removed: Vec<String> = raw
            .removed_sessions
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let excess = removed.len().saturating_sub(TOMBSTONE_CAP);
        removed.drain(..excess);
        Self { sessions, removed_sessions: removed }
    }
}

/// Ids of removed sessions, oldest first, capped at [`TOMBSTONE_CAP`].
#[derive(Debug, Default)]
pub struct Tombstones(VecDeque<String>);

impl Tombstones {
    pub fn new(ids: Vec<String>) -> Self {
        let mut t = Self::default();
        for id in ids {
            t.add(&id);
        }
        t
    }

    pub fn add(&mut self, id: &str) {
        if self.0.iter().any(|x| x == id) {
            return;
        }
        self.0.push_back(id.to_string());
        while self.0.len() > TOMBSTONE_CAP {
            self.0.pop_front();
        }
    }

    pub fn ids(&self) -> Vec<String> {
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
            title: None,
            project: "app".into(),
            created_at: "t0".into(),
            last_activity: "t1".into(),
            committed: false,
            context_window: None,
            context_percentage: None,
            test_session: false,
        }
    }

    #[test]
    fn a_registry_round_trips_through_its_stored_form() {
        let doc = RegistryDoc { sessions: vec![record("a"), record("b")], removed_sessions: vec!["x".into()] };
        let back = RegistryDoc::load(&serde_json::to_string(&doc).unwrap());
        assert_eq!(back.sessions, doc.sessions);
        assert_eq!(back.removed_sessions, ["x"]);
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
            t.add(&format!("s{i}"));
        }
        t.add("s104");
        let ids = t.ids();
        assert_eq!(ids.len(), TOMBSTONE_CAP);
        assert_eq!(ids[0], "s5");
        assert_eq!(ids.last().unwrap(), "s104");
    }

    #[test]
    fn remote_info_maps_the_record() {
        let mut rec = record("0123456789ab");
        rec.committed = true;
        rec.provider_id = Some("kimi".into());
        let info = rec.remote_info(42, SessionState::Running, Some("Kimi".into()));
        assert_eq!(info.slug, "01234567");
        assert_eq!((info.line_count, info.seq_high), (42, Some(42)));
        assert_eq!(info.committed, Some(true));
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
