//! `machines` store — the bug-B session-loss killer. Port of the PURE half of
//! `apps/mobile/src/core/stores/machines.ts`: `mergeSessionList` and the title
//! helpers. The store actions (`applySessionList`, `applyModels`, …), the
//! `MachineView`, and serialize/hydrate land in a follow-up.
//!
//! Contract, verbatim from the TS:
//! - sessions in the incoming list are upserted (`Live`, or `Offline` on a
//!   `machineOffline` shutdown publish);
//! - **absence NEVER deletes** — a known session missing from the list is kept
//!   and marked `Stale` (or held past a grace window);
//! - removal is ONLY via explicit `removedSessions` tombstones;
//! - the merge is pure — `prev` is never mutated.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use protocol::capabilities::{BridgeHostKind, PROTOCOL_VERSION};
use protocol::common::{
    AgentAccount, AgentAction, AgentDescriptor, AvailablePlugin, CredentialStatus, InstalledPlugin, McpAction, McpServerInfo,
    PermissionRule, SignInAttempt, SignInStatus,
    PluginAction, PluginMarketplace, ProviderProfileInfo, RemoteSessionInfo, SessionMcpServer, UsageData,
};
use protocol::events::{
    AccountSignInMsg, AccountsMsg, AgentAckMsg, AgentStyleMsg, CommandsMsg, McpAckMsg, McpServersMsg, ModelEntry, ModelsMsg, PermissionRulesMsg, PluginAckMsg, PluginsMsg,
    ProviderProfilesMsg,
    SessionListMsg, SessionMcpMsg, SlashCommand,
};

use super::agent_styles::AgentStyles;
use super::fetches::Fetches;
use super::pairing::is_relay_url;
use super::session_key::SessionGrant;
use protocol::direct::DirectInfo;

/// Whether `url` is a direct endpoint the phone may dial: `wss://` to any
/// host, `ws://` only to an onion service.
pub fn is_direct_endpoint(url: &str) -> bool {
    let host = |rest: &str| rest.split(['/', ':']).next().unwrap_or("").to_ascii_lowercase();
    match (url.strip_prefix("wss://"), url.strip_prefix("ws://")) {
        (Some(rest), _) => !host(rest).is_empty(),
        (None, Some(rest)) => host(rest).ends_with(".onion"),
        _ => false,
    }
}

/// A user-deleted session keeps suppressing incoming lists and live output
/// while its bridge still lists it, and for this long after: both since its
/// bridge last listed it, by that bridge's heartbeats, and by the phone's
/// clock. Counted in heartbeats too, so a bridge that was offline for a day
/// does not bring it back when it returns before it has heard the close. It
/// must outlast the direct link's resume window: a reconnecting link
/// re-sends what the bridge published in its last
/// [`protocol::direct::OUTBOX_SECS`], including the deleted session's final
/// output, which would otherwise read as news.
pub const DISMISSED_TTL_MS: u64 = 2 * protocol::direct::OUTBOX_SECS * 1000;

/// How often a `close-session` is sent again while the bridge still lists
/// the session it closes (the first went out when the delete committed).
pub const CLOSE_RETRY_MS: u64 = 5 * 60 * 1000;

/// How long a machine-settings change waits for an answer before the phone
/// gives up on it. The bridge sets no deadline of its own — it answers when
/// the agent host does — so this one is the phone's: it settles a change the
/// machine never answered (it was offline, a relay dropped it) so the UI does
/// not spin forever. An answer that arrives later still lands and replaces
/// the "did not answer" note.
pub const SETTINGS_ANSWER_TIMEOUT_MS: u64 = 60_000;

/// What the phone shows when a change went unanswered for
/// [`SETTINGS_ANSWER_TIMEOUT_MS`].
const NO_ANSWER: &str = "The machine did not answer. It may be offline; try again once it is back.";

/// One machine-settings change sent and not answered yet, with what is needed
/// to settle it if the answer never comes: the data identifies the item in
/// the store it made busy.
#[derive(Debug, Clone, PartialEq)]
enum Unanswered {
    /// A plugin install / uninstall / enable / disable / update, or a
    /// marketplace change, by its target.
    Plugin { agent: String, target: String, action: PluginAction },
    /// An agent install or removal.
    AgentAction { agent: String },
    /// A change to an agent's MCP servers, by the names it touched.
    Mcp { agent: String, action: McpAction, names: Vec<String> },
    /// Removals of saved permission rules, by their ids.
    PermissionRules { agent: String, ids: Vec<String> },
    /// A change to a provider account (a sign-in, a removal, …).
    Account { agent: String, account: String },
    /// A switch of one server in a running session.
    SessionMcp { session_id: String, name: String },
}

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
    /// Never persisted (see [`serialize_machines`]): the list is only good
    /// while the session runs, and the phone asks again when it needs it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<SessionCommands>,
    /// Never persisted, like `commands`: the session's MCP servers as its
    /// agent last reported them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<SessionMcp>,
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
        }
    }
}

/// `mergeSessionList` options.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergeOptions {
    /// A session absent from an incoming list keeps its previous presence while
    /// it was listed within this window (rapid partial lists during session
    /// creation must not flicker everything stale). `0` = stale at once.
    pub stale_grace_ms: u64,
}

/// Title-merge guard: a `null` incoming title must not wipe a title we
/// already hold (the client-side first-message stopgap), but a non-null
/// incoming title always wins. TS: `incoming.title ?? prev.title`.
fn with_guarded_title(incoming: &RemoteSessionInfo, prev: Option<&SessionView>) -> RemoteSessionInfo {
    let held = prev.and_then(|p| p.info.title.clone());
    if incoming.title.is_some() || held.is_none() {
        return incoming.clone();
    }
    RemoteSessionInfo {
        title: held,
        ..incoming.clone()
    }
}

/// Pure session-list merge. Returns a NEW map; `prev` is untouched.
pub fn merge_session_list(
    prev: &BTreeMap<String, SessionView>,
    incoming: &SessionListMsg,
    now: u64,
    opts: MergeOptions,
) -> BTreeMap<String, SessionView> {
    let machine_offline = incoming.machine_offline.unwrap_or(false);
    let presence = if machine_offline {
        ListingPresence::Offline
    } else {
        ListingPresence::Live
    };

    let mut next: BTreeMap<String, SessionView> = BTreeMap::new();
    let mut listed: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();

    for info in &incoming.sessions {
        listed.insert(info.id.as_str());
        let prior = prev.get(&info.id);
        next.insert(
            info.id.clone(),
            SessionView {
                info: with_guarded_title(info, prior),
                presence,
                last_listed_at: now,
                // per-session extras survive every heartbeat
                usage: prior.and_then(|p| p.usage.clone()),
                commands: prior.and_then(|p| p.commands.clone()),
                mcp: prior.and_then(|p| p.mcp.clone()),
            },
        );
    }

    for (id, view) in prev {
        if listed.contains(id.as_str()) {
            continue;
        }
        // Absence NEVER deletes.
        let kept = if machine_offline {
            SessionView {
                presence: ListingPresence::Offline,
                ..view.clone()
            }
        } else if now.saturating_sub(view.last_listed_at) <= opts.stale_grace_ms {
            view.clone()
        } else {
            SessionView {
                presence: ListingPresence::Stale,
                ..view.clone()
            }
        };
        next.insert(id.clone(), kept);
    }

    // Tombstones are the ONLY bridge-driven removal path.
    for id in incoming.removed_sessions.iter().flatten() {
        next.remove(id);
    }

    next
}

/// Old-app first-message title: newlines → spaces, trim; `> 80` chars →
/// `slice(0, 77) + "..."`. Empty input yields `""` (the caller skips it).
pub fn title_from_first_message(text: &str) -> String {
    let title: String = text.replace('\n', " ");
    let title = title.trim();
    if title.chars().count() > 80 {
        let head: String = title.chars().take(77).collect();
        format!("{head}...")
    } else {
        title.to_string()
    }
}


// --- MachineView + the store's pure transforms --------------------------------

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
    /// Plugins, by agent id. Never persisted (see [`serialize_machines`]):
    /// they live on the bridge's machine and are asked for when shown.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub plugins: BTreeMap<String, AgentPlugins>,
    /// MCP servers, by agent id. Never persisted, like `plugins`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp: BTreeMap<String, AgentMcp>,
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

/// The mode / effort / model a new session of one agent starts with, as that
/// agent's own ids; `""` leaves it to the agent. Applied only while the agent
/// still offers the id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefaults {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub model: String,
}

impl AgentDefaults {
    fn is_empty(&self) -> bool {
        self.mode.is_empty() && self.effort.is_empty() && self.model.is_empty()
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

    fn new(pubkey_hex: String, name: String) -> Self {
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

/// `serializeMachines`: a JSON array of the machines, `providerProfiles`,
/// `plugins` and every session's `commands` stripped. Round-tripping through this can never truncate — it holds the FULL
/// map, unlike the old app's merged-short list.
///
/// The strip happens HERE, not via a `#[serde(skip)]` on the field itself —
/// `MachineView` also serializes into the live `MachinesView` that crosses the
/// IPC boundary to the UI, and that path must carry `provider_profiles`.
pub fn serialize_machines(machines: &BTreeMap<String, MachineView>) -> String {
    let stripped: Vec<MachineView> = machines
        .values()
        .cloned()
        .map(|mut m| {
            m.provider_profiles = None;
            m.plugins.clear();
            m.mcp.clear();
            m.permission_rules.clear();
            m.accounts.clear();
            m.agent_actions.clear();
            m.incompatible = None;
            for s in m.sessions.values_mut() {
                s.commands = None;
                s.mcp = None;
            }
            m
        })
        .collect();
    serde_json::to_string(&stripped).expect("MachineView always serializes")
}

/// `hydrateMachines`: tolerant parse. Every presence comes back `Offline` and
/// `machine_offline` is forced true — honest until the first live heartbeat.
/// Garbage / unknown input yields an empty map (never a panic at boot).
pub fn hydrate_machines(raw: Option<&str>) -> BTreeMap<String, MachineView> {
    let Some(raw) = raw else {
        return BTreeMap::new();
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for item in items {
        let Ok(mut m) = serde_json::from_value::<MachineView>(item) else {
            continue;
        };
        if m.pubkey_hex.is_empty() {
            continue;
        }
        if m.name.is_empty() {
            m.name = m.pubkey_hex.chars().take(8).collect();
        }
        m.machine_offline = true;
        m.provider_profiles = None;
        for view in m.sessions.values_mut() {
            view.presence = ListingPresence::Offline;
        }
        out.insert(m.pubkey_hex.clone(), m);
    }
    out
}

/// `dismissed_sessions` for the KV. Kept apart from the machines so a
/// deleted session stays shielded across an app restart.
pub fn serialize_dismissed(dismissed: &BTreeMap<String, Dismissed>) -> String {
    serde_json::to_string(dismissed).expect("dismissed sessions serialize")
}

/// Tolerant parse of [`serialize_dismissed`]: garbage yields an empty map,
/// an unreadable entry is skipped.
pub fn hydrate_dismissed(raw: Option<&str>) -> BTreeMap<String, Dismissed> {
    let Some(map) = raw.and_then(|r| serde_json::from_str::<BTreeMap<String, serde_json::Value>>(r).ok()) else {
        return BTreeMap::new();
    };
    map.into_iter().filter_map(|(id, v)| Some((id, serde_json::from_value(v).ok()?))).collect()
}

/// The machines store as a pure state machine. Every method mutates
/// only `self`; the runtime persists `serialize_machines(&self.machines)` and
/// `serialize_dismissed(&self.dismissed_sessions)` after anything that
/// changes either. `fetches` is in-memory only.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MachinesState {
    pub machines: BTreeMap<String, MachineView>,
    pub dismissed_sessions: BTreeMap<String, Dismissed>,
    /// When a `close-session` last went to a dismissed session's bridge
    /// (ms); in memory only, so a restart sends it again at the first chance.
    pub close_sent: BTreeMap<String, u64>,
    pub merge_options: MergeOptions,
    /// The model lists and provider profiles answered on this connection.
    pub fetches: Fetches,
    /// Per machine, when the newest message read from it was written: a
    /// relay replaying something older says nothing about it now.
    pub read_at: BTreeMap<String, u64>,
    /// Agents' styles by hash, shared by every machine; persisted under its
    /// own key.
    pub agent_styles: AgentStyles,
    /// Every machine-settings change sent and not answered yet, with the
    /// machine it went to and when (ms). In memory only, like the `busy`
    /// fields it settles: nothing here is worth surviving a restart, since a
    /// change in flight at the last shutdown was answered or not by then.
    unanswered: Vec<(String, Unanswered, u64)>,
}

impl MachinesState {
    pub fn new(machines: BTreeMap<String, MachineView>, merge_options: MergeOptions) -> Self {
        Self {
            machines,
            dismissed_sessions: BTreeMap::new(),
            close_sent: BTreeMap::new(),
            merge_options,
            fetches: Fetches::default(),
            read_at: BTreeMap::new(),
            agent_styles: AgentStyles::default(),
            unanswered: Vec::new(),
        }
    }

    pub fn machine(&self, pubkey_hex: &str) -> Option<&MachineView> {
        self.machines.get(pubkey_hex)
    }
    pub fn session(&self, machine_pubkey: &str, session_id: &str) -> Option<&SessionView> {
        self.machines.get(machine_pubkey)?.sessions.get(session_id)
    }
    pub fn machine_pubkeys(&self) -> Vec<String> {
        self.machines.keys().cloned().collect()
    }

    /// Upsert a machine record (pair-ack). An existing record keeps its fields;
    /// only `name` (and `label` / `host` when given) update, and `relays` the
    /// pairing learned are added to the ones it has.
    pub fn register_machine(
        &mut self,
        pubkey_hex: &str,
        name: &str,
        label: Option<String>,
        host: Option<BridgeHostKind>,
        relays: &[String],
    ) {
        let entry = self
            .machines
            .entry(pubkey_hex.to_string())
            .or_insert_with(|| MachineView::new(pubkey_hex.to_string(), name.to_string()));
        entry.name = name.to_string();
        if let Some(l) = label {
            entry.label = Some(l);
        }
        if let Some(h) = host {
            entry.host = Some(h);
        }
        for relay in relays {
            if !entry.relays.contains(relay) {
                entry.relays.push(relay.clone());
            }
        }
    }

    /// Every paired machine's relays, deduplicated, in machine order.
    pub fn relay_set(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for relay in self.machines.values().flat_map(|m| &m.relays) {
            if !out.contains(relay) {
                out.push(relay.clone());
            }
        }
        out
    }

    /// Replace `machine`'s relays. Returns false (and changes nothing) for an
    /// unknown machine, an empty list — a machine must stay reachable — or a
    /// URL that is not a relay the phone may dial.
    pub fn set_relays(&mut self, machine_pubkey: &str, relays: Vec<String>) -> bool {
        let mut clean: Vec<String> = Vec::new();
        for relay in relays.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
            if !is_relay_url(&relay) {
                return false;
            }
            if !clean.contains(&relay) {
                clean.push(relay);
            }
        }
        if clean.is_empty() {
            return false;
        }
        self.with_machine(machine_pubkey, |m| m.relays = clean)
    }

    /// The agent `machine`'s new sessions start on; `None` clears it.
    /// A message `machine` wrote at `at` was read. True when that cleared a
    /// version mismatch no newer than it.
    pub fn note_read(&mut self, machine_pubkey: &str, at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        let read = self.read_at.entry(machine_pubkey.to_string()).or_default();
        *read = (*read).max(at);
        match m.incompatible {
            Some(i) if i.at <= at => {
                m.incompatible = None;
                true
            }
            _ => false,
        }
    }

    /// A message `machine` wrote at `at` was refused for its version
    /// (`theirs`). Only one newer than everything read from it counts. True
    /// when that changed which side needs updating.
    pub fn note_unreadable(&mut self, machine_pubkey: &str, theirs: Option<u64>, at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        if self.read_at.get(machine_pubkey).is_some_and(|read| at <= *read) {
            return false;
        }
        let changed = m.incompatible.is_none_or(|i| i.theirs != theirs);
        if m.incompatible.is_none_or(|i| i.at <= at) {
            m.incompatible = Some(Incompatible { theirs, at });
        }
        changed
    }

    pub fn set_default_agent(&mut self, machine_pubkey: &str, agent: Option<String>) -> bool {
        let agent = agent.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
        self.with_machine(machine_pubkey, |m| m.default_agent = agent)
    }

    /// What a new `agent` session on `machine` starts with; all-empty
    /// forgets the entry.
    pub fn set_agent_defaults(&mut self, machine_pubkey: &str, agent: &str, defaults: AgentDefaults) -> bool {
        let defaults = AgentDefaults {
            mode: defaults.mode.trim().to_string(),
            effort: defaults.effort.trim().to_string(),
            model: defaults.model.trim().to_string(),
        };
        self.with_machine(machine_pubkey, |m| {
            if defaults.is_empty() {
                m.agent_defaults.remove(agent);
            } else {
                m.agent_defaults.insert(agent.to_string(), defaults);
            }
        })
    }

    /// The name the user gave `machine`; `None` or blank clears it.
    pub fn set_label(&mut self, machine_pubkey: &str, label: Option<String>) -> bool {
        let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        self.with_machine(machine_pubkey, |m| m.label = label)
    }

    /// Replace every agent's new-session defaults for `machine` at once.
    pub fn replace_agent_defaults(&mut self, machine_pubkey: &str, defaults: BTreeMap<String, AgentDefaults>) -> bool {
        self.with_machine(machine_pubkey, |m| m.agent_defaults = defaults)
    }

    /// Forget a machine, and the sessions deleted on it: with the machine
    /// gone no heartbeat of it can bring them back.
    pub fn remove_machine(&mut self, pubkey_hex: &str) -> bool {
        let removed = self.machines.remove(pubkey_hex).is_some();
        self.prune_dismissed(0);
        removed
    }

    /// Forget the dismissals that are over: the machine is gone, or it has
    /// not listed the session for [`DISMISSED_TTL_MS`] of its heartbeats and
    /// as long by `now`.
    fn prune_dismissed(&mut self, now: u64) {
        let machines = &self.machines;
        self.dismissed_sessions.retain(|_, d| {
            let Some(m) = machines.get(&d.machine) else { return false };
            let quiet = m.last_heartbeat_at.map_or(0, |hb| hb.saturating_sub(d.at));
            quiet < DISMISSED_TTL_MS || now.saturating_sub(d.at) < DISMISSED_TTL_MS
        });
        let dismissed = &self.dismissed_sessions;
        self.close_sent.retain(|id, _| dismissed.contains_key(id));
    }

    /// Whether `msg` is no newer than the newest list applied for
    /// `machine_pubkey`, so applying it would step the machine back.
    pub fn is_outdated_list(&self, machine_pubkey: &str, msg: &SessionListMsg) -> bool {
        let applied = self.machine(machine_pubkey).and_then(|m| m.list_rev);
        matches!((msg.rev, applied), (Some(rev), Some(applied)) if rev <= applied)
    }

    /// The heartbeat path. CDX-022: the record is SPREAD from the existing one,
    /// never rebuilt — a field the wire omits (`models`, `host`, …) keeps its
    /// stored value; a field the wire carries always wins. The resurrection
    /// shield filters user-deleted sessions out of `msg` BEFORE the merge.
    ///
    /// Returns the deleted sessions the bridge still lists whose
    /// `close-session` it has not acknowledged: it never heard it, so the
    /// caller sends it again (see [`Self::closes_due`]). Each one listed stays
    /// dismissed for as long as it is listed.
    pub fn apply_session_list(&mut self, machine_pubkey: &str, msg: &SessionListMsg, at: u64) -> Vec<String> {
        let mut unclosed = Vec::new();
        for info in &msg.sessions {
            if let Some(d) = self.dismissed_sessions.get_mut(&info.id).filter(|d| d.machine == machine_pubkey) {
                d.at = d.at.max(at);
                if !d.closed {
                    unclosed.push(info.id.clone());
                }
            }
        }
        let dismissed = &self.dismissed_sessions;

        let prev_sessions = self
            .machines
            .get(machine_pubkey)
            .map(|m| m.sessions.clone())
            .unwrap_or_default();

        // Filtered copy of the incoming list (resurrection shield).
        let mut shielded = msg.clone();
        shielded
            .sessions
            .retain(|s| !dismissed.contains_key(&s.id));

        let sessions = merge_session_list(&prev_sessions, &shielded, at, self.merge_options);

        let entry = self
            .machines
            .entry(machine_pubkey.to_string())
            .or_insert_with(|| MachineView::new(machine_pubkey.to_string(), msg.machine.clone()));
        entry.pubkey_hex = machine_pubkey.to_string();
        entry.name = msg.machine.clone();
        if let Some(h) = msg.host {
            entry.host = Some(h);
        }
        if let Some(caps) = &msg.capabilities {
            entry.capabilities = caps.clone();
        }
        if let Some(f) = &msg.folders {
            entry.folders = f.clone();
        }
        if let Some(r) = &msg.roots {
            entry.roots = r.clone();
        }
        entry.agents = msg.agents.clone();
        entry.credentials = msg.credentials.clone();
        entry.machine_offline = msg.machine_offline.unwrap_or(false);
        entry.direct = msg.direct.clone();
        if msg.rev.is_some() {
            entry.list_rev = msg.rev;
        }
        entry.last_heartbeat_at = Some(at);
        entry.sessions = sessions;
        self.prune_dismissed(at);
        unclosed
    }

    /// Of `sessions` (deleted ones their bridge still lists), those whose
    /// `close-session` is due again, noted as sent `now`.
    pub fn closes_due(&mut self, sessions: &[String], now: u64) -> Vec<String> {
        let mut due = Vec::new();
        for id in sessions {
            if self.close_sent.get(id).is_none_or(|at| now.saturating_sub(*at) >= CLOSE_RETRY_MS) {
                self.close_sent.insert(id.clone(), now);
                due.push(id.clone());
            }
        }
        due
    }

    /// A `close-session` for `session_id` went out `now`.
    pub fn note_close_sent(&mut self, session_id: &str, now: u64) {
        self.close_sent.insert(session_id.to_string(), now);
    }

    /// The bridge acknowledged closing `session_id`: it is not sent again.
    /// The session stays dismissed (a replay of its output is not news).
    pub fn note_closed(&mut self, session_id: &str) {
        if let Some(d) = self.dismissed_sessions.get_mut(session_id) {
            d.closed = true;
        }
        self.close_sent.remove(session_id);
    }

    /// Where to reach `machine` directly: the endpoints to try, in order,
    /// and the certificate pin for its `wss://` ones. `None` when there is
    /// nowhere to try.
    pub fn direct_target(&self, machine_pubkey: &str) -> Option<(Vec<String>, Option<String>)> {
        let m = self.machines.get(machine_pubkey)?;
        let mut endpoints: Vec<String> = m.direct.iter().flat_map(|d| d.endpoints.iter().cloned()).collect();
        for extra in &m.direct_endpoints {
            if !endpoints.contains(extra) {
                endpoints.push(extra.clone());
            }
        }
        let pin = m.direct.as_ref().and_then(|d| d.cert_sha256.clone());
        (!endpoints.is_empty()).then_some((endpoints, pin))
    }

    /// Replace the user's own direct endpoints for `machine`. Returns false
    /// (and changes nothing) for an unknown machine or an endpoint that is
    /// neither `wss://…` nor `ws://….onion`.
    pub fn set_direct_endpoints(&mut self, machine_pubkey: &str, endpoints: Vec<String>) -> bool {
        let endpoints: Vec<String> = endpoints.into_iter().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect();
        if !endpoints.iter().all(|e| is_direct_endpoint(e)) {
            return false;
        }
        self.with_machine(machine_pubkey, |m| m.direct_endpoints = endpoints)
    }

    fn with_machine<F: FnOnce(&mut MachineView)>(&mut self, machine_pubkey: &str, f: F) -> bool {
        match self.machines.get_mut(machine_pubkey) {
            Some(m) => {
                f(m);
                true
            }
            None => false,
        }
    }

    pub fn apply_session_upsert(&mut self, machine_pubkey: &str, info: &RemoteSessionInfo, at: u64) {
        self.with_machine(machine_pubkey, |m| {
            let prior = m.sessions.get(&info.id);
            let view = SessionView {
                info: with_guarded_title(info, prior),
                presence: ListingPresence::Live,
                last_listed_at: at,
                usage: prior.and_then(|p| p.usage.clone()),
                commands: prior.and_then(|p| p.commands.clone()),
                mcp: prior.and_then(|p| p.mcp.clone()),
            };
            m.sessions.insert(info.id.clone(), view);
        });
    }

    /// Patch a session's `info` in place (e.g. mode / effort / model confirmed).
    pub fn update_session_info<F: FnOnce(&mut RemoteSessionInfo)>(
        &mut self,
        machine_pubkey: &str,
        session_id: &str,
        patch: F,
    ) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                patch(&mut s.info);
            }
        });
    }

    /// The FIRST user message titles an untitled session. No-op when the session
    /// is unknown, already titled, or the text is whitespace-only.
    pub fn note_first_user_message(&mut self, machine_pubkey: &str, session_id: &str, text: &str) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(session_id) else {
                return;
            };
            if s.info.title.is_some() {
                return;
            }
            let title = title_from_first_message(text);
            if title.is_empty() {
                return;
            }
            s.info.title = Some(title);
        });
    }

    /// Explicit user delete — one of exactly two removal paths.
    pub fn user_remove_session(&mut self, machine_pubkey: &str, session_id: &str) {
        self.with_machine(machine_pubkey, |m| {
            m.sessions.remove(session_id);
        });
    }

    /// Shield a user-deleted session on `machine_pubkey` from resurrection
    /// by heartbeats that still list it.
    pub fn dismiss_session(&mut self, machine_pubkey: &str, session_id: &str, at: u64) {
        self.prune_dismissed(at);
        self.dismissed_sessions
            .insert(session_id.to_string(), Dismissed { machine: machine_pubkey.to_string(), at, closed: false });
    }

    /// The user deleted `session_id`, and its bridge may still have it or
    /// have just dropped it (see [`DISMISSED_TTL_MS`]).
    pub fn is_dismissed(&self, session_id: &str) -> bool {
        self.dismissed_sessions.contains_key(session_id)
    }

    /// Undo a delete: un-dismiss and re-insert the exact snapshotted view.
    pub fn restore_session(&mut self, machine_pubkey: &str, view: SessionView) {
        self.dismissed_sessions.remove(&view.info.id);
        self.close_sent.remove(&view.info.id);
        self.with_machine(machine_pubkey, |m| {
            m.sessions.insert(view.info.id.clone(), view);
        });
    }

    pub fn apply_usage(&mut self, machine_pubkey: &str, session_id: &str, usage: UsageData) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                s.usage = Some(usage);
            }
        });
    }

    /// A list replaces the one held; an empty answer (it always carries the
    /// reason) keeps the held list and records why.
    pub fn apply_commands(&mut self, machine_pubkey: &str, msg: &CommandsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(&msg.session_id) else { return };
            if msg.commands.is_empty() {
                let held = s.commands.take().map(|c| c.commands).unwrap_or_default();
                s.commands = Some(SessionCommands { commands: held, error: msg.error.clone() });
            } else {
                s.commands = Some(SessionCommands { commands: msg.commands.clone(), error: None });
            }
        });
    }

    /// A list replaces the held one; a failed read keeps it and records why.
    /// A list without `available` keeps the held offer, less anything now
    /// installed.
    pub fn apply_plugins(&mut self, machine_pubkey: &str, msg: &PluginsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(msg.agent.clone()).or_default();
            if let Some(error) = &msg.error {
                p.error = Some(error.clone());
                return;
            }
            p.error = None;
            p.installed = msg.installed.clone();
            p.marketplaces = msg.marketplaces.clone();
            p.toggles = msg.toggles;
            if let Some(available) = &msg.available {
                p.available = Some(available.clone());
            }
            let installed: Vec<&str> = p.installed.iter().map(|i| i.id.as_str()).collect();
            if let Some(available) = &mut p.available {
                available.retain(|a| !installed.contains(&a.id.as_str()));
            }
        });
    }

    /// A change was sent: its target is busy until acknowledged, and the
    /// previous change's report gives way to it. The change is remembered
    /// with `now` so an answer that never comes can be given up on (see
    /// [`Self::expire_unanswered`]).
    pub fn plugin_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: PluginAction, target: &str, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(agent.to_string()).or_default();
            if !p.busy.iter().any(|t| t == target) {
                p.busy.push(target.to_string());
            }
            p.notice = None;
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Plugin { agent: agent.to_string(), target: target.to_string(), action },
            now,
        );
    }

    pub fn apply_plugin_ack(&mut self, machine_pubkey: &str, msg: &PluginAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(msg.agent.clone()).or_default();
            p.busy.retain(|t| *t != msg.target);
            p.notice = msg.success.then(|| msg.message.clone()).flatten().map(|message| PluginNotice {
                action: msg.action,
                target: msg.target.clone(),
                message,
            });
            p.failure = (!msg.success).then(|| PluginFailure {
                action: msg.action,
                target: msg.target.clone(),
                error: msg.error.clone().unwrap_or_else(|| "It could not be done.".into()),
            });
        });
    }

    /// An install or removal was sent: the agent is busy until acknowledged.
    pub fn agent_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: AgentAction, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.agent_actions.entry(agent.to_string()).or_default();
            a.busy = Some(action);
            a.failure = None;
        });
        self.record_unanswered(machine_pubkey, Unanswered::AgentAction { agent: agent.to_string() }, now);
    }

    pub fn apply_agent_ack(&mut self, machine_pubkey: &str, msg: &AgentAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.agent_actions.entry(msg.agent.clone()).or_default();
            a.busy = None;
            a.failure = (!msg.success).then(|| msg.error.clone().unwrap_or_else(|| "It could not be done.".into()));
        });
    }

    /// A list replaces the held one; a failed read keeps it and records why.
    pub fn apply_mcp(&mut self, machine_pubkey: &str, msg: &McpServersMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(msg.agent.clone()).or_default();
            match &msg.error {
                Some(error) => a.error = Some(error.clone()),
                None => {
                    a.error = None;
                    a.servers = msg.servers.clone();
                    a.toggles = msg.toggles;
                }
            }
        });
    }

    /// A change was sent: the servers it names are busy until acknowledged.
    pub fn mcp_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: McpAction, names: &[String], now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(agent.to_string()).or_default();
            for n in names {
                if !a.busy.contains(n) {
                    a.busy.push(n.clone());
                }
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Mcp { agent: agent.to_string(), action, names: names.to_vec() },
            now,
        );
    }

    pub fn apply_mcp_ack(&mut self, machine_pubkey: &str, msg: &McpAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(msg.agent.clone()).or_default();
            a.busy.retain(|n| !msg.names.contains(n));
            a.failure = (!msg.success).then(|| McpFailure {
                action: msg.action,
                names: msg.names.clone(),
                error: msg.error.clone().unwrap_or_else(|| "It could not be done.".into()),
            });
        });
    }

    /// A list replaces the held one; a failure keeps it and records why.
    /// Either way the answer settles every removal in flight: the bridge
    /// answers each request with exactly one message.
    pub fn apply_permission_rules(&mut self, machine_pubkey: &str, msg: &PermissionRulesMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.permission_rules.entry(msg.agent.clone()).or_default();
            a.busy.clear();
            match &msg.error {
                Some(error) => a.error = Some(error.clone()),
                None => {
                    a.error = None;
                    a.rules = msg.rules.clone();
                }
            }
        });
    }

    /// A list replaces what it covers — the connected accounts always, the
    /// whole catalogue when it is one; a failure keeps what is held and says
    /// why. Either way it settles every change in flight: the bridge answers
    /// each with exactly one message.
    pub fn apply_accounts(&mut self, machine_pubkey: &str, msg: &AccountsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(msg.agent.clone()).or_default();
            a.busy.clear();
            if let Some(error) = &msg.error {
                a.error = Some(error.clone());
                return;
            }
            a.error = None;
            a.connected = msg.accounts.iter().filter(|x| !x.connections.is_empty()).cloned().collect();
            if msg.all {
                a.all = Some(msg.accounts.clone());
            } else if let Some(all) = &mut a.all {
                // Keep the catalogue's connections in step with the list.
                for account in all.iter_mut() {
                    account.connections =
                        msg.accounts.iter().find(|x| x.id == account.id).map(|x| x.connections.clone()).unwrap_or_default();
                }
            }
        });
    }

    /// A change was sent: its account is busy until answered, and a sign-in
    /// is followed from here.
    pub fn account_action_sent(&mut self, machine_pubkey: &str, agent: &str, account: &str, sign_in: bool, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(agent.to_string()).or_default();
            if !a.busy.iter().any(|b| b == account) {
                a.busy.push(account.to_string());
            }
            if sign_in {
                a.sign_in = Some(SignInView { account: account.to_string(), status: SignInStatus::Started, attempt: None, error: None });
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Account { agent: agent.to_string(), account: account.to_string() },
            now,
        );
    }

    /// Where a sign-in stands. Its link and code stay shown until it ends;
    /// one about another sign-in than the one followed is not this client's
    /// to show.
    pub fn apply_account_sign_in(&mut self, machine_pubkey: &str, msg: &AccountSignInMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(msg.agent.clone()).or_default();
            a.busy.retain(|b| *b != msg.account);
            let Some(view) = &mut a.sign_in else { return };
            if view.account != msg.account {
                return;
            }
            let followed = view.attempt.as_ref().map(|x| x.attempt_id.clone());
            if let (Some(followed), Some(id)) = (&followed, &msg.attempt_id) {
                if followed != id {
                    return;
                }
            }
            view.status = msg.status;
            view.error = msg.error.clone();
            if let Some(attempt) = &msg.attempt {
                view.attempt = Some(attempt.clone());
            }
        });
    }

    /// The sign-in's result has been seen: stop showing it.
    pub fn dismiss_sign_in(&mut self, machine_pubkey: &str, agent: &str) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(a) = m.accounts.get_mut(agent) {
                a.sign_in = None;
            }
        });
    }

    /// A removal was sent: the rules it names are busy until answered.
    pub fn permission_rules_remove_sent(&mut self, machine_pubkey: &str, agent: &str, ids: &[String], now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.permission_rules.entry(agent.to_string()).or_default();
            for id in ids {
                if !a.busy.contains(id) {
                    a.busy.push(id.clone());
                }
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::PermissionRules { agent: agent.to_string(), ids: ids.to_vec() },
            now,
        );
    }

    /// A session's servers replace the held ones and settle every switch in
    /// flight; a failed answer keeps them and records why.
    pub fn apply_session_mcp(&mut self, machine_pubkey: &str, msg: &SessionMcpMsg) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(&msg.session_id) else { return };
            let held = s.mcp.get_or_insert_with(SessionMcp::default);
            held.busy.clear();
            match &msg.error {
                Some(error) => held.error = Some(error.clone()),
                None => {
                    *held = SessionMcp {
                        servers: msg.servers.clone(),
                        toggles: msg.toggles,
                        project_wide: msg.project_wide,
                        error: None,
                        busy: vec![],
                    }
                }
            }
        });
    }

    /// A switch was sent: that server is busy until the session answers.
    pub fn session_mcp_toggle_sent(&mut self, machine_pubkey: &str, session_id: &str, name: &str, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(session_id) else { return };
            let held = s.mcp.get_or_insert_with(SessionMcp::default);
            if !held.busy.iter().any(|n| n == name) {
                held.busy.push(name.to_string());
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::SessionMcp { session_id: session_id.to_string(), name: name.to_string() },
            now,
        );
    }

    /// Remember a change just sent, so [`Self::expire_unanswered`] can give up
    /// on it if no answer comes. Resending the same change replaces its
    /// timestamp rather than adding a second entry: the answer settles it
    /// once, so it must be given up on once.
    fn record_unanswered(&mut self, machine_pubkey: &str, item: Unanswered, now: u64) {
        if let Some(entry) = self.unanswered.iter_mut().find(|(m, u, _)| m == machine_pubkey && *u == item) {
            entry.2 = now;
            return;
        }
        self.unanswered.push((machine_pubkey.to_string(), item, now));
    }

    /// When the earliest unanswered change gives up, as a wall-clock ms — the
    /// runtime arms its timer for this. `None` when nothing is in flight.
    pub fn next_unanswered_deadline(&self) -> Option<u64> {
        self.unanswered
            .iter()
            .map(|(_, _, sent_at)| sent_at.saturating_add(SETTINGS_ANSWER_TIMEOUT_MS))
            .min()
    }

    /// Give up on every change sent before `now - SETTINGS_ANSWER_TIMEOUT_MS`
    /// and settle whatever it still has busy, so a machine that never answers
    /// does not leave the UI spinning. A change already answered is dropped
    /// without change; one whose machine or session is gone is just dropped.
    /// Returns whether any stored state changed.
    pub fn expire_unanswered(&mut self, now: u64) -> bool {
        let all = std::mem::take(&mut self.unanswered);
        let mut due = Vec::new();
        for entry in all {
            if entry.2.saturating_add(SETTINGS_ANSWER_TIMEOUT_MS) <= now {
                due.push(entry);
            } else {
                self.unanswered.push(entry);
            }
        }
        let mut changed = false;
        for (machine, item, _) in due {
            changed |= self.settle_unanswered(&machine, item);
        }
        changed
    }

    /// Settle one unanswered change: if what it names is still busy, clear it
    /// and record why. False when it was already answered or its machine or
    /// session is gone — nothing to change.
    fn settle_unanswered(&mut self, machine_pubkey: &str, item: Unanswered) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        match item {
            Unanswered::Plugin { agent, target, action } => {
                let Some(p) = m.plugins.get_mut(&agent) else { return false };
                if !p.busy.contains(&target) {
                    return false;
                }
                p.busy.retain(|t| *t != target);
                p.failure = Some(PluginFailure { action, target, error: NO_ANSWER.into() });
                true
            }
            Unanswered::AgentAction { agent } => {
                let Some(a) = m.agent_actions.get_mut(&agent) else { return false };
                if a.busy.is_none() {
                    return false;
                }
                a.busy = None;
                a.failure = Some(NO_ANSWER.into());
                true
            }
            Unanswered::Mcp { agent, action, names } => {
                let Some(a) = m.mcp.get_mut(&agent) else { return false };
                let still: Vec<String> = names.iter().filter(|n| a.busy.contains(*n)).cloned().collect();
                if still.is_empty() {
                    return false;
                }
                a.busy.retain(|n| !names.contains(n));
                a.failure = Some(McpFailure { action, names: still, error: NO_ANSWER.into() });
                true
            }
            Unanswered::PermissionRules { agent, ids } => {
                let Some(a) = m.permission_rules.get_mut(&agent) else { return false };
                if !ids.iter().any(|id| a.busy.contains(id)) {
                    return false;
                }
                a.busy.retain(|id| !ids.contains(id));
                a.error = Some(NO_ANSWER.into());
                true
            }
            Unanswered::Account { agent, account } => {
                let Some(a) = m.accounts.get_mut(&agent) else { return false };
                // Any answer about the account clears it from `busy`, so a
                // busy account is one the machine never answered for.
                if !a.busy.contains(&account) {
                    return false;
                }
                a.busy.retain(|b| *b != account);
                a.error = Some(NO_ANSWER.into());
                // A sign-in the machine never took up is reported failed
                // rather than left waiting for a link that will not come.
                if let Some(view) = a.sign_in.as_mut() {
                    if view.account == account && view.status == SignInStatus::Started && view.attempt.is_none() {
                        view.status = SignInStatus::Failed;
                        view.error = Some(NO_ANSWER.into());
                    }
                }
                true
            }
            Unanswered::SessionMcp { session_id, name } => {
                let Some(held) = m.sessions.get_mut(&session_id).and_then(|s| s.mcp.as_mut()) else {
                    return false;
                };
                if !held.busy.contains(&name) {
                    return false;
                }
                held.busy.retain(|n| *n != name);
                held.error = Some(NO_ANSWER.into());
                true
            }
        }
    }

    /// CDX-035: an EMPTY `models` is a "could not answer" report (it carries a
    /// reason) — it must never overwrite a good list. A non-empty answer is
    /// always authoritative and clears any stored reason. Applies only to the
    /// answering agent's entry, and only for a known machine.
    /// The agent running `session_id` on `machine`, when its bridge names a
    /// style for it that is not cached yet — what to ask that bridge for.
    pub fn missing_style(&self, machine_pubkey: &str, session_id: &str) -> Option<String> {
        let machine = self.machines.get(machine_pubkey)?;
        let agent = &machine.sessions.get(session_id)?.info.agent;
        let hash = machine.agent(agent)?.style_hash.as_deref()?;
        (!self.agent_styles.contains(hash)).then(|| agent.to_string())
    }

    /// A bridge's answer to `agent-style-request`. Returns whether the cache
    /// changed.
    pub fn apply_agent_style(&mut self, msg: &AgentStyleMsg) -> bool {
        let (Some(hash), Some(style)) = (&msg.style_hash, &msg.style) else {
            return false;
        };
        let named: BTreeSet<String> = self
            .machines
            .values()
            .flat_map(|m| m.agents.iter().filter_map(|a| a.style_hash.clone()))
            .collect();
        self.agent_styles.insert(hash, style.clone(), &named)
    }

    pub fn apply_models(&mut self, machine_pubkey: &str, msg: &ModelsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let entry = m.models.entry(msg.agent.clone()).or_default();
            if msg.models.is_empty() {
                entry.error = msg.error.clone();
                return;
            }
            entry.models = Some(msg.models.clone());
            if let Some(dm) = &msg.default_model {
                entry.default_model = Some(dm.clone());
            }
            entry.error = None;
        });
    }

    /// A `credentials-ack` for the bridge's own credentials (no `agent`)
    /// replaces the stored statuses; one for an agent patches that agent's
    /// catalog entry. Either way the next heartbeat re-states them.
    pub fn apply_credential_statuses(
        &mut self,
        machine_pubkey: &str,
        agent: Option<&str>,
        statuses: &[CredentialStatus],
    ) {
        self.with_machine(machine_pubkey, |m| match agent {
            None => m.credentials = statuses.to_vec(),
            Some(id) => {
                if let Some(a) = m.agents.iter_mut().find(|a| a.id == id) {
                    a.credentials = statuses.to_vec();
                }
            }
        });
    }

    /// CDX-062: plain replace (unlike `apply_models`) — the bridge always
    /// answers straight from storage, so an empty list truly means zero
    /// profiles.
    pub fn apply_provider_profiles(&mut self, machine_pubkey: &str, msg: &ProviderProfilesMsg) {
        self.with_machine(machine_pubkey, |m| {
            m.provider_profiles = Some(msg.profiles.clone());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::codec::decode_bridge_to_phone;
    use protocol::events::BridgeToPhone;
    use serde_json::json;

    fn info(id: &str) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: id.into(),
            agent: "claude-code".into(),
            slug: format!("slug-{id}"),
            cwd: "/work".into(),
            last_activity: "1970-01-01T00:00:00.000Z".into(),
            line_count: 0,
            title: None,
            project: "proj".into(),
            mode: None,
            effort: None,
            model: None,
            context_window: None,
            context_percentage: None,
            committed: None,
            state: None,
            seq_high: None,
            provider_id: None,
            provider_label: None,
            turn_started_at: None,
        }
    }

    fn titled(id: &str, title: &str) -> RemoteSessionInfo {
        RemoteSessionInfo {
            title: Some(title.into()),
            ..info(id)
        }
    }

    /// Build a `sessions` message by round-tripping through the real decoder —
    /// keeps the test honest against the wire schema.
    fn list(sessions: &[RemoteSessionInfo], extra: serde_json::Value) -> SessionListMsg {
        let mut obj = json!({
            "v": 12,
            "type": "sessions",
            "machine": "m1",
            "sessions": sessions,
            "agents": [],
            "v": protocol::capabilities::PROTOCOL_VERSION,
        });
        if let (Some(o), Some(e)) = (obj.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        match decode_bridge_to_phone(&obj.to_string()).unwrap() {
            BridgeToPhone::Sessions(m) => m,
            other => panic!("not a sessions message: {other:?}"),
        }
    }

    fn view(id: &str, presence: ListingPresence, last_listed_at: u64) -> SessionView {
        SessionView {
            info: info(id),
            presence,
            last_listed_at,
            usage: None,
            commands: None,
            mcp: None,
        }
    }

    fn map(views: Vec<SessionView>) -> BTreeMap<String, SessionView> {
        views.into_iter().map(|v| (v.info.id.clone(), v)).collect()
    }

    const NONE: fn() -> serde_json::Value = || json!({});

    #[test]
    fn an_incompatible_bridge_is_marked_until_it_is_read_and_never_persisted() {
        let mut st = MachinesState::default();
        st.machines.insert("pk".into(), MachineView::new("pk".into(), "m".into()));
        let next = u64::from(PROTOCOL_VERSION) + 1;
        assert!(Incompatible { theirs: Some(next), at: 0 }.app_is_older());
        assert!(!Incompatible { theirs: None, at: 0 }.app_is_older());
        assert!(!Incompatible { theirs: Some(10), at: 0 }.app_is_older());
        let mark = |st: &MachinesState| st.machine("pk").unwrap().incompatible.map(|i| i.theirs);

        assert!(!st.note_read("pk", 100));
        // A relay replaying a message from before the last one read.
        assert!(!st.note_unreadable("pk", None, 90));
        assert_eq!(mark(&st), None);

        assert!(st.note_unreadable("pk", Some(next), 110));
        assert!(!st.note_unreadable("pk", Some(next), 120), "no change, nothing to tell");
        assert_eq!(mark(&st), Some(Some(next)));
        assert!(!serialize_machines(&st.machines).contains("incompatible"));
        // An older readable message does not take the mark away; a newer one does.
        assert!(!st.note_read("pk", 115));
        assert!(st.note_read("pk", 120));
        assert_eq!(mark(&st), None);
        assert!(!st.note_unreadable("nobody", None, 200));
    }

    #[test]
    fn upserts_listed_sessions_as_live() {
        let next = merge_session_list(
            &BTreeMap::new(),
            &list(&[info("a"), info("b")], NONE()),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(next["a"].presence, ListingPresence::Live);
        assert_eq!(next["a"].last_listed_at, 100);
    }

    #[test]
    fn absence_never_deletes_a_missing_session_goes_stale() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(&prev, &list(&[info("a")], NONE()), 100, MergeOptions::default());
        assert_eq!(next["b"].presence, ListingPresence::Stale);
        assert_eq!(next["a"].presence, ListingPresence::Live);
    }

    #[test]
    fn an_empty_incoming_list_deletes_nothing() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
            view("c", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions::default());
        assert_eq!(next.len(), 3);
        assert!(next.values().all(|v| v.presence == ListingPresence::Stale));
    }

    #[test]
    fn tombstones_are_the_only_bridge_removal_and_only_hit_their_target() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(
            &prev,
            &list(&[info("a")], json!({ "removedSessions": ["b"] })),
            100,
            MergeOptions::default(),
        );
        assert!(!next.contains_key("b"));
        assert!(next.contains_key("a"));
    }

    #[test]
    fn a_tombstone_for_an_unknown_session_is_harmless() {
        let next = merge_session_list(
            &map(vec![view("a", ListingPresence::Live, 0)]),
            &list(&[info("a")], json!({ "removedSessions": ["ghost"] })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn machine_offline_keeps_every_session_marked_offline() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(
            &prev,
            &list(&[info("a")], json!({ "machineOffline": true })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.len(), 2);
        assert_eq!(next["a"].presence, ListingPresence::Offline);
        assert_eq!(next["b"].presence, ListingPresence::Offline);
    }

    #[test]
    fn grace_period_holds_a_recent_absentee_and_stales_an_old_one() {
        let prev = map(vec![
            view("fresh", ListingPresence::Live, 95),
            view("old", ListingPresence::Live, 10),
        ]);
        let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions { stale_grace_ms: 10 });
        assert_eq!(next["fresh"].presence, ListingPresence::Live);
        assert_eq!(next["old"].presence, ListingPresence::Stale);
    }

    #[test]
    fn merge_does_not_mutate_prev() {
        let prev = map(vec![view("a", ListingPresence::Live, 0)]);
        let snapshot = prev.clone();
        let _ = merge_session_list(
            &prev,
            &list(&[], json!({ "removedSessions": ["a"] })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(prev, snapshot);
    }

    // --- title merge guard ---

    #[test]
    fn a_titleless_incoming_session_keeps_the_held_title() {
        let prev = map(vec![SessionView {
            info: titled("s1", "client stopgap"),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 1, MergeOptions::default());
        assert_eq!(next["s1"].info.title.as_deref(), Some("client stopgap"));
    }

    #[test]
    fn a_non_null_incoming_title_always_wins() {
        let prev = map(vec![SessionView {
            info: titled("s1", "client stopgap"),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(
            &prev,
            &list(&[titled("s1", "bridge topical")], NONE()),
            1,
            MergeOptions::default(),
        );
        assert_eq!(next["s1"].info.title.as_deref(), Some("bridge topical"));
    }

    #[test]
    fn no_previous_title_incoming_null_stays_null() {
        let next = merge_session_list(
            &map(vec![view("s1", ListingPresence::Live, 0)]),
            &list(&[info("s1")], NONE()),
            1,
            MergeOptions::default(),
        );
        assert_eq!(next["s1"].info.title, None);
    }

    #[test]
    fn per_session_usage_survives_a_heartbeat() {
        let usage: UsageData = serde_json::from_value(json!({
            "available": true,
            "subscriptionType": null,
            "fiveHour": { "utilization": 0.2, "resetsAt": null },
            "fetchedAt": "1970-01-01T00:00:00.000Z"
        }))
        .unwrap();
        let prev = map(vec![SessionView {
            usage: Some(usage.clone()),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 5, MergeOptions::default());
        assert_eq!(next["s1"].usage, Some(usage));
    }

    // --- title_from_first_message ---

    #[test]
    fn title_from_first_message_truncation_is_exact() {
        let eighty = "a".repeat(80);
        assert_eq!(title_from_first_message(&eighty), eighty);
        let eighty_one = "b".repeat(81);
        assert_eq!(title_from_first_message(&eighty_one), format!("{}...", "b".repeat(77)));
        assert_eq!(title_from_first_message(&eighty_one).chars().count(), 80);
        assert_eq!(title_from_first_message("line1\nline2\n line3 "), "line1 line2  line3");
        assert_eq!(title_from_first_message("  \n \n "), "");
    }

    // --- dismissed sessions ---

    #[test]
    fn a_dismissal_ends_once_its_bridge_has_not_listed_it_for_a_while() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
        st.user_remove_session("pk", "a");
        st.dismiss_session("pk", "a", 1_000);
        // Dropped by the bridge: still dismissed through the resume window.
        st.apply_session_list("pk", &list(&[], NONE()), 1_000 + protocol::direct::OUTBOX_SECS * 1000);
        assert!(st.is_dismissed("a"));
        st.apply_session_list("pk", &list(&[], NONE()), 1_000 + DISMISSED_TTL_MS);
        assert!(!st.is_dismissed("a"));
        assert!(!st.is_dismissed("other"));
    }

    #[test]
    fn a_bridge_back_after_a_long_absence_does_not_bring_a_deleted_session_back() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
        st.user_remove_session("pk", "a");
        st.dismiss_session("pk", "a", 1_000);
        // No heartbeat for a day: by the bridge's heartbeats no time passed.
        let day = 24 * 3600 * 1000;
        st.apply_session_list("other", &list(&[], NONE()), day);
        assert!(st.is_dismissed("a"));
        // It comes back still listing it: still hidden, and the close is due.
        assert_eq!(st.apply_session_list("pk", &list(&[info("a")], NONE()), day + 1), ["a"]);
        assert!(st.session("pk", "a").is_none());
    }

    #[test]
    fn a_close_is_sent_again_while_the_bridge_lists_the_session_until_it_acks() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
        st.user_remove_session("pk", "a");
        st.dismiss_session("pk", "a", 1_000);
        st.note_close_sent("a", 1_000);
        let unclosed = st.apply_session_list("pk", &list(&[info("a")], NONE()), 2_000);
        assert!(st.closes_due(&unclosed, 2_000).is_empty(), "not again right away");
        let unclosed = st.apply_session_list("pk", &list(&[info("a")], NONE()), 1_000 + CLOSE_RETRY_MS);
        assert_eq!(st.closes_due(&unclosed, 1_000 + CLOSE_RETRY_MS), ["a"]);
        // Acknowledged: never sent again, and still kept out.
        st.note_closed("a");
        assert!(st.apply_session_list("pk", &list(&[info("a")], NONE()), 3 * CLOSE_RETRY_MS).is_empty());
        assert!(st.session("pk", "a").is_none());
    }

    #[test]
    fn removing_a_machine_forgets_the_sessions_deleted_on_it() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a")], NONE()), 1);
        st.user_remove_session("pk", "a");
        st.dismiss_session("pk", "a", 1_000);
        st.remove_machine("pk");
        assert!(!st.is_dismissed("a"));
    }

    #[test]
    fn dismissed_sessions_round_trip_and_garbage_is_empty() {
        let d: BTreeMap<String, Dismissed> =
            [("s".to_string(), Dismissed { machine: "pk".into(), at: 42, closed: true })].into_iter().collect();
        assert_eq!(hydrate_dismissed(Some(&serialize_dismissed(&d))), d);
        assert!(hydrate_dismissed(Some("[not a map")).is_empty());
        assert!(hydrate_dismissed(None).is_empty());
        // An entry it cannot read is skipped, not the whole map.
        let mixed = r#"{"old":42,"s":{"machine":"pk","at":42,"closed":true}}"#;
        assert_eq!(hydrate_dismissed(Some(mixed)), d);
    }

    // --- property: sessions are lost ONLY to tombstones ---

    fn prng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(s) / f64::from(u32::MAX)
        }
    }

    // --- MachinesState (store transforms) ---

    fn models_msg(ids: &[&str], default: Option<&str>) -> ModelsMsg {
        ModelsMsg {
            agent: "claude-code".into(),
            models: ids
                .iter()
                .map(|id| ModelEntry {
                    id: (*id).to_string(),
                    label: Some(id.to_uppercase()),
                    ..Default::default()
                })
                .collect(),
            default_model: default.map(str::to_string),
            error: None,
        }
    }

    fn agent_models<'a>(st: &'a MachinesState, agent: &str) -> &'a AgentModels {
        st.machine("pk").unwrap().models.get(agent).expect("agent entry")
    }

    #[test]
    fn apply_session_list_creates_the_machine_and_keeps_it_across_heartbeats() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
        st.apply_models("pk", &models_msg(&["opus", "sonnet"], Some("opus")));
        assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap().len(), 2);

        // CDX-022: the refresh-sessions heartbeat that used to wipe the picker.
        for at in [20, 30, 40, 50, 60] {
            st.apply_session_list("pk", &list(&[info("s1")], NONE()), at);
        }
        let kept = agent_models(&st, "claude-code");
        assert_eq!(
            kept.models.as_ref().unwrap().iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["opus", "sonnet"]
        );
        assert_eq!(kept.default_model.as_deref(), Some("opus"));
    }

    #[test]
    fn a_heartbeat_replaces_the_agent_catalog_and_bridge_credentials() {
        let mut st = MachinesState::default();
        st.apply_session_list(
            "pk",
            &list(
                &[],
                json!({
                    "agents": [{ "id": "claude-code", "displayName": "Claude Code", "supports": { "models": true } }],
                    "credentials": [{ "id": "github_pat", "label": "GitHub token", "present": true }],
                }),
            ),
            10,
        );
        let m = st.machine("pk").unwrap();
        assert!(m.agent("claude-code").unwrap().supports.models);
        assert!(m.agent("opencode").is_none());
        assert!(m.credentials[0].present);

        st.apply_session_list("pk", &list(&[], json!({ "agents": [{ "id": "opencode", "displayName": "OpenCode" }] })), 20);
        let m = st.machine("pk").unwrap();
        assert!(m.agent("claude-code").is_none());
        assert!(m.agent("opencode").is_some());
        assert!(m.credentials.is_empty());
    }

    #[test]
    fn a_style_is_wanted_until_its_hash_is_cached_and_shared_across_machines() {
        let style = protocol::common::AgentStyle { accent: Some("#D77757".into()), ..Default::default() };
        let hash = style.hash();
        let catalog = json!({ "agents": [
            { "id": "claude-code", "displayName": "Claude Code", "styleHash": hash },
            { "id": "opencode", "displayName": "OpenCode" },
        ] });
        let mut opencode = info("s2");
        opencode.agent = "opencode".into();
        let mut st = MachinesState::default();
        st.apply_session_list("a", &list(&[info("s1"), opencode], catalog.clone()), 10);
        st.apply_session_list("b", &list(&[info("s3")], catalog), 10);

        assert_eq!(st.missing_style("a", "s1").as_deref(), Some("claude-code"));
        assert_eq!(st.missing_style("a", "s2"), None, "an agent with no style");
        assert_eq!(st.missing_style("a", "nope"), None);

        let answer = |hash: Option<String>| AgentStyleMsg { agent: "claude-code".into(), style_hash: hash, style: Some(style.clone()) };
        assert!(!st.apply_agent_style(&answer(Some("0123456789abcdef".into()))), "not the style's hash");
        assert!(!st.apply_agent_style(&answer(None)));
        assert!(st.apply_agent_style(&answer(Some(hash.clone()))));
        assert_eq!(st.missing_style("a", "s1"), None);
        assert_eq!(st.missing_style("b", "s3"), None, "the same hash on another bridge");
        assert_eq!(st.agent_styles.get(&hash), Some(&style));
    }

    #[test]
    fn an_empty_models_response_never_wipes_a_good_list_and_carries_the_reason() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 10);
        st.apply_models("pk", &models_msg(&["opus"], None));
        st.apply_models(
            "pk",
            &ModelsMsg {
                agent: "claude-code".into(),
                models: vec![],
                default_model: None,
                error: Some("no live SDK".into()),
            },
        );
        assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap()[0].id, "opus");
        assert_eq!(agent_models(&st, "claude-code").error.as_deref(), Some("no live SDK"));
        // a later good answer clears the error
        st.apply_models("pk", &models_msg(&["opus", "sonnet"], None));
        assert_eq!(agent_models(&st, "claude-code").error, None);
    }

    #[test]
    fn session_commands_keep_the_held_list_on_an_error_and_are_never_persisted() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
        let cmd = |name: &str| SlashCommand { name: name.into(), description: None, argument_hint: None };
        let msg = |commands: Vec<SlashCommand>, error: Option<&str>| CommandsMsg {
            session_id: "s1".into(),
            commands,
            error: error.map(str::to_string),
        };
        let held = |st: &MachinesState| st.machine("pk").unwrap().sessions["s1"].commands.clone().unwrap();

        st.apply_commands("pk", &msg(vec![cmd("compact")], None));
        st.apply_commands("pk", &msg(vec![], Some("not running")));
        assert_eq!(held(&st), SessionCommands { commands: vec![cmd("compact")], error: Some("not running".into()) });
        st.apply_commands("pk", &msg(vec![cmd("init")], None));
        assert_eq!(held(&st), SessionCommands { commands: vec![cmd("init")], error: None });

        // Survives a heartbeat, but not a restart.
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 20);
        assert_eq!(held(&st).commands, vec![cmd("init")]);
        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert_eq!(back["pk"].sessions["s1"].commands, None);
    }

    #[test]
    fn an_agent_action_is_busy_until_acknowledged_and_never_persisted() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let held = |st: &MachinesState| st.machine("pk").unwrap().agent_actions["opencode"].clone();
        let ack = |success: bool, error: Option<&str>| AgentAckMsg {
            agent: "opencode".into(),
            action: AgentAction::Remove,
            success,
            error: error.map(str::to_string),
        };

        st.agent_action_sent("pk", "opencode", AgentAction::Remove, 0);
        assert_eq!(held(&st).busy, Some(AgentAction::Remove));
        assert!(serialize_machines(&st.machines).find("agentActions").is_none());
        st.apply_agent_ack("pk", &ack(false, Some("not removable")));
        assert_eq!(held(&st), AgentActionState { busy: None, failure: Some("not removable".into()) });
        st.agent_action_sent("pk", "opencode", AgentAction::Install, 0);
        assert_eq!(held(&st).failure, None, "a new action clears the last refusal");
        st.apply_agent_ack("pk", &ack(true, None));
        assert_eq!(held(&st), AgentActionState::default());
    }

    #[test]
    fn accounts_follow_a_sign_in_keep_their_list_on_errors_and_are_never_persisted() {
        use protocol::common::AccountConnection;
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let account = |id: &str, connected: bool| AgentAccount {
            id: id.into(),
            name: id.into(),
            methods: vec![],
            connections: if connected {
                vec![AccountConnection { id: "c".into(), label: "l".into(), kind: "key".into(), active: true, removable: true }]
            } else {
                vec![]
            },
        };
        let list = |accounts: Vec<AgentAccount>, all: bool, error: Option<&str>| AccountsMsg {
            agent: "opencode".into(),
            accounts,
            all,
            error: error.map(Into::into),
        };
        let held = |st: &MachinesState| st.machine("pk").unwrap().accounts["opencode"].clone();

        st.apply_accounts("pk", &list(vec![account("a", true), account("b", false)], true, None));
        assert_eq!(held(&st).connected.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(held(&st).all.as_ref().map(Vec::len), Some(2));

        // A sign-in: followed from the moment it is asked, its attempt kept
        // until it ends; an answer about another attempt is not shown.
        st.account_action_sent("pk", "opencode", "b", true, 0);
        assert_eq!(held(&st).busy, ["b"]);
        let attempt = SignInAttempt {
            attempt_id: "con_1".into(),
            url: "https://x".into(),
            instructions: "Enter code: X".into(),
            expires_at: 1,
            paste_back: false,
        };
        let sign_in = |status, id: &str, attempt: Option<SignInAttempt>| AccountSignInMsg {
            agent: "opencode".into(),
            account: "b".into(),
            status,
            attempt_id: Some(id.into()),
            attempt,
            error: None,
        };
        st.apply_account_sign_in("pk", &sign_in(SignInStatus::Started, "con_1", Some(attempt.clone())));
        st.apply_account_sign_in("pk", &sign_in(SignInStatus::Failed, "con_0", None));
        assert_eq!(held(&st).sign_in.unwrap().status, SignInStatus::Started);
        st.apply_account_sign_in("pk", &sign_in(SignInStatus::Complete, "con_1", None));
        let view = held(&st).sign_in.unwrap();
        assert_eq!((view.status, view.attempt), (SignInStatus::Complete, Some(attempt)));
        assert!(held(&st).busy.is_empty());

        // A connected list after a change keeps the catalogue in step; a
        // failure keeps both.
        st.apply_accounts("pk", &list(vec![account("a", true), account("b", true)], false, None));
        assert_eq!(held(&st).all.unwrap().iter().filter(|x| !x.connections.is_empty()).count(), 2);
        st.apply_accounts("pk", &list(vec![], false, Some("no opencode")));
        assert_eq!(held(&st).connected.len(), 2);
        assert_eq!(held(&st).error.as_deref(), Some("no opencode"));

        st.dismiss_sign_in("pk", "opencode");
        assert!(held(&st).sign_in.is_none());
        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(back["pk"].accounts.is_empty());
    }

    #[test]
    fn permission_rules_track_removals_keep_their_list_on_errors_and_are_never_persisted() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let rule = |id: &str| PermissionRule {
            id: id.into(),
            project: "/w".into(),
            tool: "shell".into(),
            pattern: "git status *".into(),
            created_at: 1,
        };
        let msg = |rules: Vec<PermissionRule>, error: Option<&str>| PermissionRulesMsg {
            agent: "opencode".into(),
            rules,
            error: error.map(Into::into),
        };
        let held = |st: &MachinesState| st.machine("pk").unwrap().permission_rules["opencode"].clone();

        st.apply_permission_rules("pk", &msg(vec![rule("a"), rule("b")], None));
        st.permission_rules_remove_sent("pk", "opencode", &["a".to_string()], 0);
        assert_eq!(held(&st).busy, ["a"]);
        // A refused removal keeps the list and says why; nothing stays busy.
        st.apply_permission_rules("pk", &msg(vec![], Some("database is locked")));
        assert_eq!(held(&st).rules.len(), 2);
        assert_eq!(held(&st).error.as_deref(), Some("database is locked"));
        assert!(held(&st).busy.is_empty());
        // The list after a removal replaces it and clears the error.
        st.apply_permission_rules("pk", &msg(vec![rule("b")], None));
        assert_eq!(held(&st), AgentPermissionRules { rules: vec![rule("b")], error: None, busy: vec![] });

        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(back["pk"].permission_rules.is_empty());
    }

    #[test]
    fn mcp_servers_track_changes_in_flight_keep_their_list_on_errors_and_are_never_persisted() {
        use protocol::common::{McpStatus, McpTransportKind};
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        st.apply_session_upsert("pk", &info("s1"), 0);
        let server = |name: &str| McpServerInfo {
            name: name.into(),
            transport: McpTransportKind::Http,
            target: "https://x".into(),
            env_keys: vec![],
            header_keys: vec!["Authorization".into()],
            enabled: true,
        };
        let list = |servers: Vec<McpServerInfo>, error: Option<&str>| McpServersMsg {
            agent: "claude-code".into(),
            servers,
            toggles: false,
            error: error.map(str::to_string),
        };
        let held = |st: &MachinesState| st.machine("pk").unwrap().mcp["claude-code"].clone();

        st.apply_mcp("pk", &list(vec![server("gh")], None));
        st.mcp_action_sent("pk", "claude-code", McpAction::Add, &["fs".to_string()], 0);
        assert_eq!(held(&st).busy, ["fs"]);
        st.apply_mcp_ack("pk", &McpAckMsg {
            agent: "claude-code".into(),
            action: McpAction::Add,
            names: vec!["fs".into()],
            success: false,
            error: Some("bad".into()),
        });
        assert!(held(&st).busy.is_empty());
        assert_eq!(held(&st).failure.unwrap().error, "bad");
        st.apply_mcp("pk", &list(vec![], Some("no claude")));
        assert_eq!(held(&st).servers, vec![server("gh")], "the held list stays");

        let status = |status: McpStatus, error: Option<&str>| SessionMcpMsg {
            session_id: "s1".into(),
            servers: if error.is_some() { vec![] } else { vec![SessionMcpServer { name: "gh".into(), status, error: None, tools: None }] },
            toggles: true,
            project_wide: false,
            error: error.map(str::to_string),
        };
        st.apply_session_mcp("pk", &status(McpStatus::Connected, None));
        st.session_mcp_toggle_sent("pk", "s1", "gh", 0);
        let session = |st: &MachinesState| st.machine("pk").unwrap().sessions["s1"].mcp.clone().unwrap();
        assert_eq!(session(&st).busy, ["gh"]);
        st.apply_session_mcp("pk", &status(McpStatus::Disabled, Some("refused")));
        assert!(session(&st).busy.is_empty());
        assert_eq!(session(&st).servers[0].status, McpStatus::Connected, "kept on an error");

        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(back["pk"].mcp.is_empty());
        assert_eq!(back["pk"].sessions["s1"].mcp, None);
    }

    #[test]
    fn plugins_track_changes_in_flight_and_are_never_persisted() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 10);
        let installed = |id: &str| InstalledPlugin {
            id: id.into(),
            name: id.into(),
            marketplace: None,
            version: None,
            description: None,
            enabled: true,
        };
        let offer = |id: &str| AvailablePlugin {
            id: id.into(),
            name: id.into(),
            marketplace: "m".into(),
            description: None,
            install_count: None,
        };
        let msg = |installed: Vec<InstalledPlugin>, available: Option<Vec<AvailablePlugin>>, error: Option<&str>| PluginsMsg {
            agent: "claude-code".into(),
            installed,
            marketplaces: Some(vec![]),
            toggles: true,
            available,
            error: error.map(str::to_string),
        };
        let held = |st: &MachinesState| st.machine("pk").unwrap().plugins["claude-code"].clone();

        st.apply_plugins("pk", &msg(vec![installed("a@m")], Some(vec![offer("b@m"), offer("c@m")]), None));
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
        assert_eq!(held(&st).busy, vec!["b@m".to_string()]);

        // Installed: acknowledged, then the new list without the offer.
        let ack = |success: bool| PluginAckMsg {
            agent: "claude-code".into(),
            action: PluginAction::Install,
            target: "b@m".into(),
            success,
            error: (!success).then(|| "not found".into()),
            message: None,
        };
        st.apply_plugin_ack("pk", &ack(true));
        st.apply_plugins("pk", &msg(vec![installed("a@m"), installed("b@m")], None, None));
        let p = held(&st);
        assert!(p.busy.is_empty() && p.failure.is_none());
        assert_eq!(p.available.unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["c@m"]);

        // A success with something to say keeps it; the next change sent
        // clears it, and a failure leaves nothing.
        let mut said = ack(true);
        said.message = Some("Updated from 0.1.0 to 0.2.0.".into());
        st.apply_plugin_ack("pk", &said);
        assert_eq!(held(&st).notice.as_ref().map(|n| n.message.as_str()), Some("Updated from 0.1.0 to 0.2.0."));
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
        assert_eq!(held(&st).notice, None);
        st.apply_plugin_ack("pk", &ack(false));
        assert_eq!(held(&st).notice, None);

        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
        st.apply_plugin_ack("pk", &ack(false));
        assert_eq!(held(&st).failure.map(|f| f.error), Some("not found".into()));

        // A failed read keeps what is held.
        st.apply_plugins("pk", &msg(vec![], None, Some("no claude")));
        assert_eq!((held(&st).installed.len(), held(&st).error), (2, Some("no claude".into())));

        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(back["pk"].plugins.is_empty());
    }

    #[test]
    fn a_machine_settings_change_nobody_answers_settles_at_the_timeout() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        st.apply_session_upsert("pk", &info("s1"), 0);
        let t = 1_000;
        let done = t + SETTINGS_ANSWER_TIMEOUT_MS;

        // One change of every kind, all sent at the same instant.
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
        st.agent_action_sent("pk", "opencode", AgentAction::Install, t);
        st.mcp_action_sent("pk", "claude-code", McpAction::Add, &["fs".to_string()], t);
        st.permission_rules_remove_sent("pk", "opencode", &["r1".to_string()], t);
        st.account_action_sent("pk", "opencode", "a", true, t);
        st.apply_session_mcp(
            "pk",
            &SessionMcpMsg { session_id: "s1".into(), servers: vec![], toggles: true, project_wide: false, error: None },
        );
        st.session_mcp_toggle_sent("pk", "s1", "gh", t);

        // Not before the deadline: everything is still in flight.
        assert!(!st.expire_unanswered(done - 1));
        let m = st.machine("pk").unwrap();
        assert!(m.plugins["claude-code"].busy.contains(&"b@m".to_string()));
        assert!(m.agent_actions["opencode"].busy.is_some());
        assert!(m.mcp["claude-code"].busy.contains(&"fs".to_string()));
        assert!(m.permission_rules["opencode"].busy.contains(&"r1".to_string()));
        assert!(m.accounts["opencode"].busy.contains(&"a".to_string()));
        assert!(m.sessions["s1"].mcp.as_ref().unwrap().busy.contains(&"gh".to_string()));

        // At the deadline each settles and says why.
        assert!(st.expire_unanswered(done));
        let m = st.machine("pk").unwrap();
        let p = &m.plugins["claude-code"];
        assert!(p.busy.is_empty());
        assert_eq!(p.failure.as_ref().unwrap().error, NO_ANSWER);
        assert!(m.agent_actions["opencode"].busy.is_none());
        assert_eq!(m.agent_actions["opencode"].failure.as_deref(), Some(NO_ANSWER));
        let mcp = &m.mcp["claude-code"];
        assert!(mcp.busy.is_empty());
        assert_eq!(mcp.failure.as_ref().map(|f| (f.names.clone(), f.error.as_str())), Some((vec!["fs".to_string()], NO_ANSWER)));
        assert!(m.permission_rules["opencode"].busy.is_empty());
        assert_eq!(m.permission_rules["opencode"].error.as_deref(), Some(NO_ANSWER));
        let acct = &m.accounts["opencode"];
        assert!(acct.busy.is_empty());
        assert_eq!(acct.error.as_deref(), Some(NO_ANSWER));
        let sign_in = acct.sign_in.as_ref().unwrap();
        assert_eq!(sign_in.status, SignInStatus::Failed);
        assert_eq!(sign_in.error.as_deref(), Some(NO_ANSWER));
        let session = m.sessions["s1"].mcp.as_ref().unwrap();
        assert!(session.busy.is_empty());
        assert_eq!(session.error.as_deref(), Some(NO_ANSWER));
    }

    #[test]
    fn a_change_answered_before_its_deadline_is_not_touched_by_giving_up() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let t = 1_000;
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
        st.apply_plugin_ack(
            "pk",
            &PluginAckMsg {
                agent: "claude-code".into(),
                action: PluginAction::Install,
                target: "b@m".into(),
                success: true,
                error: None,
                message: None,
            },
        );

        // It is settled, so giving up on it reports no change and does not
        // overwrite the answer with a "did not answer".
        assert!(!st.expire_unanswered(t + SETTINGS_ANSWER_TIMEOUT_MS));
        let p = &st.machine("pk").unwrap().plugins["claude-code"];
        assert!(p.busy.is_empty());
        assert!(p.failure.is_none());
    }

    #[test]
    fn a_sign_in_the_machine_answered_is_not_failed_by_giving_up() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let t = 1_000;
        st.account_action_sent("pk", "opencode", "b", true, t);
        // The machine answers, but says nothing yet about what to do.
        st.apply_account_sign_in(
            "pk",
            &AccountSignInMsg {
                agent: "opencode".into(),
                account: "b".into(),
                status: SignInStatus::Started,
                attempt_id: None,
                attempt: None,
                error: None,
            },
        );

        assert!(!st.expire_unanswered(t + SETTINGS_ANSWER_TIMEOUT_MS));
        let a = &st.machine("pk").unwrap().accounts["opencode"];
        assert_eq!(a.sign_in.as_ref().unwrap().status, SignInStatus::Started);
        assert!(a.error.is_none());
    }

    #[test]
    fn resending_a_change_pushes_its_deadline_without_duplicating_it() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 1_000);
        assert_eq!(st.next_unanswered_deadline(), Some(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 2_000);
        assert_eq!(
            st.next_unanswered_deadline(),
            Some(2_000 + SETTINGS_ANSWER_TIMEOUT_MS),
            "the resend replaces the entry's time rather than adding a second"
        );

        // The first deadline passes without effect; the second gives up.
        assert!(!st.expire_unanswered(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        assert!(st.machine("pk").unwrap().plugins["claude-code"].busy.contains(&"b@m".to_string()));
        assert!(st.expire_unanswered(2_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        assert!(st.machine("pk").unwrap().plugins["claude-code"].busy.is_empty());
    }

    #[test]
    fn an_answer_that_arrives_after_the_giving_up_still_applies() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        let t = 1_000;
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", t);
        assert!(st.expire_unanswered(t + SETTINGS_ANSWER_TIMEOUT_MS));
        assert!(st.machine("pk").unwrap().plugins["claude-code"].failure.is_some());

        // A late answer lands normally and replaces the "did not answer" note.
        st.apply_plugin_ack(
            "pk",
            &PluginAckMsg {
                agent: "claude-code".into(),
                action: PluginAction::Install,
                target: "b@m".into(),
                success: true,
                error: None,
                message: Some("done".into()),
            },
        );
        let p = &st.machine("pk").unwrap().plugins["claude-code"];
        assert!(p.failure.is_none());
        assert_eq!(p.notice.as_ref().map(|n| n.message.as_str()), Some("done"));
    }

    #[test]
    fn the_next_deadline_is_the_earliest_change_still_in_flight() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        assert_eq!(st.next_unanswered_deadline(), None);
        st.agent_action_sent("pk", "opencode", AgentAction::Install, 5_000);
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 1_000);
        assert_eq!(st.next_unanswered_deadline(), Some(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));

        // Giving up on the earliest leaves the later one in flight.
        assert!(st.expire_unanswered(1_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        assert_eq!(st.next_unanswered_deadline(), Some(5_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        assert!(st.expire_unanswered(5_000 + SETTINGS_ANSWER_TIMEOUT_MS));
        assert_eq!(st.next_unanswered_deadline(), None);
    }

    #[test]
    fn giving_up_on_a_change_whose_machine_is_gone_changes_nothing() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "m", None, None, &[]);
        st.plugin_action_sent("pk", "claude-code", PluginAction::Install, "b@m", 0);
        st.remove_machine("pk");
        assert!(!st.expire_unanswered(SETTINGS_ANSWER_TIMEOUT_MS));
        assert_eq!(st.next_unanswered_deadline(), None);
    }

    #[test]
    fn each_agents_model_list_is_tracked_separately() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 10);
        st.apply_models("pk", &models_msg(&["opus"], Some("opus")));
        st.apply_models(
            "pk",
            &ModelsMsg {
                agent: "opencode".into(),
                models: vec![ModelEntry { id: "gpt".into(), ..Default::default() }],
                default_model: None,
                error: None,
            },
        );
        st.apply_models(
            "pk",
            &ModelsMsg {
                agent: "opencode".into(),
                models: vec![],
                default_model: None,
                error: Some("opencode offline".into()),
            },
        );
        assert_eq!(agent_models(&st, "claude-code").models.as_ref().unwrap()[0].id, "opus");
        assert_eq!(agent_models(&st, "claude-code").default_model.as_deref(), Some("opus"));
        assert_eq!(agent_models(&st, "claude-code").error, None);
        assert_eq!(agent_models(&st, "opencode").models.as_ref().unwrap()[0].id, "gpt");
        assert_eq!(agent_models(&st, "opencode").error.as_deref(), Some("opencode offline"));
    }

    #[test]
    fn a_credentials_ack_patches_the_bridge_or_the_named_agent() {
        let mut st = MachinesState::default();
        st.apply_session_list(
            "pk",
            &list(&[], json!({ "agents": [{ "id": "claude-code", "displayName": "Claude Code" }] })),
            10,
        );
        let set = |id: &str| CredentialStatus {
            id: id.into(),
            label: id.into(),
            present: true,
            from_env: false,
            valid: Some(true),
        };
        st.apply_credential_statuses("pk", Some("claude-code"), &[set("anthropic_api_key")]);
        st.apply_credential_statuses("pk", None, &[set("github_pat")]);
        let m = st.machine("pk").unwrap();
        assert_eq!(m.agent("claude-code").unwrap().credentials[0].id, "anthropic_api_key");
        assert_eq!(m.credentials[0].id, "github_pat");
    }

    #[test]
    fn a_field_less_heartbeat_keeps_the_host_badge_but_a_new_host_wins() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], json!({ "host": "service" })), 10);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Service));
        st.apply_session_list("pk", &list(&[], NONE()), 20);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Service));
        st.apply_session_list("pk", &list(&[], json!({ "host": "cli" })), 30);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Cli));
    }

    #[test]
    fn two_pubkeys_with_the_same_name_stay_two_machines() {
        let mut st = MachinesState::default();
        st.apply_session_list("pkA", &list(&[], json!({ "machine": "box", "host": "cli" })), 1);
        st.apply_session_list("pkB", &list(&[], json!({ "machine": "box", "host": "service" })), 1);
        assert_eq!(st.machine_pubkeys(), vec!["pkA", "pkB"]);
        assert_eq!(st.machine("pkA").unwrap().host, Some(BridgeHostKind::Cli));
        assert_eq!(st.machine("pkB").unwrap().host, Some(BridgeHostKind::Service));
    }

    #[test]
    fn user_remove_session_is_a_local_removal_path() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
        st.user_remove_session("pk", "a");
        assert!(st.session("pk", "a").is_none());
        assert!(st.session("pk", "b").is_some());
    }

    #[test]
    fn the_resurrection_shield_keeps_a_deleted_session_out_of_a_stale_heartbeat() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
        // deleteController does both: remove now + shield against resurrection.
        st.user_remove_session("pk", "a");
        st.dismiss_session("pk", "a", 2);
        // a stale heartbeat still lists `a` — the shield filters it BEFORE the
        // merge, so it does not come back, however long that goes on.
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 3);
        assert!(st.session("pk", "a").is_none());
        assert!(st.session("pk", "b").is_some());
        st.apply_session_list("pk", &list(&[info("a")], NONE()), DISMISSED_TTL_MS + 4);
        assert!(st.session("pk", "a").is_none());
    }

    #[test]
    fn title_guard_covers_upsert() {
        let mut st = MachinesState::default();
        st.register_machine("m1", "m1", None, None, &[]);
        st.apply_session_upsert("m1", &info("s1"), 0);
        st.note_first_user_message("m1", "s1", "stopgap");

        st.apply_session_upsert("m1", &info("s1"), 1); // titleless upsert
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("stopgap"));

        st.apply_session_upsert("m1", &titled("s1", "bridge"), 2); // titled wins
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("bridge"));
    }

    #[test]
    fn note_first_user_message_only_titles_an_untitled_known_session_once() {
        let mut st = MachinesState::default();
        st.register_machine("m1", "m1", None, None, &[]);
        st.apply_session_upsert("m1", &info("s1"), 0);

        st.note_first_user_message("m1", "UNKNOWN", "hi");
        assert!(st.session("m1", "UNKNOWN").is_none());

        st.note_first_user_message("m1", "s1", "first\nmessage  ");
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));
        st.note_first_user_message("m1", "s1", "second");
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));

        st.apply_session_upsert("m1", &info("s2"), 1);
        st.note_first_user_message("m1", "s2", "  \n \n ");
        assert_eq!(st.session("m1", "s2").unwrap().info.title, None);
    }

    #[test]
    fn update_session_info_patches_in_place() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 1);
        st.update_session_info("pk", "s1", |i| i.model = Some("opus".into()));
        assert_eq!(st.session("pk", "s1").unwrap().info.model.as_deref(), Some("opus"));
        // unknown session is a no-op, not a panic
        st.update_session_info("pk", "ghost", |i| i.model = Some("x".into()));
    }

    #[test]
    fn relays_are_per_machine_learned_at_pairing_and_editable() {
        let mut st = MachinesState::default();
        let r = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        st.register_machine("pk1", "M1", None, None, &r(&["wss://a", "wss://b"]));
        st.register_machine("pk2", "M2", None, None, &r(&["wss://b", "wss://c"]));
        // Re-pairing adds what it learned, keeps what was there.
        st.register_machine("pk1", "M1", None, None, &r(&["wss://d"]));
        assert_eq!(st.machine("pk1").unwrap().relays, r(&["wss://a", "wss://b", "wss://d"]));
        assert_eq!(st.relay_set(), r(&["wss://a", "wss://b", "wss://d", "wss://c"]));

        assert!(st.set_relays("pk2", r(&[" wss://c ", "wss://e", "wss://c"])));
        assert_eq!(st.machine("pk2").unwrap().relays, r(&["wss://c", "wss://e"]));
        // Never left unreachable, never a URL the phone may not dial.
        assert!(!st.set_relays("pk2", vec![]));
        assert!(!st.set_relays("pk2", r(&["ws://cleartext.example"])));
        assert!(!st.set_relays("ghost", r(&["wss://x"])));
        assert_eq!(st.machine("pk2").unwrap().relays, r(&["wss://c", "wss://e"]));

        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert_eq!(back["pk2"].relays, r(&["wss://c", "wss://e"]));
    }

    #[test]
    fn new_session_defaults_are_per_machine_and_agent() {
        let mut st = MachinesState::default();
        st.register_machine("pk", "M", None, None, &[]);
        assert!(st.set_default_agent("pk", Some(" opencode ".into())));
        let d = |mode: &str, model: &str| AgentDefaults { mode: mode.into(), effort: String::new(), model: model.into() };
        assert!(st.set_agent_defaults("pk", "claude-code", d("plan", " opus ")));
        assert_eq!(st.machine("pk").unwrap().default_agent.as_deref(), Some("opencode"));
        assert_eq!(st.machine("pk").unwrap().agent_defaults["claude-code"], d("plan", "opus"));

        let back = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert_eq!(back["pk"].agent_defaults["claude-code"], d("plan", "opus"));

        // All-empty forgets the agent's entry; an empty agent clears the pick.
        assert!(st.set_agent_defaults("pk", "claude-code", AgentDefaults::default()));
        assert!(st.machine("pk").unwrap().agent_defaults.is_empty());
        assert!(st.set_default_agent("pk", Some("".into())));
        assert_eq!(st.machine("pk").unwrap().default_agent, None);
        assert!(!st.set_default_agent("ghost", None));
    }

    #[test]
    fn serialize_then_hydrate_never_truncates() {
        let mut st = MachinesState::default();
        st.register_machine("pk1", "M1", Some("Laptop".into()), None, &[]);
        st.apply_session_list("pk1", &list(&[info("a"), info("b")], NONE()), 50);
        st.apply_session_list("pk1", &list(&[info("a")], NONE()), 60); // b -> stale
        st.register_machine("pk2", "M2", None, None, &[]);
        st.apply_models("pk1", &models_msg(&["opus", "fable"], Some("opus")));

        let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert_eq!(hydrated.keys().cloned().collect::<Vec<_>>(), vec!["pk1", "pk2"]);
        assert_eq!(
            hydrated["pk1"].sessions.keys().cloned().collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(hydrated["pk1"].sessions["b"].presence, ListingPresence::Offline);
        assert_eq!(hydrated["pk1"].label.as_deref(), Some("Laptop"));
        assert!(hydrated["pk1"].machine_offline); // honest until a live heartbeat
        assert_eq!(
            hydrated["pk1"].models["claude-code"].models.as_ref().unwrap()[0].id,
            "opus"
        );
    }

    #[test]
    fn hydrate_tolerates_garbage_without_panicking() {
        assert!(hydrate_machines(None).is_empty());
        assert!(hydrate_machines(Some("not json")).is_empty());
        assert!(hydrate_machines(Some(r#"{"a":1}"#)).is_empty());
        assert!(hydrate_machines(Some(r#"[{"nope":true}]"#)).is_empty());
    }

    #[test]
    fn provider_profiles_never_persist_but_survive_hydration_round_trip_as_none() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 1);
        st.apply_provider_profiles(
            "pk",
            &ProviderProfilesMsg { machine: "pk".into(), profiles: vec![] },
        );
        assert!(st.machine("pk").unwrap().provider_profiles.is_some());
        let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(hydrated["pk"].provider_profiles.is_none());
    }

    /// `#[serde(skip)]` would have hidden `provider_profiles` from every
    /// serialization, including the live `MachinesView` the UI reads over IPC
    /// — silently breaking the machine-providers screen the moment the phone
    /// re-points at this core. Only `serialize_machines` (the KV-persistence
    /// path) may strip it.
    #[test]
    fn provider_profiles_serializes_in_the_live_view_json() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 1);
        st.apply_provider_profiles(
            "pk",
            &ProviderProfilesMsg {
                machine: "pk".into(),
                profiles: vec![ProviderProfileInfo {
                    id: "prof1".into(),
                    agent: "claude-code".into(),
                    label: "Anthropic".into(),
                    base_url: "https://api.example".into(),
                    models: vec![],
                    models_from_provider: false,
                    default_model: None,
                    has_token: true,
                    error: None,
                }],
            },
        );
        let json = serde_json::to_string(st.machine("pk").unwrap()).unwrap();
        assert!(json.contains("providerProfiles"));
        assert!(json.contains("prof1"));
    }

    #[test]
    fn property_sessions_survive_everything_but_a_tombstone() {
        let universe: Vec<String> = (0..8).map(|i| format!("s{i}")).collect();
        for seed in 1..=200u32 {
            let mut rnd = prng(seed);
            let mut state: BTreeMap<String, SessionView> = BTreeMap::new();
            let mut ever_known: std::collections::BTreeSet<String> = Default::default();
            let mut tombstoned: std::collections::BTreeSet<String> = Default::default();
            let mut now = 0u64;

            for step in 0..30 {
                now += (rnd() * 1000.0) as u64;
                let listed: Vec<RemoteSessionInfo> = universe
                    .iter()
                    .filter(|_| rnd() < 0.4)
                    .map(|id| info(id))
                    .collect();
                let removed: Vec<String> =
                    universe.iter().filter(|_| rnd() < 0.1).cloned().collect();
                let machine_offline = rnd() < 0.15;

                let mut extra = serde_json::Map::new();
                if !removed.is_empty() {
                    extra.insert("removedSessions".into(), json!(removed));
                }
                if machine_offline {
                    extra.insert("machineOffline".into(), json!(true));
                }
                let msg = list(&listed, serde_json::Value::Object(extra));

                for s in &listed {
                    ever_known.insert(s.id.clone());
                    tombstoned.remove(&s.id); // re-listing resurrects
                }
                for id in &removed {
                    tombstoned.insert(id.clone());
                }

                state = merge_session_list(&state, &msg, now, MergeOptions::default());

                for id in &ever_known {
                    if tombstoned.contains(id) {
                        assert!(
                            !state.contains_key(id),
                            "seed {seed} step {step}: tombstoned {id} survived"
                        );
                    } else {
                        assert!(
                            state.contains_key(id),
                            "seed {seed} step {step}: lost session {id}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_direct_target_is_the_advertised_endpoints_then_the_users_own() {
        let mut s = MachinesState::new(Default::default(), MergeOptions::default());
        s.apply_session_list("m", &list(&[], json!({})), 1);
        assert_eq!(s.direct_target("m"), None, "nothing advertised, nothing added");

        let direct = json!({"direct": {"endpoints": ["wss://192.168.1.20:7447"], "certSha256": "ab"}});
        s.apply_session_list("m", &list(&[], direct), 2);
        assert!(s.set_direct_endpoints("m", vec![" wss://laptop.ts.net:7447 ".into(), "wss://192.168.1.20:7447".into()]));
        assert_eq!(
            s.direct_target("m"),
            Some((vec!["wss://192.168.1.20:7447".into(), "wss://laptop.ts.net:7447".into()], Some("ab".into())))
        );
        // A heartbeat without it withdraws the advertised part only.
        s.apply_session_list("m", &list(&[], json!({})), 3);
        assert_eq!(s.direct_target("m").unwrap().0.len(), 2, "the user's own stay");
        assert_eq!(s.direct_target("m").unwrap().1, None);

        assert!(!s.set_direct_endpoints("m", vec!["ws://192.168.1.20:7447".into()]), "no cleartext off Tor");
        assert!(!s.set_direct_endpoints("unknown", vec![]));
        assert!(s.set_direct_endpoints("m", vec!["ws://abc.onion:7448".into()]));
    }
}
