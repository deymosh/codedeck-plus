//! Every message of the driver protocol, by direction.
//!
//! Conventions: message kinds are kebab-case, payload fields camelCase (the
//! same convention as the phone wire, whose types several payloads reuse),
//! enum values snake_case. Every request is answered by exactly one reply
//! carrying the request's frame `id`: its typed reply, or `error`.

use std::collections::BTreeMap;

use protocol::common::{
    AgentInstall, AgentSupports, AvailablePlugin, InstalledPlugin, McpAction, McpServerInfo, McpServerSpec, McpTransport,
    OptionChoice, OutputEntry, PermissionOption, PluginAction, PluginMarketplace, ProviderModel,
    QuestionOption, SessionMcpServer, SessionOption, Subagent, ToolKind, UsageData,
};
use protocol::events::{ModelEntry, SlashCommand};
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
    /// The effort a session runs at when none is chosen; one of `efforts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub supports: AgentSupports,
    #[serde(default)]
    pub credentials: Vec<CredentialSpec>,
    /// Set when the agent is installed but cannot run sessions here (e.g. a
    /// server that will not start); the bridge refuses sessions with this
    /// reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Whether the agent is on this machine. One that is not has only its
    /// id and name filled in; the rest arrives in `agent-changed` once it
    /// is installed.
    #[serde(default)]
    pub install: AgentInstall,
}

// --- MCP servers ---

/// How the agent reaches an MCP server being added: the phone's
/// `McpTransport` with every value that may hold a credential — arguments,
/// env values, header values — as a [`Secret`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerSetup {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<Secret>,
        #[serde(default)]
        env: BTreeMap<String, Secret>,
    },
    Http {
        url: Secret,
        #[serde(default)]
        headers: BTreeMap<String, Secret>,
    },
    Sse {
        url: Secret,
        #[serde(default)]
        headers: BTreeMap<String, Secret>,
    },
}

/// An MCP server to add (or replace, by name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct McpServerAdd {
    pub name: String,
    pub setup: McpServerSetup,
}

impl From<McpServerSpec> for McpServerAdd {
    fn from(spec: McpServerSpec) -> Self {
        let secrets = |m: BTreeMap<String, String>| m.into_iter().map(|(k, v)| (k, Secret::new(v))).collect();
        let setup = match spec.transport {
            McpTransport::Stdio { command, args, env } => McpServerSetup::Stdio {
                command,
                args: args.into_iter().map(Secret::new).collect(),
                env: secrets(env),
            },
            McpTransport::Http { url, headers } => McpServerSetup::Http { url: Secret::new(url), headers: secrets(headers) },
            McpTransport::Sse { url, headers } => McpServerSetup::Sse { url: Secret::new(url), headers: secrets(headers) },
        };
        Self { name: spec.name, setup }
    }
}

// --- starting a session ---

/// A provider profile, token included: one a session is bound to for its
/// whole life, or one an agent offers the models of (`set-providers`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBinding {
    pub id: String,
    /// The name the user gave it, for showing where a model comes from.
    pub label: String,
    pub base_url: String,
    pub auth_token: Secret,
    pub models: Vec<ProviderModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

/// A provider profile an agent left out of `set-providers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct RefusedProvider {
    /// The profile's id.
    pub id: String,
    pub reason: String,
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
        /// The agent named the session itself (OpenCode titles a session
        /// after its first message). It wins over the title the bridge takes
        /// from that message and over the topic it asks the agent for.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
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
    pub options: Vec<PermissionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
    /// As on the phone wire's `permission_request` entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// As on the phone wire's `permission_request` entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    /// As on the phone wire's `permission_request` entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook_plugin: Option<String>,
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
    /// The option that sends the plan back to the agent to revise, when one
    /// does: the user may send their feedback with it (`plan-outcome`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revise: Option<String>,
}

/// The answer to a permission request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SelectOutcome {
    /// One of the request's options.
    Selected { option_id: String },
    /// Nobody chose: timed out, interrupted, the session is ending.
    Cancelled { reason: String },
}

/// The answer to a plan approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PlanOutcome {
    /// One of the request's options. `feedback` is what the user wants
    /// changed, only ever with the request's `revise` option.
    Selected {
        option_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// Nobody chose: timed out, interrupted, the session is ending.
    Cancelled { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum QuestionOutcome {
    /// One answer per question, in order.
    Answered { answers: Vec<QuestionReply> },
    Cancelled { reason: String },
}

/// The answer to one question. Chosen options and typed text stay apart, so
/// a driver never has to guess whether "A, B" is two labels or what the user
/// wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuestionReply {
    /// The labels of the options chosen, in the order they were offered
    /// in; at least one, and only one unless the question is multi-select.
    Selected { labels: Vec<String> },
    /// What the user typed instead of choosing.
    Text { text: String },
}

impl QuestionReply {
    /// How the answer reads in the transcript.
    pub fn summary(&self) -> String {
        match self {
            Self::Selected { labels } => labels.join(", "),
            Self::Text { text } => text.clone(),
        }
    }
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
    /// Delete the agent's own record of a conversation — its transcript
    /// files, or its session on the agent's server — once the user deleted
    /// the bridge session `session_id` that ran it. Sent only for
    /// conversations the bridge itself started, never for one the user
    /// began elsewhere. The host first waits for `session_id` to finish
    /// ending. Reply: `ack`, also when there was nothing to delete, or
    /// `error`.
    DeleteConversation {
        session_id: String,
        agent: String,
        cwd: String,
        conversation_id: String,
    },
    /// Hand user input to the agent. Reply: `ack`.
    Prompt { session_id: String, text: String },
    /// Stop the running turn. Reply: `ack`.
    Interrupt { session_id: String },
    /// Stop one background task of the session (agents with
    /// `supports.tasks`). Reply: `ack` once asked — the task's next
    /// `background_task` entry says it stopped — or `error`.
    StopTask { session_id: String, task_id: String },
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
    /// The slash commands the session understands now (they can change
    /// while it runs: plugins, skills). Reply: `commands`.
    ListCommands { session_id: String },
    /// The agent's plugins and marketplaces; with `available`, also what the
    /// marketplaces offer. Reply: `plugins`.
    ListPlugins {
        agent: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        available: bool,
    },
    /// Change the agent's plugins. Reply: `plugins` once done — with
    /// `available` when the change was to a marketplace (add, remove or
    /// update), since that changes what the marketplaces offer — or `error`
    /// saying why it was not.
    PluginAction {
        agent: String,
        action: PluginAction,
        target: String,
    },
    /// The agent's MCP servers on this machine. Reply: `mcp-servers`.
    ListMcp { agent: String },
    /// Change the agent's MCP servers: `add` takes `servers`, the other
    /// actions `names`. Running sessions pick the change up. Reply:
    /// `mcp-servers` once done, or `error` saying why it was not.
    McpAction {
        agent: String,
        action: McpAction,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        servers: Vec<McpServerAdd>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        names: Vec<String>,
    },
    /// A running session's MCP servers and where each stands. Reply:
    /// `session-mcp`.
    SessionMcp { session_id: String },
    /// Switch one MCP server on or off in a running session. Reply:
    /// `session-mcp` once done, or `error`.
    SessionMcpToggle {
        session_id: String,
        name: String,
        enabled: bool,
    },
    /// Check a credential value with its provider. Reply: `credential-checked`.
    CheckCredential {
        agent: String,
        credential: String,
        value: Secret,
    },
    /// Check a provider profile's token with the endpoint, the way `agent`
    /// would use it, on `model`. Reply: `credential-checked`.
    CheckProvider {
        agent: String,
        provider: ProviderBinding,
        model: String,
    },
    /// The models the endpoint at `base_url` lists, read with `auth_token`
    /// the way `agent` speaks to it (a provider profile of `agent` being
    /// saved). Reply: `provider-models`, or `error` saying why there is no
    /// list.
    ListProviderModels {
        agent: String,
        base_url: String,
        auth_token: Secret,
    },
    /// The provider profiles of an agent whose catalog entry `supports`
    /// `providerModels`, all of them, oldest saved first: sent after
    /// `initialize` and whenever one changes. The agent offers their models
    /// beside its own. One it cannot add (its name is taken by one of the
    /// agent's own providers, or by an earlier profile) is left out. Reply:
    /// `providers-set`.
    SetProviders {
        agent: String,
        providers: Vec<ProviderBinding>,
    },
    /// Install an agent that is not on this machine, at the version this
    /// build pins. Reply: `ack` once the install began (or when the agent is
    /// already there); `agent-changed` follows as it goes and when it is
    /// done. `error` when it cannot be installed at all.
    InstallAgent { agent: String },
    /// Remove what was installed of an agent (`ready` with `removable`):
    /// its sessions end first. Reply: `ack` once it is gone, after an
    /// `agent-changed` saying so, or `error` saying why it cannot be.
    RemoveAgent { agent: String },
    /// Reply to `request-permission`.
    PermissionOutcome(SelectOutcome),
    /// Reply to `request-plan-approval`.
    PlanOutcome(PlanOutcome),
    /// Reply to `ask-question`.
    QuestionOutcome(QuestionOutcome),
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
    /// Reply to `list-commands`.
    Commands { commands: Vec<SlashCommand> },
    /// Reply to `list-plugins` and `plugin-action` (the fields mean what
    /// they mean on the phone wire's `plugins`).
    Plugins {
        installed: Vec<InstalledPlugin>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marketplaces: Option<Vec<PluginMarketplace>>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        toggles: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        available: Option<Vec<AvailablePlugin>>,
        /// After a `plugin-action`, what was done in the agent's own words,
        /// when it says (e.g. an update's from/to versions).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Reply to `list-mcp` and `mcp-action` (the fields mean what they mean
    /// on the phone wire's `mcp-servers`; no value of a secret is in them).
    McpServers {
        servers: Vec<McpServerInfo>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        toggles: bool,
    },
    /// Reply to `session-mcp` and `session-mcp-toggle` (as the phone wire's
    /// `session-mcp`).
    SessionMcp {
        servers: Vec<SessionMcpServer>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        toggles: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        project_wide: bool,
    },
    /// Reply to `check-credential` and `check-provider`; absent `valid` = it
    /// could not be checked.
    CredentialChecked {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        valid: Option<bool>,
    },
    /// Reply to `list-provider-models`: never empty.
    ProviderModels { models: Vec<ProviderModel> },
    /// Reply to `set-providers`: the profiles left out, with the reason in
    /// words for a person; every other one is offered.
    ProvidersSet { refused: Vec<RefusedProvider> },
    /// A notification: an agent's catalog entry changed — it is being
    /// installed, it was installed or removed, or the install failed. It
    /// replaces the entry `initialized` reported.
    AgentChanged { agent: AgentInfo },
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
