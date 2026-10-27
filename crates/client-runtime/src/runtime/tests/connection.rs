use super::*;

/// The connect deadline the `fast_reconnect` config uses, for advancing the
/// fake clock.
fn connect_deadline() -> u64 {
    fast_reconnect().connect_deadline_ms
}

#[tokio::test]
async fn start_subscribes_and_reports_connected_after_all_eose() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;

            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();

            eose_all(&mut mock).await;
            wait_for(|| spy.statuses.lock().unwrap().last().is_some_and(|(s, _)| *s == ConnectionStatus::Connected))
                .await;

            let statuses = spy.statuses.lock().unwrap().clone();
            assert!(
                statuses.iter().any(|(s, _)| *s == ConnectionStatus::Connecting),
                "{statuses:?}"
            );
            assert_eq!(statuses.last().unwrap().0, ConnectionStatus::Connected);
            // The relay that actually opened is what Settings' per-relay
            // dot should read — not an empty placeholder.
            assert_eq!(
                spy.connected_relays.lock().unwrap().last().unwrap(),
                &vec![mock.url.clone()],
            );
        })
        .await;
}

/// One relay of two dying leaves overall `ConnectionStatus` untouched
/// (`NostrClient::on_close` only fires once EVERY relay for a
/// subscription is dead), so `dispatch`'s status-transition gate never
/// runs. The transport reports the relay going down itself, so Settings'
/// per-relay dot follows at once rather than at the watchdog's next tick.
#[tokio::test]
async fn a_relay_dying_while_another_survives_is_reported_at_once() {
    LocalSet::new()
        .run_until(async {
            let mut mock1 = mock_relay().await;
            let mut mock2 = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts::default(),
                Rc::clone(&spy) as Rc<dyn CoreObserver>,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_relays(vec![mock1.url.clone(), mock2.url.clone()]);

            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();

            eose_all(&mut mock1).await;
            eose_all(&mut mock2).await;
            wait_for(|| spy.connected_relays.lock().unwrap().last().is_some_and(|r| r.len() == 2)).await;

            let before = spy.connected_relays.lock().unwrap().last().unwrap().clone();
            assert_eq!(before.len(), 2, "{before:?}");

            // Real time only, far short of the watchdog's 30 s tick.
            mock2.close();
            wait_for(|| {
                spy.connected_relays
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|r| r == &vec![mock1.url.clone()])
            })
            .await;

            let after = spy.connected_relays.lock().unwrap().last().unwrap().clone();
            assert_eq!(after, vec![mock1.url.clone()], "{after:?}");
        })
        .await;
}

#[tokio::test]
async fn a_bridge_message_is_decrypted_decoded_and_delivered() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"input-ack","sessionId":"s1","inputId":"i1"}"#,
            )
            .unwrap();
            let plaintext = encode_bridge_to_phone(&msg);
            let ct = protocol::crypto::encrypt_to(
                &machine.secret_key,
                &phone.pubkey_hex,
                &plaintext,
            )
            .unwrap();
            let event = nostr::EventBuilder::new(nostr::Kind::Custom(LIVE_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            wait_for(|| spy.messages.lock().unwrap().len() == 1).await;

            let messages = spy.messages.lock().unwrap();
            assert_eq!(messages.len(), 1, "{messages:?}");
            assert_eq!(messages[0].0, machine.pubkey_hex);
            assert!(matches!(messages[0].1, BridgeToPhone::InputAck(_)));
        })
        .await;
}

#[tokio::test]
async fn a_bridge_of_another_version_is_marked_until_it_is_read_again() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            // Paired, so the machines store knows it.
            core.dispatch(Intent::BeginManualPairing {
                npub: machine.npub.clone(),
                token: "tok".into(),
                relays: mock.url.clone(),
                label: "laptop".into(),
            })
            .await;
            let sub = drain_traffic_resubscribe(&mut mock).await;
            let ack = BridgeToPhone::PairAck(protocol::events::PairAckMsg {
                machine: "laptop".into(),
                ok: true,
                reason: None,
                relays: None,
                host: None,
            });
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &ack);
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move { core.machines_view().await.machines.contains_key(&key) }
            })
            .await;
            let sub = drain_traffic_resubscribe(&mut mock).await;

            let push_raw = |plaintext: &str| {
                let ct = protocol::crypto::encrypt_to(&machine.secret_key, &phone.pubkey_hex, plaintext).unwrap();
                let event = nostr::EventBuilder::new(nostr::Kind::Custom(LIVE_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                    .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                    .unwrap();
                mock.push(format!(r#"["EVENT","{sub}",{}]"#, <nostr::Event as nostr::JsonUtil>::as_json(&event)));
            };
            let mark = || async {
                core.machines_view().await.machines[&machine.pubkey_hex].incompatible.map(|i| i.theirs)
            };
            assert_eq!(mark().await, None);

            push_raw(r#"{"v":13,"type":"input-ack","sessionId":"s1","inputId":"i1"}"#);
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move {
                    core.machines_view().await.machines[&key].incompatible.map(|i| i.theirs) == Some(Some(13))
                }
            })
            .await;
            assert_eq!(mark().await, Some(Some(13)));
            let delivered = spy.messages.lock().unwrap().len();

            push_raw(r#"{"v":12,"type":"input-ack","sessionId":"s1","inputId":"i1"}"#);
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move { core.machines_view().await.machines[&key].incompatible.is_none() }
            })
            .await;
            assert_eq!(mark().await, None);
            assert_eq!(spy.messages.lock().unwrap().len(), delivered + 1);
        })
        .await;
}

#[tokio::test]
async fn a_notify_worthy_event_while_backgrounded_fires_the_ping_core_event() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;

            // Backgrounded — `decide_ping` wants a chime unconditionally
            // once the app isn't visible, for any notify-worthy event.
            core.pause();

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"session-failed","pendingId":"p1","reason":"boom"}"#,
            )
            .unwrap();
            let plaintext = encode_bridge_to_phone(&msg);
            let ct = protocol::crypto::encrypt_to(
                &machine.secret_key,
                &phone.pubkey_hex,
                &plaintext,
            )
            .unwrap();
            let event = nostr::EventBuilder::new(nostr::Kind::Custom(LIVE_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            wait_for(|| spy.events.lock().unwrap().contains(&CoreEvent::Ping)).await;

            let events = spy.events.lock().unwrap();
            assert!(events.contains(&CoreEvent::Ping), "{events:?}");
        })
        .await;
}

#[tokio::test]
async fn create_folder_round_trips_to_a_matching_folder_ack_core_event() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;

            core.dispatch(Intent::CreateFolder {
                machine: machine.pubkey_hex.clone(),
                path: "sub/dir".into(),
                root: None,
                request_id: "req-1".into(),
            })
            .await;

            // The dispatched command reaches the bridge as a real, signed
            // create-folder event — same publish path every other Intent uses.
            let frame = mock.next_frame().await;
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(v[0], "EVENT");

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"folder-ack","requestId":"req-1","success":true,"path":"sub/dir"}"#,
            )
            .unwrap();
            let plaintext = encode_bridge_to_phone(&msg);
            let ct = protocol::crypto::encrypt_to(
                &machine.secret_key,
                &phone.pubkey_hex,
                &plaintext,
            )
            .unwrap();
            let event = nostr::EventBuilder::new(nostr::Kind::Custom(RESPONSE_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            wait_for(|| {
                spy.events.lock().unwrap().iter().any(|e| matches!(
                    e,
                    CoreEvent::FolderAck { request_id, success: true, path: Some(p), error: None }
                        if request_id == "req-1" && p == "sub/dir"
                ))
            })
            .await;

            let events = spy.events.lock().unwrap();
            assert!(
                events.iter().any(|e| matches!(
                    e,
                    CoreEvent::FolderAck { request_id, success: true, path: Some(p), error: None }
                        if request_id == "req-1" && p == "sub/dir"
                )),
                "{events:?}",
            );
        })
        .await;
}

/// A fresh store asks for stored responses from its first start (less the
/// grace), not the identity's whole history: what earlier installs were
/// sent is under keys this one does not hold.
#[tokio::test]
async fn a_fresh_store_asks_for_stored_responses_from_its_start() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            let since = loop {
                let frame = mock.next_frame().await;
                let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                if v[0] == "REQ" && v[2]["kinds"][0] == RESPONSE_KIND {
                    break v[2]["since"].as_i64();
                }
            };
            // The test clock reads 1_000 s.
            assert_eq!(since, Some(1_000 - crate::nostr_client::STORED_SINCE_GRACE_SECONDS));
        })
        .await;
}

/// A stored-kind event (4516/30515) advancing `last_stored_seen` used to
/// update only the in-memory `LoopHost` cursor — a restart re-hydrated
/// from the `Kv` at 0 and re-fetched the peer's ENTIRE stored history
/// instead of resuming from where it left off, on every single restart.
#[tokio::test]
async fn a_stored_kind_event_persists_the_cursor_to_kv() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let kv = Rc::new(MemoryKv::new());
            let ports = CorePorts { kv: Rc::clone(&kv) as Rc<dyn Kv>, ..CorePorts::default() };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;

            assert_eq!(kv.get(LAST_STORED_SEEN_KEY).await, None);

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"input-ack","sessionId":"s1","inputId":"i1"}"#,
            )
            .unwrap();
            let plaintext = encode_bridge_to_phone(&msg);
            let ct = protocol::crypto::encrypt_to(
                &machine.secret_key,
                &phone.pubkey_hex,
                &plaintext,
            )
            .unwrap();
            let event = nostr::EventBuilder::new(nostr::Kind::Custom(RESPONSE_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            let created_at = event.created_at.as_secs();
            // "cd-1" is a real, currently-open subscription id (one of the
            // three bridge filters `eose_all` just drained) — an id with no
            // matching subscription is silently dropped by the transport,
            // same as a real relay addressing a closed sub.
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;
            // Held back by the write debounce...
            assert_eq!(kv.get(LAST_STORED_SEEN_KEY).await, None);
            // ...until it elapses.
            tokio::time::sleep(WRITE_DEBOUNCE + Duration::from_millis(200)).await;
            assert_eq!(
                kv.get(LAST_STORED_SEEN_KEY).await,
                Some(created_at.to_string()),
            );

            // A later event is written the moment the app is backgrounded.
            let newer = nostr::EventBuilder::new(nostr::Kind::Custom(RESPONSE_KIND), "x")
                .custom_created_at(nostr::Timestamp::from(created_at + 10))
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&newer)
            ));
            settle().await;
            core.pause();
            settle().await;
            assert_eq!(
                kv.get(LAST_STORED_SEEN_KEY).await,
                Some((created_at + 10).to_string()),
            );
        })
        .await;
}

#[tokio::test]
async fn a_socket_drop_backs_off_and_reconnects() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            mock.close();
            // fast_reconnect base is 40ms: the backoff and its retry follow.
            wait_for(|| {
                let statuses = spy.statuses.lock().unwrap();
                statuses.iter().any(|(s, _)| *s == ConnectionStatus::WaitingRetry)
                    && statuses.iter().filter(|(s, _)| *s == ConnectionStatus::Connecting).count() >= 2
            })
            .await;

            let statuses = spy.statuses.lock().unwrap().clone();
            assert!(
                statuses.iter().any(|(s, _)| *s == ConnectionStatus::WaitingRetry),
                "{statuses:?}"
            );
            assert!(
                statuses.iter().filter(|(s, _)| *s == ConnectionStatus::Connecting).count() >= 2,
                "expected a second Connecting after backoff: {statuses:?}"
            );
        })
        .await;
}

#[tokio::test]
async fn a_connect_that_never_reaches_eose_is_abandoned_and_retried() {
    LocalSet::new()
        .run_until(async {
            // The relay accepts the socket and reads the REQs, but never
            // sends EOSE — the FSM's `SocketOpen`, and the only thing that
            // ends `Connecting`.
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let clock = Rc::new(FixedClock(RefCell::new(1_000_000)));
            let core = core_for_ports_clock(
                &mock,
                &phone,
                Rc::clone(&spy),
                CorePorts::default(),
                Rc::clone(&clock),
            )
            .await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            wait_status(&core, ConnectionStatus::Connecting).await;
            assert_eq!(core.connection_status().await.0, ConnectionStatus::Connecting);

            *clock.0.borrow_mut() += connect_deadline() + 1_000;
            core.tick();
            // fast_reconnect's 40ms retry has fired by now.
            wait_for(|| {
                let statuses: Vec<ConnectionStatus> =
                    spy.statuses.lock().unwrap().iter().map(|(s, _)| *s).collect();
                statuses.windows(2).any(|w| w == [ConnectionStatus::WaitingRetry, ConnectionStatus::Connecting])
            })
            .await;

            let statuses: Vec<ConnectionStatus> =
                spy.statuses.lock().unwrap().iter().map(|(s, _)| *s).collect();
            assert!(statuses.contains(&ConnectionStatus::WaitingRetry), "{statuses:?}");
            assert!(
                statuses.windows(2).any(|w| w == [ConnectionStatus::WaitingRetry, ConnectionStatus::Connecting]),
                "the abandoned attempt went through backoff and retried: {statuses:?}"
            );
        })
        .await;
}

#[tokio::test]
async fn a_paused_connect_is_not_abandoned_and_a_resume_restarts_its_clock() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let clock = Rc::new(FixedClock(RefCell::new(1_000_000)));
            let core = core_for_ports_clock(
                &mock,
                &phone,
                Rc::clone(&spy),
                CorePorts::default(),
                clock.clone(),
            )
            .await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            wait_status(&core, ConnectionStatus::Connecting).await;
            assert_eq!(core.connection_status().await.0, ConnectionStatus::Connecting);

            // Hidden past the 500ms visibility debounce, then dozing: wall
            // time moves beyond the deadline while the app runs nothing.
            core.pause();
            tokio::time::sleep(Duration::from_millis(600)).await;
            *clock.0.borrow_mut() += connect_deadline() + 60_000;
            core.tick();
            assert_eq!(
                core.connection_status().await.0,
                ConnectionStatus::Connecting,
                "paused time is not spent against the connect attempt"
            );

            // Resume re-dials while still Connecting: that is a new attempt,
            // with a fresh window rather than the abandoned one's leftovers.
            // The re-dial runs on the fake clock, so let the loop take it in
            // before moving that clock.
            core.resume();
            settle().await;
            *clock.0.borrow_mut() += connect_deadline() - 1_000;
            core.tick();
            assert_eq!(
                core.connection_status().await.0,
                ConnectionStatus::Connecting,
                "the resumed attempt gets its own window"
            );

            *clock.0.borrow_mut() += 2_000;
            core.tick();
            wait_for(|| {
                spy.statuses.lock().unwrap().iter().any(|(s, _)| *s == ConnectionStatus::WaitingRetry)
            })
            .await;
            assert!(
                spy.statuses.lock().unwrap().iter().any(|(s, _)| *s == ConnectionStatus::WaitingRetry),
                "the resumed attempt is abandoned once its own deadline passes"
            );
        })
        .await;
}

#[tokio::test]
async fn stop_is_terminal_no_reconnect() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            core.stop();
            wait_status(&core, ConnectionStatus::Stopped).await;
            mock.close();
            // Nothing after Stopped, even when the socket closes.
            settle().await;

            let statuses = spy.statuses.lock().unwrap().clone();
            assert_eq!(statuses.last().unwrap().0, ConnectionStatus::Stopped);
            // nothing after Stopped
            let after_stop = statuses
                .iter()
                .skip_while(|(s, _)| *s != ConnectionStatus::Stopped)
                .count();
            assert_eq!(after_stop, 1, "status changed after Stop: {statuses:?}");
        })
        .await;
}

#[tokio::test]
async fn connection_status_query_reflects_the_live_fsm() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);

            assert_eq!(core.connection_status().await.0, ConnectionStatus::Idle);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;
            assert_eq!(core.connection_status().await.0, ConnectionStatus::Connected);
            core.stop();
            wait_status(&core, ConnectionStatus::Stopped).await;
            assert_eq!(core.connection_status().await.0, ConnectionStatus::Stopped);
        })
        .await;
}

/// A machine paired in a PRIOR run is only in the persisted `Kv`, never in
/// `set_machines` — production code never calls that (only a live pairing
/// route/intent populates the subscription author list reactively). A
/// fresh `Core::spawn()` used to leave that list empty for the rest of the
/// process's life unless a NEW pairing happened to run in it:
/// `NostrClient::connect()` treats an empty author list as vacuous and
/// opens zero of the three bridge subscriptions, so a returning phone
/// would never see another heartbeat or session update from a machine it
/// paired before this boot — the root cause behind "the machine dot never
/// leaves orange, and a bridge-confirmed session never appears, except
/// right after pairing".
#[tokio::test]
async fn a_machine_paired_in_a_prior_run_is_resubscribed_on_a_fresh_boot_without_set_machines() {
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
            let ports = CorePorts { kv: Rc::new(kv), ..CorePorts::default() };

            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            // Deliberately no `core.set_machines(...)` — this is the part
            // of the boot sequence a real app reopen actually exercises.
            core.start();

            // Hangs (and `next_frame` panics at its 2s budget) if the
            // subscription author list is still empty at this point.
            eose_all(&mut mock).await;

            // A real heartbeat from that same machine must still reach the
            // machines view — proving the subscription actually scopes to
            // it, not just that some vacuous socket opened.
            let sessions_json =
                r#"{"v":12,"type":"sessions","machine":"bridge","sessions":[],"agents":[]}"#;
            let msg = protocol::codec::decode_bridge_to_phone(sessions_json).unwrap();
            let plaintext = encode_bridge_to_phone(&msg);
            let ct = protocol::crypto::encrypt_to(
                &machine.secret_key,
                &phone.pubkey_hex,
                &plaintext,
            )
            .unwrap();
            let event =
                nostr::EventBuilder::new(nostr::Kind::Custom(SESSION_LIST_KIND), ct)
                .tag(recipient(&machine, &phone.pubkey_hex))
                    .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                    .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move {
                    core.machines_view()
                        .await
                        .machines
                        .get(&key)
                        .is_some_and(|m| m.last_heartbeat_at.is_some())
                }
            })
            .await;

            let view = core.machines_view().await;
            let m = view.machines.get(&machine.pubkey_hex).expect("machine still known");
            assert!(m.last_heartbeat_at.is_some(), "heartbeat never reached the view");
        })
        .await;
}

#[tokio::test]
async fn set_relays_repoints_the_transport_to_the_new_relay() {
    LocalSet::new()
        .run_until(async {
            let mut first = mock_relay().await;
            let mut second = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&first, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut first).await;
            wait_connected(&core).await;

            core.set_relays(vec![second.url.clone()]);
            // the new relay gets the three REQs; drain them
            for _ in 0..3 {
                let req = second.next_frame().await;
                assert!(req.starts_with(r#"["REQ""#), "got {req}");
            }
        })
        .await;
}

#[tokio::test]
async fn keepalive_probes_the_relays_and_keeps_a_healthy_connection() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            // The mock answers the probe's ping, so the check is quick
            // and leaves the connection as it was.
            tokio::time::timeout(Duration::from_secs(2), core.keepalive())
                .await
                .expect("keepalive resolves once the relay answers");
            let (status, _, connected) = core.connection_status().await;
            assert_eq!(status, ConnectionStatus::Connected);
            assert_eq!(connected, vec![mock.url.clone()]);
        })
        .await;
}

#[tokio::test]
async fn a_30515_heartbeat_reaches_the_fsm_even_if_it_is_not_ours() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut mock).await;

            // a signed 30515 from a stranger: no decode (not a paired
            // machine), but it must not crash and must not deliver.
            let stranger = generate_keypair();
            let event =
                nostr::EventBuilder::new(nostr::Kind::Custom(SESSION_LIST_KIND), "garbage")
                    .sign_with_keys(&nostr::Keys::new(stranger.secret_key.clone()))
                    .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

            assert!(spy.messages.lock().unwrap().is_empty());
        })
        .await;
}
