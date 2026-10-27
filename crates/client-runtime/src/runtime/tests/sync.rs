use super::*;

/// A local identity that counts its signatures.
struct CountingSigner(crate::signer::LocalSigner, Rc<std::cell::Cell<usize>>);

impl IdentitySigner for CountingSigner {
    fn pubkey_hex(&self) -> String {
        self.0.pubkey_hex()
    }
    fn sign_event(&self, event: nostr::UnsignedEvent) -> crate::ports::LocalBoxFuture<'_, Result<nostr::Event, SignerError>> {
        self.1.set(self.1.get() + 1);
        self.0.sign_event(event)
    }
    fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> crate::ports::LocalBoxFuture<'_, Result<String, SignerError>> {
        self.0.nip44_encrypt(peer, plaintext)
    }
    fn nip44_decrypt(&self, peer: &str, ciphertext: &str) -> crate::ports::LocalBoxFuture<'_, Result<String, SignerError>> {
        self.0.nip44_decrypt(peer, ciphertext)
    }
}

/// The identity signs on its own only for a handful of things: a
/// refresh per machine on each (re)connect, the sync requests and acks
/// that follow, and relay AUTH. A sync's chunks arrive back to back; they
/// cost one signed ack, not one each.
#[tokio::test]
async fn a_burst_of_sync_chunks_costs_one_signed_ack() {
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
            let signs = Rc::new(std::cell::Cell::new(0));
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(CountingSigner(crate::signer::LocalSigner(phone.clone()), Rc::clone(&signs))),
                    proxy: None,
                    tor: false,
                    device_label: None,
                    reconnect: fast_reconnect(),
                },
                CorePorts { kv: Rc::new(kv), ..CorePorts::default() },
                Rc::new(Spy::default()),
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;
            core.set_relays(vec![mock.url.clone()]);
            core.start();
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");
            assert_eq!(signs.get(), 1, "the reconnect's refresh");

            let decode = |v: serde_json::Value| protocol::codec::decode_bridge_to_phone(&v.to_string()).unwrap();
            let entry = serde_json::json!({ "timestamp": "t", "entryType": "turn_complete" });
            let begin = decode(serde_json::json!({
                "v": 12,
                "type": "sync-begin", "sessionId": "s1", "syncId": "y1", "seqHigh": 3, "ranges": [[1, 3]]
            }));
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &begin);
            for seq in 1..=3 {
                let chunk = decode(serde_json::json!({
                    "v": 12,
                    "type": "sync-chunk", "sessionId": "s1", "syncId": "y1", "range": [seq, seq],
                    "entries": [{ "seq": seq, "entry": entry }]
                }));
                push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &chunk);
            }
            let ack = match next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await {
                Some(PhoneToBridge::SyncAck(ack)) => ack,
                other => panic!("expected a sync-ack, got {other:?}"),
            };
            assert_eq!((ack.sync_id.as_str(), ack.ranges), ("y1", vec![(1, 1), (2, 2), (3, 3)]));
            assert_eq!(signs.get(), 2, "one signature for the three chunks");
        })
        .await;
}

/// A `sync-begin` whose `sync-end` never arrives leaves the cycle in flight;
/// without a retry the session's gap would stay unfilled until the next
/// reconnect. The watchdog's tick restarts the cycle.
#[tokio::test]
async fn a_sync_cycle_that_goes_silent_is_re_requested_by_the_watchdog() {
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
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            let begin = protocol::codec::decode_bridge_to_phone(
                &serde_json::json!({
                    "v": 12,
                    "type": "sync-begin", "sessionId": "s1", "syncId": "y1", "seqHigh": 3, "ranges": [[1, 3]]
                })
                .to_string(),
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &begin);
            wait_for_async(|| {
                let core = core.clone();
                let key = machine.pubkey_hex.clone();
                async move { core.transcript_view(key, "s1".to_string()).await.sync.target == 3 }
            })
            .await;

            *clock.0.borrow_mut() +=
                client_core::stores::transcript::SYNC_STALL_MS + 1;
            core.tick();
            let request = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(
                matches!(request, Some(PhoneToBridge::SyncRequest(ref m)) if m.session_id == "s1"),
                "{request:?}"
            );
        })
        .await;
}

/// A stalled cycle must not be re-requested once the socket is gone: the
/// tick's own heartbeat check may have just moved the FSM to WaitingRetry,
/// and publishing there only burns an attempt and a signature.
#[tokio::test]
async fn a_sync_stall_is_not_re_requested_on_a_dead_connection() {
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
            let signs = Rc::new(std::cell::Cell::new(0));
            let clock = Rc::new(FixedClock(RefCell::new(1_000_000)));
            let core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(CountingSigner(
                        crate::signer::LocalSigner(phone.clone()),
                        Rc::clone(&signs),
                    )),
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
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");
            assert_eq!(signs.get(), 1, "the reconnect's refresh");

            let begin = protocol::codec::decode_bridge_to_phone(
                &serde_json::json!({
                    "v": 12,
                    "type": "sync-begin", "sessionId": "s1", "syncId": "y1", "seqHigh": 3, "ranges": [[1, 3]]
                })
                .to_string(),
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &begin);
            wait_for_async(|| {
                let core = core.clone();
                let key = machine.pubkey_hex.clone();
                async move { core.transcript_view(key, "s1".to_string()).await.sync.target == 3 }
            })
            .await;

            core.set_online(false);
            *clock.0.borrow_mut() += client_core::stores::transcript::SYNC_STALL_MS + 1;
            core.tick();
            // Nothing is published, so there is no event to wait on: give the
            // tick's spawned work a moment before asserting the absence.
            settle().await;
            assert_eq!(signs.get(), 1, "no request is published without a live connection");
        })
        .await;
}

/// Documents the JSON shape a binding receives — externally tagged,
/// camelCase, matching `Intent`'s own convention.
#[test]
fn core_event_json_shape_is_externally_tagged_camel_case() {
    assert_eq!(
        serde_json::to_value(CoreEvent::StateChanged { slice: SliceId::Machines }).unwrap(),
        serde_json::json!({ "stateChanged": { "slice": "machines" } }),
    );
    assert_eq!(
        serde_json::to_value(CoreEvent::OutboxSettled {
            id: "in-1".into(),
            delivered: true,
        })
        .unwrap(),
        serde_json::json!({ "outboxSettled": { "id": "in-1", "delivered": true } }),
    );
    assert_eq!(
        serde_json::to_value(CoreEvent::ActionFailed {
            kind: ActionFailedKind::PublishRejected,
        })
        .unwrap(),
        serde_json::json!({ "actionFailed": { "kind": "publishRejected" } }),
    );
}
