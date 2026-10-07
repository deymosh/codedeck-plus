use super::*;
use crate::ports::RecordingNotifier;
use crate::transport::mock::{mock_relay, MockRelay};
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
use protocol::codec::encode_bridge_to_phone;
use protocol::commands::UploadFileMsg;
use protocol::kinds::{LIVE_KIND, RESPONSE_KIND, SESSION_LIST_KIND};
use crate::stores::LAST_STORED_SEEN_KEY;
use crate::intent::SessionFileSend;
use std::sync::Mutex;
use tokio::task::LocalSet;

const SEC_PHONE: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";

#[derive(Default)]
struct Spy {
    statuses: Mutex<Vec<(ConnectionStatus, bool)>>,
    connected_relays: Mutex<Vec<Vec<String>>>,
    messages: Mutex<Vec<(String, BridgeToPhone)>>,
    failures: Mutex<Vec<ActionFailedKind>>,
    events: Mutex<Vec<CoreEvent>>,
}
impl CoreObserver for Spy {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, connected_relays: &[String]) {
        self.statuses.lock().unwrap().push((status, needs_pairing_check));
        self.connected_relays.lock().unwrap().push(connected_relays.to_vec());
    }
    fn bridge_message(&self, machine: String, msg: BridgeToPhone) {
        self.messages.lock().unwrap().push((machine, msg));
    }
    fn action_failed(&self, kind: ActionFailedKind) {
        self.failures.lock().unwrap().push(kind);
    }
    fn on_event(&self, event: CoreEvent) {
        self.events.lock().unwrap().push(event);
    }
}

struct FixedClock(RefCell<u64>);
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        *self.0.borrow()
    }
}
struct ZeroEntropy;
impl Entropy for ZeroEntropy {
    fn unit(&self) -> f64 {
        0.0
    }
}

fn fast_reconnect() -> ReconnectConfig {
    ReconnectConfig {
        base_ms: 40,
        max_ms: 120,
        jitter_fraction: 0.0,
        heartbeat_stale_after_ms: 150_000,
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(120)).await;
}

async fn core_for(mock: &MockRelay, phone: &Keypair, spy: Rc<Spy>) -> Core {
    core_for_ports(mock, phone, spy, CorePorts::default()).await
}

async fn core_for_ports(
    mock: &MockRelay,
    phone: &Keypair,
    spy: Rc<Spy>,
    ports: CorePorts,
) -> Core {
    let core = Core::spawn(
        CoreConfig {
            identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
            proxy: None,
            tor: false,
            reconnect: fast_reconnect(),
        },
        ports,
        spy,
        Rc::new(FixedClock(RefCell::new(1_000_000))),
        Rc::new(ZeroEntropy),
    )
    .await;
    // No paired machine brings a relay here; point the transport at the
    // mock the way a paired machine's relays would.
    core.set_relays(vec![mock.url.clone()]);
    core
}

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
            settle().await;
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
            settle().await;

            // The upload is still hanging, yet the loop answers at once.
            tokio::time::timeout(Duration::from_secs(1), core.machines_view())
                .await
                .expect("the loop stayed blocked behind the upload");
            assert!(!upload.is_finished(), "the intent answers only when the send ends");
            upload.abort();
        })
        .await;
}

/// Records every `set_proxy` call — used to check the HTTP port's own
/// boot-time proxy wiring, the twin of `WsConfig.proxy` above.
#[derive(Default)]
struct RecordingHttp {
    proxy_calls: RefCell<Vec<Option<String>>>,
}
impl crate::attachments::HttpFetch for RecordingHttp {
    fn put(
        &self,
        _url: &str,
        _headers: Vec<(String, String)>,
        _body: Vec<u8>,
    ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
    {
        Box::pin(async { Err("not used".to_string()) })
    }
    fn set_proxy(&self, proxy: Option<&str>) {
        self.proxy_calls.borrow_mut().push(proxy.map(str::to_string));
    }
}

#[tokio::test]
async fn spawn_applies_the_boot_time_proxy_to_the_http_port_when_tor_is_on() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let recording = Rc::new(RecordingHttp::default());
            let ports = CorePorts {
                http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                ..CorePorts::default()
            };
            let _core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: Some("127.0.0.1:9050".to_string()),
                    tor: true,
                    reconnect: fast_reconnect(),
                },
                ports,
                spy,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;

            assert_eq!(
                recording.proxy_calls.borrow().as_slice(),
                [Some("127.0.0.1:9050".to_string())]
            );
        })
        .await;
}

/// A host that starts with Tor off must not have leaked the proxy address
/// to the HTTP port at all — `tor_proxy_address` is remembered for a later
/// `Intent::SetTorEnabled(true)`, but the port itself stays direct until then.
#[tokio::test]
async fn spawn_leaves_the_http_port_direct_when_tor_is_off() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let spy = Rc::new(Spy::default());
            let recording = Rc::new(RecordingHttp::default());
            let ports = CorePorts {
                http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                ..CorePorts::default()
            };
            let _core = Core::spawn(
                CoreConfig {
                    identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
                    proxy: Some("127.0.0.1:9050".to_string()),
                    tor: false,
                    reconnect: fast_reconnect(),
                },
                ports,
                spy,
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;

            assert!(recording.proxy_calls.borrow().is_empty());
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

/// EOSE the three bridge subscriptions. All are named `cd-N` and replay
/// in non-deterministic order.
async fn eose_all(mock: &mut MockRelay) {
    let mut seen = 0;
    while seen < 3 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == "REQ" {
            let sub_id = v[1].as_str().unwrap();
            mock.push(format!(r#"["EOSE","{sub_id}"]"#));
            seen += 1;
        }
    }
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
            settle().await;

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
            settle().await;

            let before = spy.connected_relays.lock().unwrap().last().unwrap().clone();
            assert_eq!(before.len(), 2, "{before:?}");

            // Real time only, far short of the watchdog's 30 s tick.
            mock2.close();
            settle().await;

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
                r#"{"type":"input-ack","sessionId":"s1","inputId":"i1"}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

            let messages = spy.messages.lock().unwrap();
            assert_eq!(messages.len(), 1, "{messages:?}");
            assert_eq!(messages[0].0, machine.pubkey_hex);
            assert!(matches!(messages[0].1, BridgeToPhone::InputAck(_)));
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
            settle().await;

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"type":"session-failed","pendingId":"p1","reason":"boom"}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

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
                r#"{"type":"folder-ack","requestId":"req-1","success":true,"path":"sub/dir"}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

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
                r#"{"type":"input-ack","sessionId":"s1","inputId":"i1"}"#,
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
            settle().await;

            mock.close();
            settle().await;

            let statuses = spy.statuses.lock().unwrap().clone();
            assert!(
                statuses.iter().any(|(s, _)| *s == ConnectionStatus::WaitingRetry),
                "{statuses:?}"
            );
            // fast_reconnect base is 40ms — the retry has fired by now.
            assert!(
                statuses.iter().filter(|(s, _)| *s == ConnectionStatus::Connecting).count() >= 2,
                "expected a second Connecting after backoff: {statuses:?}"
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
            settle().await;

            core.stop();
            settle().await;
            mock.close();
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
            settle().await;
            assert_eq!(core.connection_status().await.0, ConnectionStatus::Connected);
            core.stop();
            settle().await;
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
            settle().await;

            // A real heartbeat from that same machine must still reach the
            // machines view — proving the subscription actually scopes to
            // it, not just that some vacuous socket opened.
            let sessions_json =
                r#"{"type":"sessions","machine":"bridge","sessions":[],"agents":[],"protocolVersion":11}"#;
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
                    .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                    .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-1",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

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
            settle().await;

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
            settle().await;

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

// --- the composed store layer ---

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
            // let the EOSEs propagate through the transport → NostrClient →
            // the FSM (a few extra spawn_local tasks now share the loop).
            let mut status = String::new();
            for _ in 0..10 {
                settle().await;
                status = core.connection_view().await.unwrap().status;
                if status == "connected" {
                    break;
                }
            }
            assert_eq!(status, "connected");
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
            settle().await;

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
            settle().await;

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
            settle().await;

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
            settle().await;

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
            settle().await;

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
            settle().await;

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
                r#"{"type":"session-pending","pendingId":"p1","machine":"devbox","createdAt":"2026-01-01T00:00:00.000Z"}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

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
                r#"{"type":"session-failed","pendingId":"p1","reason":"boom"}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;
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
                r#"{"type":"output","sessionId":"s1","seq":1,"entries":[{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}]}"#,
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
                .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
                .unwrap();
            mock.push(format!(
                r#"["EVENT","cd-3",{}]"#,
                <nostr::Event as nostr::JsonUtil>::as_json(&event)
            ));
            settle().await;

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

/// A resubscribe triggered by an authors-filter change (a new pairing
/// candidate, a freshly paired machine) re-does the phone's 3 traffic
/// filters: this drains exactly 3 REQs (skipping the CLOSE frames for the
/// superseded subs along the way) and returns one sub_id the router now
/// has open.
async fn drain_traffic_resubscribe(mock: &mut MockRelay) -> String {
    let mut seen = 0;
    let mut sub_id = String::new();
    while seen < 3 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == "REQ" {
            let id = v[1].as_str().unwrap().to_string();
            mock.push(format!(r#"["EOSE","{id}"]"#));
            sub_id = id;
            seen += 1;
        }
    }
    sub_id
}

/// Pushes one raw encrypted `machine -> phone` event through the mock
/// relay, tagged to `sub_id` — the router only delivers an `EVENT` frame
/// for a sub_id it currently has open (it doesn't check the filter), and
/// every resubscribe (a new pairing candidate, a freshly paired machine)
/// tears down the old subs and opens new ones with new ids, so the caller
/// must hand in a sub_id drained from the CURRENT `eose_all` round, not
/// one left over from an earlier one.
fn push_bridge_to_phone_event(
    mock: &MockRelay,
    machine: &protocol::crypto::Keypair,
    phone_pubkey_hex: &str,
    sub_id: &str,
    msg: &BridgeToPhone,
) {
    let plaintext = encode_bridge_to_phone(msg);
    let ct = protocol::crypto::encrypt_to(&machine.secret_key, phone_pubkey_hex, &plaintext)
        .unwrap();
    let event = nostr::EventBuilder::new(nostr::Kind::Custom(LIVE_KIND), ct)
        .sign_with_keys(&nostr::Keys::new(machine.secret_key.clone()))
        .unwrap();
    mock.push(format!(
        r#"["EVENT","{sub_id}",{}]"#,
        <nostr::Event as nostr::JsonUtil>::as_json(&event)
    ));
}

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
                    reconnect: fast_reconnect(),
                },
                CorePorts::default(),
                Rc::new(Spy::default()),
                Rc::new(FixedClock(RefCell::new(1_000_000))),
                Rc::new(ZeroEntropy),
            )
            .await;
            core.start();
            settle().await;

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
            settle().await;
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
                r#"{"type":"sessions","machine":"laptop","sessions":[
                    {"id":"s1","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                ],"agents":[],"protocolVersion":11}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
            settle().await;

            let msg = protocol::codec::decode_bridge_to_phone(
                r#"{"type":"output","sessionId":"s1","seq":1,"entries":[{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}]}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &msg);
            settle().await;

            // Sanity: the transcript is really there before forgetting the machine.
            let before = core.transcript_view(machine.pubkey_hex.clone(), "s1".to_string()).await;
            assert_eq!(before.rows.len(), 1);

            core.dispatch(Intent::RemoveMachine {
                pubkey_hex: machine.pubkey_hex.clone(),
            })
            .await;
            settle().await;

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
            settle().await;

            let sub = drain_traffic_resubscribe(&mut mock).await;
            let sessions_msg = protocol::codec::decode_bridge_to_phone(
                r#"{"type":"sessions","machine":"laptop","sessions":[
                    {"id":"s1","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                ],"agents":[],"protocolVersion":11}"#,
            )
            .unwrap();
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
            settle().await;

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
            "type": "sessions",
            "machine": "laptop",
            "sessions": sessions,
            "agents": [],
            "protocolVersion": protocol::capabilities::PROTOCOL_VERSION,
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
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let ports = CorePorts { kv: Rc::new(kv), ..CorePorts::default() };
            let core = core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
            core.start();
            eose_all(&mut mock).await;
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            let listed = heartbeat_listing(&["s1", "s2", "s3"]);
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &listed);
            settle().await;
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
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &after_first);
            settle().await;
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

            // Nothing is left to undo, and nothing is sent twice.
            core.dispatch(Intent::UndoDelete).await;
            assert!(sessions(core.machines_view().await).is_empty());
        })
        .await;
}

/// The next command EVENT the identity `phone` signed for `machine`,
/// with its payload decrypted as from `payload_key` (the phone's
/// identity or its session key). Every EVENT is ACKed on the way.
async fn next_command_via(
    mock: &mut MockRelay,
    phone: &Keypair,
    payload_key: &str,
    machine: &Keypair,
) -> Option<PhoneToBridge> {
    for _ in 0..16 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] != "EVENT" {
            continue;
        }
        mock.push(format!(r#"["OK","{}",true,""]"#, v[1]["id"].as_str().unwrap()));
        let ev: nostr::Event = serde_json::from_value(v[1].clone()).unwrap();
        assert!(ev.verify().is_ok());
        assert_eq!(ev.pubkey.to_hex(), phone.pubkey_hex, "every event is signed by the identity");
        let plaintext = protocol::crypto::decrypt_from(&machine.secret_key, payload_key, &ev.content).ok()?;
        return protocol::codec::decode_phone_to_bridge(&plaintext).ok();
    }
    None
}

fn heartbeat_with(caps: &[&str]) -> BridgeToPhone {
    protocol::codec::decode_bridge_to_phone(
        &serde_json::json!({
            "type": "sessions",
            "machine": "laptop",
            "sessions": [],
            "agents": [],
            "credentials": [],
            "protocolVersion": protocol::capabilities::PROTOCOL_VERSION,
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
            // The reconnect's refresh, under the identity.
            let refresh = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(refresh, Some(PhoneToBridge::RefreshSessions(_))), "{refresh:?}");

            // A heartbeat advertising session keys earns a grant.
            let heartbeat = heartbeat_with(&[protocol::capabilities::SESSION_KEYS]);
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat);
            let grant = match next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await {
                Some(PhoneToBridge::SessionKey(m)) => m.session_key,
                other => panic!("expected a grant, got {other:?}"),
            };
            let session = grant.pubkey_hex.clone();
            assert_ne!(session, phone.pubkey_hex);

            // Before the bridge confirms, payloads stay under the identity.
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            let cmd = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");

            // The heartbeat under the key confirms it: payloads switch.
            push_bridge_to_phone_event(&mock, &machine, &session, "cd-1", &heartbeat);
            settle().await;
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            let cmd = next_command_via(&mut mock, &phone, &session, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");

            // A later message under the identity: the bridge lost the key.
            tokio::time::sleep(Duration::from_millis(1100)).await;
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &heartbeat);
            settle().await;
            core.dispatch(Intent::Interrupt { machine: machine.pubkey_hex.clone(), session_id: "s1".into() }).await;
            let cmd = next_command_via(&mut mock, &phone, &phone.pubkey_hex, &machine).await;
            assert!(matches!(cmd, Some(PhoneToBridge::Interrupt(_))), "{cmd:?}");
        })
        .await;
}

/// A host's secret store for the session keys, in memory.
#[derive(Default, Clone)]
struct MemoryKeyStore(Rc<RefCell<Option<String>>>);
impl SessionKeyStore for MemoryKeyStore {
    fn load(&self) -> crate::ports::LocalBoxFuture<'_, Option<String>> {
        let ring = self.0.borrow().clone();
        Box::pin(async move { ring })
    }
    fn save(&self, ring: &str) -> crate::ports::LocalBoxFuture<'_, ()> {
        *self.0.borrow_mut() = Some(ring.to_string());
        Box::pin(async {})
    }
}
impl MemoryKeyStore {
    fn ring(&self) -> SessionKeyRing {
        SessionKeyRing::load(self.0.borrow().as_deref(), 1_000_000).0
    }
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
            *store.0.borrow_mut() = Some(SessionKeyRing { current: old.clone(), previous: None }.encode());
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
            assert_eq!(grant.bridge_pubkey_hex, machine.pubkey_hex);
            assert_eq!(grant.expires_at, ring.current.expires_at);

            // A heartbeat under the new key confirms it: the old one goes.
            push_bridge_to_phone_event(&mock, &machine, &new, "cd-1", &heartbeat);
            settle().await;
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
            state.machines.get_mut(&machine.pubkey_hex).unwrap().direct =
                Some(protocol::direct::DirectInfo { endpoints: vec![endpoint.clone()], cert_sha256: None });
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let push = protocol::codec::decode_bridge_to_phone(r#"{"type":"input-ack","sessionId":"s1","inputId":"i1"}"#).unwrap();
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
                "type": "sync-begin", "sessionId": "s1", "syncId": "y1", "seqHigh": 3, "ranges": [[1, 3]]
            }));
            push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, "cd-1", &begin);
            for seq in 1..=3 {
                let chunk = decode(serde_json::json!({
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
            settle().await;
            assert_eq!(signs.get(), 2, "one signature for the three chunks");
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

/// The next frame of `kind` (`REQ`, `EVENT`, …), skipping the others.
async fn next_frame_of(mock: &mut MockRelay, kind: &str) -> Vec<serde_json::Value> {
    for _ in 0..20 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == kind {
            return v;
        }
    }
    panic!("no {kind} frame");
}

/// The backup look's REQ: answered with `events` then EOSE.
async fn answer_backup_req(mock: &mut MockRelay, me: &str, events: &[serde_json::Value]) {
    loop {
        let req = next_frame_of(mock, "REQ").await;
        let sub = req[1].as_str().unwrap().to_string();
        if req[2]["#d"].is_array() {
            assert_eq!(req[2]["kinds"], serde_json::json!([30078]));
            assert_eq!(req[2]["authors"], serde_json::json!([me]));
            for e in events {
                mock.push(serde_json::json!(["EVENT", sub, e]).to_string());
            }
            mock.push(format!(r#"["EOSE","{sub}"]"#));
            return;
        }
        mock.push(format!(r#"["EOSE","{sub}"]"#));
    }
}

async fn settings_backup(core: &Core) -> crate::view::BackupView {
    core.settings_view().await.unwrap().backup
}

#[tokio::test]
async fn a_backup_saved_by_one_phone_restores_the_machines_on_another() {
    LocalSet::new()
        .run_until(async {
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let machine = generate_keypair();

            // The old phone, paired with a machine, turns the backup on.
            let mut first = mock_relay().await;
            let mut state = client_core::stores::machines::MachinesState::default();
            // Names with spaces: base64 ciphertext can never contain them by chance.
            state.register_machine(&machine.pubkey_hex, "my laptop", Some("Work lab".into()), None, &[first.url.clone()]);
            let kv = MemoryKv::seeded([(
                crate::stores::MACHINES_KEY,
                client_core::stores::machines::serialize_machines(&state.machines),
            )]);
            let old_keys = MemoryKeyStore::default();
            let ports = CorePorts { kv: Rc::new(kv), session_keys: Some(Rc::new(old_keys.clone())), ..CorePorts::default() };
            let old = core_for_ports(&first, &phone, Rc::new(Spy::default()), ports).await;
            old.start();
            old.dispatch(Intent::SetBackupRelay(first.url.clone())).await;
            // Nothing on the relay yet: this phone's is saved.
            answer_backup_req(&mut first, &phone.pubkey_hex, &[]).await;
            let event = next_frame_of(&mut first, "EVENT").await[1].clone();
            assert_eq!(event["kind"], 30078);
            let wire = event.to_string();
            let old_secret = old_keys.ring().current.keypair.secret_hex();
            assert!(!wire.contains("my laptop") && !wire.contains("Work lab") && !wire.contains(&machine.pubkey_hex));
            assert!(!wire.contains(&old_secret));
            first.push(serde_json::json!(["OK", event["id"], true, ""]).to_string());
            settle().await;
            let saved = settings_backup(&old).await;
            assert_eq!(saved.relay.as_deref(), Some(first.url.as_str()));
            assert!(saved.saved_at.is_some());

            // A fresh phone with the same identity finds it and imports it.
            let mut second = mock_relay().await;
            let new_keys = MemoryKeyStore::default();
            let ports = CorePorts { session_keys: Some(Rc::new(new_keys.clone())), ..CorePorts::default() };
            let new = core_for_ports(&second, &phone, Rc::new(Spy::default()), ports).await;
            new.start();
            assert_ne!(new_keys.ring().current.keypair.secret_hex(), old_secret);
            new.dispatch(Intent::SetBackupRelay(second.url.clone())).await;
            answer_backup_req(&mut second, &phone.pubkey_hex, &[event]).await;
            settle().await;
            assert!(matches!(settings_backup(&new).await.status, crate::backup::BackupStatus::Found { machines: 1, .. }));
            assert!(new.machines_view().await.machines.is_empty(), "nothing is imported before the user says so");

            new.dispatch(Intent::ImportBackup).await;
            let machines = new.machines_view().await.machines;
            let restored = &machines[&machine.pubkey_hex];
            assert_eq!((restored.label.as_deref(), restored.relays.clone()), (Some("Work lab"), vec![first.url.clone()]));
            // It granted nothing of its own yet, so it takes the old phone's session keys.
            assert_eq!(new_keys.ring().current.keypair.secret_hex(), old_secret);
        })
        .await;
}

#[tokio::test]
async fn a_relay_address_the_phone_may_not_dial_is_refused() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
            core.dispatch(Intent::SetBackupRelay("ws://plain.example".into())).await;
            let backup = settings_backup(&core).await;
            assert_eq!(backup.relay, None);
            assert!(matches!(backup.status, crate::backup::BackupStatus::Failed { .. }));
        })
        .await;
}
