use super::*;

// --- the composed store layer ---

struct OkHttp;

impl crate::attachments::HttpFetch for OkHttp {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
    {
        Box::pin(async {
            Ok(crate::attachments::HttpResponse {
                status: 200,
                body: b"{}".to_vec(),
            })
        })
    }
}

/// Every call fails — forces the session-image chunk fallback.
struct FailHttp;

impl crate::attachments::HttpFetch for FailHttp {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
    {
        Box::pin(async { Err("no server".to_string()) })
    }
}

/// A Blossom server that accepts the upload and never answers.
struct HangHttp;

impl crate::attachments::HttpFetch for HangHttp {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
    {
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn a_stalled_image_upload_does_not_block_the_loop() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let ports = CorePorts {
                http: Rc::new(HangHttp),
                ..CorePorts::default()
            };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;
            core.dispatch(Intent::SetBlossomServer("https://blossom.example".into())).await;

            let core2 = core.clone();
            let upload = tokio::task::spawn_local(async move {
                core2
                    .dispatch(Intent::SendSessionFile(SessionFileSend {
                        machine: "m".into(),
                        session_id: "s1".into(),
                        text: String::new(),
                        data: b"bytes".to_vec(),
                        filename: "a.jpg".into(),
                        mime_type: "image/jpeg".into(),
                    }))
                    .await;
            });
            // Let the upload task reach the hanging `put` before checking the
            // loop still answers.
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }

            // The upload is still hanging, yet the loop answers at once.
            tokio::time::timeout(Duration::from_secs(1), core.machines_view())
                .await
                .expect("the loop stayed blocked behind the upload");
            assert!(!upload.is_finished(), "the intent answers only when the send ends");
            upload.abort();
        })
        .await;
}

/// Decrypt + decode a relay `EVENT` frame as a `PhoneToBridge` command from
/// `phone` to `machine` — `None` if the frame isn't an EVENT, isn't tagged
/// for `machine`, or doesn't decrypt/decode as one.
fn decode_command_frame(
    frame: &str,
    phone_pubkey: &str,
    machine: &Keypair,
) -> Option<PhoneToBridge> {
    let v: Vec<serde_json::Value> = serde_json::from_str(frame).ok()?;
    if v.first()? != "EVENT" {
        return None;
    }
    let ev = v.get(1)?;
    if ev.get("pubkey")? != &serde_json::json!(phone_pubkey) {
        return None;
    }
    let tagged = ev.get("tags")?.as_array()?.iter().any(|t| {
        t.get(0) == Some(&serde_json::json!("p"))
            && t.get(1) == Some(&serde_json::json!(machine.pubkey_hex))
    });
    if !tagged {
        return None;
    }
    let content = ev.get("content")?.as_str()?;
    let plaintext =
        protocol::crypto::decrypt_from(&machine.secret_key, phone_pubkey, content).ok()?;
    protocol::codec::decode_phone_to_bridge(&plaintext).ok()
}

#[tokio::test]
async fn connection_view_query_reflects_the_live_status() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);

            assert_eq!(core.connection_view().await.unwrap().status, "idle");
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;
            assert_eq!(core.connection_view().await.unwrap().status, "connected");
        })
        .await;
}

#[tokio::test]
async fn an_intent_becomes_a_signed_command_on_the_wire() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;

            core.dispatch(Intent::Interrupt {
                machine: machine.pubkey_hex.clone(),
                session_id: "s1".into(),
            })
            .await;

            // among the published EVENTs find the one wrapped for the
            // machine.
            let mut found = false;
            for _ in 0..6 {
                let frame = mock.next_frame().await;
                let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                if v[0] != "EVENT" {
                    continue;
                }
                let ev = &v[1];
                if ev["pubkey"] == serde_json::json!(phone.pubkey_hex)
                    && ev["tags"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|t| t[0] == "p" && t[1] == machine.pubkey_hex)
                {
                    found = true;
                    break;
                }
            }
            assert!(found, "no command EVENT p-tagged to the machine");
        })
        .await;
}

#[tokio::test]
async fn editing_a_machines_relays_repoints_the_transport() {
    LocalSet::new()
        .run_until(async {
            let mut first = mock_relay().await;
            let mut second = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            // A machine paired in an earlier run, reached over `first`.
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[first.url.clone()]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let spy = Rc::new(Spy::default());
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                Rc::clone(&spy) as Rc<dyn CoreObserver>,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;
            // Dialled from the stored machine alone: no relay configured.
            core.start();
            eose_all(&mut first).await;
            wait_connected(&core).await;

            core.dispatch(Intent::SetMachineRelays {
                machine: machine.pubkey_hex.clone(),
                relays: vec![second.url.clone()],
            })
            .await;
            for _ in 0..3 {
                let req = second.next_frame().await;
                assert!(req.starts_with(r#"["REQ""#), "got {req}");
            }
            assert!(spy.events.lock().unwrap().contains(&CoreEvent::StateChanged { slice: SliceId::Machines }));
        })
        .await;
}

#[tokio::test]
async fn select_session_intent_updates_the_ui_view_and_emits_a_state_changed_event() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;

            core.dispatch(Intent::SelectSession {
                machine: "m1".into(),
                session_id: Some("s1".into()),
            })
            .await;

            let uv = core.ui_view().await;
            assert_eq!(uv.selected_machine.as_deref(), Some("m1"));
            assert_eq!(uv.selected_session.as_deref(), Some("s1"));

            {
                let events = spy.events.lock().unwrap();
                assert!(events.contains(&CoreEvent::StateChanged { slice: SliceId::Ui }));
            }
        })
        .await;
}

#[tokio::test]
async fn selecting_a_session_cancels_its_notification_tag() {
    // CDX-026c: opening a session the user was notified about clears
    // every notification filed under its tag.
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let notifier = RecordingNotifier::new();
            let ports = CorePorts {
                notifier: Rc::new(notifier.clone()),
                ..CorePorts::default()
            };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;

            core.dispatch(Intent::SelectSession {
                machine: "m1".into(),
                session_id: Some("s1".into()),
            })
            .await;

            assert_eq!(
                notifier.cancelled(),
                vec![client_core::notifications::session_notify_tag("m1", "s1")]
            );
        })
        .await;
}

#[tokio::test]
async fn coming_back_to_a_session_cancels_what_was_notified_while_away() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let notifier = RecordingNotifier::new();
            let ports = CorePorts {
                notifier: Rc::new(notifier.clone()),
                ..CorePorts::default()
            };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.dispatch(Intent::SelectSession {
                machine: "m1".into(),
                session_id: Some("s1".into()),
            })
            .await;
            core.pause();
            core.resume();
            wait_for(|| notifier.cancelled().len() == 2).await;
            let tag = client_core::notifications::session_notify_tag("m1", "s1");
            assert_eq!(notifier.cancelled(), [tag.clone(), tag]);

            // Left for the list: coming back clears nothing.
            core.dispatch(Intent::SelectSession {
                machine: "m1".into(),
                session_id: None,
            })
            .await;
            core.pause();
            core.resume();
            settle().await;
            assert_eq!(notifier.cancelled().len(), 2);
        })
        .await;
}

#[tokio::test]
async fn set_plan_approval_choice_intent_updates_the_ui_view() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;

            core.dispatch(Intent::SetPlanApprovalChoice {
                card_id: "card1".into(),
                key: "2".into(),
            })
            .await;

            let uv = core.ui_view().await;
            assert_eq!(uv.plan_approval_choices.get("card1").map(String::as_str), Some("2"));
        })
        .await;
}

/// Read frames from `mock` until `matches` returns one, ACK-ing every
/// `EVENT` along the way (by its real id) so a concurrent
/// `publish_confirmed` settles immediately instead of riding out the full
/// confirm budget — the image upload awaits its own publish, so the test
/// must answer it while `dispatch` is still in flight.
async fn find_command_frame(
    mock: &mut MockRelay,
    phone_pubkey: &str,
    machine: &Keypair,
    matches: impl Fn(&PhoneToBridge) -> bool,
) -> PhoneToBridge {
    for _ in 0..16 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == "EVENT" {
            if let Some(id) = v[1]["id"].as_str() {
                mock.push(format!(r#"["OK","{id}",true,""]"#));
            }
        }
        if let Some(msg) = decode_command_frame(&frame, phone_pubkey, machine) {
            if matches(&msg) {
                return msg;
            }
        }
    }
    panic!("no matching command reached the machine within 16 frames");
}

#[tokio::test]
async fn sending_a_session_image_uploads_to_blossom_and_publishes_the_command() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let ports = CorePorts {
                http: Rc::new(OkHttp),
                ..CorePorts::default()
            };
            let core =
                core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            core.dispatch(Intent::SetBlossomServer("https://blossom.example".into())).await;

            let core2 = core.clone();
            let machine_pubkey = machine.pubkey_hex.clone();
            let dispatched = tokio::task::spawn_local(async move {
                core2
                    .dispatch(Intent::SendSessionFile(SessionFileSend {
                        machine: machine_pubkey,
                        session_id: "s1".into(),
                        text: "look at this".into(),
                        data: b"png bytes here".to_vec(),
                        filename: "photo.png".into(),
                        mime_type: "image/png".into(),
                    }))
                    .await;
            });

            let msg = find_command_frame(
                &mut mock,
                &phone.pubkey_hex,
                &machine,
                |m| matches!(m, PhoneToBridge::UploadFile(_)),
            )
            .await;
            dispatched.await.unwrap();

            match msg {
                PhoneToBridge::UploadFile(UploadFileMsg::Blossom(m)) => {
                    assert_eq!(m.session_id, "s1");
                    assert_eq!(m.text, "look at this");
                    assert_eq!(m.filename, "photo.png");
                    assert_eq!(m.size_bytes, b"png bytes here".len() as u64);
                    assert!(!m.hash.is_empty());
                }
                other => panic!("Blossom succeeded — should not chunk: {other:?}"),
            }
        })
        .await;
}

#[tokio::test]
async fn with_no_blossom_server_a_file_goes_through_the_relays() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let ports = CorePorts {
                http: Rc::new(OkHttp),
                ..CorePorts::default()
            };
            let core =
                core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            let core2 = core.clone();
            let machine_pubkey = machine.pubkey_hex.clone();
            let dispatched = tokio::task::spawn_local(async move {
                core2
                    .dispatch(Intent::SendSessionFile(SessionFileSend {
                        machine: machine_pubkey,
                        session_id: "s1".into(),
                        text: "look at this".into(),
                        data: b"%PDF-1.7 bytes".to_vec(),
                        filename: "notes.pdf".into(),
                        mime_type: "application/pdf".into(),
                    }))
                    .await;
            });

            let msg = find_command_frame(
                &mut mock,
                &phone.pubkey_hex,
                &machine,
                |m| matches!(m, PhoneToBridge::UploadFile(_)),
            )
            .await;
            dispatched.await.unwrap();

            // The HTTP port would accept an upload: only the missing
            // server keeps the file off Blossom.
            match msg {
                PhoneToBridge::UploadFile(UploadFileMsg::Chunk(m)) => {
                    assert_eq!((m.filename.as_str(), m.mime_type.as_str()), ("notes.pdf", "application/pdf"));
                    assert_eq!(m.total_chunks, 1);
                }
                other => panic!("no Blossom server is set: {other:?}"),
            }
        })
        .await;
}

#[tokio::test]
async fn sending_a_session_image_falls_back_to_chunks_when_blossom_is_unreachable() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let ports = CorePorts {
                http: Rc::new(FailHttp),
                ..CorePorts::default()
            };
            let core =
                core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();
            eose_all(&mut mock).await;
            wait_connected(&core).await;

            core.dispatch(Intent::SetBlossomServer("https://blossom.example".into())).await;

            let core2 = core.clone();
            let machine_pubkey = machine.pubkey_hex.clone();
            let dispatched = tokio::task::spawn_local(async move {
                core2
                    .dispatch(Intent::SendSessionFile(SessionFileSend {
                        machine: machine_pubkey,
                        session_id: "s1".into(),
                        text: "a caption".into(),
                        data: b"small image bytes".to_vec(),
                        filename: "photo.jpg".into(),
                        mime_type: "image/jpeg".into(),
                    }))
                    .await;
            });

            // Step through the upload's retry backoff (1 s, then 2 s)
            // on paused time; each sleep is only armed once the attempt
            // before it has failed, hence one advance per step.
            tokio::time::pause();
            for _ in 0..3 {
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                }
                tokio::time::advance(Duration::from_millis(2_100)).await;
            }
            tokio::time::resume();

            let msg = find_command_frame(
                &mut mock,
                &phone.pubkey_hex,
                &machine,
                |m| matches!(m, PhoneToBridge::UploadFile(_)),
            )
            .await;
            dispatched.await.unwrap();

            match msg {
                PhoneToBridge::UploadFile(UploadFileMsg::Chunk(m)) => {
                    assert_eq!(m.session_id, "s1");
                    assert_eq!(m.chunk_index, 0);
                    assert_eq!(m.total_chunks, 1); // well under 35 KB
                    assert_eq!(m.text, "a caption");
                }
                other => panic!("blossom is unreachable in this test: {other:?}"),
            }
        })
        .await;
}

#[tokio::test]
async fn the_connection_status_change_emits_a_state_changed_event() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![generate_keypair().pubkey_hex]);
            core.start();
            eose_all(&mut mock).await;
            wait_for(|| {
                spy.events.lock().unwrap().contains(&CoreEvent::StateChanged {
                    slice: SliceId::Connection,
                })
            })
            .await;

            let events = spy.events.lock().unwrap();
            assert!(events.contains(&CoreEvent::StateChanged {
                slice: SliceId::Connection
            }));
        })
        .await;
}

#[tokio::test]
async fn a_session_pending_message_populates_the_view_and_emits_a_state_changed_event() {
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
                r#"{"v":12,"type":"session-pending","pendingId":"p1","machine":"devbox","createdAt":"2026-01-01T00:00:00.000Z"}"#,
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
            wait_for(|| {
                spy.events.lock().unwrap().contains(&CoreEvent::StateChanged {
                    slice: SliceId::PendingSessions,
                })
            })
            .await;

            {
                let events = spy.events.lock().unwrap();
                assert!(events.contains(&CoreEvent::StateChanged {
                    slice: SliceId::PendingSessions
                }));
            }

            let view = core.pending_sessions_view().await;
            let placeholder = view.pending.get("p1").expect("placeholder in the view");
            assert_eq!(placeholder.machine_name, "devbox");
        })
        .await;
}

#[tokio::test]
async fn dismiss_pending_session_removes_it_and_emits_a_state_changed_event() {
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
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            wait_for_async(|| {
                let core = core.clone();
                async move { core.pending_sessions_view().await.pending.contains_key("p1") }
            })
            .await;
            assert!(core.pending_sessions_view().await.pending.contains_key("p1"));

            core.dispatch(Intent::DismissPendingSession {
                pending_id: "p1".into(),
            })
            .await;

            assert!(!core.pending_sessions_view().await.pending.contains_key("p1"));
            let events = spy.events.lock().unwrap();
            assert!(events.contains(&CoreEvent::StateChanged {
                slice: SliceId::PendingSessions
            }));
        })
        .await;
}

#[tokio::test]
async fn an_output_message_populates_the_transcript_view_and_emits_transcript_appended() {
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
                r#"{"v":12,"type":"output","sessionId":"s1","seq":1,"entries":[{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}]}"#,
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
            wait_for(|| {
                spy.events.lock().unwrap().contains(&CoreEvent::TranscriptAppended {
                    machine: machine.pubkey_hex.clone(),
                    session_id: "s1".to_string(),
                })
            })
            .await;

            let view = core.transcript_view(machine.pubkey_hex.clone(), "s1".to_string()).await;
            assert_eq!(view.rows.len(), 1);
            assert_eq!(view.rows[0].seq, 1);
            assert_eq!(view.sync.local_high, 1);

            let events = spy.events.lock().unwrap();
            assert!(events.contains(&CoreEvent::TranscriptAppended {
                machine: machine.pubkey_hex,
                session_id: "s1".to_string(),
            }));
        })
        .await;
}

#[tokio::test]
async fn transcript_view_of_an_unknown_session_is_the_honest_empty_default() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;

            let view = core.transcript_view("m1".to_string(), "s-never-seen".to_string()).await;
            assert!(view.rows.is_empty());
            assert!(view.have_ranges.is_empty());
            assert_eq!(view.sync.local_high, 0);
            assert!(view.sync.contiguous);
        })
        .await;
}
