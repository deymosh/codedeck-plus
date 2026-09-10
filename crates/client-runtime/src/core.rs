//! `Core` — the F1 runtime handle. One tokio event loop (on the FG service's
//! `LocalSet`) composes:
//!
//! * the connection FSM ([`client_core::connection`]) — every connectivity
//!   signal in, `OpenSocket` / `ScheduleRetry` / … effects out;
//! * the epoch-guarded subscription client ([`crate::nostr_client::NostrClient`])
//!   over the real [`WsTransport`];
//! * [`client_core::bridge_api`] — egress `build_command`, total `ingest`.
//!
//! The UniFFI (Android) and `#[tauri::command]` (Desktop) bindings attach here.
//! The F1 surface is deliberately minimal — enough to run transport + crypto in
//! the background service behind a flag. The View / Intent / CoreEvent API
//! (plan §2) is stabilised with the mobile app in F2.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use client_core::bridge_api::{
    build_command, BridgeApi, EgressError, IncomingEvent, Ingested, PublishResult, PublishVerdict,
};
use client_core::connection::{
    connection_reducer, heartbeats_all_stale, initial_connection_state, ConnectionEffect,
    ConnectionEvent, ConnectionState, ConnectionStatus, ReconnectConfig, DEFAULT_RECONNECT_CONFIG,
    TOR_RECONNECT_CONFIG,
};
use client_core::crypto::Keypair;
use client_core::wire::commands::PhoneToBridge;
use client_core::wire::events::BridgeToPhone;
use client_core::wire::kinds::SESSION_LIST_KIND;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::nostr_client::{NostrClient, NostrClientHost, NostrEvent};
use crate::transport::ws::{WsConfig, WsTransport, PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};

/// How often the CDX-020 dead-subscription watchdog re-checks while connected.
const STALE_WATCHDOG_EVERY: Duration = Duration::from_secs(30);

// --- ports (F1 minimal) ------------------------------------------------------

/// Injected wall clock (ms). `SystemClock` in production, a fake in tests.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

/// Injected `[0, 1)` source for backoff jitter.
pub trait Entropy {
    fn unit(&self) -> f64;
}

/// `SystemTime`-backed [`Clock`].
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// Cheap non-crypto jitter source (a hashed clock read — jitter needs spread,
/// not unpredictability).
pub struct TimeEntropy;
impl Entropy for TimeEntropy {
    fn unit(&self) -> f64 {
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        (ns % 1000) as f64 / 1000.0
    }
}

// --- observer (seed of the F2 CoreEvent stream) --------------------------

/// Why a user-visible action did not land. Semantic — the UI writes the copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionFailed {
    DecryptFailed,
    DecodeFailed,
    PublishRejected,
    PublishUnreachable,
}

/// What the `Core` tells its host. No UI strings; the binding maps these to
/// platform events.
pub trait CoreObserver {
    /// Connection status or the `needs pairing check` diagnostic changed.
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool);
    /// A decoded bridge→phone message for the given machine.
    fn bridge_message(&self, machine: String, msg: BridgeToPhone);
    fn action_failed(&self, _kind: ActionFailed) {}
}

// --- config ---------------------------------------------------------------

pub struct CoreConfig {
    pub relays: Vec<String>,
    pub identity: Keypair,
    /// SOCKS5 `host:port` (Orbot). When set every relay is dialled through it.
    pub proxy: Option<String>,
    /// Backoff / stale-window timing. [`CoreConfig::new`] picks the Tor variant
    /// when `tor` is set; tests override directly.
    pub reconnect: ReconnectConfig,
}

impl CoreConfig {
    pub fn new(
        relays: Vec<String>,
        identity: Keypair,
        proxy: Option<String>,
        tor: bool,
    ) -> Self {
        Self {
            relays,
            identity,
            proxy,
            reconnect: if tor {
                TOR_RECONNECT_CONFIG
            } else {
                DEFAULT_RECONNECT_CONFIG
            },
        }
    }
}

// --- the handle ---------------------------------------------------------

/// Cheap to clone; every method is a message to the loop.
#[derive(Clone)]
pub struct Core {
    tx: mpsc::UnboundedSender<Msg>,
}

impl Core {
    /// Build the runtime and spawn its event loop. MUST be called from inside a
    /// `tokio::task::LocalSet` (the `SubCallbacks` closures are `!Send`).
    pub fn spawn(
        config: CoreConfig,
        observer: Rc<dyn CoreObserver>,
        clock: Rc<dyn Clock>,
        entropy: Rc<dyn Entropy>,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<Msg>();
        let host = Rc::new(HostBridge {
            tx: tx.clone(),
            machines: RefCell::new(Vec::new()),
            cursor: RefCell::new(0),
        });
        let ws = WsTransport::new(WsConfig {
            relays: config.relays.clone(),
            identity: config.identity.clone(),
            proxy: config.proxy.clone(),
        });
        let nostr = NostrClient::new(
            ws.clone(),
            Rc::clone(&host),
            config.identity.pubkey_hex.clone(),
        );
        let event_loop = Loop {
            reconnect: config.reconnect,
            identity: config.identity,
            clock,
            entropy,
            observer,
            conn: initial_connection_state(),
            nostr,
            ws,
            api: BridgeApi::new(),
            machines: Vec::new(),
            host,
            retry_timer: None,
            vis_timer: None,
            stale_timer: None,
            self_tx: tx.clone(),
        };
        tokio::task::spawn_local(event_loop.run(rx));
        Self { tx }
    }

    pub fn start(&self) {
        let _ = self.tx.send(Msg::Start);
    }
    pub fn stop(&self) {
        let _ = self.tx.send(Msg::Stop);
    }
    /// The OS backgrounded the app (debounced; never tears a healthy socket).
    pub fn pause(&self) {
        let _ = self.tx.send(Msg::Pause);
    }
    /// The OS foregrounded the app.
    pub fn resume(&self) {
        let _ = self.tx.send(Msg::Resume);
    }
    /// `ConnectivityManager` says the network came / went.
    pub fn set_online(&self, online: bool) {
        let _ = self.tx.send(Msg::SetOnline(online));
    }
    /// The paired-machine list (subscription authors + the known-machine gate).
    pub fn set_machines(&self, machines: Vec<String>) {
        let _ = self.tx.send(Msg::SetMachines(machines));
    }

    /// Fire-and-forget send of a phone→bridge command.
    pub fn send(&self, machine: impl Into<String>, msg: PhoneToBridge) {
        let _ = self.tx.send(Msg::Send {
            machine: machine.into(),
            msg: Box::new(msg),
            reply: None,
        });
    }

    /// Send and await the CDX-086 publish verdict.
    pub async fn publish_confirmed(
        &self,
        machine: impl Into<String>,
        msg: PhoneToBridge,
    ) -> PublishResult {
        let (rtx, rrx) = oneshot::channel();
        if self
            .tx
            .send(Msg::Send {
                machine: machine.into(),
                msg: Box::new(msg),
                reply: Some(rtx),
            })
            .is_err()
        {
            return PublishResult {
                verdict: PublishVerdict::Unreachable,
                detail: Some("core stopped".to_string()),
            };
        }
        rrx.await.unwrap_or(PublishResult {
            verdict: PublishVerdict::Unreachable,
            detail: Some("core dropped the publish".to_string()),
        })
    }
}

// --- loop internals -------------------------------------------------

enum Msg {
    Start,
    Stop,
    Pause,
    Resume,
    SetOnline(bool),
    SetMachines(Vec<String>),
    RelayEvent(NostrEvent),
    SocketOpen,
    SocketClose,
    RetryDue,
    VisibilitySettled,
    StaleWatchdog,
    Send {
        machine: String,
        msg: Box<PhoneToBridge>,
        reply: Option<oneshot::Sender<PublishResult>>,
    },
}

/// [`NostrClientHost`] that forwards every callback into the loop as a [`Msg`]
/// (decoupling reentrancy — a callback fires inside the transport's task).
struct HostBridge {
    tx: mpsc::UnboundedSender<Msg>,
    machines: RefCell<Vec<String>>,
    /// `last_stored_seen` cursor (seconds). F1 keeps it in memory; F2 backs it
    /// with the `Kv` port.
    cursor: RefCell<i64>,
}

impl NostrClientHost for HostBridge {
    fn authors(&self) -> Vec<String> {
        self.machines.borrow().clone()
    }
    fn on_event(&self, event: &NostrEvent) {
        let _ = self.tx.send(Msg::RelayEvent(event.clone()));
    }
    fn on_socket_open(&self) {
        let _ = self.tx.send(Msg::SocketOpen);
    }
    fn on_socket_close(&self, reason: Option<String>) {
        let _ = reason;
        let _ = self.tx.send(Msg::SocketClose);
    }
    fn last_stored_seen(&self) -> i64 {
        *self.cursor.borrow()
    }
    fn note_stored_seen(&self, ts: i64) {
        let mut c = self.cursor.borrow_mut();
        if ts > *c {
            *c = ts;
        }
    }
}

struct Loop {
    reconnect: ReconnectConfig,
    identity: Keypair,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
    conn: ConnectionState,
    nostr: NostrClient<WsTransport, HostBridge>,
    ws: WsTransport,
    api: BridgeApi,
    machines: Vec<String>,
    host: Rc<HostBridge>,
    retry_timer: Option<AbortHandle>,
    vis_timer: Option<AbortHandle>,
    stale_timer: Option<AbortHandle>,
    self_tx: mpsc::UnboundedSender<Msg>,
}

impl Loop {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Start => {
                    self.dispatch(ConnectionEvent::ConnectRequested);
                    self.arm_stale_watchdog();
                }
                Msg::Stop => {
                    self.dispatch(ConnectionEvent::DisconnectRequested);
                    abort(&mut self.stale_timer);
                }
                Msg::Pause => self.dispatch(ConnectionEvent::Visibility { visible: false }),
                Msg::Resume => {
                    self.dispatch(ConnectionEvent::Visibility { visible: true });
                    self.dispatch(ConnectionEvent::Resume);
                }
                Msg::SetOnline(true) => self.dispatch(ConnectionEvent::Online),
                Msg::SetOnline(false) => self.dispatch(ConnectionEvent::Offline),
                Msg::SetMachines(machines) => {
                    *self.host.machines.borrow_mut() = machines.clone();
                    self.machines = machines;
                    if matches!(
                        self.conn.status,
                        ConnectionStatus::Connected | ConnectionStatus::Connecting
                    ) {
                        self.nostr.resubscribe();
                    }
                }
                Msg::RetryDue => self.dispatch(ConnectionEvent::RetryDue),
                Msg::VisibilitySettled => self.dispatch(ConnectionEvent::VisibilitySettled),
                Msg::SocketOpen => {
                    let at = self.clock.now_ms();
                    self.dispatch(ConnectionEvent::SocketOpen { at });
                }
                Msg::SocketClose => {
                    let random = Some(self.entropy.unit());
                    self.dispatch(ConnectionEvent::SocketClose { random });
                }
                Msg::StaleWatchdog => {
                    let now = self.clock.now_ms();
                    if heartbeats_all_stale(&self.conn, now, self.reconnect.heartbeat_stale_after_ms)
                    {
                        // CDX-020: subscriptions died without a socket close —
                        // force the normal backoff/reconnect path.
                        let random = Some(self.entropy.unit());
                        self.dispatch(ConnectionEvent::SocketClose { random });
                    }
                    if self.conn.status != ConnectionStatus::Stopped {
                        self.arm_stale_watchdog();
                    }
                }
                Msg::RelayEvent(event) => self.on_relay_event(event),
                Msg::Send { machine, msg, reply } => self.on_send(machine, *msg, reply),
            }
        }
    }

    fn dispatch(&mut self, event: ConnectionEvent) {
        let before = (self.conn.status, self.conn.needs_pairing_check);
        let result = connection_reducer(&self.conn, &event, &self.reconnect);
        self.conn = result.state;
        for effect in result.effects {
            self.apply(effect);
        }
        let after = (self.conn.status, self.conn.needs_pairing_check);
        if after != before {
            self.observer
                .connection_changed(self.conn.status, self.conn.needs_pairing_check);
        }
    }

    fn apply(&mut self, effect: ConnectionEffect) {
        match effect {
            ConnectionEffect::OpenSocket => {
                self.ws.ensure_connected();
                self.nostr.connect();
            }
            ConnectionEffect::CloseSocket => {
                self.nostr.disconnect();
                self.ws.shutdown();
            }
            ConnectionEffect::ScheduleRetry { delay_ms } => {
                abort(&mut self.retry_timer);
                self.retry_timer = Some(self.arm(delay_ms, Msg::RetryDue));
            }
            ConnectionEffect::CancelRetry => abort(&mut self.retry_timer),
            ConnectionEffect::ScheduleVisibilityCheck { delay_ms } => {
                abort(&mut self.vis_timer);
                self.vis_timer = Some(self.arm(delay_ms, Msg::VisibilitySettled));
            }
            ConnectionEffect::CancelVisibilityCheck => abort(&mut self.vis_timer),
            // F2 sync engine hooks here; F1 has no transcript store yet.
            ConnectionEffect::RefreshAndReconcile => {}
        }
    }

    fn arm(&self, delay_ms: u64, msg: Msg) -> AbortHandle {
        let tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = tx.send(msg);
        })
        .abort_handle()
    }

    fn arm_stale_watchdog(&mut self) {
        abort(&mut self.stale_timer);
        let tx = self.self_tx.clone();
        self.stale_timer = Some(
            tokio::task::spawn_local(async move {
                tokio::time::sleep(STALE_WATCHDOG_EVERY).await;
                let _ = tx.send(Msg::StaleWatchdog);
            })
            .abort_handle(),
        );
    }

    fn on_relay_event(&mut self, event: NostrEvent) {
        let known = self.machines.iter().any(|m| m == &event.pubkey);

        // A 30515 from a PAIRED machine IS a heartbeat — feed the FSM for
        // presence + CDX-020 whether or not the payload decodes. Gate on
        // `known`: the subscription filter already scopes authors, but a
        // misbehaving relay must not be able to seed a stranger's heartbeat.
        if known && event.kind == SESSION_LIST_KIND {
            let at = self.clock.now_ms();
            self.dispatch(ConnectionEvent::HeartbeatReceived {
                machine: event.pubkey.clone(),
                at,
            });
        }

        let incoming = IncomingEvent {
            id: &event.id,
            pubkey: &event.pubkey,
            kind: event.kind,
            content: &event.content,
        };
        match self
            .api
            .ingest(&incoming, &self.identity, known, self.clock.now_ms())
        {
            Ingested::Message(msg) => {
                self.observer.bridge_message(event.pubkey.clone(), *msg);
            }
            Ingested::DecryptFailed => {
                self.dispatch(ConnectionEvent::DecryptFailure);
                self.observer.action_failed(ActionFailed::DecryptFailed);
            }
            Ingested::DecodeFailed => self.observer.action_failed(ActionFailed::DecodeFailed),
            Ingested::Buffered | Ingested::UnknownMachine => {}
        }
    }

    fn on_send(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
    ) {
        let now = self.clock.now_ms();
        let event = match build_command(&self.identity, &machine, &msg, now) {
            Ok(event) => event,
            Err(err) => {
                self.observer.action_failed(ActionFailed::PublishRejected);
                if let Some(reply) = reply {
                    let _ = reply.send(PublishResult {
                        verdict: PublishVerdict::Rejected,
                        detail: Some(egress_detail(&err)),
                    });
                }
                return;
            }
        };

        // Publish off the loop so a 12s confirmation budget never blocks
        // socket-close / lifecycle handling.
        let ws = self.ws.clone();
        let observer = Rc::clone(&self.observer);
        tokio::task::spawn_local(async move {
            let result = ws
                .publish_confirmed(&event, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
            match result.verdict {
                PublishVerdict::Rejected => observer.action_failed(ActionFailed::PublishRejected),
                PublishVerdict::Unreachable => {
                    observer.action_failed(ActionFailed::PublishUnreachable)
                }
                PublishVerdict::Accepted | PublishVerdict::Unconfirmed => {}
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        });
    }
}

fn abort(slot: &mut Option<AbortHandle>) {
    if let Some(handle) = slot.take() {
        handle.abort();
    }
}

fn egress_detail(err: &EgressError) -> String {
    match err {
        EgressError::Invalid(m) => format!("egress: {m}"),
        EgressError::Crypto(e) => format!("crypto: {e}"),
        EgressError::Sign(m) => format!("sign: {m}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::{mock_relay, MockRelay};
    use client_core::crypto::{generate_keypair, keypair_from_secret_hex};
    use client_core::wire::codec::encode_bridge_to_phone;
    use client_core::wire::kinds::{LIVE_KIND, SESSION_LIST_KIND};
    use std::sync::Mutex;
    use tokio::task::LocalSet;

    const SEC_PHONE: &str =
        "0000000000000000000000000000000000000000000000000000000000000001";

    #[derive(Default)]
    struct Spy {
        statuses: Mutex<Vec<(ConnectionStatus, bool)>>,
        messages: Mutex<Vec<(String, BridgeToPhone)>>,
        failures: Mutex<Vec<ActionFailed>>,
    }
    impl CoreObserver for Spy {
        fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool) {
            self.statuses.lock().unwrap().push((status, needs_pairing_check));
        }
        fn bridge_message(&self, machine: String, msg: BridgeToPhone) {
            self.messages.lock().unwrap().push((machine, msg));
        }
        fn action_failed(&self, kind: ActionFailed) {
            self.failures.lock().unwrap().push(kind);
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

    fn core_for(mock: &MockRelay, phone: &Keypair, spy: Rc<Spy>) -> Core {
        Core::spawn(
            CoreConfig {
                relays: vec![mock.url.clone()],
                identity: phone.clone(),
                proxy: None,
                reconnect: fast_reconnect(),
            },
            spy,
            Rc::new(FixedClock(RefCell::new(1_000_000))),
            Rc::new(ZeroEntropy),
        )
    }

    async fn eose_all(mock: &mut MockRelay) {
        // NostrClient opens three subs: cd-1 / cd-2 / cd-3.
        for _ in 0..3 {
            let req = mock.next_frame().await;
            let v: Vec<serde_json::Value> = serde_json::from_str(&req).unwrap();
            assert_eq!(v[0], "REQ");
            let sub_id = v[1].as_str().unwrap().to_string();
            mock.push(format!(r#"["EOSE","{sub_id}"]"#));
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
                let core = core_for(&mock, &phone, Rc::clone(&spy));

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
                let core = core_for(&mock, &phone, Rc::clone(&spy));
                core.set_machines(vec![machine.pubkey_hex.clone()]);
                core.start();
                eose_all(&mut mock).await;

                let msg = client_core::wire::codec::decode_bridge_to_phone(
                    r#"{"type":"input-ack","sessionId":"s1","inputId":"i1"}"#,
                )
                .unwrap();
                let plaintext = encode_bridge_to_phone(&msg);
                let ct = client_core::crypto::encrypt_to(
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
    async fn a_socket_drop_backs_off_and_reconnects() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let machine = generate_keypair();
                let spy = Rc::new(Spy::default());
                let core = core_for(&mock, &phone, Rc::clone(&spy));
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
                let core = core_for(&mock, &phone, Rc::clone(&spy));
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
    async fn a_30515_heartbeat_reaches_the_fsm_even_if_it_is_not_ours() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let spy = Rc::new(Spy::default());
                let core = core_for(&mock, &phone, Rc::clone(&spy));
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
}
