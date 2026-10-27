use super::*;

/// Every command this client sends `machine` within `wait`.
async fn commands_within(
    mock: &mut MockRelay,
    payload_key: &str,
    machine: &Keypair,
    wait: Duration,
) -> Vec<PhoneToBridge> {
    let deadline = std::time::Instant::now() + wait;
    let mut sent = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        let Some(frame) = mock.frame_within(left).await else { break };
        let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(&frame) else { continue };
        if v[0] != "EVENT" {
            continue;
        }
        let Ok(ev) = serde_json::from_value::<nostr::Event>(v[1].clone()) else { continue };
        let Ok(plain) = protocol::crypto::decrypt_from(&machine.secret_key, payload_key, &ev.content) else { continue };
        if let Ok(msg) = protocol::codec::decode_phone_to_bridge(&plain) {
            sent.push(msg);
        }
    }
    sent
}

/// Every `terminal-input` this client sends `machine` within `wait`.
async fn terminal_inputs_within(
    mock: &mut MockRelay,
    payload_key: &str,
    machine: &Keypair,
    wait: Duration,
) -> Vec<protocol::commands::TerminalInputMsg> {
    commands_within(mock, payload_key, machine, wait)
        .await
        .into_iter()
        .filter_map(|m| match m {
            PhoneToBridge::TerminalInput(m) => Some(m),
            _ => None,
        })
        .collect()
}

/// The terminal on screen is what the bridge is told to send output for:
/// attaching names it in the presence, and detaching stops it. Nothing is
/// watched otherwise, so a terminal costs a backgrounded phone nothing.
#[tokio::test]
async fn the_terminal_on_screen_is_what_the_bridge_is_told() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let _ = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;

            core.dispatch(Intent::AttachTerminal { machine: machine.pubkey_hex.clone(), term: "t1".into() })
                .await;
            let sent = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert!(
                sent.iter().any(|p| p.watching_terminal.as_deref() == Some("t1")),
                "the bridge must be told which terminal is on screen: {sent:?}"
            );

            core.dispatch(Intent::DetachTerminal { machine: machine.pubkey_hex.clone() }).await;
            let sent = presences_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert!(
                sent.iter().any(|p| p.watching_terminal.is_none() && p.watching.is_none()),
                "detaching must stop the output: {sent:?}"
            );
        })
        .await;
}

/// Typing is paced by the core, not sent per keystroke: printable bytes wait
/// and go with the key a program acts on, as one sequenced command.
#[tokio::test]
async fn typing_into_a_terminal_goes_out_as_one_batched_command() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let _ = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;

            core.dispatch(Intent::AttachTerminal { machine: machine.pubkey_hex.clone(), term: "t1".into() })
                .await;
            core.dispatch(Intent::TerminalInput {
                machine: machine.pubkey_hex.clone(),
                term: "t1".into(),
                bytes: b"git che".to_vec(),
                alternate_screen: false,
            })
            .await;
            // Nothing yet: the bytes are waiting for a key a program acts on.
            assert!(terminal_inputs_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(120))
                .await
                .is_empty());

            core.dispatch(Intent::TerminalInput {
                machine: machine.pubkey_hex.clone(),
                term: "t1".into(),
                bytes: b"\t".to_vec(),
                alternate_screen: false,
            })
            .await;
            let sent = terminal_inputs_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(700)).await;
            assert_eq!(sent.len(), 1, "one command for the whole line: {sent:?}");
            assert_eq!(sent[0].seq, 1);
            assert_eq!(sent[0].data, "Z2l0IGNoZQk=", "git che plus the Tab");
        })
        .await;
}

/// A key held back for the next batch redraws the app, whose predicted echo
/// shows it at once; the send that empties the batch redraws it again.
#[tokio::test]
async fn keys_held_back_redraw_the_predicted_echo() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let spy = Rc::new(Spy::default());
            let core = core_for(&mock, &phone, Rc::clone(&spy)).await;
            core.set_machines(vec![machine.pubkey_hex.clone()]);
            core.start();

            core.dispatch(Intent::AttachTerminal { machine: machine.pubkey_hex.clone(), term: "t1".into() })
                .await;
            wait_for_async(|| {
                let core = core.clone();
                async move { core.ui_view().await.terminals.attached.is_some() }
            })
            .await;
            let ui_changes = || {
                spy.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| matches!(e, CoreEvent::StateChanged { slice: SliceId::Ui }))
                    .count()
            };
            let before = ui_changes();
            core.dispatch(Intent::TerminalInput {
                machine: machine.pubkey_hex.clone(),
                term: "t1".into(),
                bytes: b"l".to_vec(),
                alternate_screen: false,
            })
            .await;
            wait_for_async(|| {
                let core = core.clone();
                async move {
                    core.ui_view().await.terminals.attached.unwrap().waiting_input == b"l".to_vec()
                }
            })
            .await;
            assert_eq!(core.ui_view().await.terminals.attached.unwrap().waiting_input, b"l".to_vec());
            assert!(ui_changes() > before, "a held key must redraw the app");

            let before = ui_changes();
            core.dispatch(Intent::TerminalInput {
                machine: machine.pubkey_hex.clone(),
                term: "t1".into(),
                bytes: b"\r".to_vec(),
                alternate_screen: false,
            })
            .await;
            wait_for(|| ui_changes() > before).await;
            assert!(core.ui_view().await.terminals.attached.unwrap().waiting_input.is_empty());
            assert!(ui_changes() > before, "the send must clear the prediction");
        })
        .await;
}

/// Terminal output never goes through a view: it arrives as its own event,
/// already base64-decoded, with the offset it starts at.
#[tokio::test]
async fn terminal_output_reaches_the_host_on_its_own_event() {
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

            core.dispatch(Intent::AttachTerminal { machine: machine.pubkey_hex.clone(), term: "t1".into() })
                .await;
            wait_for_async(|| {
                let core = core.clone();
                async move { core.ui_view().await.terminals.attached.is_some() }
            })
            .await;

            // "hi" in base64, the shell's first output at offset 0.
            push_bridge_to_phone_event_at(
                &mock,
                &machine,
                &phone.pubkey_hex,
                "cd-1",
                &BridgeToPhone::TerminalOutput(protocol::events::TerminalOutputMsg {
                    term: "t1".into(),
                    offset: 0,
                    data: "aGk=".into(),
                    replay: None,
                }),
                LIVE_KIND,
                None,
            );
            wait_for(|| {
                spy.events.lock().unwrap().iter().any(|e| matches!(
                    e,
                    CoreEvent::TerminalOutput { term, offset: 0, bytes, .. }
                        if term == "t1" && bytes == b"hi"
                ))
            })
            .await;

            {
                let events = spy.events.lock().unwrap();
                assert!(
                    events.iter().any(|e| matches!(
                        e,
                        CoreEvent::TerminalOutput { term, offset: 0, bytes, .. }
                            if term == "t1" && bytes == b"hi"
                    )),
                    "the frame must arrive as its own event: {events:?}"
                );
            }
            let view = core.ui_view().await;
            let attached = view.terminals.attached.expect("a terminal on screen");
            assert_eq!(attached.expected_offset, 2, "the screen advanced past what it drew");
        })
        .await;
}

/// A bridge that does not advertise terminals never opens one: the command
/// would wait on an answer that never comes.
#[tokio::test]
async fn opening_a_terminal_needs_the_bridge_to_advertise_it() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let key = SessionKey { keypair: generate_keypair(), expires_at: 1_000 + 80 * 24 * 3600 };
            // `core_watched_by` registers a machine with no capabilities.
            let core = core_watched_by(&mock, &phone, &key, &machine).await;
            eose_all(&mut mock).await;
            let _ = next_command_via(&mut mock, &phone, key.pubkey_hex(), &machine).await;

            core.dispatch(Intent::OpenTerminal {
                machine: machine.pubkey_hex.clone(),
                session: None,
                cols: 80,
                rows: 24,
            })
            .await;

            assert!(core.ui_view().await.terminals.attached.is_none(), "nothing on screen");
            let sent = commands_within(&mut mock, key.pubkey_hex(), &machine, Duration::from_millis(400)).await;
            assert!(
                !sent.iter().any(|m| matches!(m, PhoneToBridge::TerminalOpen(_))),
                "no open went out: {sent:?}"
            );
        })
        .await;
}
