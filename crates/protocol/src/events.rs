//! Bridge → phone messages. Storage class per message is in `kinds.rs`. The
//! `BridgeToPhone` union is `#[serde(tag = "type")]`.

use serde::{Deserialize, Serialize};

use super::capabilities::BridgeHostKind;
use super::common::{
    AgentDescriptor, AvailablePlugin, CredentialStatus, GsdState, InstalledPlugin, McpAction, McpServerInfo, OutputEntry,
    SessionMcpServer,
    PluginAction, PluginMarketplace, ProviderProfileInfo, RemoteSessionInfo, SessionOption,
    UsageData,
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
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    /// project folders per workspace root (relative). Valid `create-session.cwd`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folders: Option<Vec<String>>,
    /// CDX-031: the workspace roots themselves, ABSOLUTE, in `--workspace` order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<String>>,
    /// v10: explicit tombstones — the ONLY way a bridge removes a session
    /// (absence from `sessions` never deletes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_sessions: Option<Vec<String>>,
    /// v10: set on clean shutdown — sessions stay listed (`state: offline`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_offline: Option<bool>,
    /// Where the phone can reach this bridge without a relay (see
    /// [`crate::direct`]). Absent when it serves no direct link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct: Option<crate::direct::DirectInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputMsg {
    pub session_id: String,
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    pub entry: OutputEntry,
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
    pub session: RemoteSessionInfo,
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
    NoSession,
    Expired,
    Busy,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplacedMsg {
    pub old_session_id: String,
    pub new_session: RemoteSessionInfo,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdStateMsg {
    pub session_id: String,
    pub gsd: GsdState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
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

/// The bridge→phone message union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum BridgeToPhone {
    Sessions(SessionListMsg),
    Output(OutputMsg),
    InputAck(InputAckMsg),
    SyncBegin(SyncBeginMsg),
    SyncChunk(SyncChunkMsg),
    SyncEnd(SyncEndMsg),
    SessionPending(SessionPendingMsg),
    SessionReady(SessionReadyMsg),
    SessionFailed(SessionFailedMsg),
    InputFailed(InputFailedMsg),
    CloseSessionAck(CloseSessionAckMsg),
    SessionReplaced(SessionReplacedMsg),
    OptionConfirmed(OptionConfirmedMsg),
    FolderAck(FolderAckMsg),
    Usage(UsageMsg),
    GsdState(GsdStateMsg),
    Models(ModelsMsg),
    Commands(CommandsMsg),
    Plugins(PluginsMsg),
    PluginAck(PluginAckMsg),
    McpServers(McpServersMsg),
    McpAck(McpAckMsg),
    SessionMcp(SessionMcpMsg),
    CredentialsAck(CredentialsAckMsg),
    PairAck(PairAckMsg),
    ProviderProfiles(ProviderProfilesMsg),
    ProviderProfileAck(ProviderProfileAckMsg),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::EntryBody;
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
    fn entry() -> serde_json::Value {
        json!({"timestamp":"t","entryType":"text","role":"agent","text":"hello"})
    }
    fn agent() -> serde_json::Value {
        json!({
            "id":"claude-code","displayName":"Claude Code",
            "modes":[{"id":"default","label":"Default"},{"id":"plan","label":"Plan"}],
            "efforts":[{"id":"high","label":"High"}],
            "defaultMode":"default","defaultEffort":"high",
            "supports":{"models":true,"usage":true,"providers":true,"gsd":true,"interrupt":true,"commands":true,"plugins":true},
            "credentials":[{"id":"anthropic_api_key","label":"Anthropic API key","present":true,"fromEnv":true}]
        })
    }

    #[test]
    fn heartbeat_minimal_and_full() {
        let m = rt(&json!({"type":"sessions","machine":"m","sessions":[],"agents":[],"protocolVersion":11}));
        match m {
            BridgeToPhone::Sessions(s) => {
                assert_eq!(s.protocol_version, 11);
                assert_eq!(s.host, None);
                assert!(s.credentials.is_empty());
            }
            _ => panic!(),
        }
        let m = rt(&json!({
            "type":"sessions","machine":"m","host":"service","sessions":[session()],
            "agents":[agent()],
            "credentials":[{"id":"github_pat","label":"GitHub token","present":false}],
            "protocolVersion":11,"capabilities":["sync/1","files"],
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
        assert!(serde_json::from_value::<BridgeToPhone>(json!({"type":"sessions","machine":"m","sessions":[],"protocolVersion":11})).is_err());
    }

    #[test]
    fn every_variant_decodes_from_a_representative_fixture() {
        rt(&json!({"type":"output","sessionId":"s","seq":7,"entry":entry()}));
        rt(&json!({"type":"input-ack","sessionId":"s","inputId":"i"}));
        rt(&json!({"type":"sync-begin","sessionId":"s","syncId":"y","seqHigh":100,"ranges":[[1,50]]}));
        rt(&json!({"type":"sync-chunk","sessionId":"s","syncId":"y","range":[1,2],"entries":[{"seq":1,"entry":entry()},{"seq":2,"entry":entry()}]}));
        rt(&json!({"type":"sync-end","sessionId":"s","syncId":"y","deliveredRanges":[[1,50]]}));
        rt(&json!({"type":"session-pending","pendingId":"p","machine":"m","createdAt":"t"}));
        rt(&json!({"type":"session-ready","pendingId":"p","session":session()}));
        rt(&json!({"type":"session-failed","pendingId":"p","reason":"boom"}));
        rt(&json!({"type":"input-failed","sessionId":"s","reason":"no-session","inputId":"i"}));
        rt(&json!({"type":"close-session-ack","sessionId":"s","success":true}));
        rt(&json!({"type":"session-replaced","oldSessionId":"o","newSession":session()}));
        rt(&json!({"type":"option-confirmed","sessionId":"s","option":"mode","value":"plan"}));
        rt(&json!({"type":"folder-ack","requestId":"r","success":true,"path":"a/b"}));
        rt(&json!({"type":"usage","sessionId":"s","usage":{"available":true,"plan":"max","windows":[{"label":"5h","utilization":42.0,"resetsAt":"t"}],"fetchedAt":"t"}}));
        rt(&json!({"type":"gsd-state","sessionId":"s","gsd":{
            "installed":true,"available":true,"hasGit":true,"situation":"x","summary":"y",
            "milestone":null,"currentPhase":null,"totalPhases":null,"percent":0.0,
            "phases":[],"actions":[],"recommended":null,"paused":false,"blockers":[],
            "verifyFailed":false,"execution":null
        }}));
        rt(&json!({"type":"models","agent":"claude-code","models":[{"id":"m1","label":"M1"},{"id":"m2"}],"defaultModel":"m1"}));
        rt(&json!({"type":"models","agent":"opencode","models":[],"error":"sdk offline"}));
        rt(&json!({"type":"commands","sessionId":"s","commands":[{"name":"compact","description":"Compact","argumentHint":"<focus>"},{"name":"p:x"}]}));
        rt(&json!({"type":"commands","sessionId":"s","commands":[],"error":"not running"}));
        rt(&json!({"type":"plugins","agent":"claude-code",
            "installed":[{"id":"c@m","name":"c","marketplace":"m","version":"1","description":"d","enabled":false}],
            "marketplaces":[{"name":"m","source":"me/skills"}],"toggles":true,
            "available":[{"id":"x@m","name":"x","marketplace":"m","installCount":12}]}));
        rt(&json!({"type":"plugins","agent":"opencode","installed":[{"id":"opencode-wakatime","name":"opencode-wakatime","enabled":true}]}));
        rt(&json!({"type":"plugins","agent":"claude-code","installed":[],"error":"no claude"}));
        rt(&json!({"type":"plugin-ack","agent":"claude-code","action":"install","target":"x@m","success":false,"error":"not found"}));
        rt(&json!({"type":"plugin-ack","agent":"claude-code","action":"update","target":"c@m","success":true,"message":"Updated from 0.1.0 to 0.2.0."}));
        rt(&json!({"type":"mcp-servers","agent":"claude-code","servers":[
            {"name":"github","transport":"http","target":"https://api.githubcopilot.com/mcp/","headerKeys":["Authorization"],"enabled":true},
            {"name":"fs","transport":"stdio","target":"npx","envKeys":["K"],"enabled":false}],"toggles":true}));
        rt(&json!({"type":"mcp-servers","agent":"claude-code","servers":[],"error":"no claude"}));
        rt(&json!({"type":"mcp-ack","agent":"claude-code","action":"add","names":["github"],"success":false,"error":"bad url"}));
        rt(&json!({"type":"session-mcp","sessionId":"s","servers":[
            {"name":"github","status":"connected","tools":12},{"name":"x","status":"needs-auth"},
            {"name":"y","status":"failed","error":"exit 1"}],"toggles":true,"projectWide":true}));
        rt(&json!({"type":"session-mcp","sessionId":"s","servers":[],"error":"not running"}));
        rt(&json!({"type":"credentials-ack","machine":"m","agent":"claude-code","success":true,
            "credentials":[{"id":"anthropic_api_key","label":"Anthropic API key","present":true,"valid":true}]}));
        rt(&json!({"type":"pair-ack","machine":"m","ok":false,"reason":"bad-token","relays":["wss://r"],"host":"cli"}));
        rt(&json!({"type":"provider-profiles","machine":"m","profiles":[{"id":"p","label":"L","baseUrl":"https://x","models":[{"id":"m"}],"hasToken":true}]}));
        rt(&json!({"type":"provider-profile-ack","machine":"m","profileId":"p","success":true,"tokenValid":false}));
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<BridgeToPhone>(r#"{"type":"warp","sessionId":"s"}"#).is_err());
        assert!(serde_json::from_str::<BridgeToPhone>(r#"{"type":"mode-confirmed","sessionId":"s","mode":"plan"}"#).is_err());
    }

    #[test]
    fn a_typed_entry_survives_the_full_message() {
        let m = rt(&json!({"type":"output","sessionId":"s","seq":1,"entry":{
            "timestamp":"t","entryType":"diff","path":"f","lines":[{"type":"add","text":"a"}],"truncated":true
        }}));
        match m {
            BridgeToPhone::Output(o) => match o.entry.body {
                EntryBody::Diff { truncated, ref lines, .. } => {
                    assert!(truncated);
                    assert_eq!(lines.len(), 1);
                }
                other => panic!("{other:?}"),
            },
            _ => panic!(),
        }
    }
}
