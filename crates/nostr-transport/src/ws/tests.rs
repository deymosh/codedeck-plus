use super::*;
use crate::mock::{mock_relay, MockRelay};
use crate::test_support::wait_until;
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
use nostr::JsonUtil;
use std::cell::RefCell;
use tokio::task::LocalSet;

const SEC_PHONE: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";

fn transport(mock: &MockRelay, phone: &Keypair) -> WsTransport {
    WsTransport::new(WsConfig {
        relays: vec![mock.url.clone()],
        auth: Rc::new(phone.clone()),
        proxy: None,
    })
}

#[tokio::test]
async fn dial_refuses_cleartext_to_a_public_host() {
    let err = dial("ws://relay.example.com", None).await.unwrap_err();
    assert!(err.contains("cleartext"), "{err}");
}

#[tokio::test]
async fn dial_does_not_refuse_cleartext_to_onion_on_scheme_grounds() {
    // A loopback stand-in for Tor: the proxy is asked to CONNECT to the
    // onion name (no local resolver sees it), answers success and closes,
    // so the dial fails at the WebSocket handshake — never the
    // cleartext-rejection this test exists to rule out.
    let (proxy, request) = crate::test_support::socks5_proxy().await;
    let err = dial("ws://expyuzz4wqqyqhjn.onion:7447", Some(proxy.to_string())).await.unwrap_err();
    assert!(!err.contains("cleartext"), "{err}");
    let request = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("the onion dial never reached the proxy")
        .expect("the proxy reported its CONNECT");
    assert_eq!(request.host, "expyuzz4wqqyqhjn.onion", "the proxy must resolve the onion name, not this machine");
}

#[tokio::test]
async fn dial_does_not_refuse_cleartext_to_loopback() {
    let mock = mock_relay().await;
    // A real connect+handshake against the mock relay itself, over ws://
    // 127.0.0.1 — proves loopback is genuinely usable, not just "not
    // rejected before some other failure".
    dial(&mock.url, None).await.unwrap();
}

#[test]
fn loopback_includes_the_bracketed_ipv6_form_url_gives() {
    for host in ["127.0.0.1", "::1", "[::1]", "localhost"] {
        assert!(is_loopback(host), "{host}");
    }
    assert!(!is_loopback("192.168.1.20"));
    assert!(!is_loopback("[::2]"));
}

#[tokio::test]
async fn dial_accepts_cleartext_to_bracketed_ipv6_loopback() {
    // Nothing has to listen: the cleartext guard must pass and the
    // failure must come from the connection attempt instead.
    let err = dial("ws://[::1]:1", None).await.unwrap_err();
    assert!(!err.contains("cleartext"), "{err}");
}

/// The absolute constraint this guards: with a proxy set, a relay is
/// never dialled directly, and the proxy is asked to CONNECT to the
/// relay's *name*. Resolving the name locally would break `.onion`
/// relays (only Tor can resolve them) and would leak the relay's address
/// to the local resolver besides.
#[tokio::test]
async fn a_proxied_relay_dial_asks_the_socks_proxy_for_the_relay_name_and_never_connects_directly() {
    // Stands in for the relay: it resolves from `localhost`, so a dial
    // that ignored the proxy would land here and be counted.
    let (relay, direct_connections) = crate::test_support::counting_listener().await;

    let (proxy, request) = crate::test_support::socks5_proxy().await;
    let err = match dial(&format!("ws://localhost:{}", relay.port()), Some(proxy.to_string())).await {
        Ok(_) => panic!("the proxy closes after CONNECT, so no ws handshake can complete"),
        Err(err) => err,
    };
    assert!(!err.starts_with("socks5:"), "the proxy answered, so the dial must not fail in SOCKS5: {err}");

    let request = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("the relay dial never reached the SOCKS5 proxy")
        .expect("the SOCKS5 proxy reported its CONNECT");
    assert_eq!(
        request.atyp, 3,
        "the relay host must be sent as a domain name (the proxy does the DNS lookup, which is what reaches .onion addresses), not as a locally resolved IP"
    );
    assert_eq!(request.host, "localhost", "the proxy was asked for the wrong host");
    assert_eq!(request.port, relay.port(), "the proxy was asked for the wrong port");
    assert_eq!(
        direct_connections.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the relay was dialled directly even though a proxy is set"
    );
}

#[tokio::test]
async fn set_proxy_updates_what_the_next_dial_uses_and_closes_every_live_connection() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            assert_eq!(t.current_proxy(), None);
            t.ensure_connected();

            t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            // Real handshake against the mock relay — poll rather than a
            // flat sleep so this isn't a race against however long that
            // takes on a loaded CI box.
            for _ in 0..100 {
                if !t.connected_relays().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!t.connected_relays().is_empty());

            t.set_proxy(Some("127.0.0.1:9050".to_string()));
            assert_eq!(t.current_proxy(), Some("127.0.0.1:9050".to_string()));
            // The live connection (dialled before the proxy existed) is
            // torn down — every existing socket was dialled under the OLD
            // setting, so none of them can be trusted to still be routed
            // correctly once it changes.
            for _ in 0..100 {
                if t.connected_relays().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(t.connected_relays().is_empty());

            t.set_proxy(None);
            assert_eq!(t.current_proxy(), None);
        })
        .await;
}

/// `set_relays` only touches the diff: a relay dropped from the list is
/// closed deliberately (no `on_close`) and its socket stops holding up
/// the subscriptions it carried, so EOSE the other relays already sent
/// completes them right away.
#[tokio::test]
async fn set_relays_closes_a_removed_relay_and_stops_the_sub_waiting_on_it() {
    LocalSet::new()
        .run_until(async {
            let mut a = mock_relay().await;
            let mut b = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![a.url.clone(), b.url.clone()],
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.ensure_connected();
            wait_until(|| t.connected_relays().len() == 2).await;
            let (_sub, seen) = recording_sub(&t, &phone);
            assert!(a.next_frame().await.starts_with(r#"["REQ","cd-1""#));
            assert!(b.next_frame().await.starts_with(r#"["REQ","cd-1""#));

            // B has stored everything it has, A has not: the subscription
            // is not complete while A still carries it. The barrier event
            // orders the wait behind B's EOSE.
            b.push(r#"["EOSE","cd-1"]"#.to_string());
            b.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, "barrier")));
            wait_until(|| !seen.events.borrow().is_empty()).await;
            assert_eq!(seen.eoses.get(), 0, "A has not EOSEd, so the sub must still wait on it");

            t.set_relays(std::slice::from_ref(&b.url));

            assert_eq!(t.connected_relays(), BTreeSet::from([b.url.clone()]), "the removed relay must no longer be connected");
            assert_eq!(seen.eoses.get(), 1, "with A closed, the sub is complete from B alone");
            assert_eq!(seen.closes.get(), 0, "a relay removed on purpose does not close the subscription");
            t.shutdown();
        })
        .await;
}

/// A relay added by `set_relays` is dialled and every open subscription is
/// REQ'd to it as it comes up, so it starts carrying traffic immediately.
#[tokio::test]
async fn set_relays_dials_and_subscribes_an_added_relay() {
    LocalSet::new()
        .run_until(async {
            let mut a = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&a, &phone);
            t.ensure_connected();
            let (_sub, _seen) = recording_sub(&t, &phone);
            assert!(a.next_frame().await.starts_with(r#"["REQ","cd-1""#));

            let mut c = mock_relay().await;
            t.set_relays(&[a.url.clone(), c.url.clone()]);
            wait_until(|| t.connected_relays().len() == 2).await;

            assert!(
                c.next_frame().await.starts_with(r#"["REQ","cd-1""#),
                "the added relay must be sent the open subscription's REQ"
            );
            assert!(t.connected_relays().contains(&a.url), "the unchanged relay keeps its socket");
            t.shutdown();
        })
        .await;
}

/// `subscribe_to` pins a subscription to the named relays: only they get
/// the REQ, and EOSE from one of them is enough although another relay is
/// connected and has said nothing.
#[tokio::test]
async fn subscribe_to_opens_the_subscription_only_on_the_named_relays() {
    LocalSet::new()
        .run_until(async {
            let mut a = mock_relay().await;
            let mut b = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![a.url.clone(), b.url.clone()],
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.ensure_connected();
            wait_until(|| t.connected_relays().len() == 2).await;

            let (callbacks, seen_b) = recording_callbacks();
            let _pinned = t.subscribe_to(std::slice::from_ref(&b.url), a_filter(&phone), callbacks);
            assert!(b.next_frame().await.starts_with(r#"["REQ","cd-1""#), "the named relay must carry the sub");

            // A second, ordinary subscription goes everywhere. A's first
            // frame must be ITS REQ: had cd-1 been sent to A, that would
            // have arrived first.
            let (_all, _seen_a) = recording_sub(&t, &phone);
            assert!(
                a.next_frame().await.starts_with(r#"["REQ","cd-2""#),
                "the pinned subscription must never reach an unnamed relay"
            );
            assert!(b.next_frame().await.starts_with(r#"["REQ","cd-2""#));

            // B's EOSE completes the pinned sub although A, connected and
            // REQ'd for the other sub only, never answered for this one.
            b.push(r#"["EOSE","cd-1"]"#.to_string());
            b.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, "barrier")));
            wait_until(|| !seen_b.events.borrow().is_empty()).await;
            assert_eq!(seen_b.eoses.get(), 1, "the pinned sub waits only on the relay it named");
            t.shutdown();
        })
        .await;
}

#[tokio::test]
async fn a_deliberate_shutdown_stops_reporting_the_relay_as_connected_at_once() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            wait_until(|| !t.connected_relays().is_empty()).await;

            t.shutdown();
            // No polling: the closing task never reports its own death,
            // so this must be true synchronously.
            assert!(t.connected_relays().is_empty());
        })
        .await;
}

#[tokio::test]
async fn a_superseded_dial_never_touches_its_replacement() {
    let mock = mock_relay().await;
    let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
    let t = transport(&mock, &phone);
    let url = mock.url.clone();
    // The live replacement (generation 7), already up.
    let (tx, mut rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE);
    {
        let mut st = t.state.borrow_mut();
        st.conns.insert(
            url.clone(),
            Conn { tx, stop: Rc::new(Stop::default()), heard: Rc::default(), up: true, up_since: None, generation: 7, dialed_at: SystemTime::now() },
        );
        st.router.relay_connected(&url);
    }

    // The old dial (generation 3) finishing either way is ignored.
    assert!(!t.on_relay_up(&url, 3));
    t.on_relay_dead(&url, 3, "dial failed: stale".into());
    assert!(t.state.borrow().conns.contains_key(&url));
    assert_eq!(t.connected_relays(), BTreeSet::from([url.clone()]));
    assert!(rx.try_recv().is_err(), "nothing was replayed onto the replacement");

    // Its own death still counts.
    t.on_relay_dead(&url, 7, "socket closed".into());
    assert!(!t.state.borrow().conns.contains_key(&url));
    assert!(t.connected_relays().is_empty());
}

fn fast_timing() -> Timing {
    Timing {
        ping_every: Duration::from_millis(50),
        dead_after: Duration::from_millis(300),
        dial: Duration::from_millis(300),
        dial_proxied: Duration::from_millis(300),
        write: Duration::from_millis(300),
        auth: Duration::from_millis(200),
        // Long enough that no redial lands inside these tests; the
        // redial tests set their own.
        retry_base: Duration::from_secs(30),
        retry_max: Duration::from_secs(30),
        stable_after: Duration::from_secs(60),
    }
}

fn counting_sub(t: &WsTransport, phone: &Keypair) -> (Box<dyn TransportSub>, Rc<RefCell<u32>>) {
    let closes = Rc::new(RefCell::new(0u32));
    let c = Rc::clone(&closes);
    let sub = t.subscribe(
        a_filter(phone),
        SubCallbacks {
            on_event: Rc::new(|_| {}),
            on_eose: Rc::new(|| {}),
            on_close: Rc::new(move |_| *c.borrow_mut() += 1),
        },
    );
    (sub, closes)
}

#[tokio::test]
async fn a_dial_that_never_completes_its_handshake_times_out() {
    LocalSet::new()
        .run_until(async {
            // Accepts TCP, never answers the WS handshake.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let held = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(tcp);
            });
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig { relays: vec![url], auth: Rc::new(phone), proxy: None });
            t.state.borrow_mut().timing = fast_timing();
            t.ensure_connected();
            assert_eq!(t.state.borrow().conns.len(), 1);
            // The failed dial frees the entry, so the FSM can redial.
            wait_until(|| t.state.borrow().conns.is_empty()).await;
            held.abort();
        })
        .await;
}

#[tokio::test]
async fn a_relay_that_goes_silent_is_dropped_and_reported() {
    LocalSet::new()
        .run_until(async {
            // Completes the handshake, then neither reads nor writes:
            // our pings go unanswered.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let held = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(ws);
            });
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![url],
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.state.borrow_mut().timing = fast_timing();
            t.ensure_connected();
            let (_sub, closes) = counting_sub(&t, &phone);
            wait_until(|| !t.connected_relays().is_empty()).await;

            wait_until(|| t.connected_relays().is_empty()).await;
            assert!(t.state.borrow().conns.is_empty());
            assert_eq!(*closes.borrow(), 1);
            held.abort();
        })
        .await;
}

#[tokio::test]
async fn a_full_outbound_queue_stops_the_connection_as_a_failure() {
    let (tx, _rx) = mpsc::channel::<Message>(1);
    let conn = Conn { tx, stop: Rc::new(Stop::default()), heard: Rc::default(), up: true, up_since: None, generation: 1, dialed_at: SystemTime::now() };
    conn.send("first".into());
    assert_eq!(conn.stop.reason.get(), None);
    conn.send("second".into());
    assert_eq!(conn.stop.reason.get(), Some(StopReason::Overflow));
    // A teardown still wins over a pending overflow: no on_close then.
    conn.close();
    assert_eq!(conn.stop.wait().await, StopReason::Deliberate);
}

#[tokio::test]
async fn a_teardown_while_dialing_abandons_the_dial() {
    LocalSet::new()
        .run_until(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let held = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(tcp);
            });
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![url],
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.ensure_connected();
            let (_sub, closes) = counting_sub(&t, &phone);
            tokio::time::sleep(Duration::from_millis(50)).await;
            t.shutdown();
            // The abandoned dial is gone and never reports a close.
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert_eq!(*closes.borrow(), 0);
            assert!(t.state.borrow().conns.is_empty());
            held.abort();
        })
        .await;
}

fn a_filter(phone: &Keypair) -> Filter {
    Filter {
        kinds: vec![24515],
        authors: vec!["a".repeat(64)],
        p_tags: vec![phone.pubkey_hex.clone()],
        d_tags: vec![],
        c_tags: vec![],
        since: None,
    }
}

fn signed_note(kind: u16, content: &str) -> String {
    let k = generate_keypair();
    nostr::EventBuilder::new(nostr::Kind::Custom(kind), content)
        .sign_with_keys(&nostr::Keys::new(k.secret_key.clone()))
        .unwrap()
        .as_json()
}

#[tokio::test]
async fn subscribe_sends_req_then_delivers_events_and_eose() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();

            let events: Rc<RefCell<Vec<NostrEvent>>> = Rc::new(RefCell::new(vec![]));
            let eosed = Rc::new(RefCell::new(false));
            let (ev_c, eo_c) = (Rc::clone(&events), Rc::clone(&eosed));
            let sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(move |ev| ev_c.borrow_mut().push(ev.clone())),
                    on_eose: Rc::new(move || *eo_c.borrow_mut() = true),
                    on_close: Rc::new(|_| {}),
                },
            );

            let req = mock.next_frame().await;
            assert!(req.starts_with(r#"["REQ","cd-1",{"#), "got {req}");
            assert!(req.contains("\"#p\":["), "filter carries #p: {req}");

            mock.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, "hi")));
            mock.push(r#"["EOSE","cd-1"]"#.to_string());
            wait_until(|| events.borrow().len() == 1 && *eosed.borrow()).await;

            assert_eq!(events.borrow().len(), 1);
            assert_eq!(events.borrow()[0].kind, 24515);
            assert!(*eosed.borrow());
            drop(sub);
        })
        .await;
}

#[tokio::test]
async fn answers_nip42_auth_with_an_identity_signed_event() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            let _sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            let _req = mock.next_frame().await;

            mock.push(r#"["AUTH","chal-42"]"#.to_string());
            let auth = mock.next_frame().await;
            let v: Vec<Value> = serde_json::from_str(&auth).unwrap();
            assert_eq!(v[0], "AUTH");
            assert_eq!(v[1]["kind"], 22242);
            assert_eq!(v[1]["pubkey"], phone.pubkey_hex);
            assert!(v[1]["tags"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tag| tag[0] == "challenge" && tag[1] == "chal-42"));
        })
        .await;
}

/// A signer that answers only after a while (an app on the phone).
struct SlowSigner(Keypair);
impl AuthSigner for SlowSigner {
    fn sign_auth(
        &self,
        relay: &str,
        challenge: &str,
        now_ms: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SignedEvent, String>> + '_>> {
        let (relay, challenge) = (relay.to_string(), challenge.to_string());
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.0.sign_auth(&relay, &challenge, now_ms).await
        })
    }
}

/// A signer whose first attempt fails (the user dismissed the prompt),
/// then signs. The failure is local: no AUTH frame is sent.
struct FlakySigner {
    key: Keypair,
    attempts: Cell<u32>,
}
impl AuthSigner for FlakySigner {
    fn sign_auth(
        &self,
        relay: &str,
        challenge: &str,
        now_ms: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SignedEvent, String>> + '_>> {
        let attempt = self.attempts.get();
        self.attempts.set(attempt + 1);
        let (relay, challenge) = (relay.to_string(), challenge.to_string());
        let key = self.key.clone();
        Box::pin(async move {
            if attempt == 0 {
                return Err("the user dismissed the prompt".to_string());
            }
            key.sign_auth(&relay, &challenge, now_ms).await
        })
    }
}

#[tokio::test]
async fn a_failed_auth_signature_releases_the_sub_and_a_new_challenge_retries() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![mock.url.clone()],
                auth: Rc::new(FlakySigner { key: phone.clone(), attempts: Cell::new(0) }),
                proxy: None,
            });
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            let _req = mock.next_frame().await;

            // The relay challenges, the signer fails (no AUTH frame), and
            // the relay refuses the REQ for auth: the sub must not wait on
            // an answer that will never come.
            mock.push(r#"["AUTH","chal-1"]"#.to_string());
            mock.push(r#"["CLOSED","cd-1","auth-required: sign in"]"#.to_string());
            wait_until(|| seen.closes.get() == 1).await;
            assert_eq!(seen.eoses.get(), 0);

            // A fresh challenge on the same connection is tried again.
            mock.push(r#"["AUTH","chal-2"]"#.to_string());
            let auth = mock.next_frame().await;
            assert!(auth.starts_with(r#"["AUTH","#), "{auth}");
            let v: Vec<Value> = serde_json::from_str(&auth).unwrap();
            assert!(v[1]["tags"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tag| tag[0] == "challenge" && tag[1] == "chal-2"));
            t.shutdown();
        })
        .await;
}

#[tokio::test]
async fn a_slow_auth_signer_still_answers_the_challenge() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![mock.url.clone()],
                auth: Rc::new(SlowSigner(phone.clone())),
                proxy: None,
            });
            t.ensure_connected();
            let _sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            let _req = mock.next_frame().await;
            mock.push(r#"["AUTH","chal-slow"]"#.to_string());
            let auth = mock.next_frame().await;
            let v: Vec<Value> = serde_json::from_str(&auth).unwrap();
            assert_eq!((v[0].as_str(), v[1]["pubkey"].as_str()), (Some("AUTH"), Some(phone.pubkey_hex.as_str())));
        })
        .await;
}

#[tokio::test]
async fn publish_confirmed_maps_the_relay_ok_verdict() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            // force the dial to complete
            let _sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            let _req = mock.next_frame().await;

            // Any signed event: the transport never looks inside it.
            let keys = nostr::Keys::new(phone.secret_key.clone());
            let signed = nostr::EventBuilder::new(nostr::Kind::Custom(4515), "payload")
                .sign_with_keys(&keys)
                .unwrap();
            let event = SignedEvent::from_nostr(&signed);

            let pt = t.clone();
            let handle = tokio::task::spawn_local(async move {
                pt.publish_confirmed(&event, Duration::from_secs(3), 3).await
            });

            let sent = mock.next_frame().await;
            let v: Vec<Value> = serde_json::from_str(&sent).unwrap();
            assert_eq!(v[0], "EVENT");
            let id = v[1]["id"].as_str().unwrap().to_string();
            mock.push(format!(r#"["OK","{id}",false,"blocked: not allowed"]"#));

            let result = handle.await.unwrap();
            assert_eq!(result.verdict, PublishVerdict::Rejected);
        })
        .await;
}

#[tokio::test]
async fn a_targeted_publish_skips_connected_relays_outside_its_list() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            let _sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            let _req = mock.next_frame().await;

            let keys = nostr::Keys::new(phone.secret_key.clone());
            let signed = nostr::EventBuilder::new(nostr::Kind::Custom(4515), "payload")
                .sign_with_keys(&keys)
                .unwrap();
            let event = SignedEvent::from_nostr(&signed);

            let elsewhere = vec!["wss://another-machine.example".to_string()];
            let result = t.publish_confirmed_to(&event, &elsewhere, Duration::from_secs(1), 1).await;
            assert_eq!(result.verdict, PublishVerdict::Unreachable);
            assert_eq!(mock.frame_within(Duration::from_millis(200)).await, None, "nothing sent to the connected relay");

            let here = vec![mock.url.clone()];
            let pt = t.clone();
            let handle = tokio::task::spawn_local(async move {
                pt.publish_confirmed_to(&event, &here, Duration::from_secs(3), 1).await
            });
            let sent = mock.next_frame().await;
            let v: Vec<Value> = serde_json::from_str(&sent).unwrap();
            assert_eq!(v[0], "EVENT");
            let id = v[1]["id"].as_str().unwrap().to_string();
            mock.push(format!(r#"["OK","{id}",true,""]"#));
            assert_eq!(handle.await.unwrap().verdict, PublishVerdict::Accepted);
        })
        .await;
}

#[tokio::test]
async fn a_socket_drop_fires_on_close_once() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();

            let closes = Rc::new(RefCell::new(0u32));
            let c = Rc::clone(&closes);
            let _sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(|_| {}),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(move |_| *c.borrow_mut() += 1),
                },
            );
            let _req = mock.next_frame().await;

            mock.close();
            wait_until(|| *closes.borrow() == 1).await;
            assert_eq!(*closes.borrow(), 1);
        })
        .await;
}

#[tokio::test]
async fn dropping_a_sub_sends_close_and_silences_it() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();

            let events: Rc<RefCell<Vec<NostrEvent>>> = Rc::new(RefCell::new(vec![]));
            let ev_c = Rc::clone(&events);
            let sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(move |ev| ev_c.borrow_mut().push(ev.clone())),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            let _req = mock.next_frame().await;

            // A second, live subscription is the barrier that proves the
            // late frame was handled: frames arrive over one socket in
            // order, so its delivery follows the dropped one.
            let live: Rc<RefCell<Vec<NostrEvent>>> = Rc::new(RefCell::new(vec![]));
            let live_c = Rc::clone(&live);
            let _live_sub = t.subscribe(
                a_filter(&phone),
                SubCallbacks {
                    on_event: Rc::new(move |ev| live_c.borrow_mut().push(ev.clone())),
                    on_eose: Rc::new(|| {}),
                    on_close: Rc::new(|_| {}),
                },
            );
            assert!(mock.next_frame().await.starts_with(r#"["REQ","cd-2","#));

            sub.close();
            assert_eq!(mock.next_frame().await, r#"["CLOSE","cd-1"]"#);

            // A late EVENT for the dropped sub must not reach its callback,
            // while the next one for the live sub still does.
            mock.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, "late")));
            mock.push(format!(r#"["EVENT","cd-2",{}]"#, signed_note(24515, "live")));
            wait_until(|| live.borrow().len() == 1).await;
            assert!(events.borrow().is_empty());
        })
        .await;
}

fn quick_redial(t: &WsTransport) {
    t.state.borrow_mut().timing = Timing {
        retry_base: Duration::from_millis(40),
        retry_max: Duration::from_millis(80),
        ..TIMING
    };
}

/// Records every callback of one subscription.
#[derive(Default)]
struct Seen {
    events: RefCell<Vec<String>>,
    eoses: Cell<u32>,
    closes: Cell<u32>,
}

fn recording_callbacks() -> (SubCallbacks, Rc<Seen>) {
    let seen = Rc::new(Seen::default());
    let (a, b, c) = (Rc::clone(&seen), Rc::clone(&seen), Rc::clone(&seen));
    let callbacks = SubCallbacks {
        on_event: Rc::new(move |ev| a.events.borrow_mut().push(ev.id.clone())),
        on_eose: Rc::new(move || b.eoses.set(b.eoses.get() + 1)),
        on_close: Rc::new(move |_| c.closes.set(c.closes.get() + 1)),
    };
    (callbacks, seen)
}

fn recording_sub(t: &WsTransport, phone: &Keypair) -> (Box<dyn TransportSub>, Rc<Seen>) {
    let (callbacks, seen) = recording_callbacks();
    (t.subscribe(a_filter(phone), callbacks), seen)
}

#[tokio::test]
async fn check_liveness_keeps_relays_that_answer_and_drops_silent_ones() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            // Completes the handshake, then never reads: no Pong.
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let silent = format!("ws://{}", listener.local_addr().unwrap());
            let held = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(ws);
            });
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: vec![mock.url.clone(), silent.clone()],
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            let _req = mock.next_frame().await;
            wait_until(|| t.connected_relays().len() == 2).await;

            assert_eq!(t.check_liveness(Duration::from_millis(300)).await, 1);
            wait_until(|| t.connected_relays().len() == 1).await;
            assert!(t.connected_relays().contains(&mock.url));
            assert_eq!(seen.closes.get(), 0, "the answering relay still carries the sub");
            t.shutdown();
            held.abort();
        })
        .await;
}

#[tokio::test]
async fn the_ping_interval_sets_the_silence_deadline() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            t.set_ping_interval(Duration::from_secs(150));
            let timing = t.state.borrow().timing;
            assert_eq!((timing.ping_every, timing.dead_after), (Duration::from_secs(150), Duration::from_secs(315)));
            assert!(t.state.borrow().pinger.is_some());
            t.shutdown();
            assert!(t.state.borrow().pinger.is_none());
            assert_eq!(DEAD_AFTER, Duration::from_secs(75));
        })
        .await;
}

#[test]
fn the_redial_delay_grows_per_failure_up_to_the_cap() {
    let delay = |attempt| TIMING.retry_delay(attempt, "wss://r.example");
    // Each step doubles until the cap, and jitter stays in a step's upper
    // half, so consecutive steps keep rising while there is room to double.
    let mut previous = Duration::ZERO;
    for attempt in 1..=8 {
        let d = delay(attempt);
        assert!(d >= previous, "attempt {attempt}: {d:?} below the previous step {previous:?}");
        previous = d;
    }
    // Past that the cap holds, and jitter never takes a delay below the
    // first step's floor — a failing relay is never hammered.
    for attempt in 1..=30 {
        let d = delay(attempt);
        assert!(d <= RETRY_MAX, "attempt {attempt}: {d:?} past the cap");
        assert!(d >= RETRY_BASE / 2, "attempt {attempt}: {d:?} below the first step's floor");
    }
    assert!(delay(30) >= RETRY_MAX / 2, "the delay settles within the cap's jitter band");
}

#[tokio::test]
async fn a_failed_relay_is_redialled_on_its_own_and_gets_its_reqs_back() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            quick_redial(&t);
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            assert!(mock.next_frame().await.starts_with(r#"["REQ","cd-1""#));

            mock.close();
            // No ensure_connected from anyone: the transport comes back
            // by itself and replays the REQ on the new socket.
            assert!(mock.next_frame().await.starts_with(r#"["REQ","cd-1""#));
            wait_until(|| !t.connected_relays().is_empty()).await;
            assert_eq!(seen.closes.get(), 1);
        })
        .await;
}

#[tokio::test]
async fn shutdown_cancels_a_pending_redial() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.state.borrow_mut().timing = Timing { retry_base: Duration::from_millis(150), ..TIMING };
            t.ensure_connected();
            let (_sub, _seen) = recording_sub(&t, &phone);
            let _req = mock.next_frame().await;
            mock.close();
            wait_until(|| !t.state.borrow().retries.is_empty()).await;

            t.shutdown();
            assert!(t.state.borrow().retries.is_empty());
            assert_eq!(mock.frame_within(Duration::from_millis(400)).await, None, "no redial after shutdown");
            assert!(t.state.borrow().conns.is_empty());
        })
        .await;
}

/// A listener that accepts TCP and never answers the WS handshake,
/// counting the dials that reach it.
async fn hanging_relay() -> (String, Rc<Cell<u32>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let accepted = Rc::new(Cell::new(0));
    let count = Rc::clone(&accepted);
    let held = tokio::task::spawn_local(async move {
        let mut held = Vec::new();
        while let Ok((tcp, _)) = listener.accept().await {
            count.set(count.get() + 1);
            held.push(tcp);
        }
    });
    (url, accepted, held)
}

fn generation_of(t: &WsTransport, relay: &str) -> Option<u64> {
    t.state.borrow().conns.get(relay).map(|c| c.generation)
}

#[tokio::test]
async fn retry_now_abandons_a_hanging_dial_and_restarts_the_backoff() {
    LocalSet::new()
        .run_until(async {
            let (url, accepted, held) = hanging_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig { relays: vec![url.clone()], auth: Rc::new(phone), proxy: None });
            // Not active yet: nothing to retry.
            t.retry_now();
            assert!(t.state.borrow().conns.is_empty());

            t.ensure_connected();
            wait_until(|| accepted.get() == 1).await;
            let first = generation_of(&t, &url).unwrap();
            t.state.borrow_mut().retries.insert(url.clone(), Retry { attempt: 9, ..Retry::default() });

            t.retry_now();
            wait_until(|| accepted.get() == 2).await;
            assert!(generation_of(&t, &url).unwrap() > first);
            assert!(t.state.borrow().retries.is_empty(), "the backoff starts over");
            held.abort();
        })
        .await;
}

#[tokio::test]
async fn retry_now_leaves_a_live_socket_alone() {
    LocalSet::new()
        .run_until(async {
            let mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            wait_until(|| !t.connected_relays().is_empty()).await;
            let live = generation_of(&t, &mock.url);

            t.retry_now();
            assert_eq!(generation_of(&t, &mock.url), live);
            assert!(!t.connected_relays().is_empty());
        })
        .await;
}

#[tokio::test]
async fn catch_up_redials_what_is_overdue_by_the_wall_clock() {
    LocalSet::new()
        .run_until(async {
            let (url, accepted, held) = hanging_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig { relays: vec![url.clone()], auth: Rc::new(phone), proxy: None });
            t.ensure_connected();
            wait_until(|| accepted.get() == 1).await;
            let first = generation_of(&t, &url).unwrap();

            // Still within its deadline: left to run.
            t.catch_up();
            assert_eq!(generation_of(&t, &url), Some(first));

            // The device slept through the deadline.
            t.state.borrow_mut().conns.get_mut(&url).unwrap().dialed_at -= DIAL_TIMEOUT;
            t.catch_up();
            wait_until(|| accepted.get() == 2).await;
            let second = generation_of(&t, &url).unwrap();
            assert!(second > first);

            // A redial whose delay passed while asleep is dialled now; one
            // still pending by the wall clock waits.
            t.state.borrow_mut().conns.remove(&url);
            let future = SystemTime::now() + Duration::from_secs(600);
            t.state.borrow_mut().retries.insert(url.clone(), Retry { attempt: 3, timer: None, due_at: Some(future) });
            t.catch_up();
            assert!(generation_of(&t, &url).is_none());
            t.state.borrow_mut().retries.get_mut(&url).unwrap().due_at = Some(SystemTime::now() - Duration::from_secs(1));
            t.catch_up();
            wait_until(|| accepted.get() == 3).await;
            assert!(generation_of(&t, &url).unwrap() > second);
            assert_eq!(t.state.borrow().retries[&url].attempt, 3, "a caught-up redial keeps its backoff");
            held.abort();
        })
        .await;
}

#[tokio::test]
async fn twenty_relays_deliver_each_event_once_and_close_only_when_all_are_gone() {
    LocalSet::new()
        .run_until(async {
            let mut mocks = Vec::new();
            for _ in 0..20 {
                mocks.push(mock_relay().await);
            }
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = WsTransport::new(WsConfig {
                relays: mocks.iter().map(|m| m.url.clone()).collect(),
                auth: Rc::new(phone.clone()),
                proxy: None,
            });
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            for m in &mut mocks {
                assert!(m.next_frame().await.starts_with(r#"["REQ","cd-1""#));
            }
            assert_eq!(t.connected_relays().len(), 20);

            // Every relay has the same stored event: one delivery.
            let note = signed_note(24515, "stored");
            for m in &mocks {
                m.push(format!(r#"["EVENT","cd-1",{note}]"#));
            }
            for (i, m) in mocks.iter().enumerate() {
                assert_eq!(seen.eoses.get(), 0, "EOSE before relay {i} sent its own");
                m.push(r#"["EOSE","cd-1"]"#.to_string());
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            wait_until(|| seen.eoses.get() == 1).await;
            assert_eq!(seen.events.borrow().len(), 1);

            // A second event, live, from a few relays: still one. Each of
            // those relays also sends a distinct barrier event after it;
            // once every barrier is delivered, every copy of the live
            // event has been through dedup too.
            let live = signed_note(24515, "live");
            let live_id = serde_json::from_str::<Value>(&live).unwrap()["id"].as_str().unwrap().to_string();
            for (i, m) in mocks.iter().enumerate().take(5) {
                m.push(format!(r#"["EVENT","cd-1",{live}]"#));
                m.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, &format!("barrier {i}"))));
            }
            wait_until(|| seen.events.borrow().len() == 7).await;
            assert_eq!(
                seen.events.borrow().iter().filter(|id| **id == live_id).count(),
                1,
                "the live event was delivered more than once: {:?}",
                seen.events.borrow()
            );

            // Nineteen relays dropping is not a close; the last one is.
            for m in &mocks[..19] {
                m.close();
            }
            wait_until(|| t.connected_relays().len() == 1).await;
            assert_eq!(seen.closes.get(), 0);
            mocks[19].close();
            wait_until(|| seen.closes.get() == 1).await;
            t.shutdown();
        })
        .await;
}

#[tokio::test]
async fn a_req_refused_for_auth_is_resent_only_after_the_auth_ok() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            let _req = mock.next_frame().await;

            mock.push(r#"["AUTH","chal"]"#.to_string());
            let auth: Vec<Value> = serde_json::from_str(&mock.next_frame().await).unwrap();
            let auth_id = auth[1]["id"].as_str().unwrap().to_string();
            mock.push(r#"["CLOSED","cd-1","auth-required: sign in first"]"#.to_string());
            assert_eq!(mock.frame_within(Duration::from_millis(200)).await, None, "the REQ waits for the AUTH OK");

            mock.push(format!(r#"["OK","{auth_id}",true,""]"#));
            assert!(mock.next_frame().await.starts_with(r#"["REQ","cd-1""#));

            // A second refusal after AUTH is final: no REQ/CLOSED loop.
            mock.push(r#"["CLOSED","cd-1","auth-required: still no"]"#.to_string());
            assert_eq!(mock.frame_within(Duration::from_millis(200)).await, None);
            assert_eq!(seen.closes.get(), 1);
        })
        .await;
}

#[tokio::test]
async fn a_publish_refused_for_auth_is_accepted_after_the_auth_ok() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            wait_until(|| !t.connected_relays().is_empty()).await;
            mock.push(r#"["AUTH","chal"]"#.to_string());
            let auth: Vec<Value> = serde_json::from_str(&mock.next_frame().await).unwrap();
            let auth_id = auth[1]["id"].as_str().unwrap().to_string();

            let keys = nostr::Keys::new(phone.secret_key.clone());
            let signed = nostr::EventBuilder::new(nostr::Kind::Custom(4515), "payload")
                .sign_with_keys(&keys)
                .unwrap();
            let event = SignedEvent::from_nostr(&signed);
            let pt = t.clone();
            let handle = tokio::task::spawn_local(async move {
                pt.publish_confirmed(&event, Duration::from_secs(3), 1).await
            });

            let first = mock.next_frame().await;
            let id = serde_json::from_str::<Vec<Value>>(&first).unwrap()[1]["id"].as_str().unwrap().to_string();
            mock.push(format!(r#"["OK","{id}",false,"auth-required: who are you"]"#));
            mock.push(format!(r#"["OK","{auth_id}",true,""]"#));
            assert_eq!(mock.next_frame().await, first, "the same event, re-sent");
            mock.push(format!(r#"["OK","{id}",true,""]"#));
            assert_eq!(handle.await.unwrap().verdict, PublishVerdict::Accepted);
        })
        .await;
}

#[tokio::test]
async fn a_repeated_auth_challenge_costs_one_identity_signature() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.ensure_connected();
            wait_until(|| !t.connected_relays().is_empty()).await;

            mock.push(r#"["AUTH","chal-1"]"#.to_string());
            let first = mock.next_frame().await;
            assert!(first.starts_with(r#"["AUTH","#), "{first}");

            for challenge in ["chal-2", "chal-3"] {
                mock.push(format!(r#"["AUTH","{challenge}"]"#));
            }
            assert_eq!(
                mock.frame_within(Duration::from_millis(300)).await,
                None,
                "a repeated challenge must not be signed again"
            );
            t.shutdown();
        })
        .await;
}

#[tokio::test]
async fn a_relay_that_never_answers_our_auth_releases_the_sub_at_its_deadline() {
    LocalSet::new()
        .run_until(async {
            let mut mock = mock_relay().await;
            let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
            let t = transport(&mock, &phone);
            t.state.borrow_mut().timing = fast_timing();
            t.ensure_connected();
            let (_sub, seen) = recording_sub(&t, &phone);
            let _req = mock.next_frame().await;

            mock.push(r#"["AUTH","chal"]"#.to_string());
            let auth = mock.next_frame().await;
            assert!(auth.starts_with(r#"["AUTH","#), "{auth}");
            // The relay refuses the REQ for auth and then never answers the
            // AUTH it asked for: the sub must not stay parked on it.
            mock.push(r#"["CLOSED","cd-1","auth-required: sign in"]"#.to_string());

            wait_until(|| seen.closes.get() == 1).await;
            assert_eq!(seen.eoses.get(), 0);
            t.shutdown();
        })
        .await;
}
