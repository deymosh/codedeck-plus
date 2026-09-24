//! Shared wire building blocks — types referenced by both command and event
//! messages.
//!
//! v11 is agent-neutral: nothing here names a particular coding agent. What an
//! agent can do (its modes, effort levels, credentials, optional features) is
//! DATA the bridge advertises per agent ([`AgentDescriptor`]); what a session
//! produced is a typed [`OutputEntry`] whose [`EntryBody`] variant says what it
//! is, instead of a loose metadata record interpreted by convention. An
//! unknown enum value is a decode error.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}

// --- agents ---

/// One selectable value of a per-agent option (a mode, an effort level, a
/// plan-approval choice). `id` is what rides the wire; `label` is for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OptionChoice {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Optional features an agent supports. A client offers a feature only when
/// the session's agent advertises it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSupports {
    /// `models-request` returns a live model list for this agent.
    #[serde(default)]
    pub models: bool,
    /// `usage-request` returns subscription usage for this agent's sessions.
    #[serde(default)]
    pub usage: bool,
    /// Sessions may be bound to a custom provider profile (`providerId`).
    #[serde(default)]
    pub providers: bool,
    /// `gsd-request` returns GSD workflow state for this agent's sessions.
    #[serde(default)]
    pub gsd: bool,
    /// `interrupt` stops the running turn.
    #[serde(default)]
    pub interrupt: bool,
}

/// A credential the bridge holds for an agent (or for itself), by id. The
/// secret never rides bridge→phone; only whether it is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub id: String,
    pub label: String,
    /// Set — by the phone or by the bridge's own environment.
    pub present: bool,
    /// Present only because the bridge's environment provides it (the phone
    /// cannot clear it).
    #[serde(default, skip_serializing_if = "is_false")]
    pub from_env: bool,
    /// The bridge checked the stored value against the provider; absent when
    /// it was not checked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid: Option<bool>,
}

/// An agent backend a bridge can run sessions on, advertised in the session
/// list heartbeat. Clients build their pickers from this rather than from
/// hardcoded lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    /// Stable id, e.g. `"claude-code"`, `"opencode"`.
    pub id: String,
    pub display_name: String,
    /// Permission / operating modes, in picker order. Empty = the agent has
    /// no switchable mode.
    #[serde(default)]
    pub modes: Vec<OptionChoice>,
    /// Reasoning-effort levels, in picker order. Empty = not configurable.
    #[serde(default)]
    pub efforts: Vec<OptionChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    #[serde(default)]
    pub supports: AgentSupports,
    /// Credentials this agent can use, with their current status.
    #[serde(default)]
    pub credentials: Vec<CredentialStatus>,
}

// --- sessions ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    WaitingPermission,
    WaitingQuestion,
    /// Set on every session when the bridge shuts down cleanly.
    Offline,
}

/// The per-session options `set-option` changes and `option-confirmed`
/// reports. Values are agent-defined strings (see [`AgentDescriptor`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SessionOption {
    Mode,
    Effort,
    Model,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub id: String,
    /// The [`AgentDescriptor::id`] this session runs on.
    pub agent: String,
    pub slug: String,
    pub cwd: String,
    pub last_activity: String,
    #[specta(type = specta_typescript::Number)]
    pub line_count: u64,
    /// nullable (always present on the wire, may be `null`).
    pub title: Option<String>,
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
    /// Highest transcript seq the bridge has persisted for this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub seq_high: Option<u64>,
    /// Bound custom provider profile (absent = the agent's own provider).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_label: Option<String>,
}

// --- provider base URL rule (CDX-071) ---

/// The message BOTH ends show when a base URL is rejected.
pub const PROVIDER_BASE_URL_ERROR: &str =
    "Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])";

/// Is `raw` an acceptable custom-provider base URL? https anywhere, or http
/// ONLY on loopback (`localhost` / `127.0.0.1` / `::1` / `[::1]`, matched
/// exactly). A local model server has no cert and its traffic never leaves the
/// machine; anything else is a network hop carrying a bearer token.
pub fn is_valid_provider_base_url(raw: &str) -> bool {
    // Minimal scheme+host split — no url crate (protocol package stays dep-light).
    let rest = match raw.split_once("://") {
        Some((scheme, rest)) => match scheme.to_ascii_lowercase().as_str() {
            "https" => return !rest.is_empty(),
            "http" => rest,
            _ => return false,
        },
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // strip userinfo, then split host[:port]
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        // IPv6 literal: [::1]:port or [::1]
        match stripped.split_once(']') {
            Some((h, _)) => return matches!(h.to_ascii_lowercase().as_str(), "::1"),
            None => return false,
        }
    } else {
        host_port.rsplit_once(':').map_or(host_port, |(h, _)| h)
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// The REDACTED wire shape of a stored provider profile (`hasToken` only — the
/// token itself never rides bridge→phone). CDX-071: `baseUrl` stays a bare
/// non-empty string on read so a pre-gate cleartext profile is still listable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileInfo {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<ProviderModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub has_token: bool,
}

// --- transcript entries ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineType {
    Add,
    Del,
    Context,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub kind: DiffLineType,
    pub text: String,
}

/// Who wrote a text entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
}

/// What a tool call does, normalized across agents (the Agent Client
/// Protocol's tool kinds). Clients pick icons and summaries from this rather
/// than from agent-specific tool names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

/// What choosing a permission option does — lets a client style and order
/// the choices without knowing the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Session lifecycle notices a client shows as a marker line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// The agent process was restarted; the conversation may continue fresh.
    SessionRestart,
    /// The agent process died unexpectedly.
    SessionDied,
    /// The session could not start or continue.
    SessionFailed,
    /// The agent rejected its credentials.
    AuthError,
    /// A device screenshot was delivered (test sessions).
    Screenshot,
}

/// What a transcript entry is. Tagged by `entryType`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "entryType",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EntryBody {
    /// Conversation text. Agent text written alongside tool calls may set
    /// `collapsible`, letting a client fold it into the tool group.
    Text {
        role: Role,
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        collapsible: bool,
    },
    /// A plan the agent proposes (rendered as markdown, never collapsed).
    Plan { text: String },
    /// Model reasoning. `redacted` = the provider withheld the content.
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        redacted: bool,
    },
    ToolCall {
        call_id: String,
        /// The agent's own tool name (display only — clients branch on `kind`).
        tool_name: String,
        kind: ToolKind,
        /// One-line human summary, e.g. `npm test` or `src/main.rs`.
        title: String,
        /// Files or paths the call touches.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        locations: Vec<String>,
        /// The agent's raw tool input, for detailed rendering.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(type = Option<specta_typescript::Unknown>)]
        raw_input: Option<serde_json::Value>,
    },
    ToolResult {
        call_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
    /// A file change, as add/del/context lines.
    Diff {
        path: String,
        lines: Vec<DiffLine>,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
    },
    /// The agent is waiting for the user to allow or deny a tool call.
    /// Answered with `permission-response` using one of `options`.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        kind: ToolKind,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        locations: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(type = Option<specta_typescript::Unknown>)]
        raw_input: Option<serde_json::Value>,
        options: Vec<PermissionOption>,
    },
    /// One question of a (possibly multi-question) ask, all sharing
    /// `request_id`. Answered with `question-response`.
    Question {
        request_id: String,
        #[specta(type = specta_typescript::Number)]
        index: u32,
        #[specta(type = specta_typescript::Number)]
        count: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        question: String,
        #[serde(default)]
        options: Vec<QuestionOption>,
        #[serde(default, skip_serializing_if = "is_false")]
        multi_select: bool,
    },
    /// The agent finished planning and asks how to proceed. Answered with
    /// `plan-response` using one of `options`.
    PlanApproval {
        request_id: String,
        options: Vec<OptionChoice>,
    },
    /// A permission request, question or plan approval was answered (or
    /// cancelled); `summary` is a short human description of the outcome.
    Resolved { request_id: String, summary: String },
    Notice { kind: NoticeKind, text: String },
    /// A one-line status message from the bridge or agent.
    Status { text: String },
    Error { text: String },
    /// The agent's turn ended; it is waiting for input.
    TurnComplete {},
}

/// Identifies the sub-agent that produced an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Subagent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One transcript entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub timestamp: String,
    #[serde(flatten)]
    pub body: EntryBody,
    /// Set when a sub-agent (not the session's main agent) produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
    /// Agent-specific data no client depends on — the one sanctioned escape
    /// hatch; anything a client renders belongs in a typed field instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub agent_extras: Option<serde_json::Value>,
}

impl OutputEntry {
    pub fn new(timestamp: impl Into<String>, body: EntryBody) -> Self {
        Self {
            timestamp: timestamp.into(),
            body,
            subagent: None,
            agent_extras: None,
        }
    }
}

// --- usage ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// e.g. "5h", "7d", "7d Opus".
    pub label: String,
    /// 0–100.
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub available: bool,
    /// Subscription / plan name, when the agent's provider reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_cost_usd: Option<f64>,
    pub fetched_at: String,
}

/// Credential writes by id: a string sets it, `null` clears it, an absent
/// id is left unchanged.
pub type CredentialValues = BTreeMap<String, Option<String>>;

// --- GSD workflow state ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdPhase {
    pub number: String,
    pub name: String,
    pub disk_status: String,
    #[specta(type = specta_typescript::Number)]
    pub plans: u64,
    #[specta(type = specta_typescript::Number)]
    pub summaries: u64,
    pub recently_touched: bool,
    pub action: Option<String>,
    pub command: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub plan_count: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub needs_you: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdExecution {
    pub phase: String,
    #[specta(type = specta_typescript::Number)]
    pub plans_total: u64,
    #[specta(type = specta_typescript::Number)]
    pub plans_done: u64,
    pub current_plan: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub tasks_done: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub tasks_total: Option<i64>,
    pub last_task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct GsdAction {
    pub id: String,
    pub label: String,
    pub command: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdState {
    pub installed: bool,
    pub available: bool,
    pub has_git: bool,
    pub situation: String,
    pub summary: String,
    pub milestone: Option<String>,
    pub current_phase: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub total_phases: Option<i64>,
    pub percent: f64,
    pub phases: Vec<GsdPhase>,
    pub actions: Vec<GsdAction>,
    pub recommended: Option<String>,
    pub paused: bool,
    pub blockers: Vec<String>,
    pub verify_failed: bool,
    pub execution: Option<GsdExecution>,
}

// --- Device / mesh config ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceRole {
    Controller,
    TestTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AppUnderTest {
    Kubo,
    Veil,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfig {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<DeviceRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_pubkey: Option<String>,
    pub app_under_test: AppUnderTest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_build_cmd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry_rt(v: serde_json::Value) -> OutputEntry {
        let e: OutputEntry = serde_json::from_value(v.clone()).unwrap_or_else(|err| panic!("{v} -> {err}"));
        let back = serde_json::to_value(&e).unwrap();
        assert_eq!(back, v, "entries serialize back to the exact wire shape");
        e
    }

    #[test]
    fn enum_wire_values() {
        assert_eq!(serde_json::to_string(&SessionState::WaitingPermission).unwrap(), r#""waiting_permission""#);
        assert_eq!(serde_json::to_string(&DiffLineType::Del).unwrap(), r#""del""#);
        assert_eq!(serde_json::to_string(&DeviceRole::TestTarget).unwrap(), r#""test-target""#);
        assert_eq!(serde_json::to_string(&ToolKind::SwitchMode).unwrap(), r#""switch_mode""#);
        assert_eq!(serde_json::to_string(&PermissionOptionKind::AllowAlways).unwrap(), r#""allow_always""#);
        assert_eq!(serde_json::to_string(&SessionOption::Effort).unwrap(), r#""effort""#);
        assert_eq!(serde_json::to_string(&NoticeKind::AuthError).unwrap(), r#""auth_error""#);
    }

    #[test]
    fn unknown_enum_value_is_a_decode_error() {
        assert!(serde_json::from_str::<SessionState>(r#""paused""#).is_err());
        assert!(serde_json::from_str::<ToolKind>(r#""teleport""#).is_err());
    }

    #[test]
    fn provider_base_url_rule() {
        assert!(is_valid_provider_base_url("https://api.example.com/v1"));
        assert!(is_valid_provider_base_url("http://localhost:11434/v1"));
        assert!(is_valid_provider_base_url("http://127.0.0.1:1234"));
        assert!(is_valid_provider_base_url("http://[::1]:8080/v1"));
        assert!(!is_valid_provider_base_url("http://api.example.com"));
        assert!(!is_valid_provider_base_url("http://evil.localhost"));
        assert!(!is_valid_provider_base_url("http://0.0.0.0:1234"));
        assert!(!is_valid_provider_base_url("ftp://localhost"));
        assert!(!is_valid_provider_base_url("not a url"));
        assert!(!is_valid_provider_base_url("https://"));
    }

    #[test]
    fn remote_session_info_round_trip_minimal_and_full() {
        let minimal = r#"{"id":"s","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}"#;
        let v: RemoteSessionInfo = serde_json::from_str(minimal).unwrap();
        assert_eq!(v.title, None);
        assert_eq!(v.state, None);
        assert_eq!(serde_json::from_str::<RemoteSessionInfo>(&serde_json::to_string(&v).unwrap()).unwrap(), v);

        let full = json!({
            "id":"s","agent":"opencode","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":42,
            "title":"T","project":"p","mode":"plan","effort":"high",
            "model":"m","contextWindow":200000,"contextPercentage":37.5,"committed":true,
            "state":"running","seqHigh":917,"providerId":"pid","providerLabel":"Prov"
        });
        let v: RemoteSessionInfo = serde_json::from_value(full).unwrap();
        assert_eq!(v.mode.as_deref(), Some("plan"));
        assert_eq!(v.seq_high, Some(917));
        assert_eq!(v.agent, "opencode");
    }

    #[test]
    fn a_session_must_name_its_agent() {
        let no_agent = r#"{"id":"s","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}"#;
        assert!(serde_json::from_str::<RemoteSessionInfo>(no_agent).is_err());
    }

    #[test]
    fn every_entry_body_round_trips_its_exact_wire_shape() {
        entry_rt(json!({"timestamp":"t","entryType":"text","role":"user","text":"hi"}));
        entry_rt(json!({"timestamp":"t","entryType":"text","role":"agent","text":"on it","collapsible":true}));
        entry_rt(json!({"timestamp":"t","entryType":"plan","text":"1. do x"}));
        entry_rt(json!({"timestamp":"t","entryType":"thinking","text":"","redacted":true}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_call","callId":"c1","toolName":"Bash","kind":"execute","title":"npm test","rawInput":{"command":"npm test"}}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_result","callId":"c1","text":"ok","isError":true}));
        entry_rt(json!({"timestamp":"t","entryType":"diff","path":"/w/a.rs","lines":[{"type":"add","text":"x"}],"truncated":true,"callId":"c1"}));
        entry_rt(json!({"timestamp":"t","entryType":"permission_request","requestId":"r","toolName":"Bash","kind":"execute","title":"rm -rf build","locations":["/w/build"],
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}]}));
        entry_rt(json!({"timestamp":"t","entryType":"question","requestId":"q","index":0,"count":2,"header":"Color","question":"Which?","options":[{"label":"Red","description":"warm"}],"multiSelect":true}));
        entry_rt(json!({"timestamp":"t","entryType":"plan_approval","requestId":"p","options":[{"id":"approve","label":"Approve"}]}));
        entry_rt(json!({"timestamp":"t","entryType":"resolved","requestId":"r","summary":"Allowed"}));
        entry_rt(json!({"timestamp":"t","entryType":"notice","kind":"session_restart","text":"restarted"}));
        entry_rt(json!({"timestamp":"t","entryType":"status","text":"compacting"}));
        entry_rt(json!({"timestamp":"t","entryType":"error","text":"boom"}));
        entry_rt(json!({"timestamp":"t","entryType":"turn_complete"}));
    }

    #[test]
    fn entry_envelope_fields_ride_alongside_the_body() {
        let e = entry_rt(json!({
            "timestamp":"t","entryType":"tool_call","callId":"c","toolName":"Read","kind":"read","title":"a.rs",
            "subagent":{"label":"explorer"},"agentExtras":{"parentToolUseId":"x"}
        }));
        assert_eq!(e.subagent, Some(Subagent { label: Some("explorer".into()) }));
        assert!(e.agent_extras.is_some());
    }

    #[test]
    fn an_unknown_entry_type_is_a_decode_error() {
        assert!(serde_json::from_value::<OutputEntry>(json!({"timestamp":"t","entryType":"hologram"})).is_err());
    }

    #[test]
    fn agent_descriptor_defaults_optional_lists() {
        let a: AgentDescriptor = serde_json::from_value(json!({"id":"pi","displayName":"Pi"})).unwrap();
        assert!(a.modes.is_empty() && a.efforts.is_empty() && a.credentials.is_empty());
        assert_eq!(a.supports, AgentSupports::default());
    }
}
