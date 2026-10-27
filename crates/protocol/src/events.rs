//! Bridge → phone messages. Storage class per message is in `kinds.rs`. The
//! `BridgeToPhone` union is `#[serde(tag = "type")]`.

use serde::{Deserialize, Serialize};

use super::capabilities::BridgeHostKind;
use super::common::{
    AgentAction, AgentDescriptor, AgentStyle, AvailablePlugin, CredentialStatus, InstalledPlugin, McpAction, McpServerInfo, OptionChoice, OutputEntry,
    AgentAccount, PermissionRule, SessionMcpServer, SignInAttempt, SignInStatus,
    PartialKind, Persona, PluginAction, PluginMarketplace, ProviderProfileInfo, RemoteSessionInfo, SessionOption,
    Subagent, UsageData, TerminalEndReason, TerminalEventKind, TerminalVia,
};
use crate::ranges::SeqRange;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionListMsg {
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
    pub sessions: Vec<RemoteSessionInfo>,
    /// The agent backends this bridge can run sessions on.
    pub agents: Vec<AgentDescriptor>,
    /// The bridge's own credentials (not tied to an agent), e.g. a GitHub token.
    #[serde(default)]
    pub credentials: Vec<CredentialStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// project folders per workspace root (relative). Valid `create-session.cwd`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<String>>,
    /// CDX-031: the workspace roots themselves, ABSOLUTE, in `--workspace` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<String>>,
    /// Explicit tombstones — the ONLY way a bridge removes a session
    /// (absence from `sessions` never deletes: a list can be partial).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_sessions: Option<Vec<String>>,
    /// Set on clean shutdown — sessions stay listed (`state: offline`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_offline: Option<bool>,
    /// Where the phone can reach this bridge without a relay (see
    /// [`crate::direct`]). Absent when it serves no direct link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct: Option<crate::direct::DirectInfo>,
    /// The terminals open on this bridge that belong to the identity this
    /// list is addressed to. A terminal is only ever told to the identity
    /// that opened it, so no other identity's heartbeat names one — not its
    /// id, its shell, nor the device running it. Absent or empty when the
    /// receiving identity has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminals: Option<Vec<TerminalInfo>>,
    /// The list's revision: strictly greater in each list the bridge
    /// publishes (its clock in ms, kept ahead of the last one). The same
    /// list reaches a phone over several relays and the direct link, and
    /// may be published again, replayed or delayed, so lists arrive out of
    /// order; a phone applies only one newer than the newest it applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub rev: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
/// A run of a session's transcript entries: `entries[i]` is seq `seq + i`.
/// Entries the bridge wrote while the relay was still taking the previous
/// event travel together, so a burst costs one event, not one per entry.
pub struct OutputMsg {
    pub session_id: String,
    /// The first entry's seq.
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    pub entries: Vec<OutputEntry>,
}

impl OutputMsg {
    /// Each entry with its seq.
    pub fn numbered(&self) -> impl Iterator<Item = (u64, &OutputEntry)> {
        self.entries.iter().enumerate().map(move |(i, e)| (self.seq + i as u64, e))
    }
}

/// Text an agent is still writing: the characters of part `key` from
/// `offset` on. Ephemeral and unnumbered — it is never stored, and a lost one
/// only freezes the live row until the entry that completes the part (the one
/// whose `part` is `key`) arrives with its seq.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialMsg {
    pub session_id: String,
    pub key: String,
    pub entry_type: PartialKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
    /// Where `text` starts in the part, in UTF-16 code units — what the
    /// phone's string length counts.
    #[specta(type = specta_typescript::Number)]
    pub offset: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputAckMsg {
    pub session_id: String,
    pub input_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncBeginMsg {
    pub session_id: String,
    pub sync_id: String,
    #[specta(type = specta_typescript::Number)]
    pub seq_high: u64,
    #[specta(type = Vec<(specta_typescript::Number, specta_typescript::Number)>)]
    pub ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    pub entry: OutputEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncChunkMsg {
    pub session_id: String,
    pub sync_id: String,
    #[specta(type = (specta_typescript::Number, specta_typescript::Number))]
    pub range: SeqRange,
    pub entries: Vec<SyncEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncEndMsg {
    pub session_id: String,
    pub sync_id: String,
    #[specta(type = Vec<(specta_typescript::Number, specta_typescript::Number)>)]
    pub delivered_ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPendingMsg {
    pub pending_id: String,
    pub machine: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadyMsg {
    pub pending_id: String,
    /// Boxed only to keep the message union small in memory; the wire is
    /// the plain object.
    pub session: Box<RemoteSessionInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionFailedMsg {
    pub pending_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum InputFailedReason {
    /// The bridge knows no session with this id.
    NoSession,
    /// The session exists but is not running.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputFailedMsg {
    pub session_id: String,
    pub reason: InputFailedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionAckMsg {
    pub session_id: String,
    pub success: bool,
}

/// A session option now has `value` — the reply to `set-option`, and also
/// sent when the agent changes an option on its own (e.g. entering plan mode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OptionConfirmedMsg {
    pub session_id: String,
    pub option: SessionOption,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderAckMsg {
    pub request_id: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageMsg {
    pub session_id: String,
    pub usage: UsageData,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Who serves the model (`OpenCode Go`, `Anthropic`), when the agent
    /// says: the same model can be offered by more than one provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The reasoning levels of this model, for an agent whose levels differ
    /// by model (its catalog entry lists none of its own). Empty: the
    /// agent's own levels, if any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<OptionChoice>,
}

/// The answer to `agent-style-request`: the agent's style and the hash its
/// descriptor names it by, or neither when it has none (or is not known).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentStyleMsg {
    /// Echoes the request's `agent`.
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<AgentStyle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelsMsg {
    /// Echoes the request's `agent`.
    pub agent: String,
    pub models: Vec<ModelEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// CDX-035: why the bridge could not answer — set ONLY alongside an empty
    /// `models`; the phone keeps its list and keeps re-requesting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A slash command a session understands: typed as `/name` (then its
/// arguments) in plain `input`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Without the leading slash; may be namespaced (`plugin:command`).
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What the command takes after its name, for display (`<file>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

/// Reply to `commands-request`. Like `models`, an empty list always comes
/// with an `error` saying why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandsMsg {
    pub session_id: String,
    pub commands: Vec<SlashCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reply to `personas-request`, for the session it named or, without one,
/// for the whole machine. Like `models`, an empty list always comes with an
/// `error` saying why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonasMsg {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub personas: Vec<Persona>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An agent's plugins on the bridge's machine: the reply to
/// `plugins-request`, and sent again after every `plugin-action` — after a
/// change to a marketplace (add/remove/update) it carries the fresh
/// `available` catalog. Otherwise `available` is present only when asked
/// for. When the list could not be read, `error`
/// says why and the lists are empty.
///
/// Agents manage plugins differently: `marketplaces` is absent for one that
/// installs plugins by package name and has no marketplaces (nor anything
/// `available`), and `toggles` says whether a plugin can be switched off
/// without uninstalling it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginsMsg {
    pub agent: String,
    pub installed: Vec<InstalledPlugin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplaces: Option<Vec<PluginMarketplace>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub toggles: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<Vec<AvailablePlugin>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reply to `plugin-action`: whether it was done, and why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginAckMsg {
    pub agent: String,
    pub action: PluginAction,
    pub target: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What was done, in the agent's own words, when it says (e.g. an
    /// update's from/to versions); absent otherwise and on failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Reply to `agent-action`: `success` once the bridge took it up — an
/// install then goes on in the background, its progress and outcome in the
/// agent's `install` — else `error` says why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAckMsg {
    pub agent: String,
    pub action: AgentAction,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An agent's MCP servers on the bridge's machine: the reply to
/// `mcp-request`, and sent again after every `mcp-action`. When the list
/// could not be read, `error` says why and `servers` is empty. `toggles`
/// says whether a server can be switched off without removing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServersMsg {
    pub agent: String,
    pub servers: Vec<McpServerInfo>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub toggles: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reply to `mcp-action`: whether it was done for the servers it `names`,
/// and why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpAckMsg {
    pub agent: String,
    pub action: McpAction,
    pub names: Vec<String>,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A running session's MCP servers: the reply to `session-mcp-request` and
/// to `session-mcp-toggle`. `toggles` says whether a server can be switched
/// in this session; with `projectWide`, a switch applies to every session of
/// the agent in the same project, not just this one. When the session could
/// not answer, `error` says why and `servers` is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMcpMsg {
    pub session_id: String,
    pub servers: Vec<SessionMcpServer>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub toggles: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub project_wide: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The permission rules an agent saved: the reply to
/// `permission-rules-request` and to `permission-rules-remove`, sent only to
/// the client that asked. When the rules could not be read or removed,
/// `error` says why; `rules` is then empty, and a client keeps showing what it
/// had.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRulesMsg {
    pub agent: String,
    pub rules: Vec<PermissionRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An agent's accounts: the reply to `accounts-request`, and to an
/// `account-action` that changed one (then only the accounts with a
/// connection). Sent only to the client that asked. When they could not be
/// read or changed, `error` says why; `accounts` is then empty, and a client
/// keeps showing what it had.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountsMsg {
    pub agent: String,
    pub accounts: Vec<AgentAccount>,
    /// Every account the agent can connect, not only the connected ones.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a sign-in stands, sent to the client that started it: `started`
/// with the `attempt` to follow, then once more as it ends. A sign-in that
/// could not start is `failed` with no `attempt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignInMsg {
    pub agent: String,
    pub account: String,
    pub status: SignInStatus,
    /// The attempt this is about; absent when none started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    /// With `started`: what to do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<SignInAttempt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reply to `set-credentials`: the resulting status of every credential in
/// the written scope (`agent`, or the bridge's own when absent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsAckMsg {
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub success: bool,
    pub credentials: Vec<CredentialStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PairAckReason {
    BadToken,
    WindowClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairAckMsg {
    pub machine: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PairAckReason>,
    /// The bridge's relay list: the phone adds it to the relays it keeps for
    /// the machine (deduped), beside the ones the pairing itself named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relays: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfilesMsg {
    pub machine: String,
    pub profiles: Vec<ProviderProfileInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileAckMsg {
    pub machine: String,
    pub profile_id: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_valid: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- terminals ---

/// One terminal open on the bridge, as the heartbeat's `terminals` lists it
/// to the identity that opened it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    /// The bridge's id for it, which every other terminal message names.
    pub term: String,
    /// What runs in it (`/bin/bash`).
    pub shell: String,
    /// When it opened, ms since the Unix epoch.
    #[specta(type = specta_typescript::Number)]
    pub opened: u64,
    /// The device that opened it (see
    /// [`device_id`](crate::recipients::device_id)).
    pub device: String,
    /// That device's name as its user set it; absent when it gave none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The device whose input it takes now (the writer).
    pub writer: String,
    pub cols: u16,
    pub rows: u16,
}

/// The answer to `terminal-open`: the id the bridge gave the terminal, and
/// what runs in it. `open_id` echoes the request's, so a phone can match the
/// answer to the request that earned it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenedMsg {
    pub open_id: String,
    pub term: String,
    /// The program the shell runs, e.g. `/bin/bash`.
    pub shell: String,
}

/// Output a terminal produced: `data` (base64 of the bytes) starts at
/// `offset`, a byte offset into everything this terminal has ever written.
/// Rides [`LIVE_KIND`](crate::kinds::LIVE_KIND) and is sent only to the
/// clients watching this terminal (see
/// [`PresenceMsg::watching_terminal`](crate::commands::PresenceMsg::watching_terminal));
/// a client that missed a run asks for the bytes again with
/// `terminal-replay`, naming the offset it got to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputMsg {
    pub term: String,
    #[specta(type = specta_typescript::Number)]
    pub offset: u64,
    pub data: String,
    /// Set (true) only on the bridge's answer to `terminal-replay`. Its
    /// `offset` may be past what the client asked for when the bridge no
    /// longer holds those bytes, and the client takes it from there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<bool>,
}

/// The input the bridge is still waiting for: `seq` is the first one that
/// never arrived (one more than the last it applied), and the writer resends
/// its input from there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputFromMsg {
    pub term: String,
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
}

/// A terminal is gone, and why. `term` names the terminal; `open_id` is set
/// instead when a `terminal-open` was refused (reason `limit`, `not-allowed`
/// or `disabled`), so the phone learns its open will never be answered any
/// other way. `code` carries the shell's exit status with `exit`; `device`
/// is set with `not-allowed`, naming the device the open was refused for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitedMsg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    pub reason: TerminalEndReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

/// Something happened to a terminal, or to who is attached to it. Sent to
/// every present client of the identity, so a phone learns of a takeover or
/// a close at once even when another client did it. `device` is the device
/// that acted, `name` its user's name for it (absent when it gave none), and
/// `via` how its command reached the bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventMsg {
    pub term: String,
    pub what: TerminalEventKind,
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub via: TerminalVia,
    /// When it happened, ms since the Unix epoch.
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
}

/// The answer to `web-sign-in`, to the client that sent it: whether `code`
/// was one the web page is showing now (and so a browser is signed in), or
/// not — mistyped, expired, or already used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSignInResultMsg {
    pub code: String,
    pub signed_in: bool,
}

/// One browser signed in to a bridge's web page, for `web-browsers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebBrowserInfo {
    /// The page's short public id for this browser: the first 16 hex
    /// characters of the SHA-256 of its session key. Never the key itself and
    /// never the session token, so a copy of the list can be replayed as
    /// nothing; a `web-browser-sign-out` names this.
    pub id: String,
    /// The npub of the phone identity that signed it in.
    pub by: String,
    /// When it signed in, ms since the Unix epoch.
    #[specta(type = specta_typescript::Number)]
    pub since_ms: u64,
    /// When it last made an authenticated request, ms since the Unix epoch.
    #[specta(type = specta_typescript::Number)]
    pub last_seen_ms: u64,
    /// When its session lapses, ms since the Unix epoch.
    #[specta(type = specta_typescript::Number)]
    pub expires_ms: u64,
    /// The address it signed in from (an IP; the page keeps no host name).
    pub peer: String,
    /// Its `User-Agent`, cleaned of control characters and bounded.
    pub agent: String,
}

/// The browsers signed in to the bridge's web page: the answer to
/// `web-browsers`, and — after a `web-browser-sign-out` — the fresh list with
/// the ended browser gone. Sent to the asking client alone; another client
/// that did not ask keeps whatever its own screen last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebBrowsersMsg {
    /// Signed-in browsers, oldest signed in first. Empty when the bridge runs
    /// no web page, and for a browser id a sign-out did not match.
    pub browsers: Vec<WebBrowserInfo>,
}

/// The bridge→phone message union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeToPhone {
    Sessions(SessionListMsg),
    Output(OutputMsg),
    Partial(PartialMsg),
    InputAck(InputAckMsg),
    SyncBegin(SyncBeginMsg),
    SyncChunk(SyncChunkMsg),
    SyncEnd(SyncEndMsg),
    SessionPending(SessionPendingMsg),
    SessionReady(SessionReadyMsg),
    SessionFailed(SessionFailedMsg),
    InputFailed(InputFailedMsg),
    CloseSessionAck(CloseSessionAckMsg),
    OptionConfirmed(OptionConfirmedMsg),
    FolderAck(FolderAckMsg),
    Usage(UsageMsg),
    Models(ModelsMsg),
    AgentStyle(AgentStyleMsg),
    Commands(CommandsMsg),
    Personas(PersonasMsg),
    Plugins(PluginsMsg),
    PluginAck(PluginAckMsg),
    AgentAck(AgentAckMsg),
    McpServers(McpServersMsg),
    McpAck(McpAckMsg),
    SessionMcp(SessionMcpMsg),
    PermissionRules(PermissionRulesMsg),
    Accounts(AccountsMsg),
    AccountSignIn(AccountSignInMsg),
    CredentialsAck(CredentialsAckMsg),
    PairAck(PairAckMsg),
    ProviderProfiles(ProviderProfilesMsg),
    ProviderProfileAck(ProviderProfileAckMsg),
    TerminalOpened(TerminalOpenedMsg),
    /// Rides LIVE_KIND, to the clients watching `term` only.
    TerminalOutput(TerminalOutputMsg),
    TerminalInputFrom(TerminalInputFromMsg),
    TerminalExited(TerminalExitedMsg),
    /// To every present client of the identity.
    TerminalEvent(TerminalEventMsg),
    WebSignInResult(WebSignInResultMsg),
    WebBrowsers(WebBrowsersMsg),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rt(v: &serde_json::Value) -> BridgeToPhone {
        let msg: BridgeToPhone = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v} -> {e}"));
        let msg2: BridgeToPhone = serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
        assert_eq!(msg, msg2, "semantic round-trip");
        msg
    }

    fn session() -> serde_json::Value {
        json!({"id":"s","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":1,"title":null,"project":"p","state":"running","seqHigh":10})
    }
    fn agent() -> serde_json::Value {
        json!({
            "id":"claude-code","displayName":"Claude Code",
            "modes":[{"id":"default","label":"Default"},{"id":"plan","label":"Plan"}],
            "efforts":[{"id":"high","label":"High"}],
            "defaultMode":"default","defaultEffort":"high",
            "supports":{"models":true,"usage":true,"providers":true,"interrupt":true,"commands":true,"plugins":true},
            "credentials":[{"id":"anthropic_api_key","label":"Anthropic API key","present":true,"fromEnv":true}]
        })
    }

    #[test]
    fn heartbeat_minimal_and_full() {
        let m = rt(&json!({"v":12,"type":"sessions","machine":"m","sessions":[],"agents":[]}));
        match m {
            BridgeToPhone::Sessions(s) => {
                assert_eq!(s.host, None);
                assert!(s.credentials.is_empty());
            }
            _ => panic!(),
        }
        let m = rt(&json!({
            "v": 12,
            "type":"sessions","machine":"m","host":"service","sessions":[session()],
            "agents":[agent()],
            "credentials":[{"id":"github_pat","label":"GitHub token","present":false}],
            "capabilities":["sync/1","files"],
            "folders":["a","b"],"roots":["/w"],"removedSessions":["old"],"machineOffline":true
        }));
        match m {
            BridgeToPhone::Sessions(s) => {
                assert_eq!(s.host, Some(BridgeHostKind::Service));
                assert_eq!(s.agents[0].modes.len(), 2);
                assert!(s.agents[0].credentials[0].from_env);
                assert_eq!(s.removed_sessions.as_deref(), Some(&["old".to_string()][..]));
                assert_eq!(s.machine_offline, Some(true));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn a_heartbeat_without_its_agent_catalog_is_rejected() {
        assert!(serde_json::from_value::<BridgeToPhone>(json!({"v":12,"type":"sessions","machine":"m","sessions":[]})).is_err());
    }

    #[test]
    fn an_agent_style_user_message_shape_decodes_to_its_variant() {
        let styled = rt(&json!({"v":12,"type":"agent-style","agent":"claude-code","style":{
            "userMessage":{"shape":"prompt","mark":">"}
        }}));
        let BridgeToPhone::AgentStyle(m) = styled else { panic!() };
        assert_eq!(m.style.unwrap().user_message, crate::common::UserMessageStyle::Prompt { mark: ">".into() });
        // A shape this build does not know is drawn as a bubble.
        let m = rt(&json!({"v":12,"type":"agent-style","agent":"x","style":{"userMessage":{"shape":"card"}}}));
        let BridgeToPhone::AgentStyle(m) = m else { panic!() };
        assert_eq!(m.style.unwrap().user_message, crate::common::UserMessageStyle::Unknown);
    }

    #[test]
    fn a_heartbeat_lists_terminals_both_shapes() {
        let m = rt(&json!({"v":12,"type":"sessions","machine":"m","sessions":[],"agents":[],
            "terminals":[{"term":"t1","shell":"/bin/bash","opened":1792008058637_u64,"device":"d1","name":"Pixel 8","writer":"d1","cols":80,"rows":24},
                         {"term":"t2","shell":"/bin/zsh","opened":1792008058638_u64,"device":"d2","writer":"d2","cols":132,"rows":43}]}));
        match m {
            BridgeToPhone::Sessions(s) => {
                let t = s.terminals.unwrap();
                assert_eq!(t.len(), 2);
                assert_eq!(t[0].name.as_deref(), Some("Pixel 8"));
                assert_eq!(t[1].name, None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<BridgeToPhone>(r#"{"v":12,"type":"warp","sessionId":"s"}"#).is_err());
        assert!(serde_json::from_str::<BridgeToPhone>(r#"{"v":12,"type":"mode-confirmed","sessionId":"s","mode":"plan"}"#).is_err());
    }

    #[test]
    fn an_unknown_terminal_vocabulary_value_is_its_catch_all() {
        let m = rt(&json!({"v":12,"type":"terminal-exited","term":"t1","reason":"melted"}));
        let BridgeToPhone::TerminalExited(e) = m else { panic!() };
        assert_eq!(e.reason, crate::common::TerminalEndReason::Unknown);
        let m = rt(&json!({"v":12,"type":"terminal-event","term":"t1","what":"hologram","device":"d","via":"telepathy","at":1}));
        let BridgeToPhone::TerminalEvent(e) = m else { panic!() };
        assert_eq!(e.what, crate::common::TerminalEventKind::Unknown);
        assert_eq!(e.via, crate::common::TerminalVia::Unknown);
    }
}
