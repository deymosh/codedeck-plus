//! The codec conformance corpus (`fixtures/corpus.json`, see its README): every
//! message type decodes and round-trips, rejected shapes stay rejected, extra
//! fields are ignored.

use protocol::commands::PhoneToBridge;
use protocol::events::BridgeToPhone;
use protocol::{decode_bridge_to_phone, decode_phone_to_bridge, encode_bridge_to_phone, encode_phone_to_bridge};
use serde_json::Value;

const CORPUS: &str = include_str!("../fixtures/corpus.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus.json is valid JSON")
}

#[test]
fn phone_to_bridge_valid_decode_and_semantic_round_trip() {
    for (i, msg) in corpus()["phoneToBridge"]["valid"].as_array().unwrap().iter().enumerate() {
        let json = msg.to_string();
        let decoded = decode_phone_to_bridge(&json)
            .unwrap_or_else(|e| panic!("phoneToBridge.valid[{i}] {json} -> {e}"));
        let wire = encode_phone_to_bridge(&decoded)
            .unwrap_or_else(|e| panic!("phoneToBridge.valid[{i}] re-encode -> {e}"));
        let redecoded = decode_phone_to_bridge(&wire)
            .unwrap_or_else(|e| panic!("phoneToBridge.valid[{i}] re-decode -> {e}"));
        assert_eq!(decoded, redecoded, "phoneToBridge.valid[{i}] not a semantic round-trip");
    }
}

#[test]
fn phone_to_bridge_rejected_are_errors() {
    for (i, msg) in corpus()["phoneToBridge"]["rejected"].as_array().unwrap().iter().enumerate() {
        let json = msg.to_string();
        assert!(
            decode_phone_to_bridge(&json).is_err(),
            "phoneToBridge.rejected[{i}] {json} decoded but should not have"
        );
    }
}

#[test]
fn bridge_to_phone_valid_decode_and_semantic_round_trip() {
    for (i, msg) in corpus()["bridgeToPhone"]["valid"].as_array().unwrap().iter().enumerate() {
        let json = msg.to_string();
        let decoded = decode_bridge_to_phone(&json)
            .unwrap_or_else(|e| panic!("bridgeToPhone.valid[{i}] {json} -> {e}"));
        let wire = encode_bridge_to_phone(&decoded);
        let redecoded = decode_bridge_to_phone(&wire)
            .unwrap_or_else(|e| panic!("bridgeToPhone.valid[{i}] re-decode -> {e}"));
        assert_eq!(decoded, redecoded, "bridgeToPhone.valid[{i}] not a semantic round-trip");
    }
}

#[test]
fn bridge_to_phone_rejected_are_errors() {
    for (i, msg) in corpus()["bridgeToPhone"]["rejected"].as_array().unwrap().iter().enumerate() {
        let json = msg.to_string();
        assert!(
            decode_bridge_to_phone(&json).is_err(),
            "bridgeToPhone.rejected[{i}] {json} decoded but should not have"
        );
    }
}

/// Every phone→bridge message type, by wire name. The match is exhaustive,
/// so a new variant does not compile until it is named here — and then the
/// coverage test below fails until the corpus has a fixture for it.
fn p2b_type(m: &PhoneToBridge) -> &'static str {
    match m {
        PhoneToBridge::Input(_) => "input",
        PhoneToBridge::PermissionResponse(_) => "permission-response",
        PhoneToBridge::QuestionResponse(_) => "question-response",
        PhoneToBridge::PlanResponse(_) => "plan-response",
        PhoneToBridge::SetOption(_) => "set-option",
        PhoneToBridge::SyncRequest(_) => "sync-request",
        PhoneToBridge::SyncAck(_) => "sync-ack",
        PhoneToBridge::CreateSession(_) => "create-session",
        PhoneToBridge::RefreshSessions(_) => "refresh-sessions",
        PhoneToBridge::CloseSession(_) => "close-session",
        PhoneToBridge::Interrupt(_) => "interrupt",
        PhoneToBridge::CreateFolder(_) => "create-folder",
        PhoneToBridge::UploadImage(_) => "upload-image",
        PhoneToBridge::UsageRequest(_) => "usage-request",
        PhoneToBridge::GsdRequest(_) => "gsd-request",
        PhoneToBridge::ModelsRequest(_) => "models-request",
        PhoneToBridge::SetCredentials(_) => "set-credentials",
        PhoneToBridge::SetDeviceConfig(_) => "set-device-config",
        PhoneToBridge::PairRequest(_) => "pair-request",
        PhoneToBridge::SetProviderProfile(_) => "set-provider-profile",
        PhoneToBridge::ProviderProfilesRequest(_) => "provider-profiles-request",
    }
}
const P2B_TYPES: usize = 21;

/// Every bridge→phone message type, by wire name (see [`p2b_type`]).
fn b2p_type(m: &BridgeToPhone) -> &'static str {
    match m {
        BridgeToPhone::Sessions(_) => "sessions",
        BridgeToPhone::Output(_) => "output",
        BridgeToPhone::InputAck(_) => "input-ack",
        BridgeToPhone::SyncBegin(_) => "sync-begin",
        BridgeToPhone::SyncChunk(_) => "sync-chunk",
        BridgeToPhone::SyncEnd(_) => "sync-end",
        BridgeToPhone::SessionPending(_) => "session-pending",
        BridgeToPhone::SessionReady(_) => "session-ready",
        BridgeToPhone::SessionFailed(_) => "session-failed",
        BridgeToPhone::InputFailed(_) => "input-failed",
        BridgeToPhone::CloseSessionAck(_) => "close-session-ack",
        BridgeToPhone::SessionReplaced(_) => "session-replaced",
        BridgeToPhone::OptionConfirmed(_) => "option-confirmed",
        BridgeToPhone::FolderAck(_) => "folder-ack",
        BridgeToPhone::Usage(_) => "usage",
        BridgeToPhone::GsdState(_) => "gsd-state",
        BridgeToPhone::Models(_) => "models",
        BridgeToPhone::CredentialsAck(_) => "credentials-ack",
        BridgeToPhone::DeviceConfigAck(_) => "device-config-ack",
        BridgeToPhone::PairAck(_) => "pair-ack",
        BridgeToPhone::ProviderProfiles(_) => "provider-profiles",
        BridgeToPhone::ProviderProfileAck(_) => "provider-profile-ack",
    }
}
const B2P_TYPES: usize = 22;

#[test]
fn corpus_covers_every_message_type() {
    let c = corpus();
    let mut p2b = std::collections::BTreeSet::new();
    for msg in c["phoneToBridge"]["valid"].as_array().unwrap() {
        let decoded = decode_phone_to_bridge(&msg.to_string()).unwrap();
        assert_eq!(p2b_type(&decoded), msg["type"].as_str().unwrap(), "wire name of {msg}");
        p2b.insert(p2b_type(&decoded));
    }
    let mut b2p = std::collections::BTreeSet::new();
    for msg in c["bridgeToPhone"]["valid"].as_array().unwrap() {
        let decoded = decode_bridge_to_phone(&msg.to_string()).unwrap();
        assert_eq!(b2p_type(&decoded), msg["type"].as_str().unwrap(), "wire name of {msg}");
        b2p.insert(b2p_type(&decoded));
    }
    assert_eq!(p2b.len(), P2B_TYPES, "phone→bridge types with a fixture: {p2b:?}");
    assert_eq!(b2p.len(), B2P_TYPES, "bridge→phone types with a fixture: {b2p:?}");
}

#[test]
fn forward_compatible_messages_still_decode() {
    for (i, entry) in corpus()["forwardCompatible"].as_array().unwrap().iter().enumerate() {
        let dir = entry["dir"].as_str().unwrap();
        let json = entry["msg"].to_string();
        let ok = match dir {
            "p2b" => decode_phone_to_bridge(&json).is_ok(),
            "b2p" => decode_bridge_to_phone(&json).is_ok(),
            other => panic!("forwardCompatible[{i}] unknown dir {other}"),
        };
        assert!(ok, "forwardCompatible[{i}] ({dir}) {json} should decode (extra fields ignored)");
    }
}
