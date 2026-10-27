use super::*;

/// A fresh phone has no relays at all: the pairing link's relays are the
/// first the transport dials, and the pair-request, sent while they are
/// still connecting, reaches them.
#[tokio::test]
async fn a_phone_with_no_relays_pairs_over_the_relays_its_pairing_names() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts::default(),
                Rc::new(Spy::default()),
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;
            core.start();

            core.dispatch(Intent::BeginManualPairing {
                npub: machine.npub.clone(),
                token: "tok".into(),
                relays: mock.url.clone(),
                label: "laptop".into(),
            })
            .await;
            let mut pair_request = false;
            for _ in 0..12 {
                let frame = mock.next_frame().await;
                let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                match v[0].as_str() {
                    Some("REQ") => mock.push(format!(r#"["EOSE","{}"]"#, v[1].as_str().unwrap())),
                    Some("EVENT") => {
                        let tags = v[1]["tags"].as_array().unwrap();
                        if tags.iter().any(|t| t[0] == "p" && t[1] == machine.pubkey_hex) {
                            pair_request = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            assert!(pair_request, "the pair-request never reached the pairing's relay");
        })
        .await;
}

#[tokio::test]
async fn remove_machine_intent_drops_it_from_the_view_and_erases_its_transcript() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            // `set_machines` alone (as other tests use it) only steers the
            // subscription authors filter — it does not populate
            // `stores.machines`, so it is not enough to make `RemoveMachine`
            // find anything to forget. Only a completed pairing does that.
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            core.dispatch(Intent::BeginManualPairing {
                npub: machine.npub.clone(),
                token: "tok".into(),
                relays: mock.url.clone(),
                label: "laptop".into(),
            })
            .await;
            // Staging the candidate resubscribes (the ack must pass the
            // authors filter) — drain that round to get a sub_id the
            // router currently has open.
            let sub = drain_traffic_resubscribe(&mut mock).await;
            push_bridge_to_phone_event(
                &mock,
                &machine,
                &phone.pubkey_hex,
                &sub,
                &BridgeToPhone::PairAck(protocol::events::PairAckMsg {
                    machine: "laptop".into(),
                    ok: true,
                    reason: None,
                    relays: None,
                    host: None,
                }),
            );
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move { core.machines_view().await.machines.contains_key(&key) }
            })
            .await;
            assert!(core
                .machines_view()
                .await
                .machines
                .contains_key(&machine.pubkey_hex));

            // Registering the machine resubscribes again — same reason.
            let sub = drain_traffic_resubscribe(&mut mock).await;

            // A session must actually be listed (not just have output
            // flowing) for `RemoveMachine` to find it — it gathers the
            // sessions to forget from `MachineView.sessions`, exactly
            // like the TS `removeMachine` it mirrors.
            let sessions_msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"sessions","machine":"laptop","sessions":[
                    {"id":"s1","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                ],"agents":[]}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
            let listed_key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = listed_key.clone();
                async move {
                    core.machines_view()
                        .await
                        .machines
                        .get(&key)
                        .is_some_and(|m| m.sessions.contains_key("s1"))
                }
            })
            .await;

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"output","sessionId":"s1","seq":1,"entries":[{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}]}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &msg);
            wait_for_async(|| {
                let core = core.clone();
                let key = machine.pubkey_hex.clone();
                async move { core.transcript_view(key, "s1".to_string()).await.rows.len() == 1 }
            })
            .await;

            // Sanity: the transcript is really there before forgetting the machine.
            let before = core.transcript_view(machine.pubkey_hex.clone(), "s1".to_string()).await;
            assert_eq!(before.rows.len(), 1);

            core.dispatch(Intent::RemoveMachine {
                pubkey_hex: machine.pubkey_hex.clone(),
            })
            .await;
            wait_for_async(|| {
                let core = core.clone();
                let key = machine.pubkey_hex.clone();
                async move { core.transcript_view(key, "s1".to_string()).await.rows.is_empty() }
            })
            .await;

            assert!(!core
                .machines_view()
                .await
                .machines
                .contains_key(&machine.pubkey_hex));
            let after = core.transcript_view(machine.pubkey_hex.clone(), "s1".to_string()).await;
            assert!(after.rows.is_empty());

            let events = spy.events.lock().unwrap();
            assert!(events.contains(&CoreEvent::StateChanged { slice: SliceId::Transcript }));
            assert!(events.contains(&CoreEvent::StateChanged { slice: SliceId::Machines }));
        })
        .await;
}

#[tokio::test]
async fn remove_machine_for_a_never_paired_pubkey_is_a_harmless_no_op() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;

            core.dispatch(Intent::RemoveMachine {
                pubkey_hex: "never-paired".into(),
            })
            .await;

            assert!(!core.machines_view().await.machines.contains_key("never-paired"));
        })
        .await;
}

#[tokio::test]
async fn the_undo_toast_clears_itself_when_the_window_expires_without_a_tap() {
    // Regression: `on_undo_timer` cleared `stores.ui.undo_toast` correctly
    // but emitted `StateChanged(Cards)` instead of `StateChanged(Ui)` — a
    // `UiView` consumer (the native adapter) never learned to re-fetch, so
    // letting the undo window expire without tapping undo left the toast
    // showing forever. Waits out the REAL `UNDO_DELAY_MS` (~4s) rather than
    // a shortened one: `Core::spawn` hydrates `StoresConfig::default()`
    // unconditionally, so the production delay isn't test-overridable here.
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
            core.dispatch(Intent::BeginManualPairing {
                npub: machine.npub.clone(),
                token: "tok".into(),
                relays: mock.url.clone(),
                label: "laptop".into(),
            })
            .await;
            let sub = drain_traffic_resubscribe(&mut mock).await;
            push_bridge_to_phone_event(
                &mock,
                &machine,
                &phone.pubkey_hex,
                &sub,
                &BridgeToPhone::PairAck(protocol::events::PairAckMsg {
                    machine: "laptop".into(),
                    ok: true,
                    reason: None,
                    relays: None,
                    host: None,
                }),
            );
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move { core.machines_view().await.machines.contains_key(&key) }
            })
            .await;

            let sub = drain_traffic_resubscribe(&mut mock).await;
            let sessions_msg = protocol::codec::decode_bridge_to_phone(
                r#"{"v":12,"type":"sessions","machine":"laptop","sessions":[
                    {"id":"s1","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                ],"agents":[]}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
            let listed_key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = listed_key.clone();
                async move {
                    core.machines_view()
                        .await
                        .machines
                        .get(&key)
                        .is_some_and(|m| m.sessions.contains_key("s1"))
                }
            })
            .await;

            core.dispatch(Intent::DeleteSession {
                machine: machine.pubkey_hex.clone(),
                session_id: "s1".into(),
                label: None,
            })
            .await;
            assert!(
                core.ui_view().await.undo_toast.is_some(),
                "delete should arm the undo toast"
            );
            let ui_events_before = spy
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, CoreEvent::StateChanged { slice: SliceId::Ui }))
                .count();

            // Let the window elapse for real, without ever dispatching
            // UndoDelete.
            tokio::time::sleep(std::time::Duration::from_millis(
                client_core::delete_controller::UNDO_DELAY_MS + 300,
            ))
            .await;

            assert!(core.ui_view().await.undo_toast.is_none());
            let ui_events_after = spy
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, CoreEvent::StateChanged { slice: SliceId::Ui }))
                .count();
            assert!(
                ui_events_after > ui_events_before,
                "the timer firing must emit its own StateChanged(Ui) — a \
                 UiView consumer has no other way to learn the toast \
                 cleared itself"
            );
        })
        .await;
}

/// A heartbeat listing `ids` for the machine of the session-delete test.
fn heartbeat_listing(ids: &[&str]) -> BridgeToPhone {
    let sessions: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            serde_json::json!({"id": id, "agent": "claude-code", "slug": id, "cwd": "/w",
                "lastActivity": "t", "lineCount": 0, "title": null, "project": "p"})
        })
        .collect();
    protocol::codec::decode_bridge_to_phone(
        &serde_json::json!({
            "v": 12,
            "type": "sessions",
            "machine": "laptop",
            "sessions": sessions,
            "agents": [],
            "v": protocol::capabilities::PROTOCOL_VERSION,
        })
        .to_string(),
    )
    .unwrap()
}

/// Deleting sessions one after another: each delete commits the one before
/// it at once (one `close-session` each), a heartbeat sent before the
/// bridge has closed the later ones does not bring them back, and the
/// last one — still in its undo window — is committed as soon as the app
/// is backgrounded rather than lost with a killed process.
#[tokio::test]
async fn deleting_sessions_in_a_row_closes_each_one_exactly_once() {
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
            let notifier = RecordingNotifier::new();
            let ports = CorePorts { kv: Rc::new(kv), notifier: Rc::new(notifier.clone()), ..CorePorts::default() };
            let spy = Rc::new(Spy::default());
            let core = core_for_ports(&mock, &phone, Rc::clone(&spy), ports).await;
            core.start();
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            let listed = heartbeat_listing(&["s1", "s2", "s3"]);
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &listed);
            let key = machine.pubkey_hex.clone();
            wait_for_async(|| {
                let core = core.clone();
                let key = key.clone();
                async move { core.machines_view().await.machines[&key].sessions.len() == 3 }
            })
            .await;
            let sessions = |view: MachinesView| -> Vec<String> {
                view.machines[&machine.pubkey_hex].sessions.keys().cloned().collect()
            };
            assert_eq!(sessions(core.machines_view().await), ["s1", "s2", "s3"]);

            for id in ["s1", "s2", "s3"] {
                core.dispatch(Intent::DeleteSession {
                    machine: machine.pubkey_hex.clone(),
                    session_id: id.into(),
                    label: None,
                })
                .await;
            }
            assert!(sessions(core.machines_view().await).is_empty());
            let toast = core.ui_view().await.undo_toast.expect("the last delete is undoable");
            assert_eq!(toast.session_id, "s3");

            // s1 and s2 were committed by the delete that followed each.
            let closed = |cmd: Option<PhoneToBridge>| match cmd {
                Some(PhoneToBridge::CloseSession(m)) => m.session_id,
                other => panic!("expected a close-session, got {other:?}"),
            };
            for id in ["s1", "s2"] {
                assert_eq!(closed(next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await), id);
            }

            // The bridge has closed s1 only; its next list still has the
            // other two, which must stay deleted on the phone.
            let after_first = heartbeat_listing(&["s2", "s3"]);
            // A heartbeat for a session already deleted still notifies; wait
            // for that to prove the frame was folded in before asserting it
            // does not resurrect anything.
            let machine_changes = || {
                spy.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| matches!(e, CoreEvent::StateChanged { slice: SliceId::Machines }))
                    .count()
            };
            let before = machine_changes();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &after_first);
            wait_for(|| machine_changes() > before).await;
            assert!(sessions(core.machines_view().await).is_empty());

            // Backgrounded inside s3's undo window: committed now, well
            // before the window would have run out.
            core.pause();
            let last = tokio::time::timeout(
                std::time::Duration::from_millis(client_core::delete_controller::UNDO_DELAY_MS / 2),
                next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine),
            )
            .await
            .expect("the pending delete is sent when the app is backgrounded");
            assert_eq!(closed(last), "s3");
            assert!(core.ui_view().await.undo_toast.is_none());
            // Each one's notifications went with it — s3's only once it was
            // deleted for good.
            let tag = |id: &str| client_core::notifications::session_notify_tag(&machine.pubkey_hex, id);
            assert_eq!(notifier.cancelled(), [tag("s1"), tag("s2"), tag("s3")]);

            // Nothing is left to undo, and nothing is sent twice.
            core.dispatch(Intent::UndoDelete).await;
            assert!(sessions(core.machines_view().await).is_empty());
        })
        .await;
}
