//! `WsTransport` — the real [`Transport`] over WebSockets: one connect + read
//! task per relay, wired through the pure [`frames`](super::frames) codec and
//! [`router`](super::router).
//!
//! Single-threaded by construction. The [`SubCallbacks`] closures
//! `nostr_client` hands us are `!Send`, so the whole transport runs on a
//! current-thread runtime inside a `LocalSet` (the FG service's client thread);
//! every task is `spawn_local`. This mirrors the TS `this`-bound model exactly.
//!
//! What lives here and NOT in a relay-pool crate (see docs/CLIENT-CORE.md):
//! * **no auto-reconnect** — a dead socket surfaces as ONE `on_close`; the
//!   connection FSM owns backoff and calls [`WsTransport::ensure_connected`].
//! * **ping liveness** — a socket with no traffic for [`DEAD_AFTER`] is dropped
//!   so a silently-rotted relay is detected, not trusted.
//! * **NIP-42 AUTH** answered with the identity key; a `CLOSED: auth-required`
//!   re-sends that subscription's REQ once AUTH is in.
//! * **`publish_confirmed`** keeps the CDX-086 four-way verdict end to end.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::time::Duration;

use client_core::bridge_api::{PublishResult, PublishVerdict};
use protocol::crypto::Keypair;
use protocol::nip42::build_auth_event;
use protocol::nostr_event::SignedEvent;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_socks::tcp::Socks5Stream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_util::either::Either;
use nostr::JsonUtil;
use url::Url;

use super::frames::{self, RelayMessage};
use super::router::{Router, RouterAction};
use crate::nostr_client::{Filter, NostrEvent, SubCallbacks, Transport, TransportSub};

/// Send a WS Ping this often.
const PING_EVERY: Duration = Duration::from_secs(30);
/// Drop a connection with no inbound traffic (frame or Pong) for this long —
/// the `enablePing` intent: a rotted socket is detected, not trusted.
const DEAD_AFTER: Duration = Duration::from_secs(75);
/// Default wall-clock budget for one `publish_confirmed` (under the outbox
/// sweep's confirm timeout, CDX-086).
pub const PUBLISH_CONFIRM_BUDGET: Duration = Duration::from_secs(12);
/// Max publishes of the SAME signed event within the budget.
pub const PUBLISH_CONFIRM_ATTEMPTS: u32 = 3;

type RelayStream =
    tokio_tungstenite::WebSocketStream<MaybeTlsStream<Either<TcpStream, Socks5Stream<TcpStream>>>>;

type OnEvent = Rc<dyn Fn(&NostrEvent)>;
type OnEose = Rc<dyn Fn()>;
type OnClose = Rc<dyn Fn(Option<String>)>;

/// What a relay's write half accepts.
enum Out {
    Text(String),
    /// Close the socket deliberately (never surfaces as `on_close`).
    Close,
}

struct SubEntry {
    callbacks: SubCallbacks,
    /// The relay-JSON filter, kept so the REQ can be re-sent on (re)connect and
    /// after NIP-42 AUTH.
    filter: Value,
}

struct Conn {
    tx: mpsc::UnboundedSender<Out>,
    /// `false` until the WS handshake completes. A REQ / EVENT is sent from
    /// `subscribe` / `publish_confirmed` only to `up` relays; a relay that
    /// connects later gets every stored sub's REQ replayed by `on_relay_up`, so
    /// nothing is sent twice.
    up: bool,
}

struct State {
    relays: Vec<String>,
    identity: Keypair,
    /// SOCKS5 `host:port` (Orbot). When set, EVERY relay is dialled through it
    /// — a `.onion` relay is only routable via Tor.
    proxy: Option<String>,
    router: Router,
    conns: HashMap<String, Conn>,
    subs: HashMap<String, SubEntry>,
    publishes: HashMap<String, oneshot::Sender<PublishResult>>,
    sub_seq: u64,
}

/// Config for [`WsTransport::new`].
pub struct WsConfig {
    pub relays: Vec<String>,
    pub identity: Keypair,
    pub proxy: Option<String>,
}

/// The real relay transport. Cheap to clone (an `Rc`).
#[derive(Clone)]
pub struct WsTransport {
    state: Rc<RefCell<State>>,
}

impl WsTransport {
    pub fn new(config: WsConfig) -> Self {
        Self {
            state: Rc::new(RefCell::new(State {
                relays: config.relays,
                identity: config.identity,
                proxy: config.proxy,
                router: Router::new(),
                conns: HashMap::new(),
                subs: HashMap::new(),
                publishes: HashMap::new(),
                sub_seq: 0,
            })),
        }
    }

    /// Dial every configured relay that has no live connection. Called on start
    /// and by the connection FSM after a backoff (this transport never
    /// reconnects on its own).
    pub fn ensure_connected(&self) {
        let relays: Vec<String> = {
            let st = self.state.borrow();
            st.relays
                .iter()
                .filter(|r| !st.conns.contains_key(*r))
                .cloned()
                .collect()
        };
        for relay in relays {
            self.spawn_relay(relay);
        }
    }

    /// Relays with a live socket right now — for a per-relay status
    /// indicator (Settings).
    pub fn connected_relays(&self) -> BTreeSet<String> {
        self.state.borrow().router.connected_relays().iter().cloned().collect()
    }

    /// Tear down every socket deliberately (no `on_close` fires).
    pub fn shutdown(&self) {
        let conns: Vec<Conn> = self.state.borrow_mut().conns.drain().map(|(_, c)| c).collect();
        for c in conns {
            let _ = c.tx.send(Out::Close);
        }
    }

    /// Publish one signed event and report the CDX-086 verdict, re-publishing
    /// the SAME event within `budget` (never rebuilding it — a rebuild changes
    /// `created_at` + the NIP-44 nonce + the id, defeats the bridge's id-dedup,
    /// and double-injects an image).
    ///
    /// A retry only helps an `unreachable` (transient network) — `accepted` /
    /// `unconfirmed` mean the bridge has it, and a `rejected` from every relay
    /// will reject the identical event identically. So the loop stops on
    /// anything but `unreachable`.
    pub async fn publish_confirmed(
        &self,
        event: &SignedEvent,
        budget: Duration,
        attempts: u32,
    ) -> PublishResult {
        let deadline = tokio::time::Instant::now() + budget;
        let mut last = PublishResult {
            verdict: PublishVerdict::Unreachable,
            detail: Some("no relay connected".to_string()),
        };

        for _ in 0..attempts.max(1) {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            let targets: Vec<String> = {
                let st = self.state.borrow();
                st.conns
                    .iter()
                    .filter(|(_, c)| c.up)
                    .map(|(r, _)| r.clone())
                    .collect()
            };
            if targets.is_empty() {
                return last;
            }

            let (tx, rx) = oneshot::channel();
            {
                let mut st = self.state.borrow_mut();
                st.router.open_publish(&event.id, &targets);
                st.publishes.insert(event.id.clone(), tx);
                let frame = frames::event_frame(event);
                for relay in &targets {
                    if let Some(c) = st.conns.get(relay) {
                        let _ = c.tx.send(Out::Text(frame.clone()));
                    }
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, rx).await {
                Ok(Ok(result)) => {
                    last = result;
                }
                _ => {
                    // Budget elapsed with relays still silent — settle them as
                    // unconfirmed and take that.
                    if let Some(RouterAction::PublishSettled { result, .. }) =
                        self.state.borrow_mut().router.publish_timed_out(&event.id)
                    {
                        last = result;
                    }
                }
            }
            {
                let mut st = self.state.borrow_mut();
                st.publishes.remove(&event.id);
                st.router.drop_publish(&event.id);
            }
            if last.verdict != PublishVerdict::Unreachable {
                return last;
            }
        }
        last
    }

    // --- internals ---------------------------------------------------

    fn spawn_relay(&self, relay: String) {
        let (tx, rx) = mpsc::unbounded_channel::<Out>();
        self.state
            .borrow_mut()
            .conns
            .insert(relay.clone(), Conn { tx, up: false });
        let this = self.clone();
        tokio::task::spawn_local(async move {
            this.run_relay(relay, rx).await;
        });
    }

    async fn run_relay(self, relay: String, mut rx: mpsc::UnboundedReceiver<Out>) {
        let proxy = self.state.borrow().proxy.clone();
        let mut ws = match dial(&relay, proxy).await {
            Ok(ws) => ws,
            Err(err) => {
                self.on_relay_dead(&relay, format!("dial failed: {err}"));
                return;
            }
        };
        self.on_relay_up(&relay);

        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await; // consume the immediate first tick
        let mut last_seen = tokio::time::Instant::now();

        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(Out::Text(t)) => {
                        if ws.send(Message::Text(t)).await.is_err() { break; }
                    }
                    Some(Out::Close) | None => {
                        let _ = ws.close(None).await;
                        return; // deliberate — no on_close
                    }
                },
                frame = ws.next() => match frame {
                    Some(Ok(Message::Text(txt))) => {
                        last_seen = tokio::time::Instant::now();
                        self.on_frame(&relay, &txt);
                    }
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Pong(_)))
                    | Some(Ok(Message::Ping(_))) => {
                        last_seen = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | Some(Ok(Message::Frame(_))) | None => break,
                    Some(Err(_)) => break,
                },
                _ = ping.tick() => {
                    if tokio::time::Instant::now().duration_since(last_seen) > DEAD_AFTER {
                        break;
                    }
                    if ws.send(Message::Ping(Vec::new())).await.is_err() { break; }
                }
            }
        }
        self.on_relay_dead(&relay, "socket closed".to_string());
    }

    fn on_relay_up(&self, relay: &str) {
        let replays: Vec<String> = {
            let mut st = self.state.borrow_mut();
            st.router.relay_connected(relay);
            if let Some(c) = st.conns.get_mut(relay) {
                c.up = true;
            }
            st.subs
                .iter()
                .map(|(id, e)| frames::req_frame(id, std::slice::from_ref(&e.filter)))
                .collect()
        };
        let st = self.state.borrow();
        if let Some(c) = st.conns.get(relay) {
            for frame in replays {
                let _ = c.tx.send(Out::Text(frame));
            }
        }
    }

    fn on_relay_dead(&self, relay: &str, reason: String) {
        let actions = {
            let mut st = self.state.borrow_mut();
            st.conns.remove(relay);
            st.router.relay_disconnected(relay)
        };
        self.apply(actions, Some(reason));
    }

    fn on_frame(&self, relay: &str, text: &str) {
        let msg = match frames::parse_relay_message(text) {
            Ok(m) => m,
            Err(_) => return, // malformed frame — drop it, keep the socket
        };
        if let RelayMessage::Notice { .. } = msg {
            return;
        }
        let actions = self.state.borrow_mut().router.route(relay, msg);
        self.apply(actions, None);
    }

    /// Run router actions AFTER dropping the state borrow — a user callback may
    /// re-enter (`subscribe`, `TransportSub::close`). Each callback is an `Rc`
    /// cloned out under a short borrow, then invoked with no borrow held.
    fn apply(&self, actions: Vec<RouterAction>, close_reason: Option<String>) {
        for action in actions {
            match action {
                RouterAction::Event { sub_id, event } => {
                    if let (Some(cb), Some(ne)) =
                        (self.on_event_of(&sub_id), project_event(&event))
                    {
                        cb(&ne);
                    }
                }
                RouterAction::Eose { sub_id } => {
                    if let Some(cb) = self.on_eose_of(&sub_id) {
                        cb();
                    }
                }
                RouterAction::SubClosed { sub_id, reason } => {
                    if let Some(cb) = self.on_close_of(&sub_id) {
                        cb(reason.or_else(|| close_reason.clone()));
                    }
                }
                RouterAction::NeedAuth { relay, challenge } => self.answer_auth(&relay, &challenge),
                RouterAction::ResubAfterAuth { relay, sub_id } => {
                    // AUTH is answered reactively on the NeedAuth the relay also
                    // sends; just re-send this sub's REQ.
                    let frame = {
                        let st = self.state.borrow();
                        st.subs
                            .get(&sub_id)
                            .map(|e| frames::req_frame(&sub_id, std::slice::from_ref(&e.filter)))
                    };
                    if let (Some(frame), Some(c)) = (frame, self.state.borrow().conns.get(&relay)) {
                        let _ = c.tx.send(Out::Text(frame));
                    }
                }
                RouterAction::PublishSettled { event_id, result } => {
                    if let Some(tx) = self.state.borrow_mut().publishes.remove(&event_id) {
                        let _ = tx.send(result);
                    }
                }
            }
        }
    }

    fn on_event_of(&self, sub_id: &str) -> Option<OnEvent> {
        self.state.borrow().subs.get(sub_id).map(|e| Rc::clone(&e.callbacks.on_event))
    }
    fn on_eose_of(&self, sub_id: &str) -> Option<OnEose> {
        self.state.borrow().subs.get(sub_id).map(|e| Rc::clone(&e.callbacks.on_eose))
    }
    fn on_close_of(&self, sub_id: &str) -> Option<OnClose> {
        self.state.borrow().subs.get(sub_id).map(|e| Rc::clone(&e.callbacks.on_close))
    }

    fn answer_auth(&self, relay: &str, challenge: &str) {
        let frame = {
            let st = self.state.borrow();
            let now_ms = now_ms();
            match build_auth_event(&st.identity, relay, challenge, now_ms) {
                Ok(ev) => frames::auth_frame(&ev),
                Err(_) => return,
            }
        };
        if let Some(c) = self.state.borrow().conns.get(relay) {
            let _ = c.tx.send(Out::Text(frame));
        }
    }
}

impl Transport for WsTransport {
    fn subscribe(&self, filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub> {
        let filter_json = frames::filter_to_json(&filter);
        let (sub_id, targets, frame) = {
            let mut st = self.state.borrow_mut();
            st.sub_seq += 1;
            let sub_id = format!("cd-{}", st.sub_seq);
            st.subs.insert(
                sub_id.clone(),
                SubEntry { callbacks, filter: filter_json.clone() },
            );
            let relays = st.relays.clone();
            st.router.open_sub(&sub_id, &relays);
            let frame = frames::req_frame(&sub_id, std::slice::from_ref(&filter_json));
            let targets: Vec<String> = st
                .conns
                .iter()
                .filter(|(_, c)| c.up)
                .map(|(r, _)| r.clone())
                .collect();
            (sub_id, targets, frame)
        };
        {
            let st = self.state.borrow();
            for relay in &targets {
                if let Some(c) = st.conns.get(relay) {
                    let _ = c.tx.send(Out::Text(frame.clone()));
                }
            }
        }
        Box::new(WsSub { state: Rc::clone(&self.state), sub_id })
    }

    fn set_relays(&self, urls: &[String]) {
        let to_kill: Vec<Conn> = {
            let mut st = self.state.borrow_mut();
            st.relays = urls.to_vec();
            let dead: Vec<String> = st
                .conns
                .keys()
                .filter(|r| !urls.contains(r))
                .cloned()
                .collect();
            dead.into_iter().filter_map(|r| st.conns.remove(&r)).collect()
        };
        for c in to_kill {
            let _ = c.tx.send(Out::Close);
        }
        self.ensure_connected();
    }
}

struct WsSub {
    state: Rc<RefCell<State>>,
    sub_id: String,
}

impl TransportSub for WsSub {
    fn close(&self) {
        let frame = frames::close_frame(&self.sub_id);
        let mut st = self.state.borrow_mut();
        st.subs.remove(&self.sub_id);
        st.router.drop_sub(&self.sub_id);
        // Only `up` relays ever got this sub's REQ; a CLOSE to a still-dialling
        // relay would sit in its queue ahead of the REQs `on_relay_up` replays
        // and arrive out of order.
        for c in st.conns.values().filter(|c| c.up) {
            let _ = c.tx.send(Out::Text(frame.clone()));
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Project a raw relay event object down to what `nostr_client` routes on. `None`
/// if it is not a well-formed, signature-valid event.
fn project_event(raw: &Value) -> Option<NostrEvent> {
    let json = raw.to_string();
    let ev = nostr::Event::from_json(&json).ok()?;
    ev.verify().ok()?;
    Some(NostrEvent {
        id: ev.id.to_hex(),
        kind: ev.kind.as_u16(),
        created_at: ev.created_at.as_secs() as i64,
        pubkey: ev.pubkey.to_hex(),
        content: ev.content.clone(),
        raw: raw.clone(),
    })
}

async fn dial(relay: &str, proxy: Option<String>) -> Result<RelayStream, String> {
    let url = Url::parse(relay).map_err(|e| format!("bad relay url {relay:?}: {e}"))?;
    let host = url.host_str().ok_or("relay url has no host")?.to_string();
    let port = url
        .port_or_known_default()
        .ok_or("relay url has no port and unknown scheme")?;
    let tls = matches!(url.scheme(), "wss");

    let tcp: Either<TcpStream, Socks5Stream<TcpStream>> = match proxy {
        Some(p) => Either::Right(
            Socks5Stream::connect(p.as_str(), (host.as_str(), port))
                .await
                .map_err(|e| format!("socks5: {e}"))?,
        ),
        None => Either::Left(
            TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|e| format!("tcp: {e}"))?,
        ),
    };

    let connector = if tls {
        None // default rustls connector from the webpki-roots feature
    } else {
        Some(tokio_tungstenite::Connector::Plain)
    };
    let (ws, _resp) =
        tokio_tungstenite::client_async_tls_with_config(url.as_str(), tcp, None, connector)
            .await
            .map_err(|e| format!("ws handshake: {e}"))?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::{mock_relay, MockRelay};
    use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
    use protocol::codec::decode_phone_to_bridge;
    use nostr::JsonUtil;
    use std::cell::RefCell;
    use tokio::task::LocalSet;

    const SEC_PHONE: &str =
        "0000000000000000000000000000000000000000000000000000000000000001";

    fn transport(mock: &MockRelay, phone: &Keypair) -> WsTransport {
        WsTransport::new(WsConfig {
            relays: vec![mock.url.clone()],
            identity: phone.clone(),
            proxy: None,
        })
    }

    fn a_filter(phone: &Keypair) -> Filter {
        Filter {
            kinds: vec![24515],
            authors: vec!["a".repeat(64)],
            p_tags: vec![phone.pubkey_hex.clone()],
            h_tags: Vec::new(),
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
                tokio::time::sleep(Duration::from_millis(120)).await;

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

    #[tokio::test]
    async fn publish_confirmed_maps_the_relay_ok_verdict() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let machine = generate_keypair();
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

                let msg = decode_phone_to_bridge(r#"{"type":"refresh-sessions"}"#).unwrap();
                let event =
                    client_core::bridge_api::build_command(&phone, &machine.pubkey_hex, &msg, 1_000)
                        .unwrap();

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
                tokio::time::sleep(Duration::from_millis(150)).await;
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

                sub.close();
                assert_eq!(mock.next_frame().await, r#"["CLOSE","cd-1"]"#);

                // a late EVENT for the dropped sub must not reach the callback
                mock.push(format!(r#"["EVENT","cd-1",{}]"#, signed_note(24515, "late")));
                tokio::time::sleep(Duration::from_millis(100)).await;
                assert!(events.borrow().is_empty());
            })
            .await;
    }
}
