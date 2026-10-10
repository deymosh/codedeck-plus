//! Session keys through the engine: granting, commands encrypted with one,
//! how messages are encrypted and addressed to each client of an identity,
//! rotation, and every refusal.

mod support;

use bridge_core::{Effect, Input, Via, MAX_CLIENTS};
use protocol::commands::{PRESENCE_LEASE_SECS, SESSION_KEY_MAX_LIFETIME_SECS};
use protocol::crypto::{generate_keypair, Keypair};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

const NOW_SECS: u64 = T0 / 1000;
const DAY: u64 = 24 * 3600;
const HEARTBEAT_MS: u64 = bridge_core::DEFAULT_HEARTBEAT_INTERVAL_MS;

fn grant_msg(bridge: &str, key: &str, expires_at: u64) -> serde_json::Value {
    json!({"v":12,"type":"session-key","sessionKey":{"pubkeyHex":key,"bridgePubkeyHex":bridge,"expiresAt":expires_at}})
}

fn rotate_msg(bridge: &str, key: &str, replaces: &str, expires_at: u64) -> serde_json::Value {
    json!({"v":12,"type":"session-key","sessionKey":{"pubkeyHex":key,"bridgePubkeyHex":bridge,"expiresAt":expires_at,"replaces":replaces}})
}

/// The keys of the paired phone's clients.
fn client_keys(rig: &Rig) -> Vec<String> {
    rig.engine.paired_phones()[0].clients.iter().map(|c| c.key.pubkey_hex.clone()).collect()
}

/// The paired phone grants `key`; returns the effects.
fn grant(rig: &mut Rig, key: &Keypair, expires_at: u64) -> Vec<Effect> {
    rig.take();
    let bridge = rig.bridge.pubkey_hex.clone();
    rig.send(grant_msg(&bridge, &key.pubkey_hex, expires_at));
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
    rig.phone_event_via_key(&phone, key, json!({"v":12,"type":"refresh-sessions"}), Via::Commands);
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
    // So is one still encrypted with the identity: it names no client, so
    // the answer goes under the identity too.
    rig.send(json!({"v":12,"type":"refresh-sessions"}));
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &rig.phone.clone()));
}

#[test]
fn an_event_signed_by_the_session_key_is_not_heard() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    rig.phone_event(&key, json!({"v":12,"type":"refresh-sessions"}), Via::Commands);
    assert!(heartbeats(&rig.take()).is_empty());
    let bridge = rig.bridge.pubkey_hex.clone();
    rig.phone_event(&key, grant_msg(&bridge, &generate_keypair().pubkey_hex, NOW_SECS + DAY), Via::Commands);
    assert_eq!(client_keys(&rig).len(), 1, "a key cannot grant a key");
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
    let bridge = rig.bridge.pubkey_hex.clone();
    for (why, key, expires_at) in cases {
        rig.send(grant_msg(&bridge, &key, expires_at));
        rig.take();
        assert!(client_keys(&rig).is_empty(), "{why}: refused");
    }
}

#[test]
fn a_grant_for_another_bridge_is_refused() {
    let mut rig = Rig::new();
    let other_bridge = generate_keypair();
    rig.send(grant_msg(&other_bridge.pubkey_hex, &generate_keypair().pubkey_hex, NOW_SECS + DAY));
    rig.take();
    assert!(client_keys(&rig).is_empty());
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
        rig.phone_event(phone, json!({"v":12,"type":"pair-request","npub":"n","pubkeyHex":"x","label":"P","token":token}), Via::Pairing);
    }
    let b_key = generate_keypair();
    let bridge = rig.bridge.pubkey_hex.clone();
    rig.phone_event(&b, grant_msg(&bridge, &b_key.pubkey_hex, NOW_SECS + DAY), Via::Commands);
    rig.take();

    // A names B's identity, then B's session key, as its own session key.
    for key in [&b.pubkey_hex, &b_key.pubkey_hex] {
        rig.phone_event(&a, grant_msg(&bridge, key, NOW_SECS + DAY), Via::Commands);
        rig.take();
    }
    let phones = rig.engine.paired_phones();
    let a_clients = &phones.iter().find(|p| p.pubkey_hex == a.pubkey_hex).unwrap().clients;
    assert!(a_clients.is_empty());
    // A's messages still go to A; B's to B's key.
    rig.advance(HEARTBEAT_MS);
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
fn every_client_of_an_identity_gets_its_own_copy() {
    let mut rig = Rig::new();
    // Two phones and a desktop, each with its own key.
    let keys = [generate_keypair(), generate_keypair(), generate_keypair()];
    for k in &keys {
        grant(&mut rig, k, NOW_SECS + DAY);
    }
    let all: Vec<(String, String)> = keys.iter().map(|k| (rig.phone.pubkey_hex.clone(), k.pubkey_hex.clone())).collect();
    // A command from any of them is read, and answered to it alone.
    for k in &keys {
        refresh_via(&mut rig, k);
        assert_eq!(heartbeats(&rig.take()), to(&rig.phone, k));
    }
    // What is for everyone goes to each.
    rig.advance(HEARTBEAT_MS);
    assert_eq!(heartbeats(&rig.take()), vec![all.clone()]);
    // Granting the same key again renews it: still three clients.
    grant(&mut rig, &keys[1], NOW_SECS + 2 * DAY);
    assert_eq!(client_keys(&rig).len(), 3);
}

#[test]
fn a_rotation_moves_its_client_to_the_new_key() {
    let mut rig = Rig::new();
    let (phone_a, phone_b, a_next) = (generate_keypair(), generate_keypair(), generate_keypair());
    grant(&mut rig, &phone_a, NOW_SECS + DAY);
    grant(&mut rig, &phone_b, NOW_SECS + DAY);
    rig.take();
    let bridge = rig.bridge.pubkey_hex.clone();
    rig.send(rotate_msg(&bridge, &a_next.pubkey_hex, &phone_a.pubkey_hex, NOW_SECS + 2 * DAY));
    let sent = heartbeats(&rig.take());
    let phone = rig.phone.pubkey_hex.clone();
    assert_eq!(sent, vec![vec![(phone.clone(), a_next.pubkey_hex.clone()), (phone.clone(), phone_b.pubkey_hex.clone())]]);
    // A command still under the old key is read while the client rotates.
    refresh_via(&mut rig, &phone_a);
    assert_eq!(heartbeats(&rig.take()).len(), 1);
    // The old key cannot come back as a client of its own.
    grant(&mut rig, &phone_a, NOW_SECS + DAY);
    assert_eq!(client_keys(&rig), vec![a_next.pubkey_hex.clone(), phone_b.pubkey_hex.clone()]);
    // Once it lapses it is not read any more.
    rig.advance((DAY + 60) * 1000);
    rig.take();
    refresh_via(&mut rig, &phone_a);
    assert!(heartbeats(&rig.take()).is_empty());
    assert!(rig.engine.paired_phones()[0].clients[0].previous.is_none(), "pruned");
}

#[test]
fn a_rotation_from_an_unknown_key_adds_a_client() {
    let mut rig = Rig::new();
    let (known, fresh) = (generate_keypair(), generate_keypair());
    grant(&mut rig, &known, NOW_SECS + DAY);
    let bridge = rig.bridge.pubkey_hex.clone();
    rig.send(rotate_msg(&bridge, &fresh.pubkey_hex, &generate_keypair().pubkey_hex, NOW_SECS + DAY));
    rig.take();
    assert_eq!(client_keys(&rig), vec![known.pubkey_hex.clone(), fresh.pubkey_hex.clone()]);
}

#[test]
fn past_the_most_clients_the_one_lapsing_soonest_goes() {
    let mut rig = Rig::new();
    let keys: Vec<Keypair> = (0..=MAX_CLIENTS).map(|_| generate_keypair()).collect();
    for (i, k) in keys.iter().enumerate() {
        // The second client's key lapses soonest.
        let expires = if i == 1 { NOW_SECS + DAY } else { NOW_SECS + 10 * DAY + i as u64 };
        grant(&mut rig, k, expires);
    }
    let kept = client_keys(&rig);
    assert_eq!(kept.len(), MAX_CLIENTS);
    assert!(!kept.contains(&keys[1].pubkey_hex));
    assert!(kept.contains(&keys[MAX_CLIENTS].pubkey_hex), "the newest client is kept");
}

#[test]
fn a_lapsed_key_falls_back_to_the_identity() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + 90);
    rig.advance(120_000);
    rig.take();
    assert!(client_keys(&rig).is_empty(), "pruned at the heartbeat");

    // Its payloads are unreadable once lapsed; the identity is used again.
    refresh_via(&mut rig, &key);
    assert!(heartbeats(&rig.take()).is_empty());
    rig.send(json!({"v":12,"type":"refresh-sessions"}));
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
        "v": 12,
        "type":"pair-request","npub":"n","pubkeyHex":"x","label":"Pixel","token":token,
        "sessionKey":{"pubkeyHex":key.pubkey_hex,"bridgePubkeyHex":rig.bridge.pubkey_hex,"expiresAt":NOW_SECS + DAY}
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

fn presence(rig: &mut Rig, key: &Keypair, away: bool) -> Vec<Effect> {
    let phone = rig.phone.clone();
    rig.take();
    rig.phone_event_via_key(&phone, key, json!({"v":12,"type":"presence","away":away}), Via::Commands);
    rig.take()
}

#[test]
fn a_client_away_gets_nothing_and_a_heartbeat_of_its_own_when_back() {
    let mut rig = Rig::new();
    let (desk, pocket) = (generate_keypair(), generate_keypair());
    grant(&mut rig, &desk, NOW_SECS + DAY);
    grant(&mut rig, &pocket, NOW_SECS + DAY);
    assert!(heartbeats(&presence(&mut rig, &pocket, true)).is_empty());
    rig.advance(HEARTBEAT_MS);
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &desk), "only the client present");
    // Back: a heartbeat for it alone, then it is among everyone again.
    assert_eq!(heartbeats(&presence(&mut rig, &pocket, false)), to(&rig.phone, &pocket));
    rig.advance(HEARTBEAT_MS);
    assert_eq!(heartbeats(&rig.take())[0].len(), 2);
}

#[test]
fn a_lease_not_renewed_runs_out_and_any_command_renews_it() {
    let mut rig = Rig::new();
    let key = generate_keypair();
    grant(&mut rig, &key, NOW_SECS + DAY);
    rig.advance(PRESENCE_LEASE_SECS * 1000 + HEARTBEAT_MS);
    rig.take();
    rig.advance(HEARTBEAT_MS);
    assert!(heartbeats(&rig.take()).is_empty(), "nobody is listening: nothing goes out");
    // Whatever it sends next says it is back.
    refresh_via(&mut rig, &key);
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key));
    rig.advance(HEARTBEAT_MS);
    assert_eq!(heartbeats(&rig.take()), to(&rig.phone, &key));
}

#[test]
fn a_restarted_bridge_counts_every_client_present() {
    let mut rig = Rig::new();
    let (a, b) = (generate_keypair(), generate_keypair());
    grant(&mut rig, &a, NOW_SECS + DAY);
    grant(&mut rig, &b, NOW_SECS + DAY);
    presence(&mut rig, &b, true);
    let mut rig = rig.restart();
    assert_eq!(heartbeats(&rig.take())[0].len(), 2, "until each renews or says it is away");
}

#[test]
fn a_sync_goes_to_the_client_that_asked_alone() {
    let mut rig = Rig::new();
    let (asking, other) = (generate_keypair(), generate_keypair());
    grant(&mut rig, &asking, NOW_SECS + DAY);
    grant(&mut rig, &other, NOW_SECS + DAY);
    rig.take();
    let phone = rig.phone.clone();
    rig.phone_event_via_key(&phone, &asking, json!({"v":12,"type":"sync-request","sessionId":"s","haveRanges":[]}), Via::Commands);
    let sync: Vec<Vec<String>> = rig
        .take()
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::SyncBegin(_) | BridgeToPhone::SyncEnd(_) } => {
                Some(to.iter().map(|a| a.key.clone()).collect())
            }
            _ => None,
        })
        .collect();
    assert_eq!(sync, vec![vec![asking.pubkey_hex.clone()]; 2]);
}
