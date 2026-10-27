use super::*;

fn heartbeat_with(caps: &[&str]) -> BridgeToPhone {
    protocol::codec::decode_bridge_to_phone(
        &serde_json::json!({
            "v": 12,
            "type": "sessions",
            "machine": "laptop",
            "sessions": [],
            "agents": [],
            "credentials": [],
            "v": protocol::capabilities::PROTOCOL_VERSION,
            "capabilities": caps,
        })
        .to_string(),
    )
    .unwrap()
}

/// The whole grant life cycle against a bridge advertising session keys:
/// granted by the identity, confirmed by a message under the key, used
/// for payloads (never for signing), and dropped when the bridge speaks
/// to the identity again.
#[tokio::test]
async fn a_bridge_with_session_keys_gets_payloads_under_the_key_and_signatures_by_the_identity() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let ports = CorePorts { kv: Rc::new(kv), ..CorePorts::default() };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.start();
            eose_all(&mut mock).await;
            // A machine not heard from is granted before anything else; the
            // reconnect's refresh waits on it.
            let grant = expect_grant(&mut mock, &phone, &machine).await;
            let session = grant.pubkey_hex.clone();
            assert_ne!(session, phone.pubkey_hex);
            assert_eq!(grant.replaces, None);

            // Before the bridge confirms, commands wait.
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;

            // The heartbeat under the key confirms it: what waited goes out
            // under the key, without the refresh the heartbeat answered.
            let heartbeat = heartbeat_with(&[protocol::capabilities::SESSION_KEYS]);
            push_bridge_to_phone_event(&mock, &machine, &session, "cd-1", &heartbeat);
            let cmd = next_command_via(&mut mock, &phone, &session, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");

            // A later message to the identity: the bridge lost the key, and
            // is granted it again at once.
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat);
            let again = expect_grant(&mut mock, &phone, &machine).await;
            assert_eq!(again.pubkey_hex, session);
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            push_bridge_to_phone_event(&mock, &machine, &session, "cd-1", &heartbeat);
            let cmd = next_command_via(&mut mock, &phone, &session, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");
        })
        .await;
}

/// The next command must be a grant, under the identity.
async fn expect_grant(
    mock: &mut MockRelay,
    phone: &Keypair,
    machine: &Keypair,
) -> protocol::commands::SessionKeyGrant {
    match next_command_via(mock, phone, &phone.pubkey_hex, machine).await {
        Some(PhoneToBridge::SessionKey(m)) => m.session_key,
        other => panic!("expected a grant, got {other:?}"),
    }
}

/// An identity signer that counts what it is asked to decrypt.
struct DecryptCounter(crate::signer::LocalSigner, Rc<std::cell::Cell<usize>>);

impl IdentitySigner for DecryptCounter {
    fn pubkey_hex(&self) -> String {
        self.0.pubkey_hex()
    }
    fn sign_event(&self, event: nostr::UnsignedEvent) -> crate::ports::LocalBoxFuture<'_, Result<nostr::Event, SignerError>> {
        self.0.sign_event(event)
    }
    fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> crate::ports::LocalBoxFuture<'_, Result<String, SignerError>> {
        self.0.nip44_encrypt(peer, plaintext)
    }
    fn nip44_decrypt(&self, peer: &str, ciphertext: &str) -> crate::ports::LocalBoxFuture<'_, Result<String, SignerError>> {
        self.1.set(self.1.get() + 1);
        self.0.nip44_decrypt(peer, ciphertext)
    }
}

/// A core whose identity counts its decrypts, with `machine` restored
/// from a backup: known, never heard from, no key of this client.
async fn restored_core(mock: &MockRelay, phone: &Keypair, machine: &Keypair, spy: Rc<Spy>) -> (Core, Rc<std::cell::Cell<usize>>) {
    let mut state = client_core::stores::machines::MachinesState::default();
    state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
    let kv = MemoryKv::seeded([(
        crate::stores::MACHINES_KEY,
        client_core::stores::machines::serialize_machines(&state.machines),
    )]);
    let decrypts = Rc::new(std::cell::Cell::new(0));
    let core = Core::spawn(
        CoreConfig {
            identity: Rc::new(DecryptCounter(crate::signer::LocalSigner(phone.clone()), Rc::clone(&decrypts))),
            proxy: None,
            tor: false,
            device_label: None,
            reconnect: fast_reconnect(),
        },
        CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
        spy,
        Rc::new(FixedClock(RefCell::new(1_000_000))),
        Rc::new(ZeroEntropy),
    )
    .await;
    core.set_relays(vec![mock.url.clone()]);
    (core, decrypts)
}

/// Every grant carries the phone's configured device name — what the bridge
/// shows in its terminal allowlist and in a refusal — and none when the phone
/// has no name to give. `CoreConfig::new` sanitizes, so a whitespace-only
/// setting is stored (and granted) as no name rather than a blank one.
#[tokio::test]
async fn every_grant_carries_the_configured_device_label() {
    LocalSet::new()
        .run_until(async {
            for (configured, expected) in [
                (Some("Pixel 8a".to_string()), Some("Pixel 8a")),
                (Some("   ".to_string()), None),
                (None, None),
            ] {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let machine = generate_keypair();
                let spy = Rc::new(Spy::default());
                let mut state = client_core::stores::machines::MachinesState::default();
                state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
                let kv = MemoryKv::seeded([(
                    crate::stores::MACHINES_KEY,
                    client_core::stores::machines::serialize_machines(&state.machines),
                )]);
                let core = Core::spawn(
                    CoreConfig::new(Rc::new(crate::signer::LocalSigner(phone.clone())), None, false, configured.clone()),
                    CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                    spy,
                    Rc::new(FixedClock(RefCell::new(1_000_000))),
                    Rc::new(ZeroEntropy),
                )
                .await;
                core.set_relays(vec![mock.url.clone()]);
                core.start();
                eose_all(&mut mock).await;
                let grant = expect_grant(&mut mock, &phone, &machine).await;
                assert_eq!(grant.label.as_deref(), expected, "configured {configured:?}");
            }
        })
        .await;
}

/// A restored device costs the identity's signer no decrypt: what the
/// bridge wrote to the identity before the grant is skipped, what it
/// writes while the grant travels is dropped once the key is confirmed,
/// and the sessions the confirming heartbeat lists sync under the key.
#[tokio::test]
async fn a_restored_machine_is_granted_first_and_nothing_to_the_identity_is_decrypted() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let (core, decrypts) = restored_core(&mock, &phone, &machine, Rc::clone(&spy)).await;
            core.start();
            eose_all(&mut mock).await;
            let grant = expect_grant(&mut mock, &phone, &machine).await;

            // An identity heartbeat from an earlier install, still on the
            // relay, and one written while the grant travels.
            let heartbeat = heartbeat_with(&[protocol::capabilities::SESSION_KEYS]);
            push_bridge_to_phone_event_at(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat, SESSION_LIST_KIND, Some(500));
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat);
            settle().await;
            assert!(spy.messages.lock().unwrap().is_empty(), "nothing to the identity is read yet");

            // The heartbeat under the key lists a session: it syncs under the key.
            let listed = protocol::codec::decode_bridge_to_phone(
                &serde_json::json!({
                    "v": protocol::capabilities::PROTOCOL_VERSION,
                    "type": "sessions",
                    "machine": "laptop",
                    "sessions": [{"id": "s1", "agent": "opencode", "slug": "sl", "cwd": "/w", "lastActivity": "t", "lineCount": 1, "title": null, "project": "p", "seqHigh": 3}],
                    "agents": [],
                    "credentials": [],
                    "capabilities": [protocol::capabilities::SESSION_KEYS],
                })
                .to_string(),
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &grant.pubkey_hex, "cd-1", &listed);
            let sync = next_command_via(&mut mock, &phone, &grant.pubkey_hex, &machine).await;
            assert!(matches!(sync, Some(PhoneToBridge::SyncRequest(_))), "{sync:?}");
            wait_for(|| spy.messages.lock().unwrap().len() == 1).await;
            assert_eq!(decrypts.get(), 0, "the identity decrypted nothing");
            assert_eq!(spy.messages.lock().unwrap().len(), 1, "only the heartbeat under the key was read");
        })
        .await;
}

/// A bridge that does not confirm the grant in time: what waited on it
/// goes on under the identity, as without session keys.
#[tokio::test]
async fn an_unconfirmed_grant_lets_what_waited_go_on_under_the_identity() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let (core, decrypts) = restored_core(&mock, &phone, &machine, Rc::clone(&spy)).await;
            core.start();
            eose_all(&mut mock).await;
            expect_grant(&mut mock, &phone, &machine).await;
            // A heartbeat to the identity, and live output superseded by
            // the sync that follows it.
            let heartbeat = heartbeat_with(&[]);
            push_bridge_to_phone_event_at(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat, SESSION_LIST_KIND, None);
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat);
            settle().await;
            assert_eq!(decrypts.get(), 0);

            tokio::time::pause();
            tokio::time::advance(super::grant::GRANT_WAIT + Duration::from_secs(1)).await;
            tokio::time::resume();
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");
            wait_for(|| decrypts.get() == 1).await;
            assert_eq!(decrypts.get(), 1, "the held heartbeat is read with the identity");
            assert!(spy.messages.lock().unwrap().iter().any(|(_, m)| matches!(m, BridgeToPhone::Sessions(_))));
        })
        .await;
}

#[tokio::test]
async fn with_a_host_key_store_the_kv_holds_no_session_key() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let kv = MemoryKv::seeded([
                (crate::stores::OLD_SESSION_KEY_KEY, generate_keypair().secret_hex()),
                (crate::stores::SESSION_KEYS_KEY, "{}".to_string()),
            ]);
            let store = MemoryKeyStore::default();
            let ports = CorePorts {
                kv: Rc::new(kv.clone()),
                session_keys: Some(Rc::new(store.clone())),
                ..CorePorts::default()
            };
            let _core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            let dump = kv.dump();
            assert!(!dump.contains_key(crate::stores::OLD_SESSION_KEY_KEY));
            assert!(!dump.contains_key(crate::stores::SESSION_KEYS_KEY));
            assert!(store.0.borrow().is_some(), "the key went to the host's store");
            let secret = store.ring().current.keypair.secret_hex();
            assert!(dump.values().all(|v| !v.contains(&secret)));
        })
        .await;
}

/// A client a bridge knows by its session key stays present there: after
/// a quiet [`PRESENCE_RENEW_SECS`] it renews with a `presence`, and a stop
/// tells the bridge it is away before it disconnects.
#[tokio::test]
async fn a_quiet_client_renews_its_presence_and_says_when_it_goes_away() {
    use client_core::stores::session_key::{SessionGrant, SessionKey};
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let start_ms: u64 = 1_000_000;
            let key = SessionKey { keypair: generate_keypair(), expires_at: start_ms / 1000 + 80 * 24 * 3600 };
            let store = MemoryKeyStore::default();
            *store.0.borrow_mut() = Some(SessionKeyRing::single(key.clone()).encode());
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            state.machines.get_mut(&machine.pubkey_hex).unwrap().session_grant = Some(SessionGrant {
                pubkey_hex: key.pubkey_hex().to_string(),
                expires_at: key.expires_at,
                sent_at: start_ms / 1000 - 100,
            });
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let clock = Rc::new(FixedClock(RefCell::new(start_ms)));
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts { kv: Rc::new(kv), session_keys: Some(Rc::new(store.clone())), ..CorePorts::default() },
                Rc::new(Spy::default()),
                Rc::clone(&clock) as Rc<dyn Clock>,
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_relays(vec![mock.url.clone()]);
            core.start();
            eose_all(&mut mock).await;
            // Connecting says it is here already.
            let refresh = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            // Quiet for the renewal period: the next check sends a presence.
            *clock.0.borrow_mut() += PRESENCE_RENEW_SECS * 1000;
            tokio::time::pause();
            tokio::time::advance(STALE_WATCHDOG_EVERY + Duration::from_secs(1)).await;
            tokio::time::resume();
            let renewal = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(renewal, Some(PhoneToBridge::Presence(PresenceMsg { away: false, watching: None, watching_terminal: None }))), "{renewal:?}");

            core.stop();
            let away = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;
            assert!(matches!(away, Some(PhoneToBridge::Presence(PresenceMsg { away: true, .. }))), "{away:?}");
        })
        .await;
}

/// A machine-settings change the bridge never answers (the machine is
/// offline, a relay dropped the command) stops showing as busy after the
/// phone's own deadline, with the reason, instead of spinning forever.
#[tokio::test]
async fn a_machine_settings_change_nobody_answers_stops_being_busy_at_the_deadline() {
    use client_core::stores::machines::SLOW_SETTINGS_ANSWER_TIMEOUT_MS;
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let start_ms: u64 = 1_000_000;
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let clock = Rc::new(FixedClock(RefCell::new(start_ms)));
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                Rc::new(Spy::default()),
                Rc::clone(&clock) as Rc<dyn Clock>,
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_relays(vec![mock.url.clone()]);
            core.start();
            eose_all(&mut mock).await;

            core.dispatch(Intent::PluginAction {
                machine: machine.pubkey_hex.clone(),
                agent: "claude-code".into(),
                action: protocol::common::PluginAction::Install,
                target: "b@m".into(),
            })
            .await;
            let busy = |view: MachinesView| view.machines[&machine.pubkey_hex].plugins["claude-code"].busy.clone();
            assert_eq!(busy(core.machines_view().await), ["b@m".to_string()]);

            // The machine never answers; the phone's clock passes the
            // deadline and the timer armed for it fires.
            *clock.0.borrow_mut() += SLOW_SETTINGS_ANSWER_TIMEOUT_MS + 1;
            tokio::time::pause();
            tokio::time::advance(Duration::from_millis(SLOW_SETTINGS_ANSWER_TIMEOUT_MS + 1)).await;
            tokio::time::resume();
            wait_for_async(|| {
                let core = core.clone();
                let key = machine.pubkey_hex.clone();
                async move {
                    let view = core.machines_view().await;
                    view.machines[&key].plugins["claude-code"].failure.is_some()
                }
            })
            .await;

            let view = core.machines_view().await;
            let plugins = &view.machines[&machine.pubkey_hex].plugins["claude-code"];
            assert!(plugins.busy.is_empty(), "the change is given up on");
            let failure = plugins.failure.as_ref().expect("and says why");
            assert!(failure.error.contains("did not answer"), "{failure:?}");
        })
        .await;
}

/// A key a month from lapsing is replaced at boot. The bridge on it keeps
/// using it until it confirms the new one, which it is granted under the
/// old one; then the old key is gone from the phone's store.
#[tokio::test]
async fn a_rotated_key_is_granted_and_the_old_one_dropped_once_confirmed() {
    use client_core::stores::session_key::{SessionGrant, SessionKey};
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let now_secs = 1_000;
            let old = SessionKey { keypair: generate_keypair(), expires_at: now_secs + 10 * 24 * 3600 };
            let store = MemoryKeyStore::default();
            *store.0.borrow_mut() = Some(SessionKeyRing::single(old.clone()).encode());
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            state.machines.get_mut(&machine.pubkey_hex).unwrap().session_grant = Some(SessionGrant {
                pubkey_hex: old.pubkey_hex().to_string(),
                expires_at: old.expires_at,
                sent_at: now_secs - 100,
            });
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let ports = CorePorts {
                kv: Rc::new(kv),
                session_keys: Some(Rc::new(store.clone())),
                ..CorePorts::default()
            };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            let ring = store.ring();
            let new = ring.current.pubkey_hex().to_string();
            assert_ne!(new, old.pubkey_hex(), "replaced at boot");
            assert_eq!(ring.previous.as_ref().map(|k| k.pubkey_hex()), Some(old.pubkey_hex()), "and kept");

            core.start();
            eose_all(&mut mock).await;
            // The bridge still holds only the old key: payloads use it.
            let refresh = next_command_via(&mut mock, &phone, old.pubkey_hex(), &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            // Its heartbeat, under the old key, earns it the new one.
            let heartbeat = heartbeat_with(&[protocol::capabilities::SESSION_KEYS]);
            push_bridge_to_phone_event(&mock, &machine, old.pubkey_hex(), "cd-1", &heartbeat);
            let grant = match next_command_via(&mut mock, &phone, old.pubkey_hex(), &machine).await {
                Some(PhoneToBridge::SessionKey(m)) => m.session_key,
                other => panic!("expected a grant, got {other:?}"),
            };
            assert_eq!(grant.pubkey_hex, new);
            assert_eq!(grant.replaces.as_deref(), Some(old.pubkey_hex()), "it moves this client, not adds one");
            assert_eq!(grant.bridge_pubkey_hex, machine.pubkey_hex);
            assert_eq!(grant.expires_at, ring.current.expires_at);

            // A heartbeat under the new key confirms it: the old one goes.
            push_bridge_to_phone_event(&mock, &machine, &new, "cd-1", &heartbeat);
            wait_for(|| store.ring().previous.is_none()).await;
            assert!(store.ring().previous.is_none());
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            let cmd = next_command_via(&mut mock, &phone, &new, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");
        })
        .await;
}

/// Coming back to the app with the socket still up asks a machine for
/// its session list only when its heartbeat has not kept it current.
#[tokio::test]
async fn a_resume_refreshes_only_machines_not_heard_from_lately() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            heard_without_session_keys(&mut state, &machine.pubkey_hex);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let clock = Rc::new(FixedClock(RefCell::new(1_000_000)));
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                Rc::new(Spy::default()),
                clock.clone(),
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_relays(vec![mock.url.clone()]);
            core.start();
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "the connect refreshes: {refresh:?}");
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat_with(&[]));
            for _ in 0..100 {
                if core.machines_view().await.machines[&machine.pubkey_hex].last_heartbeat_at.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }

            // Heard just now: the resume sends nothing, so the next
            // command out is the user's.
            core.resume();
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            let cmd = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");

            // Silent for longer than a couple of heartbeats: refreshed.
            *clock.0.borrow_mut() += RESUME_HEARD_WITHIN_MS;
            core.resume();
            let cmd = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::RefreshSessions(_))), "{cmd:?}");
        })
        .await;
}
