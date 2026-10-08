//! Pairing, credentials, provider profiles and transcript retention,
//! through the engine.

mod support;

use agent_protocol::{BridgeMessage, HostMessage, SessionEvent};
use bridge_core::ports::memory::{MemoryStore, MemoryTranscripts};
use bridge_core::ports::Transcripts as _;
use bridge_core::{Effect, Input, PairingCloseReason, Via};
use protocol::common::{EntryBody, NoticeKind, OutputEntry, ProviderModel, PROVIDER_BASE_URL_ERROR};
use protocol::crypto::generate_keypair;
use protocol::events::{BridgeToPhone, PairAckReason};
use serde_json::json;
use support::*;

// --- pairing ---

fn open_pairing(rig: &mut Rig) -> String {
    rig.input(Input::OpenPairing { duration_ms: None });
    let effects = rig.take();
    assert!(effects.iter().any(|e| matches!(e, Effect::OpenPairingSubscription { .. })));
    effects
        .into_iter()
        .find_map(|e| match e {
            Effect::PresentPairing(info) => Some(info),
            _ => None,
        })
        .map(|info| {
            assert!(info.url.starts_with(&format!("codedeck://pair?npub={}&relays=wss%3A%2F%2Frelay.example", rig.bridge.npub)));
            assert!(info.url.ends_with(&format!("&token={}", info.token)));
            info.token
        })
        .expect("the QR is presented")
}

#[test]
fn pairing_a_phone_end_to_end() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    let token = open_pairing(&mut rig);
    let phone = generate_keypair();
    let req = json!({"type":"pair-request","npub":"n","pubkeyHex":"spoofed","label":"Pixel","token":token});
    rig.phone_event(&phone, req, Via::Pairing);
    let effects = rig.take();
    assert!(effects.iter().any(|e| matches!(e, Effect::PairingClosed { reason: PairingCloseReason::Paired, phone: Some(p) } if p.pubkey_hex == phone.pubkey_hex)));
    assert!(effects.iter().any(|e| matches!(e, Effect::Resubscribe)));
    assert!(effects.iter().any(|e| matches!(e, Effect::RegisterPhone { label, .. } if label == "Pixel")));
    let acks: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message: BridgeToPhone::PairAck(a) } => {
                Some((to.iter().map(|a| a.phone.clone()).collect::<Vec<_>>(), a.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(acks[0].0, std::slice::from_ref(&phone.pubkey_hex), "the identity is the event author");
    assert!(acks[0].1.ok && acks[0].1.relays == Some(vec!["wss://relay.example".into()]));
    assert!(effects.iter().any(|e| matches!(e, Effect::Publish { message: BridgeToPhone::Sessions(_), .. })), "greeted");
    assert_eq!(rig.engine.paired_phones().len(), 1);
    assert!(rig.store.snapshot()["pairedPhones"].contains(&phone.pubkey_hex));
    assert!(!rig.engine.pairing_open());
}

fn nack(rig: &mut Rig) -> Option<PairAckReason> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::PairAck(a) if !a.ok => a.reason,
        _ => None,
    })
}

#[test]
fn a_bad_token_is_refused_the_window_stays_open_and_refusals_are_budgeted() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    open_pairing(&mut rig);
    let stranger = generate_keypair();
    let bad = json!({"type":"pair-request","npub":"n","pubkeyHex":"x","label":"P","token":"wrong"});
    let mut answered = 0;
    for _ in 0..7 {
        rig.phone_event(&stranger, bad.clone(), Via::Pairing);
        if let Some(reason) = nack(&mut rig) {
            assert_eq!(reason, PairAckReason::BadToken);
            answered += 1;
        }
    }
    assert_eq!(answered, 5, "a flood stops being answered");
    assert!(rig.engine.pairing_open());
    assert!(rig.engine.paired_phones().is_empty());
}

#[test]
fn without_a_window_a_pair_request_is_refused_and_a_window_expires() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    let stranger = generate_keypair();
    rig.phone_event(&stranger, json!({"type":"pair-request","npub":"n","pubkeyHex":"x","label":"P","token":"t"}), Via::Pairing);
    assert_eq!(nack(&mut rig), Some(PairAckReason::WindowClosed));
    open_pairing(&mut rig);
    rig.advance(10 * 60_000);
    assert!(rig.take().iter().any(|e| matches!(e, Effect::PairingClosed { reason: PairingCloseReason::Expired, .. })));
    assert!(!rig.engine.pairing_open());
}

#[test]
fn unpaired_senders_are_not_heard_on_the_command_path() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.take();
    let stranger = generate_keypair();
    rig.phone_event(&stranger, json!({"type":"create-session","agent":"alpha"}), Via::Commands);
    assert!(rig.take().is_empty());
}

// --- credentials ---

fn all_published_json(rig: &mut Rig) -> String {
    rig.messages().iter().map(|m| serde_json::to_string(m).unwrap()).collect()
}

#[test]
fn an_agent_credential_is_stored_checked_and_acked_but_never_sent_back() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.take();
    rig.send(json!({"type":"set-credentials","agent":"alpha","values":{"alpha_key":"sk-secret"}}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::CheckCredential { .. }));
    assert!(matches!(msg, BridgeMessage::CheckCredential { value, .. } if value.expose() == "sk-secret"));
    assert!(!rig.messages().iter().any(|m| matches!(m, BridgeToPhone::CredentialsAck(_))), "acked after the check");
    rig.host_reply(&id, HostMessage::CredentialChecked { valid: Some(true) });
    let msgs = rig.messages();
    let ack = msgs.iter().find_map(|m| match m {
        BridgeToPhone::CredentialsAck(a) => Some(a.clone()),
        _ => None,
    });
    let ack = ack.expect("acked");
    assert!(ack.success);
    assert_eq!((ack.credentials[0].present, ack.credentials[0].valid), (true, Some(true)));
    assert_eq!(last_heartbeat(&msgs).agents[0].credentials[0].valid, Some(true));
    assert!(!msgs.iter().any(|m| serde_json::to_string(m).unwrap().contains("sk-secret")));

    rig.send(json!({"type":"create-session","agent":"alpha"}));
    let (_, p) = rig.start_request();
    assert_eq!(p.credentials["alpha_key"].expose(), "sk-secret");
    assert!(!all_published_json(&mut rig).contains("sk-secret"));
}

#[test]
fn an_operator_env_credential_wins_and_is_not_checked() {
    let mut rig = Rig::new();
    rig.system.set_env("ALPHA_KEY");
    rig.host_up();
    let hb = last_heartbeat(&rig.messages());
    assert!(hb.agents[0].credentials[0].present && hb.agents[0].credentials[0].from_env);
    rig.send(json!({"type":"set-credentials","agent":"alpha","values":{"alpha_key":"sk-x"}}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::CheckCredential { .. })));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::CredentialsAck(a) if a.success)));
}

#[test]
fn a_credential_outside_the_scope_refuses_the_whole_write() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"set-credentials","agent":"alpha","values":{"alpha_key":"k","github_pat":"g"}}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::CredentialsAck(a)
        if !a.success && a.error.as_deref() == Some("Unknown credential: github_pat"))));
    assert!(!rig.store.snapshot().contains_key("credentials"));
}

#[test]
fn the_github_token_is_the_bridges_own_and_reaches_every_session() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"set-credentials","values":{"github_pat":"ghp_x"}}));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::CredentialsAck(a) if a.success && a.agent.is_none())));
    assert!(last_heartbeat(&msgs).credentials[0].present);
    rig.send(json!({"type":"create-session","agent":"beta"}));
    let (_, p) = rig.start_request();
    assert_eq!(p.env["GITHUB_TOKEN"].expose(), "ghp_x");
    rig.send(json!({"type":"set-credentials","values":{"github_pat":null}}));
    assert!(!last_heartbeat(&rig.messages()).credentials[0].present);
}

// --- provider profiles ---

fn set_profile(rig: &mut Rig, profile: serde_json::Value) {
    rig.send(json!({"type":"set-provider-profile","profileId":"kimi","profile":profile}));
}

fn kimi(token: Option<&str>) -> serde_json::Value {
    let mut p = json!({"agent":"alpha","label":"Kimi","baseUrl":"https://api.kimi.test/anthropic","models":[{"id":"k2"}]});
    if let Some(token) = token {
        p["authToken"] = json!(token);
    }
    p
}

/// A profile write that clears the token (`authToken: null`).
fn kimi_cleared() -> serde_json::Value {
    let mut p = kimi(None);
    p["authToken"] = json!(null);
    p
}

/// A rig whose host is up with an agent of each kind: alpha binds sessions
/// to a profile, delta adds a profile's models to its own.
fn rig_with_providers() -> Rig {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), beta(), delta()]);
    rig.take();
    rig
}

/// Answer the pending token check, if any; returns whether one was pending.
fn answer_token_check(rig: &mut Rig, valid: Option<bool>) -> bool {
    if !rig.has_host_request(|m| matches!(m, BridgeMessage::CheckProvider { .. })) {
        return false;
    }
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::CheckProvider { .. }));
    rig.host_reply(&id, HostMessage::CredentialChecked { valid });
    true
}

fn has_token(rig: &mut Rig) -> Option<bool> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::ProviderProfiles(p) => Some(p.profiles.first().is_some_and(|x| x.has_token)),
        _ => None,
    })
}

fn ack_error(rig: &mut Rig) -> Option<String> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::ProviderProfileAck(a) if !a.success => a.error,
        _ => None,
    })
}

#[test]
fn a_profile_is_stored_its_token_checked_by_its_agent_and_the_list_broadcast_redacted() {
    let mut rig = rig_with_providers();
    set_profile(&mut rig, kimi(Some("tok-secret")));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::CheckProvider { .. }));
    match msg {
        BridgeMessage::CheckProvider { agent, provider, model } => {
            assert_eq!((agent.as_str(), model.as_str()), ("alpha", "k2"));
            assert_eq!((provider.base_url.as_str(), provider.auth_token.expose()), ("https://api.kimi.test/anthropic", "tok-secret"));
        }
        _ => unreachable!(),
    }
    rig.host_reply(&id, HostMessage::CredentialChecked { valid: Some(false) });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::ProviderProfileAck(a) if a.success && a.token_valid == Some(false))));
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::ProviderProfiles(p) if p.profiles[0].has_token && p.profiles[0].agent == "alpha")));
    assert!(!msgs.iter().any(|m| serde_json::to_string(m).unwrap().contains("tok-secret")));
}

#[test]
fn a_profile_is_for_an_agent_that_takes_one() {
    let mut rig = rig_with_providers();
    let mut p = kimi(Some("t"));
    p["agent"] = json!("beta");
    set_profile(&mut rig, p);
    assert_eq!(ack_error(&mut rig).as_deref(), Some("Beta takes no provider profiles."));
    let mut p = kimi(Some("t"));
    p["agent"] = json!("nope");
    set_profile(&mut rig, p);
    assert!(ack_error(&mut rig).is_some_and(|e| e.contains("no agent 'nope'")));
    assert!(!rig.store.snapshot().contains_key("providerProfiles"));
}

#[test]
fn an_insecure_base_url_is_never_stored() {
    let mut rig = rig_with_providers();
    let mut p = kimi(Some("t"));
    p["baseUrl"] = json!("http://api.kimi.test");
    set_profile(&mut rig, p);
    assert!(!answer_token_check(&mut rig, None));
    assert_eq!(ack_error(&mut rig).as_deref(), Some(PROVIDER_BASE_URL_ERROR));
    assert!(!rig.store.snapshot().contains_key("providerProfiles"));
}

#[test]
fn the_token_is_kept_cleared_or_replaced_and_a_profile_can_be_deleted() {
    let mut rig = rig_with_providers();
    set_profile(&mut rig, kimi(Some("t1")));
    answer_token_check(&mut rig, Some(true));
    assert_eq!(has_token(&mut rig), Some(true));
    set_profile(&mut rig, kimi(None));
    assert!(answer_token_check(&mut rig, None), "an absent token keeps the stored one");
    assert_eq!(has_token(&mut rig), Some(true));
    set_profile(&mut rig, kimi_cleared());
    assert!(!answer_token_check(&mut rig, None));
    assert_eq!(has_token(&mut rig), Some(false));
    rig.send(json!({"type":"set-provider-profile","profileId":"kimi","profile":null}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::ProviderProfiles(p) if p.profiles.is_empty())));
}

/// A profile whose models come from the provider.
fn router(agent: &str, token: Option<&str>, default_model: Option<&str>) -> serde_json::Value {
    let mut p = json!({"agent":agent,"label":"Router","baseUrl":"https://router.test/api","models":[],"modelsFromProvider":true});
    if let Some(token) = token {
        p["authToken"] = json!(token);
    }
    if let Some(model) = default_model {
        p["defaultModel"] = json!(model);
    }
    p
}

fn set_router(rig: &mut Rig, profile: serde_json::Value) {
    rig.send(json!({"type":"set-provider-profile","profileId":"router","profile":profile}));
}

/// Take the pending model-list read: (request id, base URL, token).
fn take_model_fetch(rig: &mut Rig) -> Option<(String, String, String)> {
    if !rig.has_host_request(|m| matches!(m, BridgeMessage::ListProviderModels { .. })) {
        return None;
    }
    match rig.host_request(|m| matches!(m, BridgeMessage::ListProviderModels { .. })) {
        (id, BridgeMessage::ListProviderModels { base_url, auth_token, .. }) => Some((id, base_url, auth_token.expose().to_string())),
        _ => unreachable!(),
    }
}

fn listed(ids: &[&str]) -> HostMessage {
    HostMessage::ProviderModels { models: ids.iter().map(|id| ProviderModel { id: (*id).into(), ..Default::default() }).collect() }
}

fn stored_profile(rig: &mut Rig) -> Option<protocol::common::ProviderProfileInfo> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::ProviderProfiles(p) => p.profiles.into_iter().next(),
        _ => None,
    })
}

#[test]
fn a_profile_can_take_its_models_from_the_provider() {
    let mut rig = rig_with_providers();
    set_router(&mut rig, router("alpha", Some("tok-r"), Some("b")));
    let (id, base_url, token) = take_model_fetch(&mut rig).expect("the models are read first");
    assert_eq!((base_url.as_str(), token.as_str()), ("https://router.test/api", "tok-r"));
    assert!(!rig.store.snapshot().contains_key("providerProfiles"), "stored only with its models");
    rig.host_reply(&id, listed(&["a", "b"]));
    // Then the token is checked as for any profile, on the default model.
    let (check, model) = match rig.host_request(|m| matches!(m, BridgeMessage::CheckProvider { .. })) {
        (id, BridgeMessage::CheckProvider { model, .. }) => (id, model),
        _ => unreachable!(),
    };
    assert_eq!(model, "b");
    rig.host_reply(&check, HostMessage::CredentialChecked { valid: Some(true) });
    let info = stored_profile(&mut rig).expect("broadcast");
    assert!(info.models_from_provider);
    assert_eq!(info.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(info.default_model.as_deref(), Some("b"));
    assert!(rig.store.snapshot()["providerProfiles"].contains("modelsFromProvider"));
}

#[test]
fn a_default_the_provider_no_longer_lists_is_dropped() {
    let mut rig = rig_with_providers();
    set_router(&mut rig, router("alpha", Some("t"), Some("gone")));
    let (id, ..) = take_model_fetch(&mut rig).unwrap();
    rig.host_reply(&id, listed(&["a"]));
    answer_token_check(&mut rig, None);
    assert_eq!(stored_profile(&mut rig).unwrap().default_model, None);
}

#[test]
fn no_model_list_means_no_save() {
    let mut rig = rig_with_providers();
    // Without a token there is nothing to read the list with.
    set_router(&mut rig, router("alpha", None, None));
    assert!(take_model_fetch(&mut rig).is_none());
    assert!(ack_error(&mut rig).is_some_and(|e| e.contains("needs its API token")));

    for answer in [HostMessage::Error { message: "the provider refused the token (HTTP 401)".into() }, listed(&[])] {
        set_router(&mut rig, router("alpha", Some("t"), None));
        let (id, ..) = take_model_fetch(&mut rig).unwrap();
        rig.host_reply(&id, answer);
        let msgs = rig.messages();
        let error = msgs.iter().find_map(|m| match m {
            BridgeToPhone::ProviderProfileAck(a) if !a.success => a.error.clone(),
            _ => None,
        });
        assert!(error.is_some_and(|e| e.starts_with("Could not read the models from https://router.test/api: ")));
        assert!(!msgs.iter().any(|m| matches!(m, BridgeToPhone::ProviderProfiles(_))));
    }
    assert!(!rig.store.snapshot().contains_key("providerProfiles"));
}

#[test]
fn a_newer_save_wins_over_a_model_list_still_on_its_way() {
    let mut rig = rig_with_providers();
    set_router(&mut rig, router("alpha", Some("t"), None));
    let (stale, ..) = take_model_fetch(&mut rig).unwrap();
    rig.send(json!({"type":"set-provider-profile","profileId":"router","profile":null}));
    rig.take();
    rig.host_reply(&stale, listed(&["a"]));
    assert!(rig.take().is_empty(), "the deleted profile is not brought back");
}

/// The providers last handed to delta, if any were.
fn pushed_to_delta(rig: &mut Rig) -> Option<Vec<String>> {
    rig.host_frames().into_iter().rev().find_map(|f| match f.message {
        BridgeMessage::SetProviders { agent, providers } if agent == "delta" => Some(providers.into_iter().map(|p| p.id).collect()),
        _ => None,
    })
}

#[test]
fn an_agent_that_adds_profile_models_gets_its_profiles_whenever_they_change() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), beta(), delta()]);
    assert_eq!(pushed_to_delta(&mut rig), Some(vec![]), "handed its (no) profiles at start");

    let mut p = kimi(Some("t"));
    p["agent"] = json!("delta");
    set_profile(&mut rig, p.clone());
    assert_eq!(pushed_to_delta(&mut rig), Some(vec!["kimi".to_string()]));
    // Moved to another agent: delta loses it.
    set_profile(&mut rig, kimi(Some("t")));
    assert_eq!(pushed_to_delta(&mut rig), Some(vec![]));
    set_profile(&mut rig, p);
    assert_eq!(pushed_to_delta(&mut rig), Some(vec!["kimi".to_string()]));
    rig.send(json!({"type":"set-provider-profile","profileId":"kimi","profile":null}));
    assert_eq!(pushed_to_delta(&mut rig), Some(vec![]));

    // A host restart hands them over again.
    set_profile(&mut rig, json!({"agent":"delta","label":"K","baseUrl":"https://k.test","authToken":"t","models":[{"id":"m"}]}));
    rig.take();
    rig.input(Input::HostDown { reason: "test".into() });
    rig.host_up_with(vec![alpha(), beta(), delta()]);
    assert_eq!(pushed_to_delta(&mut rig), Some(vec!["kimi".to_string()]));
    // An agent that binds sessions is never handed any.
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::SetProviders { agent, .. } if agent == "alpha")));
}

fn with_kimi() -> Rig {
    let mut rig = rig_with_providers();
    set_profile(&mut rig, kimi(Some("tok")));
    answer_token_check(&mut rig, Some(true));
    rig.take();
    rig
}

fn failed_reason(rig: &mut Rig) -> String {
    rig.messages()
        .into_iter()
        .find_map(|m| match m {
            BridgeToPhone::SessionFailed(f) => Some(f.reason),
            _ => None,
        })
        .expect("session-failed")
}

#[test]
fn a_provider_bound_session_starts_on_the_live_profile_with_its_model() {
    let mut rig = with_kimi();
    rig.send(json!({"type":"create-session","agent":"alpha","providerId":"kimi"}));
    let (id, p) = rig.start_request();
    let binding = p.provider.expect("bound");
    assert_eq!((binding.base_url.as_str(), binding.auth_token.expose()), ("https://api.kimi.test/anthropic", "tok"));
    assert_eq!(p.model.as_deref(), Some("k2"));
    rig.host_reply(&id, HostMessage::Ack);
    rig.host_event(&p.session_id, SessionEvent::Ready {});
    let info = last_heartbeat(&rig.messages()).sessions[0].clone();
    assert_eq!((info.provider_id.as_deref(), info.provider_label.as_deref()), (Some("kimi"), Some("Kimi")));

    rig.send(json!({"type":"usage-request","sessionId":p.session_id}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::GetUsage { .. })), "provider usage is withheld");
    rig.send(json!({"type":"set-option","sessionId":p.session_id,"option":"model","value":"claude-x"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::SetOption { .. })));
    rig.send(json!({"type":"set-option","sessionId":p.session_id,"option":"model","value":"k2"}));
    assert!(rig.has_host_request(|m| matches!(m, BridgeMessage::SetOption { .. })));
}

#[test]
fn a_provider_session_is_refused_for_an_unknown_profile_another_agents_or_an_agent_without_providers() {
    let mut rig = with_kimi();
    rig.send(json!({"type":"create-session","agent":"alpha","providerId":"nope"}));
    assert!(failed_reason(&mut rig).contains("Unknown provider profile 'nope'"));
    rig.send(json!({"type":"create-session","agent":"beta","providerId":"kimi"}));
    assert!(failed_reason(&mut rig).contains("Beta does not support custom provider profiles"));
    let mut p = kimi(None);
    p["agent"] = json!("delta");
    set_profile(&mut rig, p);
    rig.take();
    rig.send(json!({"type":"create-session","agent":"alpha","providerId":"kimi"}));
    assert!(failed_reason(&mut rig).contains("is not one of Alpha's"));
    set_profile(&mut rig, kimi_cleared());
    rig.take();
    rig.send(json!({"type":"create-session","agent":"alpha","providerId":"kimi"}));
    assert!(failed_reason(&mut rig).contains("has no API token stored"));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
}

#[test]
fn a_session_whose_profile_was_deleted_ends_loudly_at_its_next_restart() {
    let mut rig = with_kimi();
    rig.send(json!({"type":"create-session","agent":"alpha","providerId":"kimi"}));
    let (id, p) = rig.start_request();
    rig.host_reply(&id, HostMessage::Ack);
    rig.host_event(&p.session_id, SessionEvent::Ready {});
    rig.send(json!({"type":"set-provider-profile","profileId":"kimi","profile":null}));
    rig.take();
    rig.host_event(&p.session_id, SessionEvent::Ended { error: Some("boom".into()), resume_lost: false });
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))), "never a silent fallback");
    let died = outputs(&rig.messages()).into_iter().find_map(|(_, e)| match e.body {
        EntryBody::Notice { kind: NoticeKind::SessionDied, text } => Some(text),
        _ => None,
    });
    assert_eq!(died.as_deref(), Some("Session restart failed: provider profile 'kimi' was deleted"));
}

// --- retention ---

#[test]
fn retention_removes_orphaned_transcripts_and_caps_live_ones_without_renumbering() {
    let store = MemoryStore::default();
    let registry = json!({"sessions":[{"sessionId":"live","agent":"alpha","cwd":"/w","title":"t","project":"w","createdAt":"t","lastActivity":"t"}],"removedSessions":[]});
    store.put("registry", &registry.to_string());
    let mut transcripts = MemoryTranscripts::default();
    for seq in 1..=10 {
        let e = OutputEntry::new("t", EntryBody::Status { text: seq.to_string() });
        transcripts.append("live", seq, &e).unwrap();
        transcripts.append("orphan", seq, &e).unwrap();
    }
    let mut rig = Rig::with(RigOptions { store, transcripts: transcripts.clone(), configure: |c| c.transcript_keep_last = 3, ..Default::default() });
    assert_eq!(transcripts.sessions(), ["live"]);
    assert_eq!(transcripts.entries("live").iter().map(|e| e.seq).collect::<Vec<_>>(), [8, 9, 10]);
    rig.host_up();
    rig.say("live", "next");
    assert_eq!(outputs(&rig.messages())[0].0, 11, "seqs continue after pruning");
}
