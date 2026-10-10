//! Phone → bridge command messages (COMMAND_KIND, stored, 1h expiry).
//!
//! The `PhoneToBridge` union is `#[serde(tag = "type")]` — the wire `type`
//! string selects the variant. Commands carry no version: the bridge states
//! its protocol version in the heartbeat, and a phone that does not speak it
//! says so instead of sending.

use serde::{Deserialize, Serialize};

use super::common::{
    AgentAction, CredentialValues, McpAction, McpServerSpec, PluginAction, ProviderModel, SessionOption,
};
use super::tristate::Tristate;
use crate::ranges::SeqRange;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputMsg {
    pub session_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

/// Answer to a `permission_request` entry: one of its `options[].id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseMsg {
    pub session_id: String,
    pub request_id: String,
    pub option_id: String,
}

/// The answer to one question: chosen option indices (into the question's
/// `options`), or free text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QuestionAnswer {
    Options {
        #[specta(type = Vec<specta_typescript::Number>)]
        selected: Vec<u32>,
    },
    Text { text: String },
}

/// Answer to question `index` of a `question` ask (`request_id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponseMsg {
    pub session_id: String,
    pub request_id: String,
    #[specta(type = specta_typescript::Number)]
    pub index: u32,
    pub answer: QuestionAnswer,
}

/// Answer to a `plan_approval` entry: one of its `options[].id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanResponseMsg {
    pub session_id: String,
    pub request_id: String,
    pub option_id: String,
    /// What the user wants changed, sent with the entry's `revise` option
    /// (with any other option it is ignored).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

/// Change a session option. `value` must be one the session's agent
/// advertises (a mode / effort id, or a model id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetOptionMsg {
    pub session_id: String,
    pub option: SessionOption,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequestMsg {
    pub session_id: String,
    // `SeqRange = (u64, u64)` — the tuple's own elements trip Specta's
    // BigInt-forbidden check; overridden to `[number, number]` (matches
    // this app's actual seq range, well within JS's safe-integer span).
    #[specta(type = Vec<(specta_typescript::Number, specta_typescript::Number)>)]
    pub have_ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncAckMsg {
    pub sync_id: String,
    /// The chunks this ack covers, each exactly a `sync-chunk`'s `range`.
    /// One ack may cover several chunks, so a phone can batch them.
    #[specta(type = Vec<(specta_typescript::Number, specta_typescript::Number)>)]
    pub ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionMsg {
    /// The [`AgentDescriptor::id`](crate::common::AgentDescriptor) to run on.
    pub agent: String,
    /// Initial mode / effort (ids the agent advertises); absent = its default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_cwd: Option<bool>,
    /// Custom provider profile; only for agents with `supports.providers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

/// A command with nothing to say beyond its `type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct BareMsg {}

/// Ask for an agent's live model list (agents with `supports.models`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ModelsRequestMsg {
    pub agent: String,
}

/// Ask for an agent's plugins (agents with `supports.plugins`); with
/// `available`, also every plugin the known marketplaces offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PluginsRequestMsg {
    pub agent: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub available: bool,
}

/// Change an agent's plugins. Reply: `plugin-ack`, then the new `plugins`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PluginActionMsg {
    pub agent: String,
    pub action: PluginAction,
    pub target: String,
}

/// Install or remove an agent on the bridge's machine. Reply: `agent-ack`;
/// how it goes shows in the agent's `install` in the session list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentActionMsg {
    pub agent: String,
    pub action: AgentAction,
}

/// Ask for an agent's MCP servers (agents with `supports.mcp`). Reply:
/// `mcp-servers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct McpRequestMsg {
    pub agent: String,
}

/// Change an agent's MCP servers. Reply: `mcp-ack`, then the new
/// `mcp-servers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct McpActionMsg {
    pub agent: String,
    pub action: McpAction,
    /// What `add` adds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub servers: Vec<McpServerSpec>,
    /// What `remove`, `enable` and `disable` act on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
}

/// Switch one MCP server on or off in one running session. Reply: the
/// session's new `session-mcp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMcpToggleMsg {
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdMsg {
    pub session_id: String,
}

/// Stop one of a session's background tasks (a `background_task` entry's
/// `taskId`). No reply: the task's next entry says it stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StopTaskMsg {
    pub session_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderMsg {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub request_id: String,
}

/// `key` decrypts the uploaded file: its `Debug` leaves it out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileBlossomMsg {
    pub session_id: String,
    pub hash: String,
    pub url: String,
    pub key: String,
    pub iv: String,
    pub filename: String,
    pub mime_type: String,
    pub text: String,
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
}

impl std::fmt::Debug for UploadFileBlossomMsg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadFileBlossomMsg")
            .field("session_id", &self.session_id)
            .field("hash", &self.hash)
            .field("url", &self.url)
            .field("key", &"<redacted>")
            .field("filename", &self.filename)
            .field("mime_type", &self.mime_type)
            .field("size_bytes", &self.size_bytes)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileChunkMsg {
    pub session_id: String,
    pub upload_id: String,
    pub filename: String,
    pub mime_type: String,
    pub base64_data: String,
    pub text: String,
    #[specta(type = specta_typescript::Number)]
    pub chunk_index: u64,
    #[specta(type = specta_typescript::Number)]
    pub total_chunks: u64,
}

/// Same `type`, disambiguated by shape (`hash`/`url` vs
/// `uploadId`/`base64Data`). `untagged` tries each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum UploadFileMsg {
    Blossom(UploadFileBlossomMsg),
    Chunk(UploadFileChunkMsg),
}

/// Store or clear credentials. `agent` names the agent they belong to;
/// absent = the bridge's own credentials (e.g. a GitHub token). `values`
/// maps credential ids (from the agent's advertised `credentials`) to a new
/// secret, or `null` to clear; ids not listed are left unchanged. The only
/// message a credential secret ever rides, so its `Debug` names the ids
/// and whether each is set or cleared, never a value.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialsMsg {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub values: CredentialValues,
}

impl std::fmt::Debug for SetCredentialsMsg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let values: std::collections::BTreeMap<&str, &str> = self
            .values
            .iter()
            .map(|(id, v)| (id.as_str(), if v.is_some() { "<set>" } else { "<clear>" }))
            .collect();
        f.debug_struct("SetCredentialsMsg")
            .field("agent", &self.agent)
            .field("values", &values)
            .finish()
    }
}

/// `token` is the pairing window's one-time secret: its `Debug` leaves it
/// out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestMsg {
    pub npub: String,
    pub pubkey_hex: String,
    pub label: String,
    pub token: String,
    /// A session key granted with the pairing, so the `pair-ack` is
    /// already encrypted to it.
    /// Only sent to a bridge advertising
    /// [`SESSION_KEYS`](crate::capabilities::SESSION_KEYS); the pairing QR
    /// does not say, so a phone may send it to any bridge, and one without
    /// session keys ignores the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<SessionKeyGrant>,
}

impl std::fmt::Debug for PairRequestMsg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairRequestMsg")
            .field("npub", &self.npub)
            .field("pubkey_hex", &self.pubkey_hex)
            .field("label", &self.label)
            .field("token", &"<redacted>")
            .field("session_key", &self.session_key)
            .finish()
    }
}

/// A key the phone's identity lets encrypt its traffic with one bridge: the
/// NIP-44 payloads of the phone's commands may be encrypted with it, and the
/// bridge encrypts its messages to it. The phone keeps the secret half
/// locally, so decrypting and encrypting per message never reach an
/// external signer. It never signs: every event stays authored by (and, from
/// the bridge, `p`-tagged to) the identity, so the key can only read and
/// write payloads inside events the identity signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionKeyGrant {
    /// The session key's public half, lowercase hex.
    pub pubkey_hex: String,
    /// The one bridge this grant is for (its pubkey, lowercase hex). A
    /// bridge refuses a grant naming another, so a grant cannot be replayed
    /// to a different bridge.
    pub bridge_pubkey_hex: String,
    /// When the grant lapses, seconds since the Unix epoch. At most
    /// [`SESSION_KEY_MAX_LIFETIME_SECS`] ahead; the phone grants a new key
    /// before this one lapses.
    #[specta(type = specta_typescript::Number)]
    pub expires_at: u64,
}

/// The longest a [`SessionKeyGrant`] may run.
pub const SESSION_KEY_MAX_LIFETIME_SECS: u64 = 90 * 24 * 3600;

/// `session-key`: grant (or rotate to) a session key. Like every command,
/// authored by the paired identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionKeyMsg {
    pub session_key: SessionKeyGrant,
}

/// Write shape of a provider profile (CDX-062/071). `auth_token` is tri-state
/// (keep/clear/set) — the ONLY message the token ever rides on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileWrite {
    /// The agent the profile is for (one whose catalog entry `supports`
    /// `providers` or `providerModels`).
    pub agent: String,
    pub label: String,
    /// CDX-071: https, or http only to this machine or a private-network
    /// address ([`is_valid_provider_base_url`](super::common::is_valid_provider_base_url))
    /// — validated on egress ([`super::codec::encode_phone_to_bridge`]) and
    /// again by the bridge.
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Tristate::is_keep")]
    pub auth_token: Tristate<String>,
    /// Ignored when `models_from_provider` is set.
    pub models: Vec<ProviderModel>,
    /// Ask the provider for its models instead: the bridge reads its
    /// `/v1/models` with the profile's token on every save, and stores
    /// what it lists (or refuses the save when it lists nothing).
    #[serde(default, skip_serializing_if = "super::common::is_false")]
    pub models_from_provider: bool,
    /// With `models_from_provider`, kept only when the provider lists it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderProfileMsg {
    pub profile_id: String,
    /// nullable (always present; `null` deletes the whole profile).
    pub profile: Option<ProviderProfileWrite>,
}

/// The phone→bridge message union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PhoneToBridge {
    Input(InputMsg),
    PermissionResponse(PermissionResponseMsg),
    QuestionResponse(QuestionResponseMsg),
    PlanResponse(PlanResponseMsg),
    SetOption(SetOptionMsg),
    SyncRequest(SyncRequestMsg),
    SyncAck(SyncAckMsg),
    CreateSession(CreateSessionMsg),
    RefreshSessions(BareMsg),
    CloseSession(SessionIdMsg),
    Interrupt(SessionIdMsg),
    /// Agents with `supports.tasks`.
    StopTask(StopTaskMsg),
    CreateFolder(CreateFolderMsg),
    UploadFile(UploadFileMsg),
    UsageRequest(SessionIdMsg),
    GsdRequest(SessionIdMsg),
    ModelsRequest(ModelsRequestMsg),
    /// The slash commands a session understands (agents with
    /// `supports.commands`). Reply: `commands`.
    CommandsRequest(SessionIdMsg),
    PluginsRequest(PluginsRequestMsg),
    PluginAction(PluginActionMsg),
    AgentAction(AgentActionMsg),
    McpRequest(McpRequestMsg),
    McpAction(McpActionMsg),
    /// A running session's MCP servers and where each stands. Reply:
    /// `session-mcp`.
    SessionMcpRequest(SessionIdMsg),
    SessionMcpToggle(SessionMcpToggleMsg),
    SetCredentials(SetCredentialsMsg),
    PairRequest(PairRequestMsg),
    SetProviderProfile(SetProviderProfileMsg),
    ProviderProfilesRequest(BareMsg),
    SessionKey(SessionKeyMsg),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rt(v: &serde_json::Value) -> PhoneToBridge {
        let msg: PhoneToBridge = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v} -> {e}"));
        let back = serde_json::to_value(&msg).unwrap();
        let msg2: PhoneToBridge = serde_json::from_value(back).unwrap();
        assert_eq!(msg, msg2, "semantic round-trip");
        msg
    }

    #[test]
    fn input_decodes_with_and_without_its_id() {
        let m = rt(&json!({"v":11,"type":"input","sessionId":"s","text":"hi","inputId":"i1"}));
        assert!(matches!(m, PhoneToBridge::Input(InputMsg { ref session_id, .. }) if session_id == "s"));
        let m = rt(&json!({"v":11,"type":"input","sessionId":"s","text":""}));
        assert!(matches!(m, PhoneToBridge::Input(InputMsg { input_id: None, .. })));
    }

    #[test]
    fn every_variant_decodes_from_a_representative_fixture() {
        rt(&json!({"v":11,"type":"permission-response","sessionId":"s","requestId":"r","optionId":"allow_always"}));
        rt(&json!({"v":11,"type":"question-response","sessionId":"s","requestId":"q","index":1,"answer":{"kind":"options","selected":[0,2]}}));
        rt(&json!({"v":11,"type":"question-response","sessionId":"s","requestId":"q","index":0,"answer":{"kind":"text","text":"blue"}}));
        rt(&json!({"v":11,"type":"plan-response","sessionId":"s","requestId":"p","optionId":"approve"}));
        rt(&json!({"v":11,"type":"set-option","sessionId":"s","option":"mode","value":"plan"}));
        rt(&json!({"v":11,"type":"set-option","sessionId":"s","option":"model","value":"anthropic/claude-x"}));
        rt(&json!({"v":11,"type":"sync-request","sessionId":"s","haveRanges":[[1,40],[61,80]]}));
        rt(&json!({"v":11,"type":"sync-ack","syncId":"y","ranges":[[1,50],[51,100]]}));
        rt(&json!({"v":11,"type":"create-session","agent":"opencode","effort":"high","cwd":"proj","createCwd":true,"providerId":"p"}));
        rt(&json!({"v":11,"type":"refresh-sessions"}));
        rt(&json!({"v":11,"type":"close-session","sessionId":"s"}));
        rt(&json!({"v":11,"type":"interrupt","sessionId":"s"}));
        rt(&json!({"v":11,"type":"create-folder","path":"a/b","root":"/w","requestId":"r"}));
        rt(&json!({"v":11,"type":"upload-file","sessionId":"s","hash":"h","url":"u","key":"k","iv":"iv","filename":"f","mimeType":"image/png","text":"","sizeBytes":123}));
        rt(&json!({"v":11,"type":"upload-file","sessionId":"s","uploadId":"u","filename":"f","mimeType":"image/png","base64Data":"x","text":"","chunkIndex":0,"totalChunks":2}));
        rt(&json!({"v":11,"type":"usage-request","sessionId":"s"}));
        rt(&json!({"v":11,"type":"gsd-request","sessionId":"s"}));
        rt(&json!({"v":11,"type":"models-request","agent":"opencode"}));
        rt(&json!({"v":11,"type":"commands-request","sessionId":"s"}));
        rt(&json!({"v":11,"type":"plugins-request","agent":"claude-code"}));
        rt(&json!({"v":11,"type":"plugins-request","agent":"claude-code","available":true}));
        rt(&json!({"v":11,"type":"plugin-action","agent":"claude-code","action":"add-marketplace","target":"me/skills"}));
        rt(&json!({"v":11,"type":"plugin-action","agent":"claude-code","action":"update","target":"c@m"}));
        rt(&json!({"v":11,"type":"agent-action","agent":"opencode","action":"install"}));
        rt(&json!({"v":11,"type":"agent-action","agent":"opencode","action":"remove"}));
        rt(&json!({"v":11,"type":"mcp-request","agent":"claude-code"}));
        rt(&json!({"v":11,"type":"mcp-action","agent":"claude-code","action":"add","servers":[
            {"name":"github","transport":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer t"}}},
            {"name":"fs","transport":{"type":"stdio","command":"npx","args":["-y","server-fs","/w"],"env":{"K":"v"}}},
            {"name":"old","transport":{"type":"sse","url":"https://x/sse"}}]}));
        rt(&json!({"v":11,"type":"mcp-action","agent":"opencode","action":"disable","names":["github"]}));
        rt(&json!({"v":11,"type":"session-mcp-request","sessionId":"s"}));
        rt(&json!({"v":11,"type":"session-mcp-toggle","sessionId":"s","name":"github","enabled":false}));
        rt(&json!({"v":11,"type":"pair-request","npub":"npub1","pubkeyHex":"aa","label":"phone","token":"t"}));
        rt(&json!({"v":11,"type":"pair-request","npub":"npub1","pubkeyHex":"aa","label":"phone","token":"t","sessionKey":{"pubkeyHex":"bb","bridgePubkeyHex":"cc","expiresAt":1800000000}}));
        rt(&json!({"v":11,"type":"provider-profiles-request"}));
        rt(&json!({"v":11,"type":"session-key","sessionKey":{"pubkeyHex":"bb","bridgePubkeyHex":"cc","expiresAt":1800000000}}));
    }

    #[test]
    fn upload_image_union_disambiguates_by_shape() {
        let m = rt(&json!({"v":11,"type":"upload-file","sessionId":"s","hash":"h","url":"u","key":"k","iv":"iv","filename":"f","mimeType":"image/png","text":"t","sizeBytes":1}));
        assert!(matches!(m, PhoneToBridge::UploadFile(UploadFileMsg::Blossom(_))));
        let m = rt(&json!({"v":11,"type":"upload-file","sessionId":"s","uploadId":"u","filename":"f","mimeType":"image/png","base64Data":"x","text":"t","chunkIndex":1,"totalChunks":4}));
        assert!(matches!(m, PhoneToBridge::UploadFile(UploadFileMsg::Chunk(_))));
    }

    #[test]
    fn set_credentials_set_clear_and_keep() {
        let m = rt(&json!({"v":11,"type":"set-credentials","agent":"claude-code","values":{"anthropic_api_key":"sk-x","other":null}}));
        match m {
            PhoneToBridge::SetCredentials(c) => {
                assert_eq!(c.agent.as_deref(), Some("claude-code"));
                assert_eq!(c.values.get("anthropic_api_key"), Some(&Some("sk-x".to_string())));
                assert_eq!(c.values.get("other"), Some(&None));
                assert!(!c.values.contains_key("unlisted"));
            }
            _ => panic!(),
        }
        // No agent = the bridge's own credentials.
        let m = rt(&json!({"v":11,"type":"set-credentials","values":{"github_pat":"ghp_x"}}));
        assert!(matches!(m, PhoneToBridge::SetCredentials(SetCredentialsMsg { agent: None, .. })));
    }

    #[test]
    fn logging_a_command_never_prints_its_secrets() {
        for v in [
            json!({"v":11,"type":"set-credentials","agent":"claude-code","values":{"anthropic_api_key":"sk-SECRET","other":null}}),
            json!({"v":11,"type":"upload-file","sessionId":"s","hash":"h","url":"u","key":"SECRET-key","iv":"iv","filename":"f","mimeType":"image/png","text":"","sizeBytes":1}),
            json!({"v":11,"type":"pair-request","npub":"npub1","pubkeyHex":"aa","label":"phone","token":"SECRET-token"}),
            json!({"v":11,"type":"set-provider-profile","profileId":"p","profile":{"agent":"opencode","label":"L","baseUrl":"https://x","authToken":"tok-SECRET","models":[]}}),
        ] {
            let shown = format!("{:?}", rt(&v));
            assert!(!shown.contains("SECRET"), "{shown}");
        }
        let shown = format!("{:?}", rt(&json!({"v":11,"type":"set-credentials","values":{"github_pat":"x","old":null}})));
        assert!(shown.contains("github_pat") && shown.contains("<set>") && shown.contains("<clear>"), "{shown}");
    }

    #[test]
    fn set_provider_profile_null_deletes() {
        let m = rt(&json!({"v":11,"type":"set-provider-profile","profileId":"p","profile":null}));
        assert!(matches!(m, PhoneToBridge::SetProviderProfile(SetProviderProfileMsg { profile: None, .. })));
        let m = rt(&json!({"v":11,"type":"set-provider-profile","profileId":"p","profile":{
            "agent":"claude-code","label":"L","baseUrl":"https://api.x","authToken":"tok","models":[{"id":"m1"}]
        }}));
        match m {
            PhoneToBridge::SetProviderProfile(s) => {
                let p = s.profile.unwrap();
                assert_eq!(p.auth_token, Tristate::Set("tok".into()));
                assert_eq!(p.models[0].id, "m1");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn create_session_and_models_request_must_name_the_agent() {
        assert!(serde_json::from_value::<PhoneToBridge>(json!({"v":11,"type":"create-session"})).is_err());
        assert!(serde_json::from_value::<PhoneToBridge>(json!({"v":11,"type":"models-request"})).is_err());
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<PhoneToBridge>(r#"{"v":11,"type":"teleport","sessionId":"s"}"#).is_err());
        // v10 terminal-emulation commands are gone.
        assert!(serde_json::from_str::<PhoneToBridge>(r#"{"v":11,"type":"keypress","sessionId":"s","key":"1"}"#).is_err());
    }
}
