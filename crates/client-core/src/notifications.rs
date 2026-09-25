//! Notifications — app-local, store-driven attention events. Port of the pure
//! half of `apps/mobile/src/core/notifications.ts`.
//!
//! NEVER event-sniff: every event is derived from state the phone core already
//! ingested through the typed protocol. The decision is a PURE function of
//! `(event, app visibility)` — a foregrounded app never posts an OS
//! notification (the UI is the notification). Sync catch-up never notifies:
//! only the LIVE output path calls [`classify_output_entry`].

use protocol::common::{EntryBody, NoticeKind, OutputEntry};

// --- event vocabulary ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyEvent {
    PermissionRequest {
        machine: String,
        session_id: String,
        tool_name: Option<String>,
    },
    Question {
        machine: String,
        session_id: String,
    },
    PlanApproval {
        machine: String,
        session_id: String,
    },
    SessionFinished {
        machine: String,
        session_id: String,
    },
    SessionFailed {
        machine: String,
        session_id: String,
        reason: Option<String>,
    },
    DmReceived {
        peer: String,
        peer_label: Option<String>,
        preview: Option<String>,
    },
}

impl NotifyEvent {
    pub fn session(&self) -> Option<(&str, &str)> {
        match self {
            Self::PermissionRequest { machine, session_id, .. }
            | Self::Question { machine, session_id }
            | Self::PlanApproval { machine, session_id }
            | Self::SessionFinished { machine, session_id }
            | Self::SessionFailed { machine, session_id, .. } => Some((machine, session_id)),
            Self::DmReceived { .. } => None,
        }
    }

    /// Stable kind string — the platform Notifier routes delivery on it
    /// (Android: which notification channel).
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::PermissionRequest { .. } => "permission-request",
            Self::Question { .. } => "question",
            Self::PlanApproval { .. } => "plan-approval",
            Self::SessionFinished { .. } => "session-finished",
            Self::SessionFailed { .. } => "session-failed",
            Self::DmReceived { .. } => "dm-received",
        }
    }
}

/// Human labels resolved by the runtime from its stores at emit time — the
/// event itself only carries machine/session keys. All optional; formatting
/// falls back to the bare kind text when a label is missing.
pub struct NotificationContext<'a> {
    pub session_label: Option<&'a str>,
    pub machine_label: Option<&'a str>,
    /// Display name of the agent the session runs on (from the bridge's agent
    /// catalog), so the text names the agent that actually finished or asked.
    /// Absent (session or catalog not known yet) falls back to "the agent".
    pub agent_label: Option<&'a str>,
}

impl NotificationContext<'_> {
    pub fn none() -> Self {
        Self {
            session_label: None,
            machine_label: None,
            agent_label: None,
        }
    }
}

pub fn session_key_of(machine: &str, session_id: &str) -> String {
    format!("{machine} {session_id}")
}

/// Cooldown / dedup scope: same key + type within the window → one delivery.
pub fn notify_key(event: &NotifyEvent) -> String {
    match event {
        NotifyEvent::DmReceived { peer, .. } => format!("dm {peer}"),
        _ => {
            let (m, s) = event.session().unwrap();
            format!("{} {m} {s}", event.kind_str())
        }
    }
}

/// Parsed back by platform ports (Android turns it into a notification-tap
/// deep link): `:` cannot occur in a machine key (npub/hex) or session id,
/// so ports strip the prefix and split on the LAST colon unambiguously.
pub fn session_notify_tag(machine: &str, session_id: &str) -> String {
    format!("session:{machine}:{session_id}")
}
pub fn dm_notify_tag(peer: &str) -> String {
    format!("dm:{peer}")
}

/// Cancellation scope (CDX-026c) — coarser than [`notify_key`]: opening a
/// session clears EVERY delivered notification for it.
pub fn notify_tag(event: &NotifyEvent) -> String {
    match event {
        NotifyEvent::DmReceived { peer, .. } => dm_notify_tag(peer),
        _ => {
            let (m, s) = event.session().unwrap();
            session_notify_tag(m, s)
        }
    }
}

// --- pure decisions ---

/// A visible app never posts OS notifications; everything here already passed
/// its store-level gate, so `hidden → notify` for every type.
pub fn decide_notify(_event: &NotifyEvent, visible: bool) -> bool {
    !visible
}

/// The in-app chime: ping when hidden, OR when the user is viewing a DIFFERENT
/// session than the event's. A DM event always pings (it already passed the
/// per-conversation unread gate upstream).
pub fn decide_ping(event: &NotifyEvent, visible: bool, active_session_key: Option<&str>) -> bool {
    if !visible {
        return true;
    }
    match event.session() {
        None => true, // dm-received
        Some((m, s)) => Some(session_key_of(m, s).as_str()) != active_session_key,
    }
}

// --- formatting ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}

pub fn format_notify_event(event: &NotifyEvent, ctx: &NotificationContext) -> NotificationContent {
    // Session-scoped kinds title "{kind} — {session}" so a multi-session
    // phone can tell cards apart at a glance, and name the machine in the
    // body where it reads naturally. DMs already carry their own labels.
    let titled = |kind: &str| match ctx.session_label {
        Some(s) => format!("{kind} — {s}"),
        None => kind.to_string(),
    };
    let on_machine = |base: &str| match ctx.machine_label {
        Some(m) => format!("{base} on {m}"),
        None => base.to_string(),
    };
    // Who is acting, in body text, and which kind of session, in titles.
    // Sentence-initial and mid-sentence forms of the actor.
    let (agent, agent_mid) = match ctx.agent_label {
        Some(a) => (a, a),
        None => ("The agent", "the agent"),
    };
    let session_kind = |what: &str| match ctx.agent_label {
        Some(a) => format!("{a} session {what}"),
        None => format!("Session {what}"),
    };
    let (title, body) = match event {
        NotifyEvent::PermissionRequest { tool_name, .. } => (
            titled("Permission needed"),
            match tool_name {
                Some(t) => on_machine(&format!("{agent} wants to use {t}")),
                None => on_machine(&format!("{agent} needs permission to proceed")),
            },
        ),
        NotifyEvent::Question { .. } => (
            titled(&format!("Question from {agent_mid}")),
            on_machine(&format!("{agent} is asking you a question")),
        ),
        NotifyEvent::PlanApproval { .. } => (
            titled("Plan ready for review"),
            on_machine("A plan is waiting for your approval"),
        ),
        NotifyEvent::SessionFinished { .. } => (
            titled(&session_kind("finished")),
            on_machine(&format!("{agent} finished the task")),
        ),
        NotifyEvent::SessionFailed { reason, .. } => (
            titled(&session_kind("failed")),
            // Variable text — the machine name would read oddly after it.
            reason
                .clone()
                .unwrap_or_else(|| "The session ended with an error".to_string()),
        ),
        NotifyEvent::DmReceived { peer_label, preview, .. } => (
            peer_label.clone().unwrap_or_else(|| "New message".to_string()),
            preview
                .clone()
                .unwrap_or_else(|| "You received a direct message".to_string()),
        ),
    };
    NotificationContent { title, body }
}

// --- live-output entry classification ---

/// Map ONE live output entry to a notify event, or `None`. The entry kinds
/// that ask for the user, finish a turn, or end a session notify; everything
/// else is ordinary transcript.
pub fn classify_output_entry(
    machine: &str,
    session_id: &str,
    entry: &OutputEntry,
) -> Option<NotifyEvent> {
    let machine = machine.to_string();
    let session_id = session_id.to_string();
    match &entry.body {
        EntryBody::PermissionRequest { tool_name, .. } => Some(NotifyEvent::PermissionRequest {
            machine,
            session_id,
            tool_name: (!tool_name.is_empty()).then(|| tool_name.clone()),
        }),
        // One notification per ask, not per question of a multi-question ask.
        EntryBody::Question { index: 0, .. } => Some(NotifyEvent::Question { machine, session_id }),
        EntryBody::PlanApproval { .. } => Some(NotifyEvent::PlanApproval { machine, session_id }),
        EntryBody::TurnComplete {} => Some(NotifyEvent::SessionFinished { machine, session_id }),
        EntryBody::Notice {
            kind: NoticeKind::SessionDied | NoticeKind::SessionFailed,
            text,
        } => Some(NotifyEvent::SessionFailed {
            machine,
            session_id,
            reason: (!text.is_empty()).then(|| text.clone()),
        }),
        _ => None,
    }
}

/// CDX-053: does this live entry prove the agent is ACTIVELY WORKING? Only such
/// entries may auto-clear a session's unread dot. Status lines, errors,
/// notices and the cards that wait on the user are turn ARTIFACTS, not
/// activity.
pub fn is_agent_activity_entry(entry: &OutputEntry) -> bool {
    matches!(
        entry.body,
        EntryBody::Text { .. }
            | EntryBody::Plan { .. }
            | EntryBody::Thinking { .. }
            | EntryBody::ToolCall { .. }
            | EntryBody::ToolResult { .. }
            | EntryBody::Diff { .. }
    )
}

// --- coordinator ---

pub const NOTIFY_COOLDOWN_MS: u64 = 10_000;

/// What `emit` asks the runtime to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyEffect {
    /// Fire the in-app chime.
    Ping,
    /// Post an OS notification, filed under `tag` (CDX-026c cancellation scope).
    /// `kind` is `NotifyEvent::kind_str` — platform Notifiers route delivery
    /// (Android notification channels) on it.
    Notify {
        content: NotificationContent,
        tag: String,
        kind: String,
    },
}

/// Decision + shared cooldown for the ping/notify pair. The `visible` /
/// `enabled` / `active_session_key` / `now` inputs come from the runtime; the
/// `Notifier` / ping seams are the emitted effects.
#[derive(Debug, Clone)]
pub struct NotificationCoordinator {
    recent: std::collections::BTreeMap<String, u64>,
    cooldown_ms: u64,
}

impl Default for NotificationCoordinator {
    fn default() -> Self {
        Self {
            recent: std::collections::BTreeMap::new(),
            cooldown_ms: NOTIFY_COOLDOWN_MS,
        }
    }
}

/// Everything [`NotificationCoordinator::emit`] needs besides the event
/// itself — grouped so call sites name their booleans instead of listing
/// eight positional arguments.
pub struct EmitInputs<'a> {
    pub visible: bool,
    /// `enabled` false (CDX-048 master toggle) kills BOTH channels at the
    /// single seam — no notify, no ping, no cooldown slot burned.
    pub enabled: bool,
    /// Mirrors the TS `deps.ping !== undefined` (a build with no chime seam
    /// never wants a ping).
    pub ping_available: bool,
    pub active_session_key: Option<&'a str>,
    pub context: NotificationContext<'a>,
    pub now: u64,
}

impl NotificationCoordinator {
    pub fn with_cooldown(cooldown_ms: u64) -> Self {
        Self {
            cooldown_ms,
            ..Self::default()
        }
    }

    pub fn emit(&mut self, event: &NotifyEvent, inputs: EmitInputs<'_>) -> Vec<NotifyEffect> {
        let EmitInputs {
            visible,
            enabled,
            ping_available,
            active_session_key,
            context,
            now,
        } = inputs;
        if !enabled {
            return vec![];
        }
        let want_notify = decide_notify(event, visible);
        let want_ping = ping_available && decide_ping(event, visible, active_session_key);
        if !want_notify && !want_ping {
            return vec![];
        }

        let key = notify_key(event);
        if let Some(&last) = self.recent.get(&key) {
            if now.saturating_sub(last) < self.cooldown_ms {
                return vec![];
            }
        }
        self.recent.insert(key, now);
        if self.recent.len() > 64 {
            self.recent
                .retain(|_, &mut t| now.saturating_sub(t) < self.cooldown_ms);
        }

        let mut effects = Vec::new();
        // Ping BEFORE notify — the chime must fire regardless of OS delivery.
        if want_ping {
            effects.push(NotifyEffect::Ping);
        }
        if want_notify {
            effects.push(NotifyEffect::Notify {
                content: format_notify_event(event, &context),
                tag: notify_tag(event),
                kind: event.kind_str().to_string(),
            });
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Common EmitInputs for the coordinator tests — `EmitInputs { field: x,
    /// ..inputs(...) }` overrides single fields at the call site.
    fn inputs(visible: bool, enabled: bool, ping_available: bool) -> EmitInputs<'static> {
        EmitInputs {
            visible,
            enabled,
            ping_available,
            active_session_key: None,
            context: NotificationContext::none(),
            now: 0,
        }
    }

    fn perm(m: &str, s: &str) -> NotifyEvent {
        NotifyEvent::PermissionRequest {
            machine: m.into(),
            session_id: s.into(),
            tool_name: None,
        }
    }
    fn dm(peer: &str) -> NotifyEvent {
        NotifyEvent::DmReceived {
            peer: peer.into(),
            peer_label: None,
            preview: None,
        }
    }
    fn entry(body: EntryBody) -> OutputEntry {
        OutputEntry::new("1970-01-01T00:00:00.000Z", body)
    }

    #[test]
    fn decide_notify_is_just_hidden() {
        assert!(decide_notify(&perm("m", "s"), false));
        assert!(!decide_notify(&perm("m", "s"), true));
        assert!(decide_notify(&dm("p"), false));
    }

    #[test]
    fn decide_ping_matrix() {
        // hidden -> always
        assert!(decide_ping(&perm("m", "s"), false, Some("m s")));
        // visible + viewing this session -> no
        assert!(!decide_ping(&perm("m", "s"), true, Some("m s")));
        // visible + viewing a different session -> yes
        assert!(decide_ping(&perm("m", "s"), true, Some("m other")));
        // visible + no session panel -> yes
        assert!(decide_ping(&perm("m", "s"), true, None));
        // dm -> always pings when it reaches here
        assert!(decide_ping(&dm("p"), true, Some("m s")));
    }

    #[test]
    fn keys_and_tags() {
        assert_eq!(notify_key(&perm("m", "s")), "permission-request m s");
        assert_eq!(notify_key(&dm("p")), "dm p");
        assert_eq!(notify_tag(&perm("m", "s")), "session:m:s");
        assert_eq!(notify_tag(&dm("p")), "dm:p");
    }

    #[test]
    fn formatting_covers_every_variant() {
        assert_eq!(format_notify_event(&perm("m", "s"), &NotificationContext::none()).title, "Permission needed");
        assert_eq!(
            format_notify_event(&NotifyEvent::PermissionRequest {
                machine: "m".into(),
                session_id: "s".into(),
                tool_name: Some("Bash".into())
            }, &NotificationContext::none())
            .body,
            "The agent wants to use Bash"
        );
        assert_eq!(
            format_notify_event(&NotifyEvent::SessionFailed {
                machine: "m".into(),
                session_id: "s".into(),
                reason: Some("boom".into())
            }, &NotificationContext::none())
            .body,
            "boom"
        );
        assert_eq!(
            format_notify_event(&NotifyEvent::DmReceived {
                peer: "p".into(),
                peer_label: Some("Alice".into()),
                preview: Some("hi".into())
            }, &NotificationContext::none()),
            NotificationContent { title: "Alice".into(), body: "hi".into() }
        );
    }

    #[test]
    fn formatting_uses_the_runtime_resolved_labels() {
        let ctx = NotificationContext {
            session_label: Some("refactor-api"),
            machine_label: Some("laptop-01"),
            agent_label: Some("Claude Code"),
        };
        let content = format_notify_event(&perm("m", "s"), &ctx);
        assert_eq!(content.title, "Permission needed — refactor-api");
        assert_eq!(content.body, "Claude Code needs permission to proceed on laptop-01");
        // No labels yet (unknown keys) — bare kind text, unchanged.
        let bare = format_notify_event(&perm("m", "s"), &NotificationContext::none());
        assert_eq!(bare.title, "Permission needed");
        assert_eq!(bare.body, "The agent needs permission to proceed");
    }

    #[test]
    fn formatting_names_the_sessions_agent() {
        let finished = NotifyEvent::SessionFinished { machine: "m".into(), session_id: "s".into() };
        let question = NotifyEvent::Question { machine: "m".into(), session_id: "s".into() };
        let failed = NotifyEvent::SessionFailed { machine: "m".into(), session_id: "s".into(), reason: None };
        let ctx = |agent| NotificationContext {
            session_label: Some("fix-ci"),
            machine_label: Some("laptop-01"),
            agent_label: Some(agent),
        };

        let open_code = ctx("OpenCode");
        assert_eq!(
            format_notify_event(&finished, &open_code),
            NotificationContent {
                title: "OpenCode session finished — fix-ci".into(),
                body: "OpenCode finished the task on laptop-01".into(),
            }
        );
        assert_eq!(format_notify_event(&question, &open_code).title, "Question from OpenCode — fix-ci");
        assert_eq!(format_notify_event(&failed, &open_code).title, "OpenCode session failed — fix-ci");

        let claude_code = ctx("Claude Code");
        assert_eq!(
            format_notify_event(&finished, &claude_code),
            NotificationContent {
                title: "Claude Code session finished — fix-ci".into(),
                body: "Claude Code finished the task on laptop-01".into(),
            }
        );

        // Session not in the store yet — the generic wording.
        let bare = format_notify_event(&finished, &NotificationContext::none());
        assert_eq!(bare.title, "Session finished");
        assert_eq!(bare.body, "The agent finished the task");
        assert_eq!(
            format_notify_event(&question, &NotificationContext::none()).title,
            "Question from the agent"
        );
    }

    fn body(v: serde_json::Value) -> EntryBody {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn classify_output_entry_maps_the_cards_that_want_the_user() {
        let c = |b| classify_output_entry("m", "s", &entry(body(b)));
        assert_eq!(
            c(json!({"entryType":"permission_request","requestId":"r","toolName":"Edit","kind":"edit","title":"a.rs","options":[]})),
            Some(NotifyEvent::PermissionRequest { machine: "m".into(), session_id: "s".into(), tool_name: Some("Edit".into()) })
        );
        assert_eq!(
            c(json!({"entryType":"question","requestId":"q","index":0,"count":2,"question":"?"})),
            Some(NotifyEvent::Question { machine: "m".into(), session_id: "s".into() })
        );
        // later questions of the same ask do not notify again
        assert_eq!(c(json!({"entryType":"question","requestId":"q","index":1,"count":2,"question":"?"})), None);
        assert_eq!(
            c(json!({"entryType":"plan_approval","requestId":"p","options":[]})),
            Some(NotifyEvent::PlanApproval { machine: "m".into(), session_id: "s".into() })
        );
        assert_eq!(
            c(json!({"entryType":"turn_complete"})),
            Some(NotifyEvent::SessionFinished { machine: "m".into(), session_id: "s".into() })
        );
        assert_eq!(
            c(json!({"entryType":"notice","kind":"session_died","text":"it died"})),
            Some(NotifyEvent::SessionFailed { machine: "m".into(), session_id: "s".into(), reason: Some("it died".into()) })
        );
        // no-ops
        assert_eq!(c(json!({"entryType":"notice","kind":"session_restart","text":"x"})), None);
        assert_eq!(c(json!({"entryType":"status","text":"compacting"})), None);
        assert_eq!(c(json!({"entryType":"text","role":"agent","text":"hello"})), None);
        assert_eq!(c(json!({"entryType":"error","text":"boom"})), None);
    }

    #[test]
    fn agent_activity_excludes_artifacts() {
        for b in [
            json!({"entryType":"text","role":"agent","text":"x"}),
            json!({"entryType":"plan","text":"x"}),
            json!({"entryType":"thinking","text":"x"}),
            json!({"entryType":"tool_call","callId":"c","toolName":"Read","kind":"read","title":"a"}),
            json!({"entryType":"tool_result","callId":"c","text":"x"}),
            json!({"entryType":"diff","path":"a","lines":[]}),
        ] {
            assert!(is_agent_activity_entry(&entry(body(b.clone()))), "{b}");
        }
        for b in [
            json!({"entryType":"status","text":"x"}),
            json!({"entryType":"error","text":"x"}),
            json!({"entryType":"turn_complete"}),
            json!({"entryType":"resolved","requestId":"r","summary":"ok"}),
            json!({"entryType":"permission_request","requestId":"r","toolName":"Edit","kind":"edit","title":"a","options":[]}),
        ] {
            assert!(!is_agent_activity_entry(&entry(body(b.clone()))), "{b}");
        }
    }

    // --- coordinator ---

    #[test]
    fn master_toggle_off_kills_both_channels_and_burns_no_cooldown() {
        let mut co = NotificationCoordinator::default();
        assert!(co.emit(&perm("m", "s"), inputs(false, false, true)).is_empty());
        // enabled again immediately: not blocked by a cooldown slot
        assert!(!co.emit(&perm("m", "s"), EmitInputs { now: 1, ..inputs(false, true, true) }).is_empty());
    }

    #[test]
    fn a_visible_user_watching_the_session_gets_nothing() {
        let mut co = NotificationCoordinator::default();
        assert!(co.emit(&perm("m", "s"), EmitInputs { visible: true, active_session_key: Some("m s"), ..inputs(true, true, true) }).is_empty());
    }

    #[test]
    fn ping_comes_before_notify_and_shares_one_cooldown() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), inputs(false, true, true));
        assert_eq!(eff.len(), 2);
        assert_eq!(eff[0], NotifyEffect::Ping);
        assert!(matches!(eff[1], NotifyEffect::Notify { .. }));

        // same key inside the window: nothing (the live path AND the heartbeat
        // path can both emit for one card — this is the double-fire guard).
        assert!(co.emit(&perm("m", "s"), EmitInputs { now: NOTIFY_COOLDOWN_MS - 1, ..inputs(false, true, true) }).is_empty());
        // window elapsed: fires again
        assert_eq!(co.emit(&perm("m", "s"), EmitInputs { now: NOTIFY_COOLDOWN_MS, ..inputs(false, true, true) }).len(), 2);
    }

    #[test]
    fn ping_only_when_the_os_notification_is_suppressed_but_the_user_is_elsewhere() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), EmitInputs { active_session_key: Some("m other"), ..inputs(true, true, true) });
        assert_eq!(eff, vec![NotifyEffect::Ping]);
    }

    #[test]
    fn no_ping_seam_means_no_ping_effect() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), inputs(false, true, false));
        assert_eq!(eff.len(), 1);
        assert!(matches!(eff[0], NotifyEffect::Notify { .. }));
    }
}
