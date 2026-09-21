//! Notifications — app-local, store-driven attention events. Port of the pure
//! half of `apps/mobile/src/core/notifications.ts`.
//!
//! NEVER event-sniff: every event is derived from state the phone core already
//! ingested through the typed protocol. The decision is a PURE function of
//! `(event, app visibility)` — a foregrounded app never posts an OS
//! notification (the UI is the notification). Sync catch-up never notifies:
//! only the LIVE output path calls [`classify_output_entry`].

use protocol::common::{OutputEntry, OutputEntryType};

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
/// event itself only carries machine/session keys. Both optional; formatting
/// falls back to the bare kind text when either is missing.
pub struct NotificationContext<'a> {
    pub session_label: Option<&'a str>,
    pub machine_label: Option<&'a str>,
}

impl NotificationContext<'_> {
    pub fn none() -> Self {
        Self {
            session_label: None,
            machine_label: None,
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
    let (title, body) = match event {
        NotifyEvent::PermissionRequest { tool_name, .. } => (
            titled("Permission needed"),
            match tool_name {
                Some(t) => on_machine(&format!("Claude wants to use {t}")),
                None => on_machine("Claude needs permission to proceed"),
            },
        ),
        NotifyEvent::Question { .. } => (
            titled("Question from Claude"),
            on_machine("Claude is asking you a question"),
        ),
        NotifyEvent::PlanApproval { .. } => (
            titled("Plan ready for review"),
            on_machine("A plan is waiting for your approval"),
        ),
        NotifyEvent::SessionFinished { .. } => (
            titled("Session finished"),
            on_machine("Claude finished the task"),
        ),
        NotifyEvent::SessionFailed { reason, .. } => (
            titled("Session failed"),
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

fn meta_str<'a>(entry: &'a OutputEntry, key: &str) -> Option<&'a str> {
    entry.metadata.as_ref()?.get(key)?.as_str()
}

/// Map ONE live output entry to a notify event, or `None`. Mirrors the
/// transcript renderer's special-card vocabulary — they must agree.
pub fn classify_output_entry(
    machine: &str,
    session_id: &str,
    entry: &OutputEntry,
) -> Option<NotifyEvent> {
    let special = meta_str(entry, "special");
    match entry.entry_type {
        OutputEntryType::System => match special {
            Some("permission_request") => Some(NotifyEvent::PermissionRequest {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
                tool_name: meta_str(entry, "tool_name").map(str::to_string),
            }),
            Some("ask_question") => Some(NotifyEvent::Question {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
            }),
            Some("plan_approval") => Some(NotifyEvent::PlanApproval {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
            }),
            None => {
                // Turn complete — `stream_end` is only ever set on live entries.
                let stream_end = entry
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("stream_end"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                stream_end.then(|| NotifyEvent::SessionFinished {
                    machine: machine.to_string(),
                    session_id: session_id.to_string(),
                })
            }
            _ => None,
        },
        OutputEntryType::Error => match special {
            Some("session_died") | Some("session_failed") => Some(NotifyEvent::SessionFailed {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
                reason: (!entry.content.is_empty()).then(|| entry.content.clone()),
            }),
            _ => None,
        },
        _ => None,
    }
}

/// CDX-053: does this live entry prove the agent is ACTIVELY WORKING? Only such
/// entries may auto-clear a session's unread dot. `System` / `Error` are turn
/// ARTIFACTS, not activity.
pub fn is_agent_activity_entry(entry: &OutputEntry) -> bool {
    matches!(
        entry.entry_type,
        OutputEntryType::Text
            | OutputEntryType::Thinking
            | OutputEntryType::ToolUse
            | OutputEntryType::ToolResult
            | OutputEntryType::Progress
            | OutputEntryType::Diff
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

impl NotificationCoordinator {
    pub fn with_cooldown(cooldown_ms: u64) -> Self {
        Self {
            cooldown_ms,
            ..Self::default()
        }
    }

    /// `enabled` false (CDX-048 master toggle) kills BOTH channels at the single
    /// seam — no notify, no ping, no cooldown slot burned. `ping_available`
    /// mirrors the TS `deps.ping !== undefined` (a build with no chime seam
    /// never wants a ping).
    pub fn emit(
        &mut self,
        event: &NotifyEvent,
        visible: bool,
        enabled: bool,
        ping_available: bool,
        active_session_key: Option<&str>,
        context: &NotificationContext,
        now: u64,
    ) -> Vec<NotifyEffect> {
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
                content: format_notify_event(event, context),
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
    fn entry(t: OutputEntryType, content: &str, meta: serde_json::Value) -> OutputEntry {
        OutputEntry {
            entry_type: t,
            content: content.into(),
            timestamp: "1970-01-01T00:00:00.000Z".into(),
            metadata: if meta.is_null() { None } else { Some(meta) },
            diff: None,
        }
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
            "Claude wants to use Bash"
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
        };
        let content = format_notify_event(&perm("m", "s"), &ctx);
        assert_eq!(content.title, "Permission needed — refactor-api");
        assert_eq!(content.body, "Claude needs permission to proceed on laptop-01");
        // No labels yet (unknown keys) — bare kind text, unchanged.
        let bare = format_notify_event(&perm("m", "s"), &NotificationContext::none());
        assert_eq!(bare.title, "Permission needed");
        assert_eq!(bare.body, "Claude needs permission to proceed");
    }

    #[test]
    fn classify_output_entry_maps_the_special_cards() {
        let c = |t, content, meta| classify_output_entry("m", "s", &entry(t, content, meta));
        assert_eq!(
            c(OutputEntryType::System, "", json!({ "special": "permission_request", "tool_name": "Edit" })),
            Some(NotifyEvent::PermissionRequest { machine: "m".into(), session_id: "s".into(), tool_name: Some("Edit".into()) })
        );
        assert_eq!(
            c(OutputEntryType::System, "", json!({ "special": "ask_question" })),
            Some(NotifyEvent::Question { machine: "m".into(), session_id: "s".into() })
        );
        assert_eq!(
            c(OutputEntryType::System, "", json!({ "special": "plan_approval" })),
            Some(NotifyEvent::PlanApproval { machine: "m".into(), session_id: "s".into() })
        );
        assert_eq!(
            c(OutputEntryType::System, "", json!({ "stream_end": true })),
            Some(NotifyEvent::SessionFinished { machine: "m".into(), session_id: "s".into() })
        );
        assert_eq!(
            c(OutputEntryType::Error, "it died", json!({ "special": "session_died" })),
            Some(NotifyEvent::SessionFailed { machine: "m".into(), session_id: "s".into(), reason: Some("it died".into()) })
        );
        // no-ops
        assert_eq!(c(OutputEntryType::System, "", json!({ "special": "some_status" })), None);
        assert_eq!(c(OutputEntryType::System, "", serde_json::Value::Null), None);
        assert_eq!(c(OutputEntryType::Text, "hello", serde_json::Value::Null), None);
        assert_eq!(c(OutputEntryType::Error, "", json!({ "special": "other" })), None);
    }

    #[test]
    fn agent_activity_excludes_artifacts() {
        for t in [
            OutputEntryType::Text,
            OutputEntryType::Thinking,
            OutputEntryType::ToolUse,
            OutputEntryType::ToolResult,
            OutputEntryType::Progress,
            OutputEntryType::Diff,
        ] {
            assert!(is_agent_activity_entry(&entry(t, "", serde_json::Value::Null)));
        }
        for t in [OutputEntryType::System, OutputEntryType::Error] {
            assert!(!is_agent_activity_entry(&entry(t, "", serde_json::Value::Null)));
        }
    }

    // --- coordinator ---

    #[test]
    fn master_toggle_off_kills_both_channels_and_burns_no_cooldown() {
        let mut co = NotificationCoordinator::default();
        assert!(co.emit(&perm("m", "s"), false, false, true, None, &NotificationContext::none(), 0).is_empty());
        // enabled again immediately: not blocked by a cooldown slot
        assert!(!co.emit(&perm("m", "s"), false, true, true, None, &NotificationContext::none(), 1).is_empty());
    }

    #[test]
    fn a_visible_user_watching_the_session_gets_nothing() {
        let mut co = NotificationCoordinator::default();
        assert!(co.emit(&perm("m", "s"), true, true, true, Some("m s"), &NotificationContext::none(), 0).is_empty());
    }

    #[test]
    fn ping_comes_before_notify_and_shares_one_cooldown() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), false, true, true, None, &NotificationContext::none(), 0);
        assert_eq!(eff.len(), 2);
        assert_eq!(eff[0], NotifyEffect::Ping);
        assert!(matches!(eff[1], NotifyEffect::Notify { .. }));

        // same key inside the window: nothing (the live path AND the heartbeat
        // path can both emit for one card — this is the double-fire guard).
        assert!(co.emit(&perm("m", "s"), false, true, true, None, &NotificationContext::none(), NOTIFY_COOLDOWN_MS - 1).is_empty());
        // window elapsed: fires again
        assert_eq!(co.emit(&perm("m", "s"), false, true, true, None, &NotificationContext::none(), NOTIFY_COOLDOWN_MS).len(), 2);
    }

    #[test]
    fn ping_only_when_the_os_notification_is_suppressed_but_the_user_is_elsewhere() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), true, true, true, Some("m other"), &NotificationContext::none(), 0);
        assert_eq!(eff, vec![NotifyEffect::Ping]);
    }

    #[test]
    fn no_ping_seam_means_no_ping_effect() {
        let mut co = NotificationCoordinator::default();
        let eff = co.emit(&perm("m", "s"), false, true, false, None, &NotificationContext::none(), 0);
        assert_eq!(eff.len(), 1);
        assert!(matches!(eff[0], NotifyEffect::Notify { .. }));
    }
}
