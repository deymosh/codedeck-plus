//! The real `state.json` behind the engine's `Store`: a representative
//! document written through the public `StateFile`, read back by a fresh one,
//! and a damaged file reported instead of silently replaced with an empty
//! state (which would lose the bridge identity and every pairing).

use std::fs;

use bridge_core::registry::{RegistryDoc, SessionRecord};
use bridge_core::settings::{ProviderProfile, StoredCredentials, StoredProfiles};
use bridge_core::{store_keys, PairedPhone};
use bridge_runtime::state::StateFile;
use protocol::common::ProviderModel;
use serde_json::json;

fn record(id: &str) -> SessionRecord {
    SessionRecord {
        session_id: id.into(),
        agent: "alpha".into(),
        cwd: "/w/app".into(),
        native_session_id: Some("native-1".into()),
        previous_native_session_id: Some("native-0".into()),
        model: Some("m1".into()),
        provider_id: Some("kimi".into()),
        effort: Some("high".into()),
        mode: Some("plan".into()),
        persona: Some("review".into()),
        title: Some("Fix the parser".into()),
        project: "app".into(),
        created_at: "2026-08-05T00:00:00.000Z".into(),
        last_activity: "2026-08-05T00:10:00.000Z".into(),
        committed: true,
        context_window: Some(200_000),
        context_percentage: Some(12.5),
    }
}

/// The documents a bridge stores between heartbeats, including the nested
/// registry and provider profiles, come back byte for byte through a fresh
/// `StateFile` — the shape a restarted bridge reads.
#[test]
fn a_representative_engine_state_survives_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let phone = PairedPhone {
        npub: "npub1example".into(),
        pubkey_hex: "ab".repeat(32),
        label: "Pixel".into(),
        paired_at: "2026-08-05T00:00:00.000Z".into(),
        clients: Vec::new(),
    };
    // A profile without a token is a stored profile too: sessions cannot
    // start on it, but a restart must still list it.
    let profiles = StoredProfiles {
        profiles: vec![ProviderProfile {
            id: "kimi".into(),
            agent: "alpha".into(),
            label: "Kimi".into(),
            base_url: "https://api.example/v1".into(),
            auth_token: None,
            models: vec![ProviderModel { id: "k2".into(), label: Some("K2".into()), provider: None, context_window: Some(128_000) }],
            models_from_provider: true,
            default_model: Some("k2".into()),
            updated_at: Some("2026-08-05T00:00:00.000Z".into()),
        }],
    };
    let values = [
        (store_keys::PAIRED_PHONES, serde_json::to_string(&vec![phone]).unwrap()),
        (store_keys::REGISTRY, serde_json::to_string(&RegistryDoc { sessions: vec![record("s1"), record("s2")], removed_sessions: vec!["s0".into()] }).unwrap()),
        (store_keys::LAST_SEEN, "1800000000".into()),
        (store_keys::PROCESSED_IDS, serde_json::to_string(&["ev1", "ev2", "ev3"]).unwrap()),
        (store_keys::LIST_REV, "1800000123".into()),
        (store_keys::PROVIDER_PROFILES, serde_json::to_string(&profiles).unwrap()),
        (store_keys::CREDENTIALS, serde_json::to_string(&StoredCredentials::default()).unwrap()),
    ];

    let identity = {
        let state = StateFile::open(dir.path()).unwrap();
        let identity = state.identity().unwrap();
        for (key, value) in &values {
            state.set(key, value).unwrap();
        }
        state.flush().unwrap();
        identity
    };

    let again = StateFile::open(dir.path()).unwrap();
    assert_eq!(again.identity().unwrap().pubkey_hex, identity.pubkey_hex, "the identity is the same bridge");
    for (key, value) in &values {
        // Objects come back from `get` in compact, key-sorted form: the
        // document is the same, which is what a restarted engine parses.
        let got = serde_json::from_str::<serde_json::Value>(&again.get(key).expect("the key is there")).unwrap();
        assert_eq!(got, serde_json::from_str::<serde_json::Value>(value).unwrap(), "{key} came back as it was stored");
    }
    // The registry is really nested in the file, not an escaped string, so a
    // human can read it and #154's shape is what a reopen parses.
    let raw: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(raw["kv"][store_keys::REGISTRY]["sessions"][1]["sessionId"], json!("s2"));
    assert_eq!(raw["kv"][store_keys::REGISTRY]["sessions"][0]["contextPercentage"], json!(12.5));
}

/// A state file torn by a crash is reported with what to do about it. The
/// bridge must not quietly start with an empty document: that would mint a
/// new identity and forget every pairing.
#[test]
fn a_truncated_state_file_is_reported_not_silently_emptied() {
    let dir = tempfile::tempdir().unwrap();
    let full = r#"{"secretKeyHex":"11","kv":{"pairedPhones":[{"npub":"npub1example"}],"lastSeenTimestamp":42}}"#;
    let torn = &full[..full.len() / 2];
    fs::write(dir.path().join("state.json"), torn).unwrap();

    let err = StateFile::open(dir.path()).err().expect("a truncated file is an error");
    assert!(err.contains("corrupt state file"), "the error names the file's state: {err}");
    assert!(err.contains("Move it aside"), "the error says how to recover: {err}");
    assert_eq!(fs::read_to_string(dir.path().join("state.json")).unwrap(), torn, "the damaged file is left for the owner, not overwritten");
}
