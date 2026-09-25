//! `WsTransport` — the real [`Transport`] over WebSockets: one connect + read
//! task per relay, wired through the pure [`frames`](super::frames) codec and
//! [`router`](super::router).
//!
//! Single-threaded by construction. The [`SubCallbacks`] closures a
//! runtime's subscription logic hands us are `!Send`, so the whole transport runs on a
//! current-thread runtime inside a `LocalSet` (the FG service's client thread);
//! every task is `spawn_local`. This mirrors the TS `this`-bound model exactly.
//!
//! What lives here and NOT in a relay-pool crate (see docs/CLIENT.md):
//! * **no auto-reconnect** — a dead socket surfaces as ONE `on_close`; the
//!   connection FSM owns backoff and calls [`WsTransport::ensure_connected`].
//! * **ping liveness** — a socket with no traffic for [`DEAD_AFTER`] is dropped
//!   so a silently-rotted relay is detected, not trusted. Reading and writing
//!   run concurrently, so a write stuck on a full socket buffer can neither
//!   stall inbound frames nor postpone that check; a write that stays stuck
//!   for [`WRITE_TIMEOUT`] drops the socket too.
//! * **bounded everything** — a dial (TCP, SOCKS5, TLS, WS handshake) has a
//!   deadline, and a relay's outbound queue holds at most [`OUTBOUND_QUEUE`]
//!   frames: a relay that cannot drain it is dropped and redialled rather than
//!   buffered without limit.
//! * **NIP-42 AUTH** answered with the identity key; a `CLOSED: auth-required`
//!   re-sends that subscription's REQ once AUTH is in.
//! * **`publish_confirmed`** keeps the CDX-086 four-way verdict end to end.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::time::Duration;

use crate::publish::{PublishResult, PublishVerdict};
use protocol::crypto::Keypair;
use protocol::nip42::build_auth_event;
use protocol::nostr_event::SignedEvent;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_socks::tcp::Socks5Stream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_util::either::Either;
use nostr::JsonUtil;
use url::Url;

use super::frames::{self, RelayMessage};
use super::router::{Router, RouterAction};
use crate::port::{Filter, NostrEvent, SubCallbacks, Transport, TransportSub};

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
/// Deadline for a direct dial: TCP connect, TLS and the WS handshake.
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);
/// Deadline for a dial through the SOCKS5 proxy — building a Tor circuit
/// (an onion service's especially) routinely takes tens of seconds.
const DIAL_TIMEOUT_PROXIED: Duration = Duration::from_secs(60);
/// A single frame write that has not completed in this long means the peer
/// stopped reading (or the path is gone): the socket is dropped.
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);
/// Frames queued for one relay's socket. Far above anything a healthy relay
/// accumulates (a REQ per subscription on connect, then a trickle); a relay
/// that lets it fill is dropped and redialled.
const OUTBOUND_QUEUE: usize = 1024;
/// How long a deliberate close waits to say goodbye before just dropping.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

type RelayStream =
    tokio_tungstenite::WebSocketStream<MaybeTlsStream<Either<TcpStream, Socks5Stream<TcpStream>>>>;

type OnEvent = Rc<dyn Fn(&NostrEvent)>;
type OnEose = Rc<dyn Fn()>;
type OnClose = Rc<dyn Fn(Option<String>)>;

/// The connection timings, a field so tests can shrink them.
#[derive(Clone, Copy)]
struct Timing {
    ping_every: Duration,
    dead_after: Duration,
    dial: Duration,
    dial_proxied: Duration,
    write: Duration,
}

const TIMING: Timing = Timing {
    ping_every: PING_EVERY,
    dead_after: DEAD_AFTER,
    dial: DIAL_TIMEOUT,
    dial_proxied: DIAL_TIMEOUT_PROXIED,
    write: WRITE_TIMEOUT,
};

/// Why a relay's task must end without waiting on its socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    /// Teardown or redial — never surfaces as `on_close`.
    Deliberate,
    /// The outbound queue filled up: a failure, reported like a dead socket.
    Overflow,
}

/// A one-way stop request from the transport to a relay's task.
#[derive(Default)]
struct Stop {
    reason: Cell<Option<StopReason>>,
    notify: Notify,
}

impl Stop {
    /// A deliberate stop overrides an overflow still pending; otherwise the
    /// first request wins.
    fn request(&self, reason: StopReason) {
        match (self.reason.get(), reason) {
            (None, _) | (Some(StopReason::Overflow), StopReason::Deliberate) => {
                self.reason.set(Some(reason));
                // `notify_one` keeps a permit when nobody waits yet, so a stop
                // requested before the task first polls `wait` is not lost.
                self.notify.notify_one();
            }
            _ => {}
        }
    }

    async fn wait(&self) -> StopReason {
        loop {
            if let Some(reason) = self.reason.get() {
                return reason;
            }
            self.notify.notified().await;
        }
    }
}

struct SubEntry {
    callbacks: SubCallbacks,
    /// The relay-JSON filter, kept so the REQ can be re-sent on (re)connect and
    /// after NIP-42 AUTH.
    filter: Value,
}

struct Conn {
    tx: mpsc::Sender<String>,
    stop: Rc<Stop>,
    /// `false` until the WS handshake completes. A REQ / EVENT is sent from
    /// `subscribe` / `publish_confirmed` only to `up` relays; a relay that
    /// connects later gets every stored sub's REQ replayed by `on_relay_up`, so
    /// nothing is sent twice.
    up: bool,
    /// Which dial this entry belongs to. `set_relays` / `set_proxy` replace a
    /// relay's entry while its old task may still be dialing or closing, and
    /// that task's up/dead callbacks carry its own generation so they can
    /// never mark, replay onto, or remove the replacement connection.
    generation: u64,
}

impl Conn {
    /// Queue one frame. Never blocks: a full queue stops the connection as a
    /// failure instead (the connection FSM then redials, and the REQs are
    /// replayed on connect), so a stalled relay cannot grow memory unbounded.
    fn send(&self, frame: String) {
        match self.tx.try_send(frame) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                if self.stop.reason.get().is_none() {
                    log::warn!("ws: outbound queue full ({OUTBOUND_QUEUE} frames) — dropping the connection");
                }
                self.stop.request(StopReason::Overflow);
            }
            // The task is already ending; it reports that itself.
            Err(TrySendError::Closed(_)) => {}
        }
    }

    /// Close the socket deliberately (never surfaces as `on_close`).
    fn close(&self) {
        self.stop.request(StopReason::Deliberate);
    }
}

/// How one live connection ended.
enum Ended {
    Deliberate,
    Failed(String),
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
    next_generation: u64,
    timing: Timing,
}

impl State {
    /// Take `relay`'s connection out deliberately (teardown / redial). The
    /// router must stop counting it as connected right away: the closing task
    /// no longer reports its own death (see `run_relay`), and a replacement
    /// dial for the same URL must not be confused with it.
    fn detach(&mut self, relay: &str) -> Option<Conn> {
        let conn = self.conns.remove(relay)?;
        if conn.up {
            self.router.forget_connected(relay);
        }
        Some(conn)
    }
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

/// `rustls` 0.23 dropped its old "exactly one crypto backend feature is
/// compiled in, so pick that one" auto-detection: with neither `ring` nor
/// `aws-lc-rs` unambiguously selected across the dependency graph — which is
/// exactly what `tokio-tungstenite`'s `rustls-tls-webpki-roots` feature
/// leaves this crate with — building the default `wss://` connector inside
/// [`dial`] now panics on the FIRST TLS handshake instead of silently
/// picking one, and it does so inside a `spawn_local`'d per-relay task, so
/// the panic never reaches the connection FSM or the UI: every relay just
/// stays permanently unconnected with no visible error (device-verified
/// 2026-09-19, `adb logcat` + a fresh emulator install — even the built-in
/// public defaults never connected). Installing a provider explicitly, once,
/// before the first dial is the fix `rustls` itself documents; `ring` (not
/// `aws-lc-rs`) matches what this workspace already vendors for `nostr`'s own
/// crypto and cross-compiles to Android without a C++ toolchain.
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Already installed (e.g. a host embedding this transport alongside
        // another rustls user) is not an error — every dial just uses
        // whichever provider got there first.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

impl WsTransport {
    pub fn new(config: WsConfig) -> Self {
        install_crypto_provider();
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
                next_generation: 0,
                timing: TIMING,
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
        log::debug!("ws: ensure_connected — {} relay(s) need a fresh dial: {relays:?}", relays.len());
        for relay in relays {
            self.spawn_relay(relay);
        }
    }

    /// How many relays this transport was configured with — a boot-time
    /// sanity check (see the `apply()` call site): zero here with a
    /// non-empty Settings relay list means the two disagree about what the
    /// user actually has persisted, not that every dial failed.
    pub fn relay_count(&self) -> usize {
        self.state.borrow().relays.len()
    }

    /// Relays with a live socket right now — for a per-relay status
    /// indicator (Settings).
    pub fn connected_relays(&self) -> BTreeSet<String> {
        self.state.borrow().router.connected_relays().iter().cloned().collect()
    }

    /// The proxy every NEW dial uses right now — test/introspection only.
    pub fn current_proxy(&self) -> Option<String> {
        self.state.borrow().proxy.clone()
    }

    /// Tear down every socket deliberately (no `on_close` fires).
    pub fn shutdown(&self) {
        let conns: Vec<Conn> = {
            let mut st = self.state.borrow_mut();
            let relays: Vec<String> = st.conns.keys().cloned().collect();
            relays.iter().filter_map(|r| st.detach(r)).collect()
        };
        for c in conns {
            c.close();
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
                        c.send(frame.clone());
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
        let (tx, rx) = mpsc::channel::<String>(OUTBOUND_QUEUE);
        let stop = Rc::new(Stop::default());
        let generation = {
            let mut st = self.state.borrow_mut();
            st.next_generation += 1;
            let generation = st.next_generation;
            st.conns.insert(relay.clone(), Conn { tx, stop: Rc::clone(&stop), up: false, generation });
            generation
        };
        let this = self.clone();
        tokio::task::spawn_local(async move {
            this.run_relay(relay, generation, rx, stop).await;
        });
    }

    async fn run_relay(
        self,
        relay: String,
        generation: u64,
        mut rx: mpsc::Receiver<String>,
        stop: Rc<Stop>,
    ) {
        let (proxy, timing) = {
            let st = self.state.borrow();
            (st.proxy.clone(), st.timing)
        };
        let budget = if proxy.is_some() { timing.dial_proxied } else { timing.dial };
        log::debug!("ws: dialing {relay} (proxy={proxy:?})");
        let dialed = tokio::select! {
            dialed = tokio::time::timeout(budget, dial(&relay, proxy)) => {
                dialed.unwrap_or_else(|_| Err(format!("timed out after {budget:?}")))
            }
            // A teardown mid-dial abandons the dial at once.
            StopReason::Deliberate = stop.wait() => return,
        };
        let ws = match dialed {
            Ok(ws) => ws,
            Err(err) => {
                log::warn!("ws: dial failed for {relay}: {err}");
                self.on_relay_dead(&relay, generation, format!("dial failed: {err}"));
                return;
            }
        };
        let (mut sink, mut stream) = ws.split();
        if !self.on_relay_up(&relay, generation) {
            // Detached while dialing (teardown or redial): this socket is no
            // longer wanted.
            let _ = tokio::time::timeout(CLOSE_GRACE, sink.close()).await;
            return;
        }
        log::info!("ws: {relay} connected");

        // Writer and reader are polled side by side in this one task: a
        // write parked on a full socket buffer leaves the reader running,
        // so inbound frames keep flowing and the liveness deadline still
        // fires.
        let ended = {
            let writer = async {
                let mut ping = tokio::time::interval(timing.ping_every);
                ping.tick().await; // consume the immediate first tick
                loop {
                    let message = tokio::select! {
                        frame = rx.recv() => match frame {
                            Some(text) => Message::Text(text),
                            // Every sender gone: the entry was detached.
                            None => return Ended::Deliberate,
                        },
                        _ = ping.tick() => Message::Ping(Vec::new()),
                    };
                    match tokio::time::timeout(timing.write, sink.send(message)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => return Ended::Failed(format!("write failed: {err}")),
                        Err(_) => return Ended::Failed(format!("write stalled for {:?}", timing.write)),
                    }
                }
            };
            let reader = async {
                loop {
                    // Any inbound frame — text, Pong, Ping — restarts the
                    // deadline; the writer's pings make a live relay answer.
                    match tokio::time::timeout(timing.dead_after, stream.next()).await {
                        Err(_) => {
                            return Ended::Failed(format!("no traffic for {:?}", timing.dead_after))
                        }
                        Ok(Some(Ok(Message::Text(text)))) => self.on_frame(&relay, &text),
                        Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                            return Ended::Failed("socket closed".to_string())
                        }
                        Ok(Some(Err(err))) => return Ended::Failed(format!("read failed: {err}")),
                        Ok(Some(Ok(_))) => {}
                    }
                }
            };
            tokio::select! {
                ended = writer => ended,
                ended = reader => ended,
                reason = stop.wait() => match reason {
                    StopReason::Deliberate => Ended::Deliberate,
                    StopReason::Overflow => {
                        Ended::Failed(format!("outbound queue full ({OUTBOUND_QUEUE} frames)"))
                    }
                },
            }
        };
        match ended {
            Ended::Deliberate => {
                let _ = tokio::time::timeout(CLOSE_GRACE, sink.close()).await;
            }
            Ended::Failed(reason) => self.on_relay_dead(&relay, generation, reason),
        }
    }

    /// `false` when this dial's entry has been detached or replaced — the
    /// caller then drops the socket without touching any shared state.
    fn on_relay_up(&self, relay: &str, generation: u64) -> bool {
        let replays: Vec<String> = {
            let mut st = self.state.borrow_mut();
            match st.conns.get_mut(relay) {
                Some(c) if c.generation == generation => c.up = true,
                _ => return false,
            }
            st.router.relay_connected(relay);
            st.subs
                .iter()
                .map(|(id, e)| frames::req_frame(id, std::slice::from_ref(&e.filter)))
                .collect()
        };
        let st = self.state.borrow();
        if let Some(c) = st.conns.get(relay) {
            for frame in replays {
                c.send(frame);
            }
        }
        true
    }

    fn on_relay_dead(&self, relay: &str, generation: u64, reason: String) {
        let actions = {
            let mut st = self.state.borrow_mut();
            // A superseded dial dying must not remove its replacement.
            if st.conns.get(relay).map(|c| c.generation) != Some(generation) {
                return;
            }
            log::info!("ws: {relay} disconnected ({reason})");
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
                        c.send(frame);
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
            c.send(frame);
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
                    c.send(frame.clone());
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
            dead.into_iter().filter_map(|r| st.detach(&r)).collect()
        };
        for c in to_kill {
            c.close();
        }
        self.ensure_connected();
    }

    /// Every relay is dialled through the (possibly new) proxy — unlike
    /// `set_relays`, which only redials the relays that actually changed, a
    /// proxy change invalidates EVERY existing socket (each one dialled
    /// through the OLD setting), so every current connection is redialled,
    /// not just the ones matching some diff.
    fn set_proxy(&self, proxy: Option<String>) {
        let to_kill: Vec<Conn> = {
            let mut st = self.state.borrow_mut();
            st.proxy = proxy;
            let relays: Vec<String> = st.conns.keys().cloned().collect();
            relays.iter().filter_map(|r| st.detach(r)).collect()
        };
        for c in to_kill {
            c.close();
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
            c.send(frame.clone());
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
    // Cleartext ws:// leaks every relay message (session output, DMs, pairing)
    // to anyone on the path — allowed only for .onion (Tor's own onion routing
    // + the hidden service's authentication already provide the transport
    // security wss:// would otherwise supply) and loopback (traffic that never
    // leaves the machine — the mock relays every test in this file dials
    // against). This was previously only an app-level settings check (easy to
    // bypass via config file or a manually typed relay); it now holds
    // regardless of what added this URL.
    let is_loopback = matches!(host.as_str(), "127.0.0.1" | "::1" | "localhost");
    if !tls && !host.ends_with(".onion") && !is_loopback {
        return Err(format!(
            "refusing cleartext ws:// to non-.onion, non-loopback host {host:?} — use wss://"
        ));
    }

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
    use crate::mock::{mock_relay, MockRelay};
    use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
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

    #[tokio::test]
    async fn dial_refuses_cleartext_to_a_public_host() {
        let err = dial("ws://relay.example.com", None).await.unwrap_err();
        assert!(err.contains("cleartext"), "{err}");
    }

    #[tokio::test]
    async fn dial_does_not_refuse_cleartext_to_onion_on_scheme_grounds() {
        // No real Tor network in a test — this fails on the actual connection
        // attempt (no proxy, an .onion address does not resolve over plain
        // DNS), but that failure must be a dial/DNS error, never the
        // cleartext-rejection this test exists to rule out.
        let err = dial("ws://expyuzz4wqqyqhjn.onion", None).await.unwrap_err();
        assert!(!err.contains("cleartext"), "{err}");
    }

    #[tokio::test]
    async fn dial_does_not_refuse_cleartext_to_loopback() {
        let mock = mock_relay().await;
        // A real connect+handshake against the mock relay itself, over ws://
        // 127.0.0.1 — proves loopback is genuinely usable, not just "not
        // rejected before some other failure".
        dial(&mock.url, None).await.unwrap();
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

    async fn wait_until(mut cond: impl FnMut() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never became true");
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
        let (tx, mut rx) = mpsc::channel::<String>(OUTBOUND_QUEUE);
        {
            let mut st = t.state.borrow_mut();
            st.conns.insert(
                url.clone(),
                Conn { tx, stop: Rc::new(Stop::default()), up: true, generation: 7 },
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
                let t = WsTransport::new(WsConfig { relays: vec![url], identity: phone, proxy: None });
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
                    identity: phone.clone(),
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
        let (tx, _rx) = mpsc::channel::<String>(1);
        let conn = Conn { tx, stop: Rc::new(Stop::default()), up: true, generation: 1 };
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
                    identity: phone.clone(),
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
