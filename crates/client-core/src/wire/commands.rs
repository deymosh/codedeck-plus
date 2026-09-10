//! Phone → bridge command messages (COMMAND_KIND, stored, 1h expiry). Port of
//! `packages/protocol/src/schemas/commands.ts`.
//!
//! Every command carries an optional `v` (sender's PROTOCOL_VERSION) and `caps`
//! so version/capability negotiation is two-directional. The `PhoneToBridge`
//! union is `#[serde(tag = "type")]` — the wire `type` string selects the
//! variant, exactly the discriminant zod's `z.union` keys on.

use serde::{Deserialize, Serialize};

use super::common::{DeviceConfig, EffortLevel, PermissionMode, ProviderModel};
use super::tristate::Tristate;
use crate::ranges::SeqRange;

/// `v` + `caps` — flattened into every command. Kept as one struct so the pair
/// is defined once; serde `flatten` places them alongside `type`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionModifier {
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeypressContext {
    PlanApproval,
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionInputMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub text: String,
    pub option_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub request_id: String,
    pub allow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifier: Option<PermissionModifier>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeypressMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<KeypressContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChangeMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortChangeMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub level: EffortLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChangeMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequestMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub have_ranges: Vec<SeqRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAckMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub sync_id: String,
    pub range: SeqRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<EffortLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_cwd: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BareMsg {
    #[serde(flatten)]
    pub version: VersionFields,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadImageBlossomMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub hash: String,
    pub url: String,
    pub key: String,
    pub iv: String,
    pub filename: String,
    pub mime_type: String,
    pub text: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadImageChunkMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub upload_id: String,
    pub filename: String,
    pub mime_type: String,
    pub base64_data: String,
    pub text: String,
    pub chunk_index: u64,
    pub total_chunks: u64,
}

/// Mirrors zod's `z.union([blossom, chunk])` — same `type`, disambiguated by
/// shape (`hash`/`url` vs `uploadId`/`base64Data`). `untagged` tries each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UploadImageMsg {
    Blossom(UploadImageBlossomMsg),
    Chunk(UploadImageChunkMsg),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialsMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    #[serde(default, skip_serializing_if = "Tristate::is_keep")]
    pub anthropic_api_key: Tristate<String>,
    #[serde(default, skip_serializing_if = "Tristate::is_keep")]
    pub github_pat: Tristate<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDeviceConfigMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub config: DeviceConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub npub: String,
    pub pubkey_hex: String,
    pub label: String,
    pub token: String,
}

/// Write shape of a provider profile (CDX-062/071). `auth_token` is tri-state
/// (keep/clear/set) — the ONLY message the token ever rides on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileWrite {
    pub label: String,
    /// CDX-071: https, or http ONLY on loopback — validated on egress
    /// ([`super::codec::encode_phone_to_bridge`]).
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Tristate::is_keep")]
    pub auth_token: Tristate<String>,
    pub models: Vec<ProviderModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderProfileMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub profile_id: String,
    /// nullable (always present; `null` deletes the whole profile).
    pub profile: Option<ProviderProfileWrite>,
}

/// The phone→bridge message union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PhoneToBridge {
    Input(InputMsg),
    QuestionInput(QuestionInputMsg),
    #[serde(rename = "permission-res")]
    PermissionRes(PermissionResMsg),
    Keypress(KeypressMsg),
    Mode(ModeChangeMsg),
    Effort(EffortChangeMsg),
    Model(ModelChangeMsg),
    SyncRequest(SyncRequestMsg),
    SyncAck(SyncAckMsg),
    CreateSession(CreateSessionMsg),
    RefreshSessions(BareMsg),
    CloseSession(SessionIdMsg),
    Interrupt(SessionIdMsg),
    CreateFolder(CreateFolderMsg),
    UploadImage(UploadImageMsg),
    UsageRequest(SessionIdMsg),
    GsdRequest(SessionIdMsg),
    ModelsRequest(BareMsg),
    SetCredentials(SetCredentialsMsg),
    SetDeviceConfig(SetDeviceConfigMsg),
    PairRequest(PairRequestMsg),
    SetProviderProfile(SetProviderProfileMsg),
    ProviderProfilesRequest(BareMsg),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rt(v: &serde_json::Value) -> PhoneToBridge {
        let msg: PhoneToBridge = serde_json::from_value(v.clone()).unwrap();
        let back = serde_json::to_value(&msg).unwrap();
        let msg2: PhoneToBridge = serde_json::from_value(back).unwrap();
        assert_eq!(msg, msg2, "semantic round-trip");
        msg
    }

    #[test]
    fn input_with_and_without_version_fields() {
        let m = rt(&json!({"type":"input","sessionId":"s","text":"hi","inputId":"i1"}));
        assert!(matches!(m, PhoneToBridge::Input(InputMsg { ref session_id, .. }) if session_id == "s"));
        let m = rt(&json!({"type":"input","v":10,"caps":["diff","chunked"],"sessionId":"s","text":""}));
        match m {
            PhoneToBridge::Input(i) => {
                assert_eq!(i.version.v, Some(10));
                assert_eq!(i.version.caps.as_deref(), Some(&["diff".to_string(), "chunked".to_string()][..]));
                assert_eq!(i.input_id, None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn every_variant_decodes_from_a_representative_fixture() {
        rt(&json!({"type":"question-input","sessionId":"s","text":"?","optionCount":3}));
        rt(&json!({"type":"permission-res","sessionId":"s","requestId":"r","allow":true,"modifier":"always"}));
        rt(&json!({"type":"keypress","sessionId":"s","key":"1","context":"plan-approval"}));
        rt(&json!({"type":"mode","sessionId":"s","mode":"acceptEdits"}));
        rt(&json!({"type":"effort","sessionId":"s","level":"xhigh"}));
        rt(&json!({"type":"model","sessionId":"s","model":"claude-x"}));
        rt(&json!({"type":"sync-request","sessionId":"s","haveRanges":[[1,40],[61,80]]}));
        rt(&json!({"type":"sync-ack","syncId":"y","range":[1,50]}));
        rt(&json!({"type":"create-session","defaultEffort":"high","cwd":"proj","createCwd":true,"providerId":"p"}));
        rt(&json!({"type":"refresh-sessions"}));
        rt(&json!({"type":"close-session","sessionId":"s"}));
        rt(&json!({"type":"interrupt","sessionId":"s"}));
        rt(&json!({"type":"create-folder","path":"a/b","root":"/w","requestId":"r"}));
        rt(&json!({"type":"upload-image","sessionId":"s","hash":"h","url":"u","key":"k","iv":"iv","filename":"f","mimeType":"image/png","text":"","sizeBytes":123}));
        rt(&json!({"type":"upload-image","sessionId":"s","uploadId":"u","filename":"f","mimeType":"image/png","base64Data":"x","text":"","chunkIndex":0,"totalChunks":2}));
        rt(&json!({"type":"usage-request","sessionId":"s"}));
        rt(&json!({"type":"gsd-request","sessionId":"s"}));
        rt(&json!({"type":"models-request"}));
        rt(&json!({"type":"set-device-config","config":{"label":"dev","appUnderTest":"kubo"}}));
        rt(&json!({"type":"pair-request","npub":"npub1","pubkeyHex":"aa","label":"phone","token":"t"}));
        rt(&json!({"type":"provider-profiles-request"}));
    }

    #[test]
    fn upload_image_union_disambiguates_by_shape() {
        let m = rt(&json!({"type":"upload-image","sessionId":"s","hash":"h","url":"u","key":"k","iv":"iv","filename":"f","mimeType":"image/png","text":"t","sizeBytes":1}));
        assert!(matches!(m, PhoneToBridge::UploadImage(UploadImageMsg::Blossom(_))));
        let m = rt(&json!({"type":"upload-image","sessionId":"s","uploadId":"u","filename":"f","mimeType":"image/png","base64Data":"x","text":"t","chunkIndex":1,"totalChunks":4}));
        assert!(matches!(m, PhoneToBridge::UploadImage(UploadImageMsg::Chunk(_))));
    }

    #[test]
    fn set_credentials_tristate() {
        // absent = keep
        let m = rt(&json!({"type":"set-credentials"}));
        match m { PhoneToBridge::SetCredentials(c) => {
            assert_eq!(c.anthropic_api_key, Tristate::Keep);
            assert_eq!(c.github_pat, Tristate::Keep);
        }, _ => panic!() }
        // null = clear, string = set
        let m = rt(&json!({"type":"set-credentials","anthropicApiKey":null,"githubPat":"ghp_x"}));
        match m { PhoneToBridge::SetCredentials(c) => {
            assert_eq!(c.anthropic_api_key, Tristate::Clear);
            assert_eq!(c.github_pat, Tristate::Set("ghp_x".into()));
        }, _ => panic!() }
    }

    #[test]
    fn set_provider_profile_null_deletes() {
        let m = rt(&json!({"type":"set-provider-profile","profileId":"p","profile":null}));
        assert!(matches!(m, PhoneToBridge::SetProviderProfile(SetProviderProfileMsg { profile: None, .. })));
        let m = rt(&json!({"type":"set-provider-profile","profileId":"p","profile":{
            "label":"L","baseUrl":"https://api.x","authToken":"tok","models":[{"id":"m1"}]
        }}));
        match m { PhoneToBridge::SetProviderProfile(s) => {
            let p = s.profile.unwrap();
            assert_eq!(p.auth_token, Tristate::Set("tok".into()));
            assert_eq!(p.models[0].id, "m1");
        }, _ => panic!() }
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<PhoneToBridge>(r#"{"type":"teleport","sessionId":"s"}"#).is_err());
    }
}
