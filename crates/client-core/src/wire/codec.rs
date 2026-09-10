//! The only place wire JSON is parsed. Port of `packages/protocol/src/codec.ts`.
//! Both sides call these at ingest — a raw `serde_json::from_str` into a message
//! type is banned everywhere else. Invalid payloads come back as a structured
//! error to log-and-drop, never a panic or a lying value.

use serde::{de::DeserializeOwned, Serialize};

use super::commands::PhoneToBridge;
use super::events::BridgeToPhone;

/// `Ok(msg)` or `Err(human-readable reason)`. Mirrors the TS
/// `{ ok: true, msg } | { ok: false, error }`.
pub type DecodeResult<T> = Result<T, String>;

fn decode<T: DeserializeOwned>(json: &str) -> DecodeResult<T> {
    let raw: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    serde_json::from_value::<T>(raw.clone()).map_err(|e| {
        let ty = raw
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>");
        format!("schema mismatch for type \"{ty}\": {e}")
    })
}

/// Bridge-side ingest: decode a message sent by a phone.
pub fn decode_phone_to_bridge(json: &str) -> DecodeResult<PhoneToBridge> {
    decode(json)
}

/// Phone-side ingest: decode a message sent by a bridge.
pub fn decode_bridge_to_phone(json: &str) -> DecodeResult<BridgeToPhone> {
    decode(json)
}

fn encode<T: Serialize>(msg: &T) -> String {
    serde_json::to_string(msg).expect("wire messages always serialize")
}

/// Encode a phone→bridge message for the wire. CDX-071: rejects a
/// `set-provider-profile` whose `base_url` is not https (or http on loopback),
/// so a cleartext profile fails loudly at the sender.
pub fn encode_phone_to_bridge(msg: &PhoneToBridge) -> DecodeResult<String> {
    if let PhoneToBridge::SetProviderProfile(m) = msg {
        if let Some(profile) = &m.profile {
            if !super::common::is_valid_provider_base_url(&profile.base_url) {
                return Err(super::common::PROVIDER_BASE_URL_ERROR.to_string());
            }
        }
    }
    Ok(encode(msg))
}

/// Encode a bridge→phone message for the wire.
pub fn encode_bridge_to_phone(msg: &BridgeToPhone) -> String {
    encode(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::commands::{ProviderProfileWrite, SetProviderProfileMsg, VersionFields};
    use crate::wire::tristate::Tristate;
    use serde_json::json;

    #[test]
    fn decode_phone_ok_and_error() {
        let ok = decode_phone_to_bridge(r#"{"type":"input","sessionId":"s","text":"hi"}"#);
        assert!(ok.is_ok());

        let bad_json = decode_phone_to_bridge("{not json");
        assert!(bad_json.unwrap_err().starts_with("invalid JSON:"));

        let bad_schema = decode_phone_to_bridge(r#"{"type":"input","text":"hi"}"#); // no sessionId
        assert!(bad_schema.unwrap_err().starts_with(r#"schema mismatch for type "input":"#));

        let unknown = decode_phone_to_bridge(r#"{"type":"teleport"}"#);
        assert!(unknown.unwrap_err().contains(r#"type "teleport""#));
    }

    #[test]
    fn decode_bridge_ok_and_error() {
        assert!(decode_bridge_to_phone(r#"{"type":"input-ack","sessionId":"s","inputId":"i"}"#).is_ok());
        assert!(decode_bridge_to_phone(r#"{"type":"output","sessionId":"s"}"#).unwrap_err().contains("output"));
    }

    #[test]
    fn round_trip_via_encode_decode() {
        let src = json!({"type":"sync-request","sessionId":"s","haveRanges":[[1,40],[61,80]]});
        let msg = decode_phone_to_bridge(&src.to_string()).unwrap();
        let wire = encode_phone_to_bridge(&msg).unwrap();
        assert_eq!(decode_phone_to_bridge(&wire).unwrap(), msg);
    }

    #[test]
    fn extra_unknown_field_still_decodes_forward_compat() {
        // serde ignores unknown fields by default — matches zod's default strip.
        let with_extra = r#"{"type":"input","sessionId":"s","text":"hi","futureField":123}"#;
        assert!(decode_phone_to_bridge(with_extra).is_ok());
    }

    #[test]
    fn encode_phone_rejects_cleartext_provider_base_url() {
        let cleartext = PhoneToBridge::SetProviderProfile(SetProviderProfileMsg {
            version: VersionFields::default(),
            profile_id: "p".into(),
            profile: Some(ProviderProfileWrite {
                label: "L".into(),
                base_url: "http://api.example.com".into(),
                auth_token: Tristate::Set("tok".into()),
                models: vec![],
                default_model: None,
            }),
        });
        assert_eq!(
            encode_phone_to_bridge(&cleartext).unwrap_err(),
            super::super::common::PROVIDER_BASE_URL_ERROR
        );

        let loopback = PhoneToBridge::SetProviderProfile(SetProviderProfileMsg {
            version: VersionFields::default(),
            profile_id: "p".into(),
            profile: Some(ProviderProfileWrite {
                label: "L".into(),
                base_url: "http://localhost:11434/v1".into(),
                auth_token: Tristate::Keep,
                models: vec![],
                default_model: None,
            }),
        });
        assert!(encode_phone_to_bridge(&loopback).is_ok());
    }
}
