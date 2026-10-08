//! The only place wire JSON is parsed.
//! Both sides call these at ingest — a raw `serde_json::from_str` into a message
//! type is banned everywhere else. Invalid payloads come back as a structured
//! error to log-and-drop, never a panic or a lying value.
//!
//! Every message carries `v`, its sender's [`PROTOCOL_VERSION`], stamped here
//! on encode and checked here on decode before anything else: two ends of
//! different versions cannot talk, and a clear [`DecodeError::Version`] says
//! so where a body read by the wrong version's rules would fail at random (or,
//! worse, decode into something else).

use serde::{de::DeserializeOwned, Serialize};

use super::capabilities::PROTOCOL_VERSION;
use super::commands::PhoneToBridge;
use super::events::BridgeToPhone;

/// Why a payload was not decoded. The text quotes the sender's bytes escaped
/// and capped, for a log line.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// The sender speaks another protocol version — the one it names, or
    /// none (`None`: a sender from before messages were versioned, or not a
    /// CodeDeck one). Nothing it sends can be read here.
    #[error("the sender speaks {}, not v{PROTOCOL_VERSION}", .0.map_or("no protocol version".to_string(), |v| format!("protocol v{v}")))]
    Version(Option<u64>),
    #[error("{0}")]
    Invalid(String),
}

/// `Ok(msg)` or why not (see [`DecodeError`]); the message is dropped.
pub type DecodeResult<T> = Result<T, DecodeError>;

fn decode<T: DeserializeOwned>(json: &str) -> DecodeResult<T> {
    let raw: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| DecodeError::Invalid(format!("invalid JSON: {}", loggable(&e.to_string(), 200))))?;
    match raw.get("v").map(serde_json::Value::as_u64) {
        Some(Some(v)) if v == u64::from(PROTOCOL_VERSION) => {}
        Some(v) => return Err(DecodeError::Version(v)),
        None => return Err(DecodeError::Version(None)),
    }
    serde_json::from_value::<T>(raw.clone()).map_err(|e| {
        let ty = raw
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>");
        DecodeError::Invalid(format!("schema mismatch for type \"{}\": {}", loggable(ty, 64), loggable(&e.to_string(), 200)))
    })
}

/// The error text quotes the sender's own bytes (its `type`, and serde
/// echoes unknown variants and field names), and callers log it: control
/// characters are escaped so a payload cannot forge log lines or terminal
/// escapes, and the length is capped.
fn loggable(text: &str, max_chars: usize) -> String {
    let mut out: String = text
        .chars()
        .take(max_chars)
        .flat_map(|c| if c.is_control() { c.escape_debug().collect::<Vec<_>>() } else { vec![c] })
        .collect();
    if text.chars().nth(max_chars).is_some() {
        out.push('…');
    }
    out
}

/// Bridge-side ingest: decode a message sent by a phone, packed or not
/// (see `packing.rs`).
pub fn decode_phone_to_bridge(json: &str) -> DecodeResult<PhoneToBridge> {
    decode(&super::packing::unpack(json).map_err(DecodeError::Invalid)?)
}

/// Phone-side ingest: decode a message sent by a bridge, packed or not
/// (see `packing.rs`).
pub fn decode_bridge_to_phone(json: &str) -> DecodeResult<BridgeToPhone> {
    decode(&super::packing::unpack(json).map_err(DecodeError::Invalid)?)
}

/// `msg` as wire JSON with `v` first: the object serde writes, opened with
/// the version (every message is an object with at least its `type`).
fn encode<T: Serialize>(msg: &T) -> String {
    let body = serde_json::to_string(msg).expect("wire messages always serialize");
    format!("{{\"v\":{PROTOCOL_VERSION},{}", &body[1..])
}

/// Encode a phone→bridge message for the wire. CDX-071: rejects a
/// `set-provider-profile` whose `base_url` the bridge would refuse (see
/// [`is_valid_provider_base_url`](super::common::is_valid_provider_base_url):
/// https, or http only to this machine or a private-network address), so it
/// fails loudly at the sender.
pub fn encode_phone_to_bridge(msg: &PhoneToBridge) -> Result<String, String> {
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
    use crate::commands::{ProviderProfileWrite, SetProviderProfileMsg};
    use crate::tristate::Tristate;
    use serde_json::json;

    #[test]
    fn decode_phone_ok_and_error() {
        let ok = decode_phone_to_bridge(r#"{"v":11,"type":"input","sessionId":"s","text":"hi"}"#);
        assert!(ok.is_ok());

        let bad_json = decode_phone_to_bridge("{not json").unwrap_err().to_string();
        assert!(bad_json.starts_with("invalid JSON:"));

        let bad_schema = decode_phone_to_bridge(r#"{"v":11,"type":"input","text":"hi"}"#); // no sessionId
        assert!(bad_schema.unwrap_err().to_string().starts_with(r#"schema mismatch for type "input":"#));

        let unknown = decode_phone_to_bridge(r#"{"v":11,"type":"teleport"}"#);
        assert!(unknown.unwrap_err().to_string().contains(r#"type "teleport""#));
    }

    /// The version is read before the body: a message from another version
    /// is refused as such, whatever its body would have decoded to.
    #[test]
    fn a_message_of_another_version_or_none_is_refused_as_such() {
        let input = |v: &str| format!(r#"{{{v}"type":"input","sessionId":"s","text":"hi"}}"#);
        assert_eq!(decode_phone_to_bridge(&input(r#""v":12,"#)), Err(DecodeError::Version(Some(12))));
        assert_eq!(decode_phone_to_bridge(&input("")), Err(DecodeError::Version(None)));
        assert_eq!(decode_phone_to_bridge(&input(r#""v":"11","#)), Err(DecodeError::Version(None)));
        assert_eq!(decode_bridge_to_phone(r#"{"v":10,"type":"warp"}"#), Err(DecodeError::Version(Some(10))));
        assert_eq!(
            DecodeError::Version(Some(12)).to_string(),
            format!("the sender speaks protocol v12, not v{PROTOCOL_VERSION}")
        );
    }

    #[test]
    fn every_encoded_message_opens_with_its_version() {
        let wire = encode_bridge_to_phone(&decode_bridge_to_phone(r#"{"v":11,"type":"input-ack","sessionId":"s","inputId":"i"}"#).unwrap());
        assert!(wire.starts_with(&format!(r#"{{"v":{PROTOCOL_VERSION},"type":"input-ack""#)), "{wire}");
    }

    /// A phone whose identity lives in a signer app may hand it a message with
    /// a leading space (so the signer files it as text); it must decode as is.
    #[test]
    fn a_message_with_leading_whitespace_decodes() {
        assert!(decode_phone_to_bridge(r#" {"v":11,"type":"input","sessionId":"s","text":"hi"}"#).is_ok());
    }

    #[test]
    fn decode_errors_escape_and_cap_the_senders_bytes() {
        let forged = json!({"v":11,"type":"x\n[Engine] Paired phone attacker\u{1b}[2J"}).to_string();
        let err = decode_phone_to_bridge(&forged).unwrap_err().to_string();
        assert!(!err.chars().any(char::is_control), "{err:?}");
        assert!(err.contains(r"x\n[Engine]"), "{err}");

        let long = json!({"v":11,"type": "t".repeat(10_000)}).to_string();
        let err = decode_phone_to_bridge(&long).unwrap_err().to_string();
        assert!(err.len() < 600, "{} bytes", err.len());
    }

    #[test]
    fn decode_bridge_ok_and_error() {
        assert!(decode_bridge_to_phone(r#"{"v":11,"type":"input-ack","sessionId":"s","inputId":"i"}"#).is_ok());
        assert!(decode_bridge_to_phone(r#"{"v":11,"type":"output","sessionId":"s"}"#).unwrap_err().to_string().contains("output"));
    }

    #[test]
    fn round_trip_via_encode_decode() {
        let src = json!({"v":11,"type":"sync-request","sessionId":"s","haveRanges":[[1,40],[61,80]]});
        let msg = decode_phone_to_bridge(&src.to_string()).unwrap();
        let wire = encode_phone_to_bridge(&msg).unwrap();
        assert_eq!(decode_phone_to_bridge(&wire).unwrap(), msg);
    }

    #[test]
    fn extra_unknown_field_still_decodes_forward_compat() {
        // serde ignores unknown fields by default: an added optional field
        // reaches an older peer as nothing, not as an error.
        let with_extra = r#"{"v":11,"type":"input","sessionId":"s","text":"hi","futureField":123}"#;
        assert!(decode_phone_to_bridge(with_extra).is_ok());
    }

    #[test]
    fn encode_phone_rejects_cleartext_provider_base_url() {
        let cleartext = PhoneToBridge::SetProviderProfile(SetProviderProfileMsg {
            profile_id: "p".into(),
            profile: Some(ProviderProfileWrite {
                agent: "claude-code".into(),
                label: "L".into(),
                base_url: "http://api.example.com".into(),
                auth_token: Tristate::Set("tok".into()),
                models: vec![],
                models_from_provider: false,
                default_model: None,
            }),
        });
        assert_eq!(
            encode_phone_to_bridge(&cleartext).unwrap_err(),
            super::super::common::PROVIDER_BASE_URL_ERROR
        );

        let loopback = PhoneToBridge::SetProviderProfile(SetProviderProfileMsg {
            profile_id: "p".into(),
            profile: Some(ProviderProfileWrite {
                agent: "claude-code".into(),
                label: "L".into(),
                base_url: "http://localhost:11434/v1".into(),
                auth_token: Tristate::Keep,
                models: vec![],
                models_from_provider: false,
                default_model: None,
            }),
        });
        assert!(encode_phone_to_bridge(&loopback).is_ok());
    }
}
