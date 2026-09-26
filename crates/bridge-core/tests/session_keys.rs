//! Session keys through the engine: granting, acting through one, where
//! messages go, and every refusal.

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

fn registered(effects: &[Effect], key: &Keypair) -> bool {
    effects.iter().any(|e| matches!(e, Effect::RegisterPhone { pubkey_hex, .. } if *pubkey_hex == key.pubkey_hex))
}

fn heartbeat_recipients(effects: &[Effect]) -> Vec<Vec<String>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::Sessions(_) } => Some(to.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_granted_key_is_heard_registered_and_addressed() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    let effects = grant(&mut rig, &key, NOW_SECS + 30 * DAY);

    assert!(effects.iter().any(|e| matches!(e, Effect::Resubscribe)));
    assert!(registered(&effects, &key));
    assert_eq!(heartbeat_recipients(&effects), vec![vec![key.pubkey_hex.clone()]], "the heartbeat confirms the key");
    let filter = rig.engine.commands_filter();
    assert!(filter.authors.contains(&rig.phone.pubkey_hex) && filter.authors.contains(&key.pubkey_hex));
    assert!(rig.store.snapshot()["pairedPhones"].contains(&key.pubkey_hex), "survives a restart");

    // A command written with the key counts as the phone's.
    rig.phone_event(&key, json!({"type":"refresh-sessions"}), Via::Commands);
    let to = heartbeat_recipients(&rig.take());
    assert_eq!(to, vec![vec![key.pubkey_hex.clone()]]);
}

#[test]
fn a_restarted_bridge_keeps_the_key() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    let mut rig = rig.restart();
    assert!(rig.engine.commands_filter().authors.contains(&key.pubkey_hex));
    assert_eq!(heartbeat_recipients(&rig.take()), vec![vec![key.pubkey_hex.clone()]], "even the first heartbeat");
    rig.phone_event(&key, json!({"type":"refresh-sessions"}), Via::Commands);
    assert_eq!(heartbeat_recipients(&rig.take()), vec![vec![key.pubkey_hex.clone()]]);
}

#[test]
fn a_session_key_cannot_grant_a_key() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    let other = generate_keypair();
    rig.phone_event(&key, grant_msg(&other.pubkey_hex, NOW_SECS + DAY), Via::Commands);
    let effects = rig.take();
    assert!(!registered(&effects, &other));
    assert!(!rig.engine.commands_filter().authors.contains(&other.pubkey_hex));
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
        let effects = rig.take();
        assert!(
            !effects.iter().any(|e| matches!(e, Effect::RegisterPhone { .. })),
            "{why}: refused"
        );
    }
    assert_eq!(rig.engine.commands_filter().authors, vec![rig.phone.pubkey_hex.clone()]);
}

#[test]
fn a_grant_cannot_capture_another_phones_traffic() {
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
        assert!(!rig.take().iter().any(|e| matches!(e, Effect::RegisterPhone { .. })));
    }
    // B's traffic is still B's.
    rig.phone_event(&b_key, json!({"type":"refresh-sessions"}), Via::Commands);
    let to = heartbeat_recipients(&rig.take());
    assert_eq!(to, vec![vec![a.pubkey_hex.clone(), b_key.pubkey_hex.clone()]]);
}

#[test]
fn the_ring_keeps_the_two_newest_keys_and_addresses_the_newest() {
    let mut rig = Rig::new();
    let (k1, k2, k3) = (generate_keypair(), generate_keypair(), generate_keypair());
    for k in [&k1, &k2, &k3] {
        grant(&mut rig, k, NOW_SECS + DAY);
    }
    let authors = rig.engine.commands_filter().authors;
    assert!(!authors.contains(&k1.pubkey_hex), "the oldest left the ring");
    assert!(authors.contains(&k2.pubkey_hex) && authors.contains(&k3.pubkey_hex));

    // The previous key is still heard while the phone rotates...
    rig.phone_event(&k2, json!({"type":"refresh-sessions"}), Via::Commands);
    // ...but messages go to the newest.
    assert_eq!(heartbeat_recipients(&rig.take()), vec![vec![k3.pubkey_hex.clone()]]);
}

#[test]
fn a_lapsed_key_falls_back_to_the_identity() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + 90);
    rig.advance(120_000);
    let effects = rig.take();
    assert!(effects.iter().any(|e| matches!(e, Effect::Resubscribe)), "pruned at the heartbeat");
    assert_eq!(rig.engine.commands_filter().authors, vec![rig.phone.pubkey_hex.clone()]);

    // Unheard once lapsed; the identity is addressed again.
    rig.phone_event(&key, json!({"type":"refresh-sessions"}), Via::Commands);
    assert!(heartbeat_recipients(&rig.take()).is_empty());
    rig.send(json!({"type":"refresh-sessions"}));
    assert_eq!(heartbeat_recipients(&rig.take()), vec![vec![rig.phone.pubkey_hex.clone()]]);
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
    let ack_to: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::PairAck(a) } if a.ok => Some(to.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ack_to, vec![vec![key.pubkey_hex.clone()]], "the ack goes to the key");
    assert!(registered(&effects, &key));
    assert!(rig.engine.commands_filter().authors.contains(&key.pubkey_hex));
}
