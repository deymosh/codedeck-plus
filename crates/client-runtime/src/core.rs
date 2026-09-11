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
use protocol::crypto::Keypair;
use client_core::notifications::NotifyEffect;
use protocol::commands::PhoneToBridge;
use protocol::events::BridgeToPhone;
use protocol::kinds::SESSION_LIST_KIND;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use client_core::notifications::{dm_notify_tag, session_notify_tag, NotifyEvent};
use client_core::stores::dm::{
    AddOutcome, DmRumor, DM_RELAY_LIST_KIND, DM_RUMOR_KIND, GIFT_WRAP_KIND,
};
use client_core::stores::ui::UiEffect;
use client_core::stores::marmot::{
    should_mint_key_package, AddOutcome as MarmotAddOutcome, MarmotIngested, PublishedKeyPackage,
    GROUP_MESSAGE_KIND, KEY_PACKAGE_ROTATION_MS, KP_RELAY_LIST_KIND, WELCOME_RUMOR_KIND,
};

use crate::dispatch::{PairDeadline, RouteResult, Router, Send as RouteSend, StoreId};
use crate::giftwrap::{relay_list_event, unwrap_gift_parts, wrap_dm};
use crate::intent::{apply as apply_intent, Intent, IntentCtx, IntentResult, UndoTimer};
use crate::nostr_client::{
    Filter, NostrClient, NostrClientHost, NostrEvent, SubCallbacks, Transport,
};
use crate::ports::{Kv, MemoryKv, MemoryTranscriptStore, NullNotifier, Notifier, TranscriptStore};
use crate::stores::{hydrate, CoreStores, Persister, StoresConfig};
use crate::transport::ws::{WsConfig, WsTransport, PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};
use crate::view::{
    ConnectionView, DmView, MachinesView, MarmotView, OutboxView, PairingView,
    PendingSessionsView, QuickPromptsView, SettingsView, TranscriptRowsView, UiView,
};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
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
    /// The semantic event stream (plan §2.3). No UI strings — the consumer
    /// decides how to surface each one and re-reads the named view slice.
    fn on_event(&self, _event: CoreEvent) {}
}

/// A read-projection slice (plan §2.1) — the granularity a consumer
/// re-subscribes to on a [`CoreEvent::StateChanged`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SliceId {
    Connection,
    Machines,
    Transcript,
    Outbox,
    Cards,
    Settings,
    Pairing,
    Dm,
    Marmot,
    QuickPrompts,
    PendingSessions,
    Ui,
}

/// The closed, semantic event set (plan §2.3). Serde shape: externally
/// tagged, camelCase (same convention as [`crate::intent::Intent`]) — e.g.
/// `{"stateChanged": {"slice": "machines"}}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CoreEvent {
    /// The named view slice changed — re-read it.
    StateChanged { slice: SliceId },
    /// An outbox item reached a terminal state (`delivered` = bridge ack'd, not
    /// just published).
    OutboxSettled { id: String, delivered: bool },
    /// The pair flow ended: `paired` true on success, false on nack / timeout.
    PairingSettled { paired: bool },
    /// A user-visible action did not land. Semantic — the UI writes the copy.
    ActionFailed { kind: ActionFailed },
    /// New rows landed for this session (a live `Output`, or a `SyncChunk`
    /// filling a gap) — a dedicated, per-session event rather than a generic
    /// `StateChanged { slice: Transcript }`, since a blanket slice notify
    /// cannot tell a consumer WHICH session to re-fetch and transcripts are
    /// per-session by nature.
    TranscriptAppended { machine: String, session_id: String },
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

/// The platform I/O seams the composed `Core` needs. [`Default`] wires
/// in-memory implementations (tests, and the transitional native-core seam
/// where the WebView still owns persistence).
pub struct CorePorts {
    pub kv: Rc<dyn Kv>,
    pub transcript_store: Rc<dyn TranscriptStore>,
    pub notifier: Rc<dyn Notifier>,
    /// Blossom image upload/download. `NoHttpFetch` until the platform binds
    /// real networking.
    pub http: Rc<dyn crate::attachments::HttpFetch>,
    /// The MDK / MLS engine. `NoMarmot` until the engine is relocated into this
    /// crate — Marmot chats are unavailable, NIP-17 only, until then.
    pub marmot: Rc<dyn crate::marmot::MarmotEngine>,
}

impl Default for CorePorts {
    fn default() -> Self {
        Self {
            kv: Rc::new(MemoryKv::new()),
            transcript_store: Rc::new(MemoryTranscriptStore::new()),
            notifier: Rc::new(NullNotifier),
            http: Rc::new(crate::attachments::NoHttpFetch),
            marmot: Rc::new(crate::marmot::NoMarmot),
        }
    }
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
    /// Hydrates the [`CoreStores`] from the [`CorePorts::kv`] before starting.
    pub async fn spawn(
        config: CoreConfig,
        ports: CorePorts,
        observer: Rc<dyn CoreObserver>,
        clock: Rc<dyn Clock>,
        entropy: Rc<dyn Entropy>,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<Msg>();

        let hydrated = hydrate(
            ports.kv.as_ref(),
            ports.transcript_store.as_ref(),
            &StoresConfig::default(),
        )
        .await;
        if hydrated.identity_needs_persist {
            Persister::new(ports.kv.as_ref())
                .save_identity_secret(&config.identity)
                .await;
        }

        let host = Rc::new(HostBridge {
            tx: tx.clone(),
            machines: RefCell::new(Vec::new()),
            cursor: RefCell::new(hydrated.last_stored_seen),
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
            pair_timer: None,
            undo_timer: None,
            dm_sub: None,
            dm_epoch: 0,
            marmot_sub: None,
            marmot_epoch: 0,
            self_tx: tx.clone(),
            stores: hydrated.stores,
            kv: ports.kv,
            transcript_store: ports.transcript_store,
            notifier: ports.notifier,
            http: ports.http,
            marmot_engine: ports.marmot,
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

    /// Replace the relay list (settings changed). The transport re-dials the
    /// diff and, if connected, the subscription client re-REQs.
    pub fn set_relays(&self, relays: Vec<String>) {
        let _ = self.tx.send(Msg::SetRelays(relays));
    }

    /// Current connection status + the `needs pairing check` diagnostic. A
    /// fresh read for a UI that just attached (the observer only reports
    /// changes).
    pub async fn connection_status(&self) -> (ConnectionStatus, bool) {
        let (rtx, rrx) = oneshot::channel();
        if self.tx.send(Msg::QueryStatus(rtx)).is_err() {
            return (ConnectionStatus::Stopped, false);
        }
        rrx.await.unwrap_or((ConnectionStatus::Stopped, false))
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

    /// Apply a user action. Resolves once the loop has folded it into the
    /// stores and queued its effects.
    pub async fn dispatch(&self, intent: Intent) {
        let (rtx, rrx) = oneshot::channel();
        if self
            .tx
            .send(Msg::Intent {
                intent: Box::new(intent),
                reply: rtx,
            })
            .is_ok()
        {
            let _ = rrx.await;
        }
    }

    /// Read-projection snapshots (plan §2.1). Each answers off the loop's own
    /// store state, so a reader that just attached gets a consistent view.
    pub async fn machines_view(&self) -> MachinesView {
        self.query(ViewQuery::Machines).await.unwrap_or(MachinesView {
            machines: Default::default(),
        })
    }
    pub async fn settings_view(&self) -> Option<SettingsView> {
        self.query(ViewQuery::Settings).await
    }
    pub async fn outbox_view(&self) -> OutboxView {
        self.query(ViewQuery::Outbox)
            .await
            .unwrap_or(OutboxView { items: Vec::new() })
    }
    pub async fn pairing_view(&self) -> Option<PairingView> {
        self.query(ViewQuery::Pairing).await
    }
    pub async fn connection_view(&self) -> Option<ConnectionView> {
        self.query(ViewQuery::Connection).await
    }
    pub async fn dm_view(&self) -> Option<DmView> {
        self.query(ViewQuery::Dm).await
    }
    pub async fn marmot_view(&self) -> Option<MarmotView> {
        self.query(ViewQuery::Marmot).await
    }
    pub async fn quick_prompts_view(&self) -> QuickPromptsView {
        self.query(ViewQuery::QuickPrompts)
            .await
            .unwrap_or(QuickPromptsView { prompts: Vec::new() })
    }
    pub async fn pending_sessions_view(&self) -> PendingSessionsView {
        self.query(ViewQuery::PendingSessions).await.unwrap_or(PendingSessionsView {
            pending: Default::default(),
        })
    }
    /// Everything needed to render one session's transcript: rows
    /// (`1..=local_high`, unpaginated — matches the TS store's own
    /// `entriesOf` contract), sync status, and coverage. The one view
    /// backed by I/O (`TranscriptStore`, SQLite on device), so it alone
    /// takes an extra loop round trip beyond the in-memory snapshot views.
    pub async fn transcript_view(&self, machine: String, session_id: String) -> TranscriptRowsView {
        self.query(|reply| ViewQuery::Transcript { machine, session_id, reply })
            .await
            .unwrap_or_else(TranscriptRowsView::empty)
    }
    pub async fn ui_view(&self) -> UiView {
        self.query(ViewQuery::Ui).await.unwrap_or(UiView {
            selected_machine: None,
            selected_session: None,
            panel_mode: Default::default(),
            active_dm_peer: None,
            active_marmot_group: None,
            unread_sessions: Default::default(),
            responded_cards: Default::default(),
            plan_approval_choices: Default::default(),
            credentials_status: Default::default(),
            device_config_status: Default::default(),
            provider_profile_status: Default::default(),
            undo_toast: None,
        })
    }

    async fn query<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> ViewQuery) -> Option<T> {
        let (rtx, rrx) = oneshot::channel();
        self.tx.send(Msg::View(make(rtx))).ok()?;
        rrx.await.ok()
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
    SetRelays(Vec<String>),
    QueryStatus(oneshot::Sender<(ConnectionStatus, bool)>),
    RelayEvent(NostrEvent),
    SocketOpen,
    SocketClose,
    RetryDue,
    VisibilitySettled,
    StaleWatchdog,
    PairDeadline,
    Send {
        machine: String,
        msg: Box<PhoneToBridge>,
        reply: Option<oneshot::Sender<PublishResult>>,
    },
    Intent {
        intent: Box<Intent>,
        reply: oneshot::Sender<()>,
    },
    View(ViewQuery),
    /// The off-loop publish of an outbox item settled.
    PublishSettled {
        id: String,
        result: PublishResult,
    },
    /// The delete-controller's 4 s undo window elapsed.
    UndoTimerFired,
    /// The connection FSM asked for a post-(re)connect reconcile.
    RefreshReconcile,
    /// A kind-1059 gift wrap arrived on the DM subscription.
    DmEvent(NostrEvent),
    /// The DM subscription of `epoch` died (not a deliberate teardown).
    DmClosed(u64),
    /// A kind-445 group message arrived on the Marmot subscription (the raw
    /// relay event object — the MLS engine re-decrypts from that, same as a
    /// buffered VEIL-029 re-feed).
    MarmotEvent(serde_json::Value),
    /// The Marmot subscription of `epoch` died.
    MarmotClosed(u64),
    /// A (re)connect: run the Marmot start sequence (engine init, group
    /// reconcile, KeyPackage / 10051 publish, then the 445 sub). Deferred to a
    /// message so the sync connection `apply` stays non-blocking.
    MarmotStart,
}

/// A read-projection request answered off the loop's own store snapshot.
enum ViewQuery {
    Machines(oneshot::Sender<MachinesView>),
    Settings(oneshot::Sender<SettingsView>),
    Outbox(oneshot::Sender<OutboxView>),
    Pairing(oneshot::Sender<PairingView>),
    Connection(oneshot::Sender<ConnectionView>),
    Dm(oneshot::Sender<DmView>),
    Marmot(oneshot::Sender<MarmotView>),
    QuickPrompts(oneshot::Sender<QuickPromptsView>),
    PendingSessions(oneshot::Sender<PendingSessionsView>),
    Ui(oneshot::Sender<UiView>),
    Transcript {
        machine: String,
        session_id: String,
        reply: oneshot::Sender<TranscriptRowsView>,
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
    /// CDX-040 pair-ack deadline.
    pair_timer: Option<AbortHandle>,
    /// The delete-controller's 4 s undo window.
    undo_timer: Option<AbortHandle>,
    /// The kind-1059 DM subscription + its epoch guard.
    dm_sub: Option<Box<dyn crate::nostr_client::TransportSub>>,
    dm_epoch: u64,
    /// The kind-445 Marmot group-message subscription (over joined `h` tags).
    marmot_sub: Option<Box<dyn crate::nostr_client::TransportSub>>,
    marmot_epoch: u64,
    self_tx: mpsc::UnboundedSender<Msg>,
    // --- F2b: the composed store layer ---
    stores: CoreStores,
    kv: Rc<dyn Kv>,
    transcript_store: Rc<dyn TranscriptStore>,
    notifier: Rc<dyn Notifier>,
    http: Rc<dyn crate::attachments::HttpFetch>,
    /// The MLS engine — `on_dm_event` routes kind-444 welcomes to it. Inert
    /// (`NoMarmot`, every call errors → the welcome counts invalid) until the
    /// MDK engine is relocated into this crate.
    marmot_engine: Rc<dyn crate::marmot::MarmotEngine>,
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
                Msg::SetRelays(relays) => self.nostr.set_relays(&relays),
                Msg::QueryStatus(reply) => {
                    let _ = reply.send((self.conn.status, self.conn.needs_pairing_check));
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
                Msg::RelayEvent(event) => self.on_relay_event(event).await,
                Msg::Send { machine, msg, reply } => self.on_send(machine, *msg, reply),
                Msg::PairDeadline => self.on_pair_deadline(),
                Msg::Intent { intent, reply } => {
                    self.on_intent(*intent).await;
                    let _ = reply.send(());
                }
                Msg::View(query) => self.answer_view(query).await,
                Msg::PublishSettled { id, result } => self.on_publish_settled(id, result).await,
                Msg::UndoTimerFired => self.on_undo_timer().await,
                Msg::RefreshReconcile => self.on_refresh_reconcile().await,
                Msg::DmEvent(event) => self.on_dm_event(event).await,
                Msg::DmClosed(epoch) => {
                    if epoch == self.dm_epoch {
                        self.dm_sub = None;
                    }
                }
                Msg::MarmotEvent(event) => self.on_marmot_event(event).await,
                Msg::MarmotClosed(epoch) => {
                    if epoch == self.marmot_epoch {
                        self.marmot_sub = None;
                    }
                }
                Msg::MarmotStart => self.on_marmot_start().await,
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
            self.state_changed(SliceId::Connection);
        }
    }

    fn apply(&mut self, effect: ConnectionEffect) {
        match effect {
            ConnectionEffect::OpenSocket => {
                self.ws.ensure_connected();
                self.nostr.connect();
                self.start_dm_sub();
                let _ = self.self_tx.send(Msg::MarmotStart);
            }
            ConnectionEffect::CloseSocket => {
                self.nostr.disconnect();
                self.stop_dm_sub();
                self.stop_marmot_sub();
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
            // A (re)connect: reset stuck sync cycles, ask every machine for a
            // fresh list, reconcile from what we know. Deferred to a message so
            // this sync `apply` can stay non-blocking.
            ConnectionEffect::RefreshAndReconcile => {
                let _ = self.self_tx.send(Msg::RefreshReconcile);
            }
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

    async fn on_relay_event(&mut self, event: NostrEvent) {
        let known = self.machines.iter().any(|m| m == &event.pubkey);

        // A 30515 from a PAIRED machine IS a heartbeat — feed the FSM for
        // presence + CDX-020 whether or not the payload decodes (a chunked
        // list is `Buffered`, not `Message`, yet the machine is alive). Gate on
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
        let ingested = self
            .api
            .ingest(&incoming, &self.identity, known, self.clock.now_ms());
        match ingested {
            Ingested::Message(msg) => {
                // F2b: fold the decoded message into the composed store layer,
                // then carry out its effects. The observer callback stays for
                // the transitional native-core seam (the WebView still consumes
                // decoded messages until `apps/mobile` is re-pointed).
                let machine = event.pubkey.clone();
                let now = self.clock.now_ms();
                let visible = self.conn.visible;
                let notify_enabled = self.stores.settings.data.notifications_enabled;
                let mut router = Router::new(
                    &mut self.stores,
                    self.transcript_store.as_ref(),
                    &self.identity,
                    now,
                );
                router.visible = visible;
                router.notify_enabled = notify_enabled;
                let result = router.route(&machine, &msg).await;
                self.interpret_route(result).await;
                self.observer.bridge_message(machine, *msg);
            }
            Ingested::DecryptFailed => {
                self.dispatch(ConnectionEvent::DecryptFailure);
                self.observer.action_failed(ActionFailed::DecryptFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailed::DecryptFailed,
                });
            }
            Ingested::DecodeFailed => {
                self.observer.action_failed(ActionFailed::DecodeFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailed::DecodeFailed,
                });
            }
            Ingested::Buffered | Ingested::UnknownMachine => {}
        }
    }

    fn emit(&self, event: CoreEvent) {
        self.observer.on_event(event);
    }

    fn state_changed(&self, slice: SliceId) {
        self.emit(CoreEvent::StateChanged { slice });
    }

    /// Carry out the side effects a [`Router`] / intent produced.
    async fn interpret_route(&mut self, r: RouteResult) {
        for &id in &r.persist {
            self.persist_store(id).await;
            self.state_changed(slice_of(id));
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if !r.notifies.is_empty() {
            self.state_changed(SliceId::Cards);
        }
        for effect in r.notifies {
            if let NotifyEffect::Notify { content, tag } = effect {
                self.notifier.notify(&content.title, &content.body, Some(&tag));
            }
            // Ping seam not wired yet (F2b: the chime is a platform port).
        }
        if !r.transcript_removed.is_empty() {
            self.state_changed(SliceId::Transcript);
        }
        for (machine, session) in r.transcript_removed {
            self.transcript_store.remove(&machine, &session).await;
        }
        for (id, delivered) in r.outbox_settled {
            self.emit(CoreEvent::OutboxSettled { id, delivered });
        }
        if let Some(paired) = r.pairing_settled {
            self.emit(CoreEvent::PairingSettled { paired });
            self.state_changed(SliceId::Pairing);
        }
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        if r.pending_sessions_changed {
            self.state_changed(SliceId::PendingSessions);
        }
        if r.ui_changed {
            self.state_changed(SliceId::Ui);
        }
        if let Some((machine, session_id)) = r.transcript_appended {
            self.emit(CoreEvent::TranscriptAppended { machine, session_id });
        }
        match r.pair_deadline {
            Some(PairDeadline::Arm { ms }) => {
                abort(&mut self.pair_timer);
                self.pair_timer = Some(self.arm(ms, Msg::PairDeadline));
            }
            Some(PairDeadline::Clear) => abort(&mut self.pair_timer),
            None => {}
        }
        // `r.heartbeat` is already covered by the pre-decode path above;
        // `r.mesh_join` needs a platform seam (F2b).
    }

    async fn persist_store(&self, id: StoreId) {
        let p = Persister::new(self.kv.as_ref());
        match id {
            StoreId::Machines => p.save_machines(&self.stores.machines).await,
            StoreId::Outbox => p.save_outbox(&self.stores.outbox).await,
            StoreId::Settings => p.save_settings(&self.stores.settings).await,
            StoreId::QuickPrompts => p.save_quick_prompts(&self.stores.quick_prompts).await,
            StoreId::Dm => p.save_dm(&self.stores.dm).await,
            StoreId::Marmot => p.save_marmot(&self.stores.marmot).await,
        }
    }

    /// Subscription authors = registered machines + the pairing candidate (its
    /// pair-ack must pass the filter). Push them to the `HostBridge` and, if
    /// connected, re-REQ.
    fn refresh_authors(&mut self) {
        let mut authors = self.stores.machines.machine_pubkeys();
        if let Some(candidate) = &self.stores.pairing.candidate {
            if !authors.contains(&candidate.pubkey_hex) {
                authors.push(candidate.pubkey_hex.clone());
            }
        }
        *self.host.machines.borrow_mut() = authors.clone();
        self.machines = authors;
        if matches!(
            self.conn.status,
            ConnectionStatus::Connected | ConnectionStatus::Connecting
        ) {
            self.nostr.resubscribe();
        }
    }

    /// Fold a user action into the stores and carry out its effects.
    async fn on_intent(&mut self, intent: Intent) {
        let ctx = IntentCtx {
            now: self.clock.now_ms(),
            visible: self.conn.visible,
        };
        let result = apply_intent(&mut self.stores, intent, &self.identity, ctx);
        let dm_send = result.dm_send.clone();
        let dm_image_send = result.dm_image_send.clone();
        let session_image_send = result.session_image_send.clone();
        let marmot_accept = result.marmot_accept.clone();
        let marmot_send = result.marmot_send.clone();
        let marmot_start_chat = result.marmot_start_chat.clone();
        self.interpret_intent(result).await;
        if let Some((peer, text)) = dm_send {
            self.send_dm(peer, text).await;
        }
        if let Some((peer, text, image)) = dm_image_send {
            self.send_dm_image(peer, text, image).await;
        }
        if let Some(send) = session_image_send {
            self.send_session_image(
                send.machine,
                send.session_id,
                send.text,
                send.image,
                send.filename,
                send.mime_type,
            )
            .await;
        }
        if let Some(welcome_id) = marmot_accept {
            self.accept_marmot_welcome(welcome_id).await;
        }
        if let Some((group_id, text)) = marmot_send {
            self.send_marmot_message(group_id, text).await;
        }
        if let Some(peer_pubkey) = marmot_start_chat {
            self.start_marmot_chat(peer_pubkey).await;
        }
    }

    /// Encrypt + upload an image, then send it as a DM (the ref line appended
    /// to `text`).
    async fn send_dm_image(&mut self, peer: String, text: String, image: Vec<u8>) {
        let opts = crate::attachments::UploadOptions::at(self.clock.now_ms());
        match crate::attachments::upload_encrypted_image(
            &image,
            &self.identity,
            self.http.as_ref(),
            opts,
        )
        .await
        {
            Ok(reference) => {
                let line = client_core::dm_attachments::build_image_ref(&reference);
                let body = if text.is_empty() {
                    line
                } else {
                    format!("{text}\n{line}")
                };
                self.send_dm(peer, body).await;
            }
            Err(_) => self.observer.action_failed(ActionFailed::PublishRejected),
        }
    }

    async fn interpret_intent(&mut self, r: IntentResult) {
        for &id in &r.persist {
            self.persist_store(id).await;
            self.state_changed(slice_of(id));
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if let Some(o) = r.outbox_send {
            self.on_send_tracked(o.id, o.machine, o.msg);
        }
        if let Some(relays) = r.relays_changed {
            self.nostr.set_relays(&relays);
        }
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        match r.pair_deadline {
            Some(PairDeadline::Arm { ms }) => {
                abort(&mut self.pair_timer);
                self.pair_timer = Some(self.arm(ms, Msg::PairDeadline));
            }
            Some(PairDeadline::Clear) => abort(&mut self.pair_timer),
            None => {}
        }
        match r.undo_timer {
            Some(UndoTimer::Arm { ms }) => {
                abort(&mut self.undo_timer);
                self.undo_timer = Some(self.arm(ms, Msg::UndoTimerFired));
            }
            Some(UndoTimer::Clear) => abort(&mut self.undo_timer),
            None => {}
        }
        if let Some(paired) = r.pairing_settled {
            self.emit(CoreEvent::PairingSettled { paired });
        }
        if r.pair_deadline.is_some() || r.pairing_settled.is_some() {
            self.state_changed(SliceId::Pairing);
        }
        if r.pending_sessions_changed {
            self.state_changed(SliceId::PendingSessions);
        }
        if r.ui_changed {
            self.state_changed(SliceId::Ui);
        }
        if !r.transcript_removed.is_empty() {
            self.state_changed(SliceId::Transcript);
        }
        for (machine, session) in r.transcript_removed {
            self.transcript_store.remove(&machine, &session).await;
        }
        // CDX-026c: opening a session/DM the user was notified about clears
        // every notification filed under its (coarser-than-delivery) tag.
        for effect in r.ui_effects {
            match effect {
                UiEffect::SessionViewed { machine, session_id } => {
                    self.notifier.cancel(&session_notify_tag(&machine, &session_id));
                }
                UiEffect::DmOpened { peer } => {
                    self.notifier.cancel(&dm_notify_tag(&peer));
                }
            }
        }
        // `r.tor_changed` needs a transport-proxy seam; `r.mesh_join` a mesh
        // seam (F2b ports).
    }

    /// Post-(re)connect reconcile. Port of `createPhoneCore`'s
    /// `refreshAndReconcile` handler.
    async fn on_refresh_reconcile(&mut self) {
        // Reset any sync cycle a prior failure left stuck.
        self.stores.transcript.on_reconnect(None);

        let machines = self.stores.machines.machine_pubkeys();
        for machine in &machines {
            // Ask for a fresh session list (the stored 30515's seqHigh goes
            // stale — CDX-008).
            self.on_send(
                machine.clone(),
                PhoneToBridge::RefreshSessions(protocol::commands::BareMsg {
                    version: Default::default(),
                }),
                None,
            );
            // Reconcile from what we already know while the answers travel.
            let targets: Vec<(String, u64)> = self
                .stores
                .machines
                .machine(machine)
                .map(|mv| {
                    mv.sessions
                        .iter()
                        .filter_map(|(id, v)| v.info.seq_high.map(|h| (id.clone(), h)))
                        .collect()
                })
                .unwrap_or_default();
            for (session_id, target) in targets {
                if target == 0 {
                    continue;
                }
                let effects = self.stores.transcript.ensure_synced(
                    machine,
                    &session_id,
                    target,
                    self.clock.now_ms(),
                );
                for e in effects {
                    self.on_send(machine.clone(), crate::dispatch::sync_effect_to_cmd(e), None);
                }
            }
        }

        self.stores.outbox.sweep(self.clock.now_ms());
        self.persist_store(StoreId::Outbox).await;
        self.state_changed(SliceId::Outbox);
    }

    /// The undo window elapsed — commit the delete (send `close-session`).
    async fn on_undo_timer(&mut self) {
        let effects = self.stores.delete_controller.timer_fired();
        let mut r = IntentResult::default();
        // The delete-controller's timer_fired only emits ClearUndoTimer +
        // SendCloseSession + HideUndoToast; route them through the same
        // interpreter path.
        for effect in effects {
            match effect {
                client_core::delete_controller::DeleteEffect::SendCloseSession {
                    machine,
                    session_id,
                } => r.sends.push(RouteSend {
                    machine,
                    msg: PhoneToBridge::CloseSession(
                        protocol::commands::SessionIdMsg {
                            version: Default::default(),
                            session_id,
                        },
                    ),
                }),
                client_core::delete_controller::DeleteEffect::ClearUndoTimer => {
                    abort(&mut self.undo_timer)
                }
                client_core::delete_controller::DeleteEffect::HideUndoToast => {
                    self.stores.ui.set_undo_toast(None)
                }
                _ => {}
            }
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        // `commit()` only ever emits ClearUndoTimer + SendCloseSession +
        // HideUndoToast (see delete_controller::commit) — never a card
        // effect. This was `SliceId::Cards`, which notified nothing that
        // could see `stores.ui.undo_toast` had just been cleared: the undo
        // toast would silently outlive its own window forever once the user
        // let it expire instead of tapping undo (a `UiView` consumer never
        // learns to re-fetch).
        self.state_changed(SliceId::Ui);
    }

    async fn answer_view(&self, query: ViewQuery) {
        match query {
            ViewQuery::Machines(reply) => {
                let _ = reply.send(MachinesView::from_stores(&self.stores));
            }
            ViewQuery::Settings(reply) => {
                let _ = reply.send(SettingsView::from_stores(&self.stores));
            }
            ViewQuery::Outbox(reply) => {
                let _ = reply.send(OutboxView::from_stores(&self.stores));
            }
            ViewQuery::Pairing(reply) => {
                let _ = reply.send(PairingView::from_stores(&self.stores));
            }
            ViewQuery::Connection(reply) => {
                let _ = reply.send(ConnectionView::new(
                    self.conn.status,
                    self.conn.needs_pairing_check,
                ));
            }
            ViewQuery::Dm(reply) => {
                let _ = reply.send(DmView::from_stores(&self.stores));
            }
            ViewQuery::Marmot(reply) => {
                let _ = reply.send(MarmotView::from_stores(&self.stores));
            }
            ViewQuery::QuickPrompts(reply) => {
                let _ = reply.send(QuickPromptsView::from_stores(&self.stores));
            }
            ViewQuery::PendingSessions(reply) => {
                let _ = reply.send(PendingSessionsView::from_stores(&self.stores));
            }
            ViewQuery::Ui(reply) => {
                let _ = reply.send(UiView::from_stores(&self.stores));
            }
            ViewQuery::Transcript { machine, session_id, reply } => {
                let view = TranscriptRowsView::load(
                    &self.stores.transcript,
                    self.transcript_store.as_ref(),
                    &machine,
                    &session_id,
                )
                .await;
                let _ = reply.send(view);
            }
        }
    }

    // --- NIP-17 DM runtime ---

    /// (Re)open the kind-1059 subscription with a fresh epoch + catch-up cursor,
    /// and publish the kind-10050 DM relay list.
    fn start_dm_sub(&mut self) {
        self.dm_epoch += 1;
        let epoch = self.dm_epoch;
        if let Some(sub) = self.dm_sub.take() {
            sub.close();
        }
        let filter = Filter {
            kinds: vec![GIFT_WRAP_KIND],
            authors: Vec::new(),
            p_tags: vec![self.identity.pubkey_hex.clone()],
            h_tags: Vec::new(),
            since: self.stores.dm.since_cursor().map(|s| s as i64),
        };
        let ev_tx = self.self_tx.clone();
        let close_tx = self.self_tx.clone();
        let callbacks = SubCallbacks {
            on_event: Rc::new(move |ev: &NostrEvent| {
                let _ = ev_tx.send(Msg::DmEvent(ev.clone()));
            }),
            on_eose: Rc::new(|| {}),
            on_close: Rc::new(move |_reason| {
                let _ = close_tx.send(Msg::DmClosed(epoch));
            }),
        };
        self.dm_sub = Some(self.ws.subscribe(filter, callbacks));

        let relays = self.stores.settings.data.relays.clone();
        if !relays.is_empty() {
            if let Ok(event) =
                relay_list_event(&self.identity, DM_RELAY_LIST_KIND, &relays, self.clock.now_ms() / 1000)
            {
                self.publish_raw(event);
            }
        }
    }

    fn stop_dm_sub(&mut self) {
        self.dm_epoch += 1; // orphan any in-flight callback
        if let Some(sub) = self.dm_sub.take() {
            sub.close();
        }
    }

    /// A kind-1059 gift wrap: unwrap, and either fold a kind-14 rumor into the
    /// DM store or count it (CD-001: never silent, never a throw).
    async fn on_dm_event(&mut self, ev: NostrEvent) {
        self.stores.dm.note_event_received();
        let me = self.identity.pubkey_hex.clone();
        match unwrap_gift_parts(&self.identity, &ev.pubkey, &ev.content) {
            Err(_) => self.stores.dm.note_unwrap_failure(),
            Ok(rumor) if rumor.kind == DM_RUMOR_KIND => {
                let outcome = self.stores.dm.ingest_dm_rumor(&rumor, &me);
                if let AddOutcome::Inserted {
                    is_incoming,
                    counts_unread,
                    ..
                } = outcome
                {
                    self.persist_store(StoreId::Dm).await;
                    self.state_changed(SliceId::Dm);
                    if is_incoming && counts_unread {
                        let preview = truncate_preview(&rumor.content);
                        self.run_notify(NotifyEvent::DmReceived {
                            peer: rumor.pubkey.clone(),
                            peer_label: None,
                            preview: Some(preview),
                        });
                    }
                }
            }
            // A Marmot welcome (kind-444) rides the SAME 1059 subscription:
            // hand the ORIGINAL event to the MLS engine, which re-unwraps it
            // with its own keys. `NoMarmot` errors — then it counts invalid,
            // as it did before the engine existed.
            Ok(rumor) if rumor.kind == WELCOME_RUMOR_KIND => {
                match self.marmot_engine.ingest(&ev.raw).await {
                    Ok(MarmotIngested::Welcome(welcome)) => {
                        let kp_changed = self.stores.marmot.apply_welcome(welcome);
                        if kp_changed {
                            self.persist_store(StoreId::Marmot).await;
                        }
                        self.state_changed(SliceId::Marmot);
                    }
                    Ok(MarmotIngested::Ignored { .. }) => self.stores.marmot.note_ignored(),
                    Ok(_) => {}
                    Err(_) => self.stores.dm.note_invalid_rumor(),
                }
            }
            Ok(_) => self.stores.dm.note_invalid_rumor(),
        }
    }

    /// NIP-17 send: wrap the rumor once, publish the recipient + self copies,
    /// and add it locally (optimistic, status `sent`).
    async fn send_dm(&mut self, peer: String, text: String) {
        let Ok(wrapped) = wrap_dm(&self.identity, &peer, &text).await else {
            self.observer.action_failed(ActionFailed::PublishRejected);
            return;
        };
        self.publish_raw(wrapped.for_recipient);
        self.publish_raw(wrapped.for_self);
        let me = self.identity.pubkey_hex.clone();
        let rumor = DmRumor {
            id: wrapped.rumor_id,
            pubkey: me.clone(),
            kind: DM_RUMOR_KIND,
            content: text,
            created_at: wrapped.created_at,
            tags: vec![vec!["p".to_string(), peer]],
        };
        self.stores.dm.ingest_dm_rumor(&rumor, &me);
        self.persist_store(StoreId::Dm).await;
        self.state_changed(SliceId::Dm);
    }

    // --- Marmot (MLS group) runtime ---

    /// (Re)open the kind-445 subscription over the joined groups' `h` tags with
    /// a fresh epoch + catch-up cursor. A group with no joined `h` tags has
    /// nothing to listen for, so the subscription is torn down until a welcome
    /// is accepted (which calls this again).
    fn start_marmot_sub(&mut self) {
        self.marmot_epoch += 1;
        let epoch = self.marmot_epoch;
        if let Some(sub) = self.marmot_sub.take() {
            sub.close();
        }
        let h_tags = self.stores.marmot.h_tags();
        if h_tags.is_empty() {
            return;
        }
        let filter = Filter {
            kinds: vec![GROUP_MESSAGE_KIND],
            authors: Vec::new(),
            p_tags: Vec::new(),
            h_tags,
            since: self.stores.marmot.since_cursor().map(|s| s as i64),
        };
        let ev_tx = self.self_tx.clone();
        let close_tx = self.self_tx.clone();
        let callbacks = SubCallbacks {
            on_event: Rc::new(move |ev: &NostrEvent| {
                let _ = ev_tx.send(Msg::MarmotEvent(ev.raw.clone()));
            }),
            on_eose: Rc::new(|| {}),
            on_close: Rc::new(move |_reason| {
                let _ = close_tx.send(Msg::MarmotClosed(epoch));
            }),
        };
        self.marmot_sub = Some(self.ws.subscribe(filter, callbacks));
    }

    fn stop_marmot_sub(&mut self) {
        self.marmot_epoch += 1; // orphan any in-flight callback
        if let Some(sub) = self.marmot_sub.take() {
            sub.close();
        }
    }

    /// A kind-445 group message: feed it to the MLS engine and fold the decrypted
    /// result into the Marmot store. A 445 for a group we have not joined yet is
    /// buffered (VEIL-029) and re-fed once the welcome is accepted; it is never
    /// dropped and never a throw. `NoMarmot` errors — then it counts as an
    /// engine error, as it did before the engine existed. Also the entry point
    /// for a VEIL-029 re-feed, which passes the buffered event verbatim.
    async fn on_marmot_event(&mut self, raw: serde_json::Value) {
        self.stores.marmot.note_event_received();
        let me = self.identity.pubkey_hex.clone();
        match self.marmot_engine.ingest(&raw).await {
            Ok(MarmotIngested::Message(result)) => {
                if let Some(MarmotAddOutcome::Inserted {
                    is_incoming,
                    counts_unread,
                }) = self.stores.marmot.apply_group_message(&result, &me)
                {
                    self.persist_store(StoreId::Marmot).await;
                    self.state_changed(SliceId::Marmot);
                    if is_incoming && counts_unread {
                        let preview = truncate_preview(&result.content);
                        self.run_notify(NotifyEvent::DmReceived {
                            peer: result.sender.clone(),
                            peer_label: None,
                            preview: Some(preview),
                        });
                    }
                }
            }
            // A 445 whose group is not joined yet: hold the ORIGINAL event so it
            // can be re-fed verbatim after `accept_welcome` (VEIL-029 / -167).
            Ok(MarmotIngested::NotJoined { h_tag }) => {
                self.stores.marmot.buffer_not_joined(&h_tag, raw);
                self.state_changed(SliceId::Marmot);
            }
            Ok(MarmotIngested::Welcome(welcome)) => {
                let kp_changed = self.stores.marmot.apply_welcome(welcome);
                if kp_changed {
                    self.persist_store(StoreId::Marmot).await;
                }
                self.state_changed(SliceId::Marmot);
            }
            Ok(MarmotIngested::Ignored { .. }) => self.stores.marmot.note_ignored(),
            Ok(MarmotIngested::None) => {}
            Err(_) => self.stores.marmot.note_error(),
        }
    }

    /// (Re)connect: engine init (idempotent) → reconcile joined groups from the
    /// engine → apply any pending welcomes → mint + publish the KeyPackage once
    /// (CDX-030) plus the kind-10051 KP relay list → open the 445 subscription.
    /// `NoMarmot` fails `init`, so with the engine absent this is a no-op and
    /// Marmot chats stay unavailable (NIP-17 only), same as before the engine
    /// existed.
    async fn on_marmot_start(&mut self) {
        if self
            .marmot_engine
            .init(&self.identity.secret_hex())
            .await
            .is_err()
        {
            return;
        }
        self.stores.marmot.available = true;

        // A restart or a peer's action may have changed the joined groups —
        // reconcile from the engine's own book-keeping.
        if let Ok(groups) = self.marmot_engine.list_groups().await {
            if !groups.is_empty() {
                let me = self.identity.pubkey_hex.clone();
                let now = self.clock.now_ms();
                for g in &groups {
                    self.stores.marmot.upsert_conversation(g, &me, now);
                }
                self.persist_store(StoreId::Marmot).await;
                self.state_changed(SliceId::Marmot);
            }
        }

        if let Ok(welcomes) = self.marmot_engine.pending_welcomes().await {
            if !welcomes.is_empty() {
                for w in welcomes {
                    self.stores.marmot.apply_welcome(w);
                }
                self.state_changed(SliceId::Marmot);
            }
        }

        let relays = self.stores.settings.data.relays.clone();
        if !relays.is_empty() {
            let now = self.clock.now_ms();
            let payload = serde_json::to_string(&relays).unwrap_or_default();
            if should_mint_key_package(
                self.stores.marmot.published_key_package.as_ref(),
                &payload,
                now,
                KEY_PACKAGE_ROTATION_MS,
            ) {
                if let Ok(kp_event) = self.marmot_engine.publish_key_package(&relays).await {
                    if let Some(record) = key_package_record(&kp_event, &payload, now) {
                        self.publish_value(kp_event);
                        self.stores.marmot.store_published_key_package(record);
                        self.persist_store(StoreId::Marmot).await;
                    }
                }
            }
            if let Ok(event) =
                relay_list_event(&self.identity, KP_RELAY_LIST_KIND, &relays, now / 1000)
            {
                self.publish_raw(event);
            }
        }

        self.start_marmot_sub();
    }

    /// Publish an event the Marmot engine produced (kind 445 / 30443 JSON, same
    /// field shape as [`protocol::nostr_event::SignedEvent`]).
    fn publish_value(&self, event: serde_json::Value) {
        match serde_json::from_value::<protocol::nostr_event::SignedEvent>(event) {
            Ok(ev) => self.publish_raw(ev),
            Err(_) => self.observer.action_failed(ActionFailed::PublishRejected),
        }
    }

    /// The user accepted a pending Marmot welcome: join the group engine-side,
    /// upsert the conversation, re-feed the 445s buffered for its `h` tag while
    /// unjoined (VEIL-029, in order), then reopen the 445 sub to cover it.
    /// VEIL-117: a welcome that can never be accepted (a stale KeyPackage after
    /// reinstall) drops the card instead of retrying forever.
    async fn accept_marmot_welcome(&mut self, welcome_id: String) {
        let info = match self.marmot_engine.accept_welcome(&welcome_id).await {
            Ok(info) => info,
            Err(_) => {
                self.stores.marmot.drop_pending_welcome(&welcome_id);
                self.stores.marmot.note_error();
                self.persist_store(StoreId::Marmot).await;
                self.state_changed(SliceId::Marmot);
                return;
            }
        };
        let me = self.identity.pubkey_hex.clone();
        let now = self.clock.now_ms();
        let h_tag = self
            .stores
            .marmot
            .on_welcome_accepted(&welcome_id, &info, &me, now);
        self.persist_store(StoreId::Marmot).await;
        self.state_changed(SliceId::Marmot);

        for buffered in self.stores.marmot.take_buffered_for(&h_tag) {
            self.on_marmot_event(buffered).await;
        }
        self.start_marmot_sub();
    }

    /// Send a Marmot group message: the engine encrypts it into a kind-445
    /// event, which we publish; the plaintext is added locally (optimistic,
    /// status `sent`) so the sender sees it immediately.
    async fn send_marmot_message(&mut self, group_id: String, text: String) {
        let out = match self.marmot_engine.send(&group_id, &text).await {
            Ok(out) => out,
            Err(_) => {
                self.observer.action_failed(ActionFailed::PublishRejected);
                return;
            }
        };
        self.publish_value(out.event);
        let me = self.identity.pubkey_hex.clone();
        self.stores.marmot.add_message(
            client_core::stores::marmot::MarmotMessage {
                id: out.rumor_id,
                group_id,
                sender_pubkey: me.clone(),
                content: text,
                at: out.created_at.saturating_mul(1000),
                status: client_core::stores::marmot::MarmotMessageStatus::Sent,
            },
            &me,
        );
        self.persist_store(StoreId::Marmot).await;
        self.state_changed(SliceId::Marmot);
    }

    /// One-shot fetch of `peer_pubkey`'s newest kind-30443 KeyPackage.
    /// `None` on timeout or if the peer never published one — never errors,
    /// mirrors the TS `fetchKeyPackage` (a temporary sub, EOSE or the timeout
    /// closes it, never left dangling).
    async fn fetch_key_package(&self, peer_pubkey: &str, timeout_ms: u64) -> Option<serde_json::Value> {
        use client_core::stores::marmot::KEY_PACKAGE_KIND;

        let filter = Filter {
            kinds: vec![KEY_PACKAGE_KIND],
            authors: vec![peer_pubkey.to_string()],
            p_tags: Vec::new(),
            h_tags: Vec::new(),
            since: None,
        };
        let newest: Rc<RefCell<Option<(i64, serde_json::Value)>>> = Rc::new(RefCell::new(None));
        let (done_tx, mut done_rx) = mpsc::unbounded_channel::<()>();

        let newest_ev = Rc::clone(&newest);
        let peer = peer_pubkey.to_string();
        let eose_tx = done_tx.clone();
        let close_tx = done_tx;
        let callbacks = SubCallbacks {
            on_event: Rc::new(move |ev: &NostrEvent| {
                if ev.pubkey != peer {
                    return;
                }
                let mut slot = newest_ev.borrow_mut();
                let replace = match slot.as_ref() {
                    Some((newest_at, _)) => ev.created_at > *newest_at,
                    None => true,
                };
                if replace {
                    *slot = Some((ev.created_at, ev.raw.clone()));
                }
            }),
            on_eose: Rc::new(move || {
                let _ = eose_tx.send(());
            }),
            on_close: Rc::new(move |_reason| {
                let _ = close_tx.send(());
            }),
        };
        let sub = self.ws.subscribe(filter, callbacks);
        tokio::select! {
            _ = done_rx.recv() => {}
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {}
        }
        sub.close();
        let taken = newest.borrow_mut().take();
        taken.map(|(_, value)| value)
    }

    /// Open (or start) a 1:1 Marmot chat: an existing conversation with `peer`
    /// is reused, never duplicated — opening it in the UI is a separate
    /// `SelectMarmotGroup`. Otherwise fetch the peer's newest KeyPackage, ask
    /// the engine to create the group, and publish the resulting welcome.
    /// A missing KeyPackage or an engine/publish failure surfaces as
    /// `ActionFailed` — no half-created group is left for the UI to trip over.
    async fn start_marmot_chat(&mut self, peer_pubkey: String) {
        use client_core::stores::marmot::{MarmotGroupInfo, KEY_PACKAGE_FETCH_TIMEOUT_MS};

        let fail = |this: &Self| {
            this.observer.action_failed(ActionFailed::PublishRejected);
            this.observer
                .on_event(CoreEvent::ActionFailed { kind: ActionFailed::PublishRejected });
        };

        if !self.stores.marmot.available {
            fail(self);
            return;
        }
        if self
            .stores
            .marmot
            .conversations
            .values()
            .any(|c| c.peer_pubkey == peer_pubkey)
        {
            return;
        }

        let Some(kp_event) = self
            .fetch_key_package(&peer_pubkey, KEY_PACKAGE_FETCH_TIMEOUT_MS)
            .await
        else {
            fail(self);
            return;
        };

        let relays = self.stores.settings.data.relays.clone();
        let created = match self
            .marmot_engine
            .create_group(&peer_pubkey, &kp_event, &relays)
            .await
        {
            Ok(created) => created,
            Err(_) => {
                fail(self);
                return;
            }
        };

        let Ok(welcome) =
            serde_json::from_value::<protocol::nostr_event::SignedEvent>(created.welcome_event)
        else {
            fail(self);
            return;
        };
        let result = self
            .ws
            .publish_confirmed(&welcome, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
            .await;
        if !matches!(result.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed) {
            // The group exists engine-side but the peer can never join — a
            // retry from the UI creates a fresh group rather than reusing this
            // dead one.
            fail(self);
            return;
        }

        let me = self.identity.pubkey_hex.clone();
        let now = self.clock.now_ms();
        let info = MarmotGroupInfo {
            group_id: created.group_id,
            h_tag: created.h_tag,
            name: String::new(),
            members: vec![me.clone(), peer_pubkey],
            admins: Vec::new(),
            active: true,
        };
        self.stores.marmot.upsert_conversation(&info, &me, now);
        self.persist_store(StoreId::Marmot).await;
        self.state_changed(SliceId::Marmot);
        self.start_marmot_sub();
    }

    /// Run the notification coordinator for one event and deliver its effects.
    fn run_notify(&mut self, event: NotifyEvent) {
        let visible = self.conn.visible;
        let enabled = self.stores.settings.data.notifications_enabled;
        let effects = self
            .stores
            .notifications
            .emit(&event, visible, enabled, false, None, self.clock.now_ms());
        if !effects.is_empty() {
            self.state_changed(SliceId::Cards);
        }
        for effect in effects {
            if let client_core::notifications::NotifyEffect::Notify { content, tag } = effect {
                self.notifier.notify(&content.title, &content.body, Some(&tag));
            }
        }
    }

    /// Publish a pre-built signed event (DM wraps, the 10050 relay list) off the
    /// loop.
    fn publish_raw(&self, event: protocol::nostr_event::SignedEvent) {
        let ws = self.ws.clone();
        tokio::task::spawn_local(async move {
            let _ = ws
                .publish_confirmed(&event, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
        });
    }

    /// CDX-040: the pair-ack deadline elapsed.
    fn on_pair_deadline(&mut self) {
        use client_core::stores::pairing::{
            pairing_reducer, PairingEvent, PairingPhase, PAIR_ACK_TIMEOUT_MS,
        };
        let result = pairing_reducer(
            &self.stores.pairing,
            PairingEvent::DeadlineFired,
            PAIR_ACK_TIMEOUT_MS,
        );
        let settled = matches!(result.state.phase, PairingPhase::Failed);
        self.stores.pairing = result.state;
        abort(&mut self.pair_timer);
        if settled {
            self.emit(CoreEvent::PairingSettled { paired: false });
            self.state_changed(SliceId::Pairing);
        }
    }

    fn on_send(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
    ) {
        self.publish_command(machine, msg, reply, None);
    }

    /// Like [`Self::on_send`] but the publish outcome comes back as
    /// [`Msg::PublishSettled`] so the loop can settle an outbox item.
    fn on_send_tracked(&mut self, id: String, machine: String, msg: PhoneToBridge) {
        self.publish_command(machine, msg, None, Some(id));
    }

    fn publish_command(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    ) {
        let now = self.clock.now_ms();
        let event = match build_command(&self.identity, &machine, &msg, now) {
            Ok(event) => event,
            Err(err) => {
                self.observer.action_failed(ActionFailed::PublishRejected);
                let result = PublishResult {
                    verdict: PublishVerdict::Rejected,
                    detail: Some(egress_detail(&err)),
                };
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                } else if let Some(id) = outbox_id {
                    let _ = self.self_tx.send(Msg::PublishSettled { id, result });
                }
                return;
            }
        };

        // Publish off the loop so a 12s confirmation budget never blocks
        // socket-close / lifecycle handling.
        let ws = self.ws.clone();
        let observer = Rc::clone(&self.observer);
        let self_tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let result = ws
                .publish_confirmed(&event, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
            let failed = match result.verdict {
                PublishVerdict::Rejected => Some(ActionFailed::PublishRejected),
                PublishVerdict::Unreachable => Some(ActionFailed::PublishUnreachable),
                PublishVerdict::Accepted | PublishVerdict::Unconfirmed => None,
            };
            if let Some(kind) = failed {
                observer.action_failed(kind);
                observer.on_event(CoreEvent::ActionFailed { kind });
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            } else if let Some(id) = outbox_id {
                let _ = self_tx.send(Msg::PublishSettled { id, result });
            }
        });
    }

    /// Build + sign + publish one command inline (unlike [`Self::publish_command`],
    /// which is fire-and-forget off the loop) so a caller can branch on the
    /// verdict — the session-image upload needs that to decide Blossom vs.
    /// chunk fallback.
    async fn publish_and_confirm(
        &self,
        machine: &str,
        msg: PhoneToBridge,
        budget: Duration,
        attempts: u32,
    ) -> PublishResult {
        let now = self.clock.now_ms();
        match build_command(&self.identity, machine, &msg, now) {
            Ok(event) => self.ws.publish_confirmed(&event, budget, attempts).await,
            Err(err) => PublishResult {
                verdict: PublishVerdict::Rejected,
                detail: Some(egress_detail(&err)),
            },
        }
    }

    /// Session image upload (CDX-029), Blossom-first with a relay-chunk
    /// fallback — port of the TS `sendSessionImage`. Two INDEPENDENT stages:
    /// stage 1 puts the bytes somewhere durable, stage 2 tells the bridge
    /// where they are. Only a stage-1 failure reaches the chunk fallback — once
    /// the bridge is told a URL, the bytes are already on the server, so a
    /// stage-2 rejection is a hard failure, never a reason to re-upload
    /// megabytes over the relays. No optimistic local echo: the image lands in
    /// the transcript only once the bridge injects it, like any other output.
    async fn send_session_image(
        &mut self,
        machine: String,
        session_id: String,
        text: String,
        image: Vec<u8>,
        filename: String,
        mime_type: String,
    ) {
        use client_core::image_chunks::{chunk_base64, IMAGE_CHUNK_BYTES, IMAGE_CHUNK_DELAY_MS};
        use protocol::commands::{
            UploadImageBlossomMsg, UploadImageChunkMsg, UploadImageMsg, VersionFields,
        };

        /// Overall wall clock for the whole send, all stages together.
        const SESSION_IMAGE_SEND_BUDGET_MS: u64 = 120_000;
        /// Budget for the chunk fallback, from the first chunk. Deliberately
        /// under the bridge's 60 s chunk-assembly window (armed on the first
        /// chunk) — past that point every further chunk is guaranteed waste,
        /// the tracker is already gone. PAIRED CONSTANT with the bridge side.
        const CHUNK_ASSEMBLY_BUDGET_MS: u64 = 55_000;
        /// A run that cannot fit this window needs Blossom, not patience.
        const MAX_FALLBACK_CHUNKS: usize = 200;

        let started_at = self.clock.now_ms();
        let size_bytes = image.len() as u64;

        let fail = |this: &Self| {
            this.observer.action_failed(ActionFailed::PublishRejected);
            this.observer
                .on_event(CoreEvent::ActionFailed { kind: ActionFailed::PublishRejected });
        };

        // --- Stage 1: the bytes ---
        let opts = crate::attachments::UploadOptions::at(started_at);
        let uploaded =
            crate::attachments::upload_encrypted_image(&image, &self.identity, self.http.as_ref(), opts)
                .await;

        if let Ok(reference) = uploaded {
            // --- Stage 2: the reference ---
            let hash = client_core::image_chunks::blossom_hash_from_url(&reference.url).to_string();
            let msg = PhoneToBridge::UploadImage(UploadImageMsg::Blossom(UploadImageBlossomMsg {
                version: VersionFields::default(),
                session_id,
                hash,
                url: reference.url,
                key: reference.key,
                iv: reference.iv,
                filename,
                mime_type,
                text,
                size_bytes,
            }));
            let result = self
                .publish_and_confirm(&machine, msg, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
            if !matches!(result.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed) {
                fail(self);
            }
            return;
        }

        // --- Stage 3: chunk fallback (nobody holds the bytes) ---
        use base64::Engine as _;
        let base64_image = base64::engine::general_purpose::STANDARD.encode(&image);
        let chunks = chunk_base64(&base64_image, IMAGE_CHUNK_BYTES);
        if chunks.len() > MAX_FALLBACK_CHUNKS {
            fail(self);
            return;
        }
        let upload_id = format!("{started_at:x}-{:x}", (self.entropy.unit() * 1e9) as u64);
        let total_chunks = chunks.len() as u64;
        let chunks_started_at = self.clock.now_ms();
        for (i, chunk) in chunks.into_iter().enumerate() {
            let now = self.clock.now_ms();
            if now.saturating_sub(chunks_started_at) >= CHUNK_ASSEMBLY_BUDGET_MS
                || now.saturating_sub(started_at) >= SESSION_IMAGE_SEND_BUDGET_MS
            {
                fail(self);
                return;
            }
            let msg = PhoneToBridge::UploadImage(UploadImageMsg::Chunk(UploadImageChunkMsg {
                version: VersionFields::default(),
                session_id: session_id.clone(),
                upload_id: upload_id.clone(),
                filename: filename.clone(),
                mime_type: mime_type.clone(),
                base64_data: chunk,
                // Chunk 0 carries the caption; the rest must not repeat it.
                text: if i == 0 { text.clone() } else { String::new() },
                chunk_index: i as u64,
                total_chunks,
            }));
            // The TS client sends chunks with a single attempt each — the outer
            // budget disciplines the run, not per-frame retry.
            let result = self
                .publish_and_confirm(&machine, msg, PUBLISH_CONFIRM_BUDGET, 1)
                .await;
            if !matches!(result.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed) {
                fail(self);
                return;
            }
            if (i as u64) + 1 < total_chunks {
                tokio::time::sleep(Duration::from_millis(IMAGE_CHUNK_DELAY_MS)).await;
            }
        }
    }

    /// The publish of an outbox item settled — record it and emit `OutboxSettled`.
    async fn on_publish_settled(&mut self, id: String, result: PublishResult) {
        let accepted = matches!(
            result.verdict,
            PublishVerdict::Accepted | PublishVerdict::Unconfirmed
        );
        self.stores
            .outbox
            .settle_publish(&id, accepted, result.detail, self.clock.now_ms());
        self.persist_store(StoreId::Outbox).await;
        self.state_changed(SliceId::Outbox);
        // `delivered` here means "published" — the bridge `input-ack` is the
        // real confirmation and fires a second `OutboxSettled` via the router.
        self.emit(CoreEvent::OutboxSettled {
            id,
            delivered: accepted,
        });
    }
}

fn abort(slot: &mut Option<AbortHandle>) {
    if let Some(handle) = slot.take() {
        handle.abort();
    }
}

/// Notification / conversation-list preview cap (mirrors the TS 120/117 rule).
fn truncate_preview(content: &str) -> String {
    if content.chars().count() > 120 {
        let head: String = content.chars().take(117).collect();
        format!("{head}…")
    } else {
        content.to_string()
    }
}

/// Extract the `PublishedKeyPackage` bookkeeping record (CDX-030) from the
/// engine's KeyPackage event JSON: the event id and its `d` tag (the
/// addressable identity a rotation/republish replaces).
fn key_package_record(
    event: &serde_json::Value,
    relays_payload: &str,
    now_ms: u64,
) -> Option<PublishedKeyPackage> {
    let id = event.get("id")?.as_str()?.to_string();
    let d_tag = event
        .get("tags")
        .and_then(|t| t.as_array())
        .and_then(|tags| {
            tags.iter().find_map(|t| {
                let t = t.as_array()?;
                if t.first()?.as_str()? == "d" {
                    Some(t.get(1)?.as_str()?.to_string())
                } else {
                    None
                }
            })
        })
        .unwrap_or_default();
    Some(PublishedKeyPackage {
        id,
        d_tag,
        relays_payload: relays_payload.to_string(),
        published_at: now_ms,
        consumed: false,
    })
}

fn slice_of(id: StoreId) -> SliceId {
    match id {
        StoreId::Machines => SliceId::Machines,
        StoreId::Outbox => SliceId::Outbox,
        StoreId::Settings => SliceId::Settings,
        StoreId::QuickPrompts => SliceId::QuickPrompts,
        StoreId::Dm => SliceId::Dm,
        StoreId::Marmot => SliceId::Marmot,
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
    use crate::ports::RecordingNotifier;
    use crate::transport::mock::{mock_relay, MockRelay};
    use protocol::crypto::{generate_keypair, keypair_from_secret_hex};
    use protocol::codec::encode_bridge_to_phone;
    use protocol::commands::UploadImageMsg;
    use protocol::kinds::{LIVE_KIND, SESSION_LIST_KIND};
    use crate::intent::SessionImageSend;
    use std::sync::Mutex;
    use tokio::task::LocalSet;

    const SEC_PHONE: &str =
        "0000000000000000000000000000000000000000000000000000000000000001";

    #[derive(Default)]
    struct Spy {
        statuses: Mutex<Vec<(ConnectionStatus, bool)>>,
        messages: Mutex<Vec<(String, BridgeToPhone)>>,
        failures: Mutex<Vec<ActionFailed>>,
        events: Mutex<Vec<CoreEvent>>,
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
        Core::spawn(
            CoreConfig {
                relays: vec![mock.url.clone()],
                identity: phone.clone(),
                proxy: None,
                reconnect: fast_reconnect(),
            },
            ports,
            spy,
            Rc::new(FixedClock(RefCell::new(1_000_000))),
            Rc::new(ZeroEntropy),
        )
        .await
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
        fn get(
            &self,
            _url: &str,
        ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
        {
            Box::pin(async { Err("not used".to_string()) })
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
        fn get(
            &self,
            _url: &str,
        ) -> crate::ports::LocalBoxFuture<'_, Result<crate::attachments::HttpResponse, String>>
        {
            Box::pin(async { Err("no server".to_string()) })
        }
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

    /// EOSE the four subscriptions (3 bridge + 1 DM) and return the DM sub's id
    /// (the REQ whose filter is `kinds:[1059]`). All are named `cd-N` and replay
    /// in non-deterministic order; a kind-10050 EVENT is interleaved — skip it.
    async fn eose_all(mock: &mut MockRelay) -> String {
        let mut seen = 0;
        let mut dm_sub = String::new();
        while seen < 4 {
            let frame = mock.next_frame().await;
            let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
            if v[0] == "REQ" {
                let sub_id = v[1].as_str().unwrap().to_string();
                if v.get(2).and_then(|f| f["kinds"].as_array())
                    == Some(&vec![serde_json::json!(1059)])
                {
                    dm_sub = sub_id.clone();
                }
                mock.push(format!(r#"["EOSE","{sub_id}"]"#));
                seen += 1;
            }
        }
        dm_sub
    }

    /// Like [`eose_all`] but for a phone with a joined Marmot group: five REQs
    /// (3 bridge + DM + the kind-445 group sub). Returns the 445 sub's id.
    async fn eose_all_with_marmot(mock: &mut MockRelay) -> String {
        let mut seen = 0;
        let mut marmot_sub = String::new();
        while seen < 5 {
            let frame = mock.next_frame().await;
            let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
            if v[0] == "REQ" {
                let sub_id = v[1].as_str().unwrap().to_string();
                if v.get(2).and_then(|f| f["kinds"].as_array())
                    == Some(&vec![serde_json::json!(445)])
                {
                    marmot_sub = sub_id.clone();
                }
                mock.push(format!(r#"["EOSE","{sub_id}"]"#));
                seen += 1;
            }
        }
        marmot_sub
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

    // --- F2b: the composed store layer ---

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
                let mut status = "";
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

                // among the published EVENTs (the kind-10050 DM list, then the
                // command) find the one wrapped for the machine.
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
    async fn add_relay_intent_persists_and_repoints_the_transport() {
        LocalSet::new()
            .run_until(async {
                let mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let spy = Rc::new(Spy::default());
                let core = core_for(&mock, &phone, Rc::clone(&spy)).await;

                core.dispatch(Intent::AddRelay {
                    url: "wss://added.example".into(),
                })
                .await;

                let sv = core.settings_view().await.unwrap();
                assert!(sv.0.relays.iter().any(|r| r == "wss://added.example"));
                // the intent emits a Settings + a Machines (resubscribe) slice change
                let events = spy.events.lock().unwrap();
                assert!(events.contains(&CoreEvent::StateChanged {
                    slice: SliceId::Settings
                }));
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
    async fn selecting_a_session_or_dm_peer_cancels_its_notification_tag() {
        // CDX-026c: opening a session/DM the user was notified about clears
        // every notification filed under its tag — `IntentResult::ui_effects`
        // was already populated correctly by `SelectSession`/`SelectDmPeer`
        // (see the `intent` module's own tests), but nothing in the runtime
        // ever acted on it.
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
                core.dispatch(Intent::SelectDmPeer {
                    peer: Some("peer1".into()),
                })
                .await;

                assert_eq!(
                    notifier.cancelled(),
                    vec![
                        client_core::notifications::session_notify_tag("m1", "s1"),
                        client_core::notifications::dm_notify_tag("peer1"),
                    ]
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

    #[tokio::test]
    async fn a_nip17_dm_round_trips_through_the_1059_subscription() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();
                let core = core_for(&mock, &phone, Rc::new(Spy::default())).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                let dm_sub = eose_all(&mut mock).await;
                settle().await;

                // --- send: optimistic local add + two 1059 wraps on the wire ---
                core.dispatch(Intent::SendDm {
                    peer: peer.pubkey_hex.clone(),
                    text: "hi over nostr".into(),
                })
                .await;
                settle().await;

                // optimistic local add (status sent, our own message)
                let dm = core.dm_view().await.unwrap();
                assert_eq!(dm.messages[&peer.pubkey_hex].len(), 1);
                assert_eq!(dm.messages[&peer.pubkey_hex][0].content, "hi over nostr");

                // --- receive: a 1059 for us from another sender ---
                let w = crate::giftwrap::wrap_dm(&peer, &phone.pubkey_hex, "hello back")
                    .await
                    .unwrap();
                mock.push(format!(
                    r#"["EVENT","{dm_sub}",{}]"#,
                    serde_json::to_string(&w.for_recipient).unwrap()
                ));
                settle().await;

                let dm = core.dm_view().await.unwrap();
                assert_eq!(dm.events_received, 1);
                let from_peer = &dm.messages[&peer.pubkey_hex];
                assert!(from_peer.iter().any(|m| m.content == "hello back"));
                assert_eq!(dm.conversations[0].unread_count, 1);
            })
            .await;
    }

    #[tokio::test]
    async fn send_dm_image_uploads_then_appends_the_ref_line_to_the_dm() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();
                let ports = CorePorts {
                    http: Rc::new(OkHttp),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                eose_all(&mut mock).await;
                settle().await;

                core.dispatch(Intent::SendDmImage {
                    peer: peer.pubkey_hex.clone(),
                    text: "look at this".into(),
                    image: b"png bytes here".to_vec(),
                })
                .await;
                for _ in 0..5 {
                    settle().await;
                }

                let dm = core.dm_view().await.unwrap();
                let msg = &dm.messages[&peer.pubkey_hex][0].content;
                assert!(msg.starts_with("look at this\n"));
                // the appended line is `<blossom-url> key=<64hex> iv=<24hex>`
                let line = msg.lines().nth(1).unwrap();
                assert!(line.contains(" key=") && line.contains(" iv="));
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

                let core2 = core.clone();
                let machine_pubkey = machine.pubkey_hex.clone();
                let dispatched = tokio::task::spawn_local(async move {
                    core2
                        .dispatch(Intent::SendSessionImage(SessionImageSend {
                            machine: machine_pubkey,
                            session_id: "s1".into(),
                            text: "look at this".into(),
                            image: b"png bytes here".to_vec(),
                            filename: "photo.png".into(),
                            mime_type: "image/png".into(),
                        }))
                        .await;
                });

                let msg = find_command_frame(
                    &mut mock,
                    &phone.pubkey_hex,
                    &machine,
                    |m| matches!(m, PhoneToBridge::UploadImage(_)),
                )
                .await;
                dispatched.await.unwrap();

                match msg {
                    PhoneToBridge::UploadImage(UploadImageMsg::Blossom(m)) => {
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

                let core2 = core.clone();
                let machine_pubkey = machine.pubkey_hex.clone();
                let dispatched = tokio::task::spawn_local(async move {
                    core2
                        .dispatch(Intent::SendSessionImage(SessionImageSend {
                            machine: machine_pubkey,
                            session_id: "s1".into(),
                            text: "a caption".into(),
                            image: b"small image bytes".to_vec(),
                            filename: "photo.jpg".into(),
                            mime_type: "image/jpeg".into(),
                        }))
                        .await;
                });

                let msg = find_command_frame(
                    &mut mock,
                    &phone.pubkey_hex,
                    &machine,
                    |m| matches!(m, PhoneToBridge::UploadImage(_)),
                )
                .await;
                dispatched.await.unwrap();

                match msg {
                    PhoneToBridge::UploadImage(UploadImageMsg::Chunk(m)) => {
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

    /// A [`crate::marmot::MarmotEngine`] double, configurable per test:
    /// `ingest_results` is consumed front-to-back, one verdict per call (the
    /// last one repeats once exhausted — a scripted sequence for a
    /// not-joined-then-joined re-feed); `send` / `accept_welcome` answer with
    /// the canned `Ok` set, or error (unused on that test's path) when left
    /// `None`; `pending_welcomes_result` seeds the welcomes `on_marmot_start`
    /// picks up.
    struct FakeMarmot {
        ingest_results: RefCell<Vec<client_core::stores::marmot::MarmotIngested>>,
        send_result: Option<crate::marmot::MarmotOutgoing>,
        accept_result: Option<client_core::stores::marmot::MarmotGroupInfo>,
        pending_welcomes_result: Vec<client_core::stores::marmot::MarmotWelcomeInfo>,
        create_group_result: Option<crate::marmot::MarmotGroupCreated>,
    }
    impl Default for FakeMarmot {
        fn default() -> Self {
            Self {
                ingest_results: RefCell::new(vec![MarmotIngested::None]),
                send_result: None,
                accept_result: None,
                pending_welcomes_result: Vec::new(),
                create_group_result: None,
            }
        }
    }
    impl crate::marmot::MarmotEngine for FakeMarmot {
        fn init(&self, _s: &str) -> crate::ports::LocalBoxFuture<'_, Result<String, String>> {
            Box::pin(async { Ok(String::new()) })
        }
        fn publish_key_package(
            &self,
            _relays: &[String],
        ) -> crate::ports::LocalBoxFuture<'_, Result<serde_json::Value, String>> {
            Box::pin(async { Err("unused".to_string()) })
        }
        fn create_group(
            &self,
            _peer: &str,
            _kp: &serde_json::Value,
            _relays: &[String],
        ) -> crate::ports::LocalBoxFuture<'_, Result<crate::marmot::MarmotGroupCreated, String>>
        {
            let out = self.create_group_result.clone();
            Box::pin(async move { out.ok_or_else(|| "unused".to_string()) })
        }
        fn send(
            &self,
            _group_id: &str,
            _text: &str,
        ) -> crate::ports::LocalBoxFuture<'_, Result<crate::marmot::MarmotOutgoing, String>> {
            let out = self.send_result.clone();
            Box::pin(async move { out.ok_or_else(|| "unused".to_string()) })
        }
        fn ingest(
            &self,
            _event: &serde_json::Value,
        ) -> crate::ports::LocalBoxFuture<'_, Result<MarmotIngested, String>> {
            let mut q = self.ingest_results.borrow_mut();
            let r = if q.len() > 1 {
                q.remove(0)
            } else {
                q.first().cloned().unwrap_or(MarmotIngested::None)
            };
            Box::pin(async move { Ok(r) })
        }
        fn pending_welcomes(
            &self,
        ) -> crate::ports::LocalBoxFuture<
            '_,
            Result<Vec<client_core::stores::marmot::MarmotWelcomeInfo>, String>,
        > {
            let v = self.pending_welcomes_result.clone();
            Box::pin(async move { Ok(v) })
        }
        fn accept_welcome(
            &self,
            _id: &str,
        ) -> crate::ports::LocalBoxFuture<
            '_,
            Result<client_core::stores::marmot::MarmotGroupInfo, String>,
        > {
            let out = self.accept_result.clone();
            Box::pin(async move { out.ok_or_else(|| "unused".to_string()) })
        }
        fn list_groups(
            &self,
        ) -> crate::ports::LocalBoxFuture<
            '_,
            Result<Vec<client_core::stores::marmot::MarmotGroupInfo>, String>,
        > {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    #[tokio::test]
    async fn a_kind_445_group_message_folds_into_the_marmot_view() {
        use client_core::stores::marmot::{
            MarmotConversation, MarmotMessageResult, MarmotPersisted,
        };
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();

                // A phone that has already joined one 1:1 Marmot group.
                let mut persisted = MarmotPersisted::default();
                persisted.conversations.insert(
                    "group-abc".into(),
                    MarmotConversation {
                        group_id: "group-abc".into(),
                        h_tag: "hhh111".into(),
                        peer_pubkey: peer.pubkey_hex.clone(),
                        name: "peer".into(),
                        member_count: 2,
                        last_message_at: 0,
                        unread_count: 0,
                        last_preview: String::new(),
                    },
                );
                let kv = MemoryKv::seeded([(
                    crate::stores::MARMOT_KEY,
                    client_core::stores::marmot::serialize_marmot(&persisted),
                )]);

                let ports = CorePorts {
                    kv: Rc::new(kv),
                    marmot: Rc::new(FakeMarmot {
                        ingest_results: RefCell::new(vec![MarmotIngested::Message(
                            MarmotMessageResult {
                                group_id: "group-abc".into(),
                                id: "rumor-1".into(),
                                sender: peer.pubkey_hex.clone(),
                                kind: 9,
                                content: "hello group".into(),
                                created_at: 1_700_000,
                            },
                        )]),
                        ..FakeMarmot::default()
                    }),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                let marmot_sub = eose_all_with_marmot(&mut mock).await;
                assert!(!marmot_sub.is_empty(), "no kind-445 subscription opened");
                settle().await;

                // A real signed kind-445 for the joined group lands on that
                // subscription (the read loop verifies sigs, so it must be
                // genuine — the MLS ciphertext is opaque and the FakeMarmot
                // returns the decrypted rumor regardless).
                let ev = {
                    use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
                    let keys = Keys::new(peer.secret_key.clone());
                    EventBuilder::new(Kind::Custom(445), "mls-ciphertext")
                        .tags([Tag::parse(["h".to_string(), "hhh111".to_string()]).unwrap()])
                        .sign_with_keys(&keys)
                        .unwrap()
                        .as_json()
                };
                mock.push(format!(r#"["EVENT","{marmot_sub}",{ev}]"#));
                settle().await;

                let m = core.marmot_view().await.unwrap();
                assert_eq!(m.events_received, 1);
                let msgs = &m.messages["group-abc"];
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].content, "hello group");
                assert_eq!(m.conversations[0].unread_count, 1);
            })
            .await;
    }

    #[tokio::test]
    async fn sending_a_marmot_message_publishes_and_adds_it_locally() {
        use client_core::stores::marmot::{MarmotConversation, MarmotPersisted};
        LocalSet::new()
            .run_until(async {
                let mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();

                let mut persisted = MarmotPersisted::default();
                persisted.conversations.insert(
                    "group-abc".into(),
                    MarmotConversation {
                        group_id: "group-abc".into(),
                        h_tag: "hhh111".into(),
                        peer_pubkey: peer.pubkey_hex.clone(),
                        name: "peer".into(),
                        member_count: 2,
                        last_message_at: 0,
                        unread_count: 0,
                        last_preview: String::new(),
                    },
                );
                let kv = MemoryKv::seeded([(
                    crate::stores::MARMOT_KEY,
                    client_core::stores::marmot::serialize_marmot(&persisted),
                )]);
                let outgoing = serde_json::json!({
                    "id": "evt-out", "pubkey": phone.pubkey_hex, "created_at": 1_700_100,
                    "kind": 445, "tags": [["h", "hhh111"]], "content": "mls-ciphertext",
                    "sig": "sig-out",
                });
                let ports = CorePorts {
                    kv: Rc::new(kv),
                    marmot: Rc::new(FakeMarmot {
                        send_result: Some(crate::marmot::MarmotOutgoing {
                            event: outgoing,
                            rumor_id: "rumor-out".into(),
                            created_at: 1_700_100,
                        }),
                        ..FakeMarmot::default()
                    }),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                settle().await;

                core.dispatch(Intent::SendMarmotMessage {
                    group_id: "group-abc".into(),
                    text: "hi group".into(),
                })
                .await;
                settle().await;

                let m = core.marmot_view().await.unwrap();
                let msgs = &m.messages["group-abc"];
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].content, "hi group");
                assert_eq!(msgs[0].sender_pubkey, phone.pubkey_hex);
            })
            .await;
    }

    #[tokio::test]
    async fn accepting_a_marmot_welcome_joins_and_refeeds_buffered_445s() {
        use client_core::stores::marmot::{
            MarmotConversation, MarmotGroupInfo, MarmotMessageResult, MarmotPersisted,
            MarmotWelcomeInfo,
        };
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();

                // One group already joined (so the 445 sub opens at all) plus a
                // pending welcome into a SECOND group the engine has not joined.
                let mut persisted = MarmotPersisted::default();
                persisted.conversations.insert(
                    "group-abc".into(),
                    MarmotConversation {
                        group_id: "group-abc".into(),
                        h_tag: "hhh111".into(),
                        peer_pubkey: peer.pubkey_hex.clone(),
                        name: "peer".into(),
                        member_count: 2,
                        last_message_at: 0,
                        unread_count: 0,
                        last_preview: String::new(),
                    },
                );
                let kv = MemoryKv::seeded([(
                    crate::stores::MARMOT_KEY,
                    client_core::stores::marmot::serialize_marmot(&persisted),
                )]);

                let ports = CorePorts {
                    kv: Rc::new(kv),
                    marmot: Rc::new(FakeMarmot {
                        // First 445 fed (before accept) is not-joined and gets
                        // buffered; the re-feed after accept decrypts for real.
                        ingest_results: RefCell::new(vec![
                            MarmotIngested::NotJoined {
                                h_tag: "hhh222".into(),
                            },
                            MarmotIngested::Message(MarmotMessageResult {
                                group_id: "group-xyz".into(),
                                id: "rumor-2".into(),
                                sender: peer.pubkey_hex.clone(),
                                kind: 9,
                                content: "welcome to the group".into(),
                                created_at: 1_700_200,
                            }),
                        ]),
                        accept_result: Some(MarmotGroupInfo {
                            group_id: "group-xyz".into(),
                            h_tag: "hhh222".into(),
                            name: String::new(),
                            members: vec![phone.pubkey_hex.clone(), peer.pubkey_hex.clone()],
                            admins: Vec::new(),
                            active: true,
                        }),
                        pending_welcomes_result: vec![MarmotWelcomeInfo {
                            welcome_id: "w1".into(),
                            wrapper_id: "wrap1".into(),
                            group_id: "group-xyz".into(),
                            h_tag: "hhh222".into(),
                            name: String::new(),
                            welcomer: peer.pubkey_hex.clone(),
                            member_count: 2,
                        }],
                        ..FakeMarmot::default()
                    }),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                let marmot_sub = eose_all_with_marmot(&mut mock).await;
                settle().await;

                // A 445 for the not-yet-joined group arrives and is buffered
                // (VEIL-029) instead of being dropped.
                let ev = {
                    use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
                    let keys = Keys::new(peer.secret_key.clone());
                    EventBuilder::new(Kind::Custom(445), "mls-ciphertext")
                        .tags([Tag::parse(["h".to_string(), "hhh222".to_string()]).unwrap()])
                        .sign_with_keys(&keys)
                        .unwrap()
                        .as_json()
                };
                mock.push(format!(r#"["EVENT","{marmot_sub}",{ev}]"#));
                settle().await;
                assert_eq!(core.marmot_view().await.unwrap().buffered, 1);

                core.dispatch(Intent::AcceptMarmotWelcome {
                    welcome_id: "w1".into(),
                })
                .await;
                settle().await;

                let m = core.marmot_view().await.unwrap();
                assert_eq!(m.buffered, 0, "the buffered 445 was not re-fed");
                assert!(m.conversations.iter().any(|c| c.group_id == "group-xyz"));
                let msgs = &m.messages["group-xyz"];
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].content, "welcome to the group");
            })
            .await;
    }

    #[tokio::test]
    async fn starting_a_marmot_chat_fetches_the_key_package_and_creates_the_group() {
        LocalSet::new()
            .run_until(async {
                let mut mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();

                let welcome_event = serde_json::json!({
                    "id": "welcome-evt", "pubkey": phone.pubkey_hex, "created_at": 1_700_300,
                    "kind": 1059, "tags": [], "content": "gift-wrap", "sig": "sig-welcome",
                });
                let ports = CorePorts {
                    marmot: Rc::new(FakeMarmot {
                        create_group_result: Some(crate::marmot::MarmotGroupCreated {
                            group_id: "group-new".into(),
                            h_tag: "hnew".into(),
                            welcome_event,
                        }),
                        ..FakeMarmot::default()
                    }),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                eose_all(&mut mock).await;
                settle().await;

                let core2 = core.clone();
                let peer_pubkey = peer.pubkey_hex.clone();
                let dispatched = tokio::task::spawn_local(async move {
                    core2
                        .dispatch(Intent::StartMarmotChat { peer_pubkey })
                        .await;
                });

                // The KeyPackage fetch: a one-shot sub over the peer's kind-30443.
                let kp_sub = loop {
                    let frame = mock.next_frame().await;
                    let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                    if v[0] == "REQ" && v[2]["kinds"] == serde_json::json!([30443]) {
                        break v[1].as_str().unwrap().to_string();
                    }
                };
                let kp_event = {
                    use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
                    let keys = Keys::new(peer.secret_key.clone());
                    EventBuilder::new(Kind::Custom(30443), "keypackage-content")
                        .tags([Tag::parse(["d".to_string(), "kp1".to_string()]).unwrap()])
                        .sign_with_keys(&keys)
                        .unwrap()
                        .as_json()
                };
                mock.push(format!(r#"["EVENT","{kp_sub}",{kp_event}]"#));
                mock.push(format!(r#"["EOSE","{kp_sub}"]"#));

                // The resulting welcome, published to confirm.
                let mut welcome_published = false;
                for _ in 0..8 {
                    let frame = mock.next_frame().await;
                    let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
                    if v[0] == "EVENT" {
                        let id = v[1]["id"].as_str().unwrap();
                        mock.push(format!(r#"["OK","{id}",true,""]"#));
                        if id == "welcome-evt" {
                            welcome_published = true;
                            break;
                        }
                    }
                }
                assert!(welcome_published, "the welcome was never published");
                dispatched.await.unwrap();

                let m = core.marmot_view().await.unwrap();
                let conv = m
                    .conversations
                    .iter()
                    .find(|c| c.group_id == "group-new")
                    .expect("the new group was not upserted");
                assert_eq!(conv.h_tag, "hnew");
                assert_eq!(conv.peer_pubkey, peer.pubkey_hex);
            })
            .await;
    }

    #[tokio::test]
    async fn starting_a_marmot_chat_reuses_an_existing_conversation_with_the_peer() {
        use client_core::stores::marmot::{MarmotConversation, MarmotPersisted};
        LocalSet::new()
            .run_until(async {
                let mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let peer = generate_keypair();

                let mut persisted = MarmotPersisted::default();
                persisted.conversations.insert(
                    "group-existing".into(),
                    MarmotConversation {
                        group_id: "group-existing".into(),
                        h_tag: "hexisting".into(),
                        peer_pubkey: peer.pubkey_hex.clone(),
                        name: String::new(),
                        member_count: 2,
                        last_message_at: 0,
                        unread_count: 0,
                        last_preview: String::new(),
                    },
                );
                let kv = MemoryKv::seeded([(
                    crate::stores::MARMOT_KEY,
                    client_core::stores::marmot::serialize_marmot(&persisted),
                )]);
                // No `create_group_result` — a call to `create_group` errors,
                // proving the existing conversation short-circuits the fetch.
                let ports = CorePorts {
                    kv: Rc::new(kv),
                    marmot: Rc::new(FakeMarmot::default()),
                    ..CorePorts::default()
                };
                let core =
                    core_for_ports(&mock, &phone, Rc::new(Spy::default()), ports).await;
                core.set_machines(vec![generate_keypair().pubkey_hex]);
                core.start();
                settle().await;

                core.dispatch(Intent::StartMarmotChat {
                    peer_pubkey: peer.pubkey_hex.clone(),
                })
                .await;
                settle().await;

                let m = core.marmot_view().await.unwrap();
                assert_eq!(m.conversations.len(), 1);
                assert_eq!(m.conversations[0].group_id, "group-existing");
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
                    r#"{"type":"output","sessionId":"s1","seq":1,"entry":{"entryType":"text","content":"hi","timestamp":"t"}}"#,
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
    /// candidate, a freshly paired machine) only re-does the phone's 3
    /// traffic filters — the DM sub is managed separately and untouched — so
    /// unlike [`eose_all`] this drains exactly 3 REQs (skipping the CLOSE
    /// frames for the superseded subs along the way) and returns one sub_id
    /// the router now has open.
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
                        {"id":"s1","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                    ],"protocolVersion":10}"#,
                )
                .unwrap();
                push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
                settle().await;

                let msg = protocol::codec::decode_bridge_to_phone(
                    r#"{"type":"output","sessionId":"s1","seq":1,"entry":{"entryType":"text","content":"hi","timestamp":"t"}}"#,
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
                        {"id":"s1","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                    ],"protocolVersion":10}"#,
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
                kind: ActionFailed::PublishRejected,
            })
            .unwrap(),
            serde_json::json!({ "actionFailed": { "kind": "publishRejected" } }),
        );
    }
}
