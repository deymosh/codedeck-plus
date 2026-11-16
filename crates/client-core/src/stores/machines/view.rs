//! The machines store's view types: what the phone knows about each paired
//! bridge and its sessions, as the UI, the backup and the persisted store
//! read it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use protocol::capabilities::{BridgeHostKind, PROTOCOL_VERSION};
use protocol::common::{
    AgentAccount, AgentAction, AgentDescriptor, AvailablePlugin, CredentialStatus, InstalledPlugin, McpAction,
    McpServerInfo, PermissionRule, Persona, PluginAction, PluginMarketplace, ProviderProfileInfo, RemoteSessionInfo,
    SessionMcpServer, SignInAttempt, SignInStatus, UsageData,
};
use protocol::direct::DirectInfo;
use protocol::events::{ModelEntry, PersonasMsg, SlashCommand};

use crate::stores::session_key::SessionGrant;

/// A session the user deleted, kept until its bridge has dropped it too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dismissed {
    /// The machine it was on.
    pub machine: String,
    /// When it was deleted, or later last listed by its machine (ms).
    pub at: u64,
    /// The bridge acknowledged the `close-session`: nothing to send again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
}

/// The three honest presence states for a listed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ListingPresence {
    Live,
    Stale,
    Offline,
}

/// One session as the machines store holds it. The per-session extras (`usage`,
/// `commands`) survive every heartbeat — the merge spreads the previous
/// view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub info: RemoteSessionInfo,
    pub presence: ListingPresence,
    /// ms timestamp this session was last present in an incoming list.
    #[specta(type = specta_typescript::Number)]
    pub last_listed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageData>,
    /// Never persisted (see [`serialize_machines`](super::serialize_machines)): the list is only good
    /// while the session runs, and the phone asks again when it needs it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<SessionCommands>,
    /// Never persisted, like `commands`: the session's MCP servers as its
    /// agent last reported them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<SessionMcp>,
    /// Never persisted, like `commands`: the personas the session can switch
    /// to, as its agent last listed them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personas: Option<PersonaList>,
}

/// A running session's MCP servers, and the switches sent and not answered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMcp {
    pub servers: Vec<SessionMcpServer>,
    /// A server can be switched in the session.
    #[serde(default)]
    pub toggles: bool,
    /// A switch applies to every session of the agent in the same project.
    #[serde(default)]
    pub project_wide: bool,
    /// Why the last request got no answer. The servers held are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Servers switched and not answered yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub busy: Vec<String>,
}

/// Personas as an agent last listed them, for a session or for a whole
/// machine.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonaList {
    pub personas: Vec<Persona>,
    /// Why the last request got no list. The list held before is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PersonaList {
    /// A list replaces the one held; an empty answer (it always carries the
    /// reason) keeps the held list and records why.
    pub(super) fn apply(held: Option<PersonaList>, msg: &PersonasMsg) -> PersonaList {
        if msg.personas.is_empty() {
            PersonaList { personas: held.map(|h| h.personas).unwrap_or_default(), error: msg.error.clone() }
        } else {
            PersonaList { personas: msg.personas.clone(), error: None }
        }
    }
}

/// A session's slash commands as its agent last listed them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommands {
    pub commands: Vec<SlashCommand>,
    /// Why the last request got no list. The list held before is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SessionView {
    /// A freshly-listed session with no prior extras.
    pub fn listed(info: RemoteSessionInfo, presence: ListingPresence, now: u64) -> Self {
        Self {
            info,
            presence,
            last_listed_at: now,
            usage: None,
            commands: None,
            mcp: None,
            personas: None,
        }
    }
}

/// A paired bridge and its session list. `provider_profiles` is
/// bridge-authoritative and in-memory only — it DOES serialize into the live
/// `MachinesView` (so the phone UI can render it), but `serialize_machines`
/// (the KV-persistence path) strips it explicitly before writing, so a fresh
/// boot re-requests the live list instead of trusting a stale local copy
/// (CDX-062).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MachineView {
    pub pubkey_hex: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub machine_offline: bool,
    #[serde(default)]
    #[specta(type = Option<specta_typescript::Number>)]
    pub last_heartbeat_at: Option<u64>,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionView>,
    /// The agent backends this bridge runs, from its latest heartbeat.
    #[serde(default)]
    pub agents: Vec<AgentDescriptor>,
    /// The bridge's own credentials (not tied to an agent), from its latest
    /// heartbeat or `credentials-ack`.
    #[serde(default)]
    pub credentials: Vec<CredentialStatus>,
    /// Live model lists, by agent id. Kept per agent because agents support
    /// entirely different models — one agent's answer never touches another's.
    #[serde(default)]
    pub models: BTreeMap<String, AgentModels>,    /// Stripped by `serialize_machines` before persisting and forced back to
    /// `None` by `hydrate_machines` on load (CDX-062) — but present here so it
    /// serializes normally into the live `MachinesView` an IPC boundary reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_profiles: Option<Vec<ProviderProfileInfo>>,
    /// Plugins, by agent id. Never persisted (see [`serialize_machines`](super::serialize_machines)):
    /// they live on the bridge's machine and are asked for when shown.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plugins: BTreeMap<String, AgentPlugins>,
    /// MCP servers, by agent id. Never persisted, like `plugins`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp: BTreeMap<String, AgentMcp>,
    /// The personas a new session can start as anywhere on the machine, by
    /// agent id. Never persisted, like `plugins`: asked for when shown.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub personas: BTreeMap<String, PersonaList>,
    /// Saved permission rules, by agent id. Never persisted, like `plugins`:
    /// they live on the bridge's machine and are asked for when shown.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub permission_rules: BTreeMap<String, AgentPermissionRules>,
    /// Provider accounts, by agent id. Never persisted, like `plugins`: the
    /// keys and sign-ins live on the bridge's machine.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub accounts: BTreeMap<String, AgentAccounts>,
    /// Installs and removals asked of the bridge, by agent id. Never
    /// persisted, like `plugins`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_actions: BTreeMap<String, AgentActionState>,
    /// The session-key grant this bridge last confirmed. See
    /// `stores::session_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_grant: Option<SessionGrant>,
    /// A grant sent to this bridge and not confirmed yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_grant_sent: Option<SessionGrant>,
    /// The `rev` of the newest session list applied: an older one, arriving
    /// late over another path or replayed, is not applied over it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub list_rev: Option<u64>,
    /// Where the bridge says it can be reached directly (its heartbeat's
    /// `direct`), as last heard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct: Option<DirectInfo>,
    /// Direct endpoints the user added for this bridge (a VPN name the
    /// bridge cannot know, say), tried after the advertised ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub direct_endpoints: Vec<String>,
    /// The relays this bridge is reached over: learned when pairing (its
    /// pairing link and pair-ack), editable by the user. The phone listens on
    /// every paired machine's relays and sends each command only to its
    /// machine's; it has no relays of its own.
    #[serde(default)]
    pub relays: Vec<String>,
    /// The agent the new-session screen starts on (`None`: the bridge's
    /// first one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    /// Per agent id, what a new session on this machine starts with.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_defaults: BTreeMap<String, AgentDefaults>,
    /// The bridge's newest message was refused for its protocol version:
    /// nothing it sends can be read until one side is updated. Cleared by a
    /// message as new that decodes; never persisted, like `plugins`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incompatible: Option<Incompatible>,
}

/// A bridge speaking another protocol version than this app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Incompatible {
    /// The version its messages carry; `None` when they carry none (a bridge
    /// from before messages carried one).
    #[specta(type = Option<specta_typescript::Number>)]
    pub theirs: Option<u64>,
    /// When the refused message was written (its event's `created_at`).
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
}

impl Incompatible {
    /// The bridge is the newer side, so it is this app that needs updating.
    pub fn app_is_older(&self) -> bool {
        self.theirs.is_some_and(|v| v > u64::from(PROTOCOL_VERSION))
    }
}

/// The mode / effort / model / persona a new session of one agent starts
/// with, as that agent's own ids; `""` leaves it to the agent. Applied only
/// while the agent still offers the id — except the persona, which a
/// session's directory may add to: the agent itself falls back, and says so,
/// where it has none by that name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub persona: String,
}

impl AgentDefaults {
    pub(super) fn is_empty(&self) -> bool {
        self.mode.is_empty() && self.effort.is_empty() && self.model.is_empty() && self.persona.is_empty()
    }
}

/// One agent's live model list on one machine. `models` stays `None` until
/// the first non-empty answer; `error` is the bridge's reason for its latest
/// empty answer (CDX-035).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One agent's plugins on a machine, as the bridge last reported them, and
/// the changes asked for and not answered yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlugins {
    pub installed: Vec<InstalledPlugin>,
    /// Absent: the agent installs plugins by package name, from no
    /// marketplace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplaces: Option<Vec<PluginMarketplace>>,
    /// A plugin can be switched off without uninstalling it.
    #[serde(default)]
    pub toggles: bool,
    /// What `install` takes, as the install field's placeholder, for an
    /// agent without marketplaces; the driver's wording, absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
    /// One sentence on where an install comes from and how a change reaches
    /// sessions, for an agent without marketplaces; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_note: Option<String>,
    /// What the marketplaces offer, once asked for; never an installed one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<Vec<AvailablePlugin>>,
    /// Why the last list could not be read. The lists held are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Targets of the changes sent and not acknowledged yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub busy: Vec<String>,
    /// What the last change that succeeded reported, in the agent's words
    /// (e.g. an update's from/to versions); cleared when the next change is
    /// sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<PluginNotice>,
    /// The last change that failed, until the next one succeeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<PluginFailure>,
}

/// One agent's MCP servers on a machine, as the bridge last reported them,
/// and the changes asked for and not answered yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcp {
    pub servers: Vec<McpServerInfo>,
    /// A server can be switched off without removing it.
    #[serde(default)]
    pub toggles: bool,
    /// Why the last list could not be read. The list held is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Names of the servers changed and not acknowledged yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub busy: Vec<String>,
    /// The last change that failed, until the next one succeeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<McpFailure>,
}

/// One agent's saved permission rules on a machine, as the bridge last
/// reported them, and the removals asked for and not answered yet. Absent
/// until the first answer: a page shows it loading.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionRules {
    pub rules: Vec<PermissionRule>,
    /// Why the last list or removal failed. The rules held are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Ids of the rules being removed, not answered yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub busy: Vec<String>,
}

/// One agent's provider accounts on a machine, as the bridge last reported
/// them, the changes asked for and not answered yet, and the sign-in under
/// way. Absent until the first answer: a page shows it loading.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccounts {
    /// The accounts with a connection.
    pub connected: Vec<AgentAccount>,
    /// Every account the agent can connect, once a picker asked for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<AgentAccount>>,
    /// Why the last list or change failed. What is held is kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Ids of the accounts changed and not answered yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub busy: Vec<String>,
    /// The last sign-in started from this client, until another starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<SignInView>,
}

/// A sign-in as this client follows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignInView {
    pub account: String,
    /// `started` from the moment it is asked for; the bridge's answers move
    /// it on.
    pub status: SignInStatus,
    /// What to do, once the machine said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<SignInAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An install or removal of an agent asked of the bridge: in flight until
/// the bridge takes it up, or refused. The install itself then shows in the
/// agent's `install`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentActionState {
    /// Sent, and not acknowledged yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<AgentAction>,
    /// Why the bridge refused the last one, until the next one is taken up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpFailure {
    pub action: McpAction,
    pub names: Vec<String>,
    pub error: String,
}

/// What a change that succeeded reported, and which change it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotice {
    pub action: PluginAction,
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginFailure {
    pub action: PluginAction,
    pub target: String,
    pub error: String,
}

impl MachineView {
    /// The catalog entry for `agent_id`, if this bridge advertises it.
    pub fn agent(&self, agent_id: &str) -> Option<&AgentDescriptor> {
        self.agents.iter().find(|a| a.id == agent_id)
    }

    pub(super) fn new(pubkey_hex: String, name: String) -> Self {
        Self {
            pubkey_hex,
            name,
            host: None,
            label: None,
            capabilities: Vec::new(),
            folders: Vec::new(),
            roots: Vec::new(),
            machine_offline: false,
            last_heartbeat_at: None,
            sessions: BTreeMap::new(),
            agents: Vec::new(),
            credentials: Vec::new(),
            models: BTreeMap::new(),
            provider_profiles: None,
            plugins: BTreeMap::new(),
            mcp: BTreeMap::new(),
            personas: BTreeMap::new(),
            permission_rules: BTreeMap::new(),
            accounts: BTreeMap::new(),
            agent_actions: BTreeMap::new(),
            session_grant: None,
            session_grant_sent: None,
            list_rev: None,
            direct: None,
            direct_endpoints: Vec::new(),
            relays: Vec::new(),
            default_agent: None,
            agent_defaults: BTreeMap::new(),
            incompatible: None,
        }
    }
}
