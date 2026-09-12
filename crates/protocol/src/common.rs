//! Shared wire building blocks — enums + object types referenced by both
//! command and event messages. Port of `packages/protocol/src/schemas/common.ts`.
//!
//! Faithful to the zod schemas: an unknown enum value is a decode error (the TS
//! `z.enum` rejects it too). The forward-compatible `#[serde(other)]` leniency
//! the migration plan §3 calls for is a deliberate, separately-tested change on
//! top of this port, not part of it.

use serde::{Deserialize, Serialize};

// --- enums ---

/// `bypassPermissions` is intentionally absent — the bridge coerces it to `Default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum PermissionMode {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "plan")]
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    WaitingPermission,
    WaitingQuestion,
    /// v10: set on every session when the bridge shuts down cleanly.
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OutputEntryType {
    Text,
    ToolUse,
    ToolResult,
    System,
    Error,
    Progress,
    /// Extended-thinking block — rendered collapsed.
    Thinking,
    /// CDX-050: a file-edit diff card.
    Diff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineType {
    Add,
    Del,
    Context,
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

// --- object types ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub id: String,
    pub slug: String,
    pub cwd: String,
    pub last_activity: String,
    #[specta(type = specta_typescript::Number)]
    pub line_count: u64,
    /// nullable (always present on the wire, may be `null`).
    pub title: Option<String>,
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort_level: Option<EffortLevel>,
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
    /// v10: highest transcript seq the bridge has persisted for this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub seq_high: Option<u64>,
    /// CDX-062: bound provider profile id (absent = Anthropic).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub has_anthropic_key: bool,
    pub has_github_pat: bool,
    pub has_env_key: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub kind: DiffLineType,
    pub text: String,
}

/// Structured payload of an entryType `Diff` entry (CDX-050). Flat: a lines
/// array derived from the Edit/Write tool INPUT, not real unified-diff hunks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffData {
    pub path: String,
    pub lines: Vec<DiffLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub entry_type: OutputEntryType,
    pub content: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    // Genuinely untyped JSON (arbitrary bridge-supplied hints), not a real
    // shape — see this file's `specta-typescript` dependency comment.
    #[specta(type = specta_typescript::Unknown)]
    pub metadata: Option<serde_json::Value>,
    /// Present iff `entry_type == Diff`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<DiffData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub available: bool,
    pub subscription_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day_opus: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seven_day_sonnet: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_cost_usd: Option<f64>,
    pub fetched_at: String,
}

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

    #[test]
    fn enum_wire_values() {
        assert_eq!(serde_json::to_string(&PermissionMode::AcceptEdits).unwrap(), r#""acceptEdits""#);
        assert_eq!(serde_json::to_string(&EffortLevel::Xhigh).unwrap(), r#""xhigh""#);
        assert_eq!(serde_json::to_string(&SessionState::WaitingPermission).unwrap(), r#""waiting_permission""#);
        assert_eq!(serde_json::to_string(&OutputEntryType::ToolUse).unwrap(), r#""tool_use""#);
        assert_eq!(serde_json::to_string(&DiffLineType::Del).unwrap(), r#""del""#);
        assert_eq!(serde_json::to_string(&DeviceRole::TestTarget).unwrap(), r#""test-target""#);
    }

    #[test]
    fn unknown_enum_value_is_a_decode_error_like_zod() {
        assert!(serde_json::from_str::<EffortLevel>(r#""ultra""#).is_err());
        assert!(serde_json::from_str::<SessionState>(r#""paused""#).is_err());
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
        let minimal = r#"{"id":"s","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}"#;
        let v: RemoteSessionInfo = serde_json::from_str(minimal).unwrap();
        assert_eq!(v.title, None);
        assert_eq!(v.state, None);
        // round-trips without inventing optional keys
        assert_eq!(serde_json::from_str::<RemoteSessionInfo>(&serde_json::to_string(&v).unwrap()).unwrap(), v);

        let full = serde_json::json!({
            "id":"s","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":42,
            "title":"T","project":"p","permissionMode":"plan","effortLevel":"high",
            "model":"m","contextWindow":200000,"contextPercentage":37.5,"committed":true,
            "state":"running","seqHigh":917,"providerId":"pid","providerLabel":"Prov"
        });
        let v: RemoteSessionInfo = serde_json::from_value(full).unwrap();
        assert_eq!(v.permission_mode, Some(PermissionMode::Plan));
        assert_eq!(v.seq_high, Some(917));
    }

    #[test]
    fn output_entry_diff_shape() {
        let j = serde_json::json!({
            "entryType":"diff","content":"+a\n-b","timestamp":"t",
            "diff":{"path":"f.rs","lines":[{"type":"add","text":"a"},{"type":"del","text":"b"}]}
        });
        let e: OutputEntry = serde_json::from_value(j).unwrap();
        assert_eq!(e.entry_type, OutputEntryType::Diff);
        assert_eq!(e.diff.as_ref().unwrap().lines[0].kind, DiffLineType::Add);
        assert_eq!(serde_json::from_str::<OutputEntry>(&serde_json::to_string(&e).unwrap()).unwrap().diff, e.diff);
    }
}
