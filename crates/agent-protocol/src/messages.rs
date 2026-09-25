//! Every message of the driver protocol, by direction.
//!
//! Conventions: message kinds are kebab-case, payload fields camelCase (the
//! same convention as the phone wire, whose types several payloads reuse),
//! enum values snake_case. Every request is answered by exactly one reply
//! carrying the request's frame `id`: its typed reply, or `error`.

use std::collections::BTreeMap;

use protocol::common::{
    AgentSupports, OptionChoice, OutputEntry, PermissionOption, ProviderModel, QuestionOption,
    SessionOption, Subagent, ToolKind, UsageData,
};
use protocol::events::ModelEntry;
use serde::{Deserialize, Serialize};

use crate::Secret;

fn is_false(b: &bool) -> bool {
    !*b
}

// --- agents ---

/// A credential an agent can use. The bridge stores the value and reports
/// its status to the phone; the host decides how the agent consumes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSpec {
    pub id: String,
    pub label: String,
    /// The environment variable that provides this credential when the
    /// bridge's operator sets it themselves; such a value wins over a stored
    /// one and the phone cannot clear it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
}

/// An agent the host can run, as its driver describes it. The bridge turns
/// this into the phone-facing `AgentDescriptor` by adding credential status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub modes: Vec<OptionChoice>,
    #[serde(default)]
    pub efforts: Vec<OptionChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    #[serde(default)]
    pub supports: AgentSupports,
    #[serde(default)]
    pub credentials: Vec<CredentialSpec>,
    /// Set when the driver is installed but cannot run sessions here (e.g. a
    /// missing binary); the bridge refuses sessions with this reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

// --- starting a session ---

/// A custom provider profile a session is bound to for its whole life.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBinding {
    pub id: String,
    pub base_url: String,
    pub auth_token: Secret,
    pub models: Vec<ProviderModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

/// A tool the bridge implements and offers to a session's agent (the
/// device-test tools). The driver exposes it to its agent under `name`;
/// every call comes back to the bridge as `call-host-tool`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments: an object schema whose properties are
    /// `string`, `number`, `integer` or `boolean`.
    #[specta(type = specta_typescript::Unknown)]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartSession {
    /// The bridge's session id — every later message about this session
    /// carries it.
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The agent's own conversation id to continue (from an earlier
    /// `info.nativeSessionId`); absent = start a fresh conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Stored values of this agent's credentials, by [`CredentialSpec`] id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub credentials: BTreeMap<String, Secret>,
    /// Extra environment for the agent's processes (bridge-level credentials
    /// such as `GITHUB_TOKEN`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderBinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub host_tools: Vec<HostToolSpec>,
    /// Refuse every tool call that touches signing keystores or secret files,
    /// whatever the mode (device-test sessions).
    #[serde(default, skip_serializing_if = "is_false")]
    pub deny_secret_paths: bool,
}

// --- what a session reports ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Running,
    Idle,
}

/// Something a running session reports. The host translates its agent's own
/// events into these; the bridge never sees an SDK message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SessionEvent {
    /// The agent came up and accepts prompts. Sent once per `start-session`.
    Ready {},
    /// Session facts changed. Only the fields that changed are set.
    Info {
        /// The agent's own conversation id — the `resume` target.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        native_session_id: Option<String>,
        /// The model the agent actually resolved.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// The agent changed its own mode (e.g. it entered plan mode, or a
        /// plan approval switched it).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(type = Option<specta_typescript::Number>)]
        context_window: Option<u64>,
        /// 0–100.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_percentage: Option<f64>,
    },
    /// Transcript entries, in order. The bridge assigns their seqs.
    Entries { entries: Vec<OutputEntry> },
    Turn { state: TurnState },
    /// The session is gone. Absent `error` = it ended normally. The host
    /// forgets the session after sending this.
    Ended {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// The agent could not find the `resume` conversation, so continuing
        /// it is impossible; a new start must be fresh.
        #[serde(default, skip_serializing_if = "is_false")]
        resume_lost: bool,
    },
}

// --- the host asking the user ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub session_id: String,
    /// Identifies the card on the phone (and in `resolved`).
    pub request_id: String,
    pub tool_name: String,
    pub kind: ToolKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub raw_input: Option<serde_json::Value>,
    pub options: Vec<PermissionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequest {
    pub session_id: String,
    pub request_id: String,
    pub questions: Vec<QuestionSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanApprovalRequest {
    pub session_id: String,
    pub request_id: String,
    pub options: Vec<OptionChoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HostToolCall {
    pub session_id: String,
    pub tool: String,
    #[specta(type = specta_typescript::Unknown)]
    pub args: serde_json::Value,
}

/// The answer to a permission request or a plan approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SelectOutcome {
    /// One of the request's options.
    Selected { option_id: String },
    /// Nobody chose: timed out, interrupted, the session is ending.
    Cancelled { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum QuestionOutcome {
    /// One answer per question, in order; a chosen option is its label
    /// (several joined with ", "), free text is the text.
    Answered { answers: Vec<String> },
    Cancelled { reason: String },
}

// --- the frames ---

/// Bridge → host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum BridgeMessage {
    /// First request after spawning the host. Reply: `initialized`.
    Initialize { bridge_version: String },
    /// Reply: `ack` once the agent is starting (its progress follows as
    /// session events), or `error` when it cannot start at all.
    StartSession(Box<StartSession>),
    /// Stop the session and forget it. Reply: `ack`. No `ended` follows.
    EndSession { session_id: String },
    /// Hand user input to the agent. Reply: `ack`.
    Prompt { session_id: String, text: String },
    /// Stop the running turn. Reply: `ack`.
    Interrupt { session_id: String },
    /// Reply: `ack` when the agent applied it, else `error`.
    SetOption {
        session_id: String,
        option: SessionOption,
        value: String,
    },
    /// Reply: `models`.
    ListModels { agent: String },
    /// Reply: `usage`.
    GetUsage { session_id: String },
    /// Check a credential value with its provider. Reply: `credential-checked`.
    CheckCredential {
        agent: String,
        credential: String,
        value: Secret,
    },
    /// Reply to `request-permission`.
    PermissionOutcome(SelectOutcome),
    /// Reply to `request-plan-approval`.
    PlanOutcome(SelectOutcome),
    /// Reply to `ask-question`.
    QuestionOutcome(QuestionOutcome),
    /// Reply to `call-host-tool`.
    HostToolResult {
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
}

/// Host → bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum HostMessage {
    /// Reply to `initialize`.
    Initialized {
        host_version: String,
        agents: Vec<AgentInfo>,
    },
    Ack,
    /// Reply to any request that failed.
    Error { message: String },
    /// Reply to `list-models`.
    Models {
        models: Vec<ModelEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_model: Option<String>,
    },
    /// Reply to `get-usage`; absent when the agent has none to report.
    Usage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<UsageData>,
    },
    /// Reply to `check-credential`; absent `valid` = it could not be checked.
    CredentialChecked {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        valid: Option<bool>,
    },
    /// A notification: no frame id, no reply.
    SessionEvent {
        session_id: String,
        event: SessionEvent,
    },
    /// Reply: `permission-outcome`.
    RequestPermission(PermissionRequest),
    /// Reply: `question-outcome`.
    AskQuestion(QuestionRequest),
    /// Reply: `plan-outcome`.
    RequestPlanApproval(PlanApprovalRequest),
    /// Reply: `host-tool-result`.
    CallHostTool(HostToolCall),
}

/// One line on the pipe: `{ "v": 1, "id"?: string, "kind": …, "payload": … }`.
/// Requests and their replies share `id`; notifications have none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Frame<M> {
    pub v: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(flatten)]
    pub message: M,
}

pub type BridgeFrame = Frame<BridgeMessage>;
pub type HostFrame = Frame<HostMessage>;
