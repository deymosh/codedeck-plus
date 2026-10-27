use super::*;

/// A bridge's direct link, scripted: it takes the phone's HELLO, pushes
/// `push` (a message for the phone), then answers every command with an
/// `OK` and hands it to `commands`.
async fn scripted_direct_bridge(
    listener: tokio::net::TcpListener,
    machine: Keypair,
    phone_pubkey: String,
    push: BridgeToPhone,
    commands: mpsc::UnboundedSender<PhoneToBridge>,
) {
    use futures_util::{SinkExt, StreamExt};
    use protocol::direct::{check_direct_auth, decode_direct_frame, encode_direct_frame, DirectFrame};
    use tokio_tungstenite::tungstenite::Message;
    let (tcp, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
    let text = |f: &DirectFrame| Message::Text(encode_direct_frame(f));
    ws.send(text(&DirectFrame::Challenge("c1".into()))).await.unwrap();
    let hello = loop {
        if let Some(Ok(Message::Text(t))) = ws.next().await {
            break decode_direct_frame(&t).unwrap();
        }
    };
    let DirectFrame::Hello { auth, .. } = hello else { panic!("expected HELLO") };
    assert_eq!(check_direct_auth(&auth, "c1", auth.created_at).unwrap(), phone_pubkey, "signed by the identity");
    ws.send(text(&DirectFrame::Ready)).await.unwrap();

    let ct = protocol::crypto::encrypt_to(&machine.secret_key, &phone_pubkey, &encode_bridge_to_phone(&push)).unwrap();
    let event = nostr::EventBuilder::new(nostr::Kind::Custom(LIVE_KIND), ct)
                .tag(recipient(&machine, &phone_pubkey))
        .tag(nostr::Tag::public_key(nostr::PublicKey::from_hex(&phone_pubkey).unwrap()))
        .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
        .unwrap();
    ws.send(text(&DirectFrame::Event(SignedEvent::from_nostr(&event)))).await.unwrap();

    loop {
        if let Some(Ok(Message::Text(t))) = ws.next().await {
            if let Ok(DirectFrame::Event(command)) = decode_direct_frame(&t) {
                ws.send(text(&DirectFrame::Ok { id: command.id.clone(), accepted: true, message: String::new() })).await.unwrap();
                let plaintext = protocol::crypto::decrypt_from(&machine.secret_key, &phone_pubkey, &command.content).unwrap();
                let _ = commands.send(protocol::codec::decode_phone_to_bridge(&plaintext).unwrap());
            }
        }
    }
}

/// A bridge that advertises a direct endpoint gets a link: its messages
/// arrive over it, the machines view says so, and commands go over it.
#[tokio::test]
async fn a_direct_link_carries_messages_and_commands() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("ws://{}", listener.local_addr().unwrap());
            let mut state = client_core::stores::machines::MachinesState::default();
            state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
            heard_without_session_keys(&mut state, &machine.pubkey_hex);
            state.machines.get_mut(&machine.pubkey_hex).unwrap().direct =
                Some(protocol::direct::DirectInfo { endpoints: vec![endpoint.clone()], cert_sha256: None });
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let push = protocol::codec::decode_bridge_to_phone(r#"{"v":12,"type":"input-ack","sessionId":"s1","inputId":"i1"}"#).unwrap();
            let (commands_tx, mut commands) = mpsc::unbounded_channel();
            tokio::task::spawn_local(scripted_direct_bridge(
                listener,
                machine.clone(),
                phone.pubkey_hex.clone(),
                push,
                commands_tx,
            ));

            let spy = Rc::new(Spy::default());
            let core = core_for_ports(&mock, &phone, Rc::clone(&spy), CorePorts { kv: Rc::new(kv), ..CorePorts::default() }).await;
            core.start();
            eose_all(&mut mock).await;
            for _ in 0..100 {
                if spy.messages.lock().unwrap().iter().any(|(_, m)| matches!(m, BridgeToPhone::InputAck(_))) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(
                spy.messages.lock().unwrap().iter().any(|(m, msg)| *m == machine.pubkey_hex && matches!(msg, BridgeToPhone::InputAck(_))),
                "the pushed message arrived over the link"
            );
            assert_eq!(core.machines_view().await.direct_up.get(&machine.pubkey_hex), Some(&endpoint));

            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            // Other commands (the session-key grant) may come first.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match commands.recv().await {
                        Some(PhoneToBridge::Interrupt(_)) => break,
                        Some(_) => {}
                        None => panic!("the link closed"),
                    }
                }
            })
            .await
            .expect("the interrupt went over the link in time");
        })
        .await;
}
