//! Session keys through the engine: granting, commands encrypted with one,
//! how messages are encrypted and addressed, and every refusal.

mod support;

use bridge_core::{Effect, Input, Via};
use protocol::commands::SESSION_KEY_MAX_LIFETIME_SECS;
use protocol::crypto::{generate_keypair, Keypair};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

const NOW_SECS: u64 = T0 / 1000;
const DAY: u64 = 24 * 3600;

fn grant_msg(key: &str, expires_at: u64) -> serde_json::Value {
    json!({"type":"session-key","sessionKey":{"pubkeyHex":key,"expiresAt":expires_at}})
}

/// The paired phone grants `key`; returns the effects.
fn grant(rig: &mut Rig, key: &Keypair, expires_at: u64) -> Vec<Effect> {
    rig.take();
    rig.send(grant_msg(&key.pubkey_hex, expires_at));
    rig.take()
}

/// Each heartbeat's addressees, as `(phone, key)` pairs.
fn heartbeats(effects: &[Effect]) -> Vec<Vec<(String, String)>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::Sessions(_) } => {
                Some(to.iter().map(|a| (a.phone.clone(), a.key.clone())).collect())
            }
            _ => None,
        })
        .collect()
}

fn to(phone: &Keypair, key: &Keypair) -> Vec<Vec<(String, String)>> {
    vec![vec![(phone.pubkey_hex.clone(), key.pubkey_hex.clone())]]
}

/// A refresh from the phone, its payload encrypted with `key`.
fn refresh_via(rig: &mut Rig, key: &Keypair) {
    let phone = rig.phone.clone();
    rig.phone_event_via_key(&phone, key, json!({"type":"refresh-sessions"}), Via::Commands);
}

#[test]
fn a_granted_key_encrypts_and_the_identity_stays_the_party() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    let effects = grant(&mut rig, &key, NOW_SECS + 30 * DAY);

    assert_eq!(heartbeats(&effects), to(&rig.phone, &key), "the heartbeat confirms the key");
    // Only the identity is ever an author or registered anywhere.
    assert!(!effects.iter().any(|e| matches!(e, Effect::Resubscribe | Effect::RegisterPhone { .. })));
    assert_eq!(rig.engine.commands_filter().authors, vec![rig.phone.pubkey_hex.clone()]);
    assert!(rig.store.snapshot()["pairedPhones"].contains(&key.pubkey_hex), "survives a restart");

    // A command the identity signed with the payload under the key is heard.
    refresh_via(&mut rig, &key);
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key));
    // So is one still encrypted with the identity.
    rig.send(json!({"type":"refresh-sessions"}));
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key));
}

#[test]
fn an_event_signed_by_the_session_key_is_not_heard() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    rig.phone_event(&key, json!({"type":"refresh-sessions"}), Via::Commands);
    assert!(heartbeats(&rig.take()).is_empty());
    rig.phone_event(&key, grant_msg(&generate_keypair().pubkey_hex, NOW_SECS + DAY), Via::Commands);
    assert_eq!(rig.engine.paired_phones()[0].session_keys.len(), 1, "a key cannot grant a key");
}

#[test]
fn a_restarted_bridge_keeps_the_key() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    let mut rig = rig.restart();
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key), "even the first heartbeat");
    refresh_via(&mut rig, &key);
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key));
}

#[test]
fn bad_grants_are_refused() {
    let mut rig = Rig::new();
    let cases = [
        ("not a key", "zz".to_string(), NOW_SECS + DAY),
        ("expired", generate_keypair().pubkey_hex, NOW_SECS - 1),
        ("too long", generate_keypair().pubkey_hex, NOW_SECS + SESSION_KEY_MAX_LIFETIME_SECS + 3600),
        ("the bridge's own key", rig.bridge.pubkey_hex.clone(), NOW_SECS + DAY),
        ("its own identity", rig.phone.pubkey_hex.clone(), NOW_SECS + DAY),
    ];
    for (why, key, expires_at) in cases {
        rig.send(grant_msg(&key, expires_at));
        rig.take();
        assert!(rig.engine.paired_phones()[0].session_keys.is_empty(), "{why}: refused");
    }
}

#[test]
fn a_key_belongs_to_one_phone() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    let (a, b) = (generate_keypair(), generate_keypair());
    for phone in [&a, &b] {
        rig.input(Input::OpenPairing { duration_ms: None });
        let token = rig
            .take()
            .into_iter()
            .find_map(|e| match e {
                Effect::PresentPairing(info) => Some(info.token),
                _ => None,
            })
            .unwrap();
        rig.phone_event(phone, json!({"type":"pair-request","npub":"n","pubkeyHex":"x","label":"P","token":token}), Via::Pairing);
    }
    let b_key = generate_keypair();
    rig.phone_event(&b, grant_msg(&b_key.pubkey_hex, NOW_SECS + DAY), Via::Commands);
    rig.take();

    // A names B's identity, then B's session key, as its own session key.
    for key in [&b.pubkey_hex, &b_key.pubkey_hex] {
        rig.phone_event(&a, grant_msg(key, NOW_SECS + DAY), Via::Commands);
        rig.take();
    }
    let phones = rig.engine.paired_phones();
    let a_keys = &phones.iter().find(|p| p.pubkey_hex == a.pubkey_hex).unwrap().session_keys;
    assert!(a_keys.is_empty());
    // A's messages still go to A; B's to B's key.
    rig.phone_event(&b, json!({"type":"refresh-sessions"}), Via::Commands);
    let sent = heartbeats(&rig.take());
    assert_eq!(
        sent,
        vec![vec![
            (a.pubkey_hex.clone(), a.pubkey_hex.clone()),
            (b.pubkey_hex.clone(), b_key.pubkey_hex.clone())
        ]]
    );
}

#[test]
fn the_ring_keeps_the_two_newest_keys_and_encrypts_to_the_newest() {
    let mut rig = Rig::new();
    let (k1, k2, k3) = (generate_keypair(), generate_keypair(), generate_keypair());
    for k in [&k1, &k2, &k3] {
        grant(&mut rig, k, NOW_SECS + DAY);
    }
    // The oldest left the ring: its payloads are unreadable.
    refresh_via(&mut rig, &k1);
    assert!(heartbeats(&rig.take()).is_empty());
    // The previous key is still read while the phone rotates...
    refresh_via(&mut rig, &k2);
    // ...but messages are encrypted to the newest.
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &k3));
}

#[test]
fn a_lapsed_key_falls_back_to_the_identity() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + 90);
    rig.advance(120_000);
    rig.take();
    assert!(rig.engine.paired_phones()[0].session_keys.is_empty(), "pruned at the heartbeat");

    // Its payloads are unreadable once lapsed; the identity is used again.
    refresh_via(&mut rig, &key);
    assert!(heartbeats(&rig.take()).is_empty());
    rig.send(json!({"type":"refresh-sessions"}));
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &rig.phone.clone()));
}

#[test]
fn a_pair_request_can_grant_the_first_key() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    rig.input(Input::OpenPairing { duration_ms: None });
    let token = rig
        .take()
        .into_iter()
        .find_map(|e| match e {
            Effect::PresentPairing(info) => Some(info.token),
            _ => None,
        })
        .unwrap();
    let (phone, key) = (generate_keypair(), generate_keypair());
    let req = json!({
        "type":"pair-request","npub":"n","pubkeyHex":"x","label":"Pixel","token":token,
        "sessionKey":{"pubkeyHex":key.pubkey_hex,"expiresAt":NOW_SECS + DAY}
    });
    rig.phone_event(&phone, req, Via::Pairing);
    let effects = rig.take();
    let acks: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::PairAck(a) } if a.ok => {
                Some(to.iter().map(|a| (a.phone.clone(), a.key.clone())).collect::<Vec<_>>())
            }
            _ => None,
        })
        .collect();
    assert_eq!(acks, to(&phone, &key), "the ack is already encrypted to the key");
    // The identity, never the key, is what gets registered.
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::RegisterPhone { pubkey_hex, .. } if *pubkey_hex == key.pubkey_hex)));
}
