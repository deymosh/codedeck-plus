//! Bridge → phone messages. Port of `packages/protocol/src/schemas/events.ts`.
//! Storage class per message is in `kinds.rs`. The `BridgeToPhone` union is
//! `#[serde(tag = "type")]`.

use serde::{Deserialize, Serialize};

use super::capabilities::BridgeHostKind;
use super::common::{
    AuthStatus, EffortLevel, GsdState, OutputEntry, PermissionMode, ProviderProfileInfo,
    RemoteSessionInfo, UsageData,
};
use crate::ranges::SeqRange;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListMsg {
    pub machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
    pub sessions: Vec<RemoteSessionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_status: Option<AuthStatus>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputMsg {
    pub session_id: String,
    pub seq: u64,
    pub entry: OutputEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputAckMsg {
    pub session_id: String,
    pub input_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBeginMsg {
    pub session_id: String,
    pub sync_id: String,
    pub seq_high: u64,
    pub ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    pub seq: u64,
    pub entry: OutputEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChunkMsg {
    pub session_id: String,
    pub sync_id: String,
    pub range: SeqRange,
    pub entries: Vec<SyncEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEndMsg {
    pub session_id: String,
    pub sync_id: String,
    pub delivered_ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPendingMsg {
    pub pending_id: String,
    pub machine: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadyMsg {
    pub pending_id: String,
    pub session: RemoteSessionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFailedMsg {
    pub pending_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputFailedReason {
    NoSession,
    Expired,
    Busy,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFailedMsg {
    pub session_id: String,
    pub reason: InputFailedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionAckMsg {
    pub session_id: String,
    pub success: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplacedMsg {
    pub old_session_id: String,
    pub new_session: RemoteSessionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeConfirmedMsg {
    pub session_id: String,
    pub mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortConfirmedMsg {
    pub session_id: String,
    pub level: EffortLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfirmedMsg {
    pub session_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAckMsg {
    pub request_id: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMsg {
    pub session_id: String,
    pub usage: UsageData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GsdStateMsg {
    pub session_id: String,
    pub gsd: GsdState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsMsg {
    pub models: Vec<ModelEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// CDX-035: why the bridge could not answer — set ONLY alongside an empty
    /// `models`; the phone keeps its list and keeps re-requesting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsAckMsg {
    pub machine: String,
    pub success: bool,
    pub has_anthropic_key: bool,
    pub has_github_pat: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_valid: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfigAckMsg {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairAckReason {
    BadToken,
    WindowClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairAckMsg {
    pub machine: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<PairAckReason>,
    /// the bridge's relay list, so a manual-npub pairing still learns where it
    /// lives (merged into settings, deduped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relays: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfilesMsg {
    pub machine: String,
    pub profiles: Vec<ProviderProfileInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    ModeConfirmed(ModeConfirmedMsg),
    EffortConfirmed(EffortConfirmedMsg),
    ModelConfirmed(ModelConfirmedMsg),
    FolderAck(FolderAckMsg),
    Usage(UsageMsg),
    GsdState(GsdStateMsg),
    Models(ModelsMsg),
    CredentialsAck(CredentialsAckMsg),
    DeviceConfigAck(DeviceConfigAckMsg),
    PairAck(PairAckMsg),
    ProviderProfiles(ProviderProfilesMsg),
    ProviderProfileAck(ProviderProfileAckMsg),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rt(v: &serde_json::Value) -> BridgeToPhone {
        let msg: BridgeToPhone = serde_json::from_value(v.clone()).unwrap();
        let msg2: BridgeToPhone = serde_json::from_value(serde_json::to_value(&msg).unwrap()).unwrap();
        assert_eq!(msg, msg2, "semantic round-trip");
        msg
    }

    fn session() -> serde_json::Value {
        json!({"id":"s","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":1,"title":null,"project":"p","state":"running","seqHigh":10})
    }
    fn entry() -> serde_json::Value {
        json!({"entryType":"text","content":"hello","timestamp":"t"})
    }

    #[test]
    fn heartbeat_minimal_and_full() {
        let m = rt(&json!({"type":"sessions","machine":"m","sessions":[],"protocolVersion":10}));
        match m {
            BridgeToPhone::Sessions(s) => {
                assert_eq!(s.protocol_version, 10);
                assert_eq!(s.host, None);
                assert_eq!(s.removed_sessions, None);
            }
            _ => panic!(),
        }
        let m = rt(&json!({
            "type":"sessions","machine":"m","host":"service","sessions":[session()],
            "authStatus":{"hasAnthropicKey":true,"hasGithubPat":false,"hasEnvKey":false},
            "protocolVersion":10,"capabilities":["sync/1","diff"],
            "folders":["a","b"],"roots":["/w"],"removedSessions":["old"],"machineOffline":true
        }));
        match m {
            BridgeToPhone::Sessions(s) => {
                assert_eq!(s.host, Some(BridgeHostKind::Service));
                assert_eq!(s.removed_sessions.as_deref(), Some(&["old".to_string()][..]));
                assert_eq!(s.machine_offline, Some(true));
            }
            _ => panic!(),
        }
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
        rt(&json!({"type":"mode-confirmed","sessionId":"s","mode":"plan"}));
        rt(&json!({"type":"effort-confirmed","sessionId":"s","level":"max"}));
        rt(&json!({"type":"model-confirmed","sessionId":"s","model":"m"}));
        rt(&json!({"type":"folder-ack","requestId":"r","success":true,"path":"a/b"}));
        rt(&json!({"type":"usage","sessionId":"s","usage":{"available":true,"subscriptionType":null,"fetchedAt":"t"}}));
        rt(&json!({"type":"gsd-state","sessionId":"s","gsd":{
            "installed":true,"available":true,"hasGit":true,"situation":"x","summary":"y",
            "milestone":null,"currentPhase":null,"totalPhases":null,"percent":0.0,
            "phases":[],"actions":[],"recommended":null,"paused":false,"blockers":[],
            "verifyFailed":false,"execution":null
        }}));
        rt(&json!({"type":"models","models":[{"id":"m1","label":"M1"},{"id":"m2"}],"defaultModel":"m1"}));
        rt(&json!({"type":"models","models":[],"error":"sdk offline"}));
        rt(&json!({"type":"credentials-ack","machine":"m","success":true,"hasAnthropicKey":true,"hasGithubPat":false,"keyValid":true}));
        rt(&json!({"type":"device-config-ack","success":false,"error":"unreachable"}));
        rt(&json!({"type":"pair-ack","machine":"m","ok":false,"reason":"bad-token","relays":["wss://r"],"host":"cli"}));
        rt(&json!({"type":"provider-profiles","machine":"m","profiles":[{"id":"p","label":"L","baseUrl":"https://x","models":[{"id":"m"}],"hasToken":true}]}));
        rt(&json!({"type":"provider-profile-ack","machine":"m","profileId":"p","success":true,"tokenValid":false}));
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<BridgeToPhone>(r#"{"type":"warp","sessionId":"s"}"#).is_err());
    }

    #[test]
    fn diff_output_entry_survives_the_full_message() {
        let m = rt(&json!({"type":"output","sessionId":"s","seq":1,"entry":{
            "entryType":"diff","content":"+a","timestamp":"t",
            "diff":{"path":"f","lines":[{"type":"add","text":"a"}],"truncated":true}
        }}));
        match m {
            BridgeToPhone::Output(o) => {
                assert_eq!(o.entry.entry_type, crate::wire::common::OutputEntryType::Diff);
                assert_eq!(o.entry.diff.unwrap().truncated, Some(true));
            }
            _ => panic!(),
        }
    }
}
