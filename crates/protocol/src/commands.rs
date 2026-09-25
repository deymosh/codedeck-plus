//! Phone → bridge command messages (COMMAND_KIND, stored, 1h expiry).
//!
//! Every command carries an optional `v` (sender's PROTOCOL_VERSION) and `caps`
//! so version/capability negotiation is two-directional. The `PhoneToBridge`
//! union is `#[serde(tag = "type")]` — the wire `type` string selects the
//! variant.

use serde::{Deserialize, Serialize};

use super::common::{CredentialValues, DeviceConfig, ProviderModel, SessionOption};
use super::tristate::Tristate;
use crate::ranges::SeqRange;

/// `v` + `caps` — flattened into every command. Kept as one struct so the pair
/// is defined once; serde `flatten` places them alongside `type`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct VersionFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caps: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InputMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
}

/// Answer to a `permission_request` entry: one of its `options[].id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponseMsg {
    #[serde(flatten)]
    pub version: VersionFields,
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
    #[serde(flatten)]
    pub version: VersionFields,
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
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub request_id: String,
    pub option_id: String,
}

/// Change a session option. `value` must be one the session's agent
/// advertises (a mode / effort id, or a model id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetOptionMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
    pub option: SessionOption,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequestMsg {
    #[serde(flatten)]
    pub version: VersionFields,
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
    #[serde(flatten)]
    pub version: VersionFields,
    pub sync_id: String,
    #[specta(type = (specta_typescript::Number, specta_typescript::Number))]
    pub range: SeqRange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionMsg {
    #[serde(flatten)]
    pub version: VersionFields,
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
    pub test_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_cwd: Option<bool>,
    /// Custom provider profile; only for agents with `supports.providers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct BareMsg {
    #[serde(flatten)]
    pub version: VersionFields,
}

/// Ask for an agent's live model list (agents with `supports.models`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ModelsRequestMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub agent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    #[specta(type = specta_typescript::Number)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    #[specta(type = specta_typescript::Number)]
    pub chunk_index: u64,
    #[specta(type = specta_typescript::Number)]
    pub total_chunks: u64,
}

/// Same `type`, disambiguated by shape (`hash`/`url` vs
/// `uploadId`/`base64Data`). `untagged` tries each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum UploadImageMsg {
    Blossom(UploadImageBlossomMsg),
    Chunk(UploadImageChunkMsg),
}

/// Store or clear credentials. `agent` names the agent they belong to;
/// absent = the bridge's own credentials (e.g. a GitHub token). `values`
/// maps credential ids (from the agent's advertised `credentials`) to a new
/// secret, or `null` to clear; ids not listed are left unchanged. The only
/// message a credential secret ever rides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialsMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub values: CredentialValues,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetDeviceConfigMsg {
    #[serde(flatten)]
    pub version: VersionFields,
    pub config: DeviceConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderProfileMsg {
    #[serde(flatten)]
    pub version: VersionFields,
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
    CreateFolder(CreateFolderMsg),
    UploadImage(UploadImageMsg),
    UsageRequest(SessionIdMsg),
    GsdRequest(SessionIdMsg),
    ModelsRequest(ModelsRequestMsg),
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
        let msg: PhoneToBridge = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v} -> {e}"));
        let back = serde_json::to_value(&msg).unwrap();
        let msg2: PhoneToBridge = serde_json::from_value(back).unwrap();
        assert_eq!(msg, msg2, "semantic round-trip");
        msg
    }

    #[test]
    fn input_with_and_without_version_fields() {
        let m = rt(&json!({"type":"input","sessionId":"s","text":"hi","inputId":"i1"}));
        assert!(matches!(m, PhoneToBridge::Input(InputMsg { ref session_id, .. }) if session_id == "s"));
        let m = rt(&json!({"type":"input","v":11,"caps":["chunked"],"sessionId":"s","text":""}));
        match m {
            PhoneToBridge::Input(i) => {
                assert_eq!(i.version.v, Some(11));
                assert_eq!(i.version.caps.as_deref(), Some(&["chunked".to_string()][..]));
                assert_eq!(i.input_id, None);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn every_variant_decodes_from_a_representative_fixture() {
        rt(&json!({"type":"permission-response","sessionId":"s","requestId":"r","optionId":"allow_always"}));
        rt(&json!({"type":"question-response","sessionId":"s","requestId":"q","index":1,"answer":{"kind":"options","selected":[0,2]}}));
        rt(&json!({"type":"question-response","sessionId":"s","requestId":"q","index":0,"answer":{"kind":"text","text":"blue"}}));
        rt(&json!({"type":"plan-response","sessionId":"s","requestId":"p","optionId":"approve"}));
        rt(&json!({"type":"set-option","sessionId":"s","option":"mode","value":"plan"}));
        rt(&json!({"type":"set-option","sessionId":"s","option":"model","value":"anthropic/claude-x"}));
        rt(&json!({"type":"sync-request","sessionId":"s","haveRanges":[[1,40],[61,80]]}));
        rt(&json!({"type":"sync-ack","syncId":"y","range":[1,50]}));
        rt(&json!({"type":"create-session","agent":"opencode","effort":"high","cwd":"proj","createCwd":true,"providerId":"p"}));
        rt(&json!({"type":"refresh-sessions"}));
        rt(&json!({"type":"close-session","sessionId":"s"}));
        rt(&json!({"type":"interrupt","sessionId":"s"}));
        rt(&json!({"type":"create-folder","path":"a/b","root":"/w","requestId":"r"}));
        rt(&json!({"type":"upload-image","sessionId":"s","hash":"h","url":"u","key":"k","iv":"iv","filename":"f","mimeType":"image/png","text":"","sizeBytes":123}));
        rt(&json!({"type":"upload-image","sessionId":"s","uploadId":"u","filename":"f","mimeType":"image/png","base64Data":"x","text":"","chunkIndex":0,"totalChunks":2}));
        rt(&json!({"type":"usage-request","sessionId":"s"}));
        rt(&json!({"type":"gsd-request","sessionId":"s"}));
        rt(&json!({"type":"models-request","agent":"opencode"}));
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
    fn set_credentials_set_clear_and_keep() {
        let m = rt(&json!({"type":"set-credentials","agent":"claude-code","values":{"anthropic_api_key":"sk-x","other":null}}));
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
        let m = rt(&json!({"type":"set-credentials","values":{"github_pat":"ghp_x"}}));
        assert!(matches!(m, PhoneToBridge::SetCredentials(SetCredentialsMsg { agent: None, .. })));
    }

    #[test]
    fn set_provider_profile_null_deletes() {
        let m = rt(&json!({"type":"set-provider-profile","profileId":"p","profile":null}));
        assert!(matches!(m, PhoneToBridge::SetProviderProfile(SetProviderProfileMsg { profile: None, .. })));
        let m = rt(&json!({"type":"set-provider-profile","profileId":"p","profile":{
            "label":"L","baseUrl":"https://api.x","authToken":"tok","models":[{"id":"m1"}]
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
        assert!(serde_json::from_value::<PhoneToBridge>(json!({"type":"create-session"})).is_err());
        assert!(serde_json::from_value::<PhoneToBridge>(json!({"type":"models-request"})).is_err());
    }

    #[test]
    fn unknown_type_is_a_decode_error() {
        assert!(serde_json::from_str::<PhoneToBridge>(r#"{"type":"teleport","sessionId":"s"}"#).is_err());
        // v10 terminal-emulation commands are gone.
        assert!(serde_json::from_str::<PhoneToBridge>(r#"{"type":"keypress","sessionId":"s","key":"1"}"#).is_err());
    }
}
