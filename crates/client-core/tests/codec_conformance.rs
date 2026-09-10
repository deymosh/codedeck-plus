//! Rust half of the shared codec conformance corpus
//! (`packages/protocol/fixtures/corpus.json`). The TS half lives in
//! `packages/protocol/src/__tests__/fixtures.test.ts` and runs the identical
//! assertions on the identical bytes. A zod-schema change that isn't mirrored
//! here (or vice versa) fails CI on one side.

use client_core::wire::{decode_bridge_to_phone, decode_phone_to_bridge, encode_bridge_to_phone, encode_phone_to_bridge};
use serde_json::Value;

const CORPUS: &str = include_str!("../../../packages/protocol/fixtures/corpus.json");

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
