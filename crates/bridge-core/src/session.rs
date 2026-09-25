//! One session's state, and the agent-neutral rules applied to what flows
//! through it.
//!
//! A session is its persisted [`SessionRecord`] plus, while it runs, a
//! [`Runner`]: where it is in its life, the cards waiting on the user, and
//! the bookkeeping for its input and output. The agent itself runs in the
//! agent host; a runner only mirrors it.

use std::collections::{BTreeMap, VecDeque};
use std::sync::OnceLock;

use agent_protocol::{QuestionSpec, TurnState};
use protocol::common::{OptionChoice, PermissionOption, PermissionOptionKind, SessionState};
use regex::Regex;

use crate::io::TimerId;
use crate::registry::SessionRecord;

/// Restarts a session gets after its agent dies before it is ended.
pub const MAX_RESTARTS: u32 = 2;

/// Appended to the first ordinary message of a session: asks the agent to
/// name the task so the phone can title the session.
pub const META_REQUEST: &str = "\n\n<!-- emit-session-meta: In your response, include exactly one HTML comment: <!-- session-meta: {\"topic\": \"<2-4 word task summary>\", \"project\": \"<project name>\"} --> -->";

/// How many sent messages are remembered for echo suppression.
const AUTHORED_CAP: usize = 16;

pub(crate) struct Session {
    pub rec: SessionRecord,
    /// The phone knows this session: it became ready once. Only listed
    /// sessions are persisted and appear in the heartbeat.
    pub listed: bool,
    /// Present while the session runs (or waits to be restarted).
    pub run: Option<Runner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Created from the phone; not confirmed by the agent yet.
    Pending,
    Ready,
}

/// Why a session is being started — decides whether to resume and what a
/// failure is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartKind {
    /// A new session from the phone: a fresh conversation.
    Create,
    /// A session from the registry after the bridge started.
    Resume,
    /// Its agent died and it is being brought back.
    Restart,
}

pub(crate) struct Runner {
    pub phase: Phase,
    pub start_kind: StartKind,
    /// The agent host has been asked to run it. False while the host is down.
    pub started: bool,
    pub restarts: u32,
    pub turn: TurnState,
    /// Cards waiting on the user, by request id.
    pub cards: BTreeMap<String, Card>,
    pub card_seq: u64,
    /// Input that arrived while the host was down, sent once it is back.
    pub queued: Vec<String>,
    /// Messages sent to the agent, for dropping its echo of them.
    pub authored: VecDeque<String>,
    pub meta_requested: bool,
    /// The session-meta tag has been read once; later ones are only stripped.
    pub summarized: bool,
    /// git HEAD when the session started; a different HEAD later = a commit.
    pub base_head: Option<String>,
}

impl Runner {
    pub fn new(phase: Phase, start_kind: StartKind, titled: bool) -> Self {
        Self {
            phase,
            start_kind,
            started: false,
            restarts: 0,
            turn: TurnState::Idle,
            cards: BTreeMap::new(),
            card_seq: 0,
            queued: Vec::new(),
            authored: VecDeque::new(),
            meta_requested: titled,
            summarized: titled,
            base_head: None,
        }
    }

    pub fn remember_authored(&mut self, text: &str) {
        self.authored.push_back(text.to_string());
        while self.authored.len() > AUTHORED_CAP {
            self.authored.pop_front();
        }
    }

    /// True (and forgotten) when `text` is the echo of a message we sent.
    /// Each echo consumes one remembered send, so two identical messages
    /// still give two entries.
    pub fn take_echo(&mut self, text: &str) -> bool {
        match self.authored.iter().position(|t| t == text) {
            Some(i) => {
                self.authored.remove(i);
                true
            }
            None => false,
        }
    }

    pub fn waiting_permission(&self) -> bool {
        self.cards.values().any(|c| !matches!(c.kind, CardKind::Question { .. }))
    }

    pub fn waiting_question(&self) -> bool {
        self.cards.values().any(|c| matches!(c.kind, CardKind::Question { .. }))
    }

    /// The most recently asked pending question — the one the phone shows.
    pub fn active_question(&self) -> Option<String> {
        self.cards
            .iter()
            .filter(|(_, c)| matches!(c.kind, CardKind::Question { .. }))
            .max_by_key(|(_, c)| c.order)
            .map(|(id, _)| id.clone())
    }
}

impl Session {
    pub fn state(&self, offline: bool) -> SessionState {
        if offline {
            return SessionState::Offline;
        }
        match &self.run {
            None => SessionState::Idle,
            Some(r) if r.waiting_permission() => SessionState::WaitingPermission,
            Some(r) if r.waiting_question() => SessionState::WaitingQuestion,
            Some(r) => match r.turn {
                TurnState::Running => SessionState::Running,
                TurnState::Idle => SessionState::Idle,
            },
        }
    }
}

/// A host request waiting on the user.
pub(crate) struct Card {
    /// The host frame id to answer.
    pub host_id: String,
    pub kind: CardKind,
    pub timer: TimerId,
    /// Arrival order within the session.
    pub order: u64,
}

pub(crate) enum CardKind {
    Permission { options: Vec<PermissionOption> },
    Plan { options: Vec<OptionChoice> },
    Question { questions: Vec<QuestionSpec>, answers: BTreeMap<u32, String> },
}

/// How a chosen permission option reads in the transcript.
pub fn permission_summary(kind: PermissionOptionKind) -> &'static str {
    match kind {
        PermissionOptionKind::AllowOnce => "Allowed",
        PermissionOptionKind::AllowAlways => "Always allowed",
        PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways => "Denied",
    }
}

/// The answer text for chosen option indices: their labels joined with
/// ", ". None when an index is out of range or nothing was chosen.
pub fn option_answer(question: &QuestionSpec, selected: &[u32]) -> Option<String> {
    let labels: Option<Vec<&str>> = selected
        .iter()
        .map(|&i| question.options.get(i as usize).map(|o| o.label.as_str()))
        .collect();
    labels.filter(|l| !l.is_empty()).map(|l| l.join(", "))
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// A slash command: the agent takes everything after its name as the
/// command's arguments, so nothing may be appended to it.
pub fn is_slash_command(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"^/[A-Za-z][\w:-]*(\s|$)").is_match(text)
}

/// A session title from the first usable message, or None when the message
/// is not one (empty, bracketed tooling text, an interruption marker).
pub fn title_from(text: &str) -> Option<String> {
    let cleaned = text.replace('\n', " ");
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned.starts_with('[') || cleaned.starts_with("Request interrupted") {
        return None;
    }
    Some(if cleaned.chars().count() > 80 {
        format!("{}...", cleaned.chars().take(77).collect::<String>())
    } else {
        cleaned.to_string()
    })
}

/// The topic and project a session-meta tag names.
#[derive(Debug, PartialEq, Eq)]
pub struct SessionMeta {
    pub topic: Option<String>,
    pub project: Option<String>,
}

/// Remove every session-meta tag from agent text; also return the first
/// tag's contents when it parses. Agents repeat the tag on later turns
/// unprompted, so stripping always applies.
pub fn strip_session_meta(text: &str) -> (String, Option<SessionMeta>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = regex(&RE, r"<!--\s*session-meta:\s*(\{[^}]+\})\s*-->");
    let Some(caps) = re.captures(text) else { return (text.to_string(), None) };
    let meta = serde_json::from_str::<serde_json::Value>(&caps[1]).ok().map(|v| {
        let field = |k: &str| {
            v.get(k)
                .filter(|x| !x.is_null() && x.as_str() != Some(""))
                .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string).chars().take(40).collect())
        };
        SessionMeta { topic: field("topic"), project: field("project") }
    });
    (re.replace_all(text, "").trim().to_string(), meta)
}

/// Whether a shell command runs `git commit` (not just its help).
pub fn runs_git_commit(command: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"\bgit\s+commit\b(\s+--help)?")
        .captures_iter(command)
        .any(|c| c.get(1).is_none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::QuestionOption;

    #[test]
    fn slash_commands_are_recognized() {
        assert!(is_slash_command("/compact"));
        assert!(is_slash_command("/gsd:plan-phase 3"));
        assert!(!is_slash_command("/ path"));
        assert!(!is_slash_command("please /compact"));
        assert!(!is_slash_command("/etc/hosts is broken"));
    }

    #[test]
    fn titles_come_from_the_first_usable_message() {
        assert_eq!(title_from("fix\nthe build").as_deref(), Some("fix the build"));
        assert_eq!(title_from("  "), None);
        assert_eq!(title_from("[Image: a.png]"), None);
        assert_eq!(title_from("Request interrupted by user"), None);
        let long = "x".repeat(100);
        assert_eq!(title_from(&long).unwrap().chars().count(), 80);
    }

    #[test]
    fn the_meta_tag_is_parsed_once_and_always_stripped() {
        let (text, meta) =
            strip_session_meta("Done.\n<!-- session-meta: {\"topic\": \"Fix login\", \"project\": \"web\"} -->");
        assert_eq!(text, "Done.");
        assert_eq!(meta, Some(SessionMeta { topic: Some("Fix login".into()), project: Some("web".into()) }));

        let (text, meta) = strip_session_meta("<!-- session-meta: {broken} --> ok");
        assert_eq!((text.as_str(), meta), ("ok", None));
        assert_eq!(strip_session_meta("plain").0, "plain");
    }

    #[test]
    fn git_commit_detection_ignores_help() {
        assert!(runs_git_commit("git add . && git commit -m 'x'"));
        assert!(!runs_git_commit("git commit --help"));
        assert!(runs_git_commit("git commit --help; git commit -am y"));
        assert!(!runs_git_commit("git committed"));
    }

    #[test]
    fn option_answers_join_labels() {
        let q = QuestionSpec {
            header: None,
            question: "Which?".into(),
            options: vec![QuestionOption { label: "Red".into(), description: None }, QuestionOption { label: "Blue".into(), description: None }],
            multi_select: true,
        };
        assert_eq!(option_answer(&q, &[1, 0]).as_deref(), Some("Blue, Red"));
        assert_eq!(option_answer(&q, &[2]), None);
        assert_eq!(option_answer(&q, &[]), None);
    }

    #[test]
    fn echoes_consume_one_send_each() {
        let mut r = Runner::new(Phase::Ready, StartKind::Create, false);
        r.remember_authored("hi");
        r.remember_authored("hi");
        assert!(r.take_echo("hi"));
        assert!(r.take_echo("hi"));
        assert!(!r.take_echo("hi"));
    }
}
