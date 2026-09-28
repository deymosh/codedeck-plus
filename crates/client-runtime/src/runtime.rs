//! The event loop and its handle, [`Core`]. One tokio loop (on the host's
//! `LocalSet`) composes:
//!
//! * the connection FSM ([`client_core::connection`]) — every connectivity
//!   signal in, `OpenSocket` / `ScheduleRetry` / … effects out;
//! * the epoch-guarded subscription client ([`crate::nostr_client::NostrClient`])
//!   over the real [`WsTransport`];
//! * [`client_core::bridge_api`] — egress `build_command`, total `ingest`;
//! * the store layer ([`CoreStores`]) behind the `Intent` / view / `CoreEvent`
//!   surface, and the timers.
//!
//! Bindings (`crates/client-ffi` for Android) wrap the handle; nothing here
//! knows which host it runs in.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use std::collections::HashMap;

use client_core::bridge_api::{BridgeApi, EgressError, IncomingEvent, Ingested};
use client_core::stores::session_key::{Recipient, SessionKeyRing, REGRANT_EVERY_MS};
use nostr_transport::direct::{DirectConfig as LinkConfig, DirectHandlers, DirectLink};
use nostr_transport::{PublishResult, PublishVerdict};
use client_core::connection::{
    connection_reducer, heartbeats_all_stale, initial_connection_state, ConnectionEffect,
    ConnectionEvent, ConnectionState, ConnectionStatus, ReconnectConfig, DEFAULT_RECONNECT_CONFIG,
    TOR_RECONNECT_CONFIG,
};
use client_core::notifications::NotifyEffect;
use protocol::commands::{PhoneToBridge, SessionKeyMsg, SyncAckMsg};
use protocol::ranges::SeqRange;
use protocol::nostr_event::SignedEvent;
use protocol::events::BridgeToPhone;
use protocol::kinds::SESSION_LIST_KIND;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use client_core::notifications::session_notify_tag;
use client_core::stores::ui::UiEffect;

use crate::dispatch::{PairDeadline, RouteResult, Router, Send as RouteSend, StoreId};
use crate::intent::{apply as apply_intent, Intent, IntentCtx, IntentResult, SessionFileSend, UndoTimer};
use crate::nostr_client::{NostrClient, NostrClientHost, NostrEvent};
use crate::ports::{
    Kv, KvSessionKeyStore, MemoryKv, MemoryTranscriptStore, NullNotifier, Notifier, SessionKeyStore, TranscriptStore,
};
use crate::signer::{Cipher, IdentityAuth, IdentitySigner, PhoneKeys, SignerError};
use crate::stores::{hydrate, CoreStores, Persister, StoresConfig};
use crate::transport::ws::{WsConfig, WsTransport, PING_EVERY, PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};
use crate::view::{
    ConnectionView, MachinesView, OutboxView, PairingView,
    PendingSessionsView, QuickPromptsView, SettingsView, TranscriptRowsView, UiView,
};

/// On a resume with the socket still up, a machine whose heartbeat (which
/// carries its whole session list) arrived this recently is not asked for a
/// fresh list. Bridges beat every 60 s.
const RESUME_HEARD_WITHIN_MS: u64 = 90_000;
/// How often the CDX-020 dead-subscription watchdog re-checks while connected.
const STALE_WATCHDOG_EVERY: Duration = Duration::from_secs(30);
/// Relay ping interval while the app is in the background. Every ping is a
/// radio wake-up per relay round; in the background the host's periodic
/// [`Core::keepalive`] is what checks the sockets.
const BACKGROUND_PING_EVERY: Duration = Duration::from_secs(150);
/// How long [`Core::keepalive`] waits for the relays to answer its ping.
const KEEPALIVE_PROBE: Duration = Duration::from_secs(10);
/// How long the machines store and the stored-event cursor may stay dirty in
/// memory. Heartbeats, usage and GSD updates each change the machines store,
/// and every stored event moves the cursor; writing each one through
/// (serialize the whole store, then a database write) cost more than the
/// event itself. Both are flushed at once when the app is backgrounded or
/// stopped, and losing the last few seconds to a crash only means the next
/// heartbeat or a slightly wider stored-event replay restores them.
const WRITE_DEBOUNCE: Duration = Duration::from_secs(2);
/// How long a `sync-ack` waits for the acks of the chunks arriving behind it.
/// Every command is a signature by the identity, perhaps in another app, and
/// a bridge sends a sync's chunks back to back: one ack per sync per window
/// instead of one per chunk. The bridge resends a pass only after 10 s.
const ACK_BATCH_WINDOW: Duration = Duration::from_millis(500);
/// How long a command sent over a direct link waits for the bridge's `OK`
/// before it goes to the relays instead.
const DIRECT_PUBLISH_WAIT: Duration = Duration::from_secs(5);

/// Where a machine's direct link goes: its endpoints, the certificate pin,
/// and the proxy (Orbot) in force.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectTarget {
    endpoints: Vec<String>,
    pin: Option<String>,
    proxy: Option<String>,
}

// --- clock and entropy ports -----------------------------------------------

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

// --- observer and the CoreEvent stream ------------------------------------

/// Why a user-visible action did not land. Semantic — the UI writes the copy.
/// Named `ActionFailedKind`, not `ActionFailed`: a type with the same name as
/// its own enclosing `CoreEvent::ActionFailed` variant makes UniFFI's Kotlin
/// codegen resolve the field's type to the variant's own sealed subclass
/// instead of this type, a compile error only caught by actually building the
/// generated Kotlin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[serde(rename_all = "camelCase")]
pub enum ActionFailedKind {
    DecryptFailed,
    DecodeFailed,
    PublishRejected,
    PublishUnreachable,
}

/// What the `Core` tells its host. No UI strings; the binding maps these to
/// platform events.
pub trait CoreObserver {
    /// Connection status or the `needs pairing check` diagnostic changed.
    /// `connected_relays` is a live snapshot (not itself part of what
    /// triggered this callback — a relay dropping without the overall
    /// status changing does not re-fire this) for a per-relay status dot
    /// (Settings) to have a reasonably fresh value without its own push
    /// channel.
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, connected_relays: &[String]);
    /// A decoded bridge→phone message for the given machine.
    fn bridge_message(&self, machine: String, msg: BridgeToPhone);
    fn action_failed(&self, _kind: ActionFailedKind) {}
    /// The semantic event stream. No UI strings — the consumer
    /// decides how to surface each one and re-reads the named view slice.
    fn on_event(&self, _event: CoreEvent) {}
}

/// A read-projection slice — the granularity a consumer
/// re-subscribes to on a [`CoreEvent::StateChanged`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
#[serde(rename_all = "camelCase")]
pub enum SliceId {
    Connection,
    Machines,
    Transcript,
    Outbox,
    Cards,
    Settings,
    Pairing,
    QuickPrompts,
    PendingSessions,
    Ui,
}

/// The closed, semantic event set. Serde shape: externally
/// tagged, camelCase (same convention as [`crate::intent::Intent`]) — e.g.
/// `{"stateChanged": {"slice": "machines"}}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
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
    ActionFailed { kind: ActionFailedKind },
    /// New rows landed for this session (a live `Output`, or a `SyncChunk`
    /// filling a gap) — a dedicated, per-session event rather than a generic
    /// `StateChanged { slice: Transcript }`, since a blanket slice notify
    /// cannot tell a consumer WHICH session to re-fetch and transcripts are
    /// per-session by nature.
    TranscriptAppended { machine: String, session_id: String },
    /// The correlated response to `Intent::CreateFolder` — matched by
    /// `request_id` off this stream (no store, no view: nothing to persist or
    /// re-fetch for a one-shot RPC-style exchange).
    FolderAck {
        request_id: String,
        success: bool,
        path: Option<String>,
        error: Option<String>,
    },
    /// The in-app attention chime — `client_core::notifications::decide_ping`
    /// already decided this event needs it (app hidden, or a different
    /// session is active); the core has no audio API of its own, so the host
    /// plays its chime on this event.
    Ping,
}

// --- config ---------------------------------------------------------------

/// The relays are not part of the configuration: the transport dials the
/// paired machines' own (see [`CoreStores::relay_set`]).
pub struct CoreConfig {
    /// The phone's identity: signs every event the phone publishes, and
    /// keys the payloads for a bridge holding no live session key — see
    /// [`crate::signer`].
    pub identity: Rc<dyn IdentitySigner>,
    /// SOCKS5 `host:port` (Orbot) — the address to dial through WHEN Tor is
    /// on. Sent unconditionally by the phone (not nulled out when starting
    /// with Tor off), so a later `Intent::SetTorEnabled(true)` has an address
    /// to switch back to; `tor` below is the separate flag deciding whether
    /// it's actually in use, at boot and hereafter.
    pub proxy: Option<String>,
    /// Whether the proxy above is in use at boot. The loop remembers `proxy`
    /// regardless, so `Intent::SetTorEnabled` can toggle between `Some` and
    /// `None` without needing the phone to resend the address.
    pub tor: bool,
    /// Backoff / stale-window timing. [`CoreConfig::new`] picks the Tor variant
    /// when `tor` is set; tests override directly.
    pub reconnect: ReconnectConfig,
}

/// The platform I/O seams the composed `Core` needs. [`Default`] wires
/// in-memory / no-op implementations (tests, and any port a host does not
/// bind).
pub struct CorePorts {
    pub kv: Rc<dyn Kv>,
    pub transcript_store: Rc<dyn TranscriptStore>,
    pub notifier: Rc<dyn Notifier>,
    /// Blossom image upload. `NoHttpFetch` when the host binds no
    /// networking (image sends then fall back to relay chunks).
    pub http: Rc<dyn crate::attachments::HttpFetch>,
    /// Where the session keys are kept. `None` keeps them in [`Self::kv`];
    /// a host with a secret store should bind it, and then the KV holds no
    /// session key at all.
    pub session_keys: Option<Rc<dyn SessionKeyStore>>,
}

impl Default for CorePorts {
    fn default() -> Self {
        Self {
            kv: Rc::new(MemoryKv::new()),
            transcript_store: Rc::new(MemoryTranscriptStore::new()),
            notifier: Rc::new(NullNotifier),
            http: Rc::new(crate::attachments::NoHttpFetch),
            session_keys: None,
        }
    }
}

impl CoreConfig {
    pub fn new(identity: Rc<dyn IdentitySigner>, proxy: Option<String>, tor: bool) -> Self {
        Self {
            identity,
            proxy,
            tor,
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
        // The open transcript is re-read after every append; keep its rows
        // in memory. The runtime is the store's only writer from here on.
        let ports = CorePorts {
            transcript_store: Rc::new(crate::ports::CachedTranscriptStore::new(ports.transcript_store)),
            ..ports
        };

        let hydrated = hydrate(
            ports.kv.as_ref(),
            ports.transcript_store.as_ref(),
            &StoresConfig::default(),
        )
        .await;
        ports.kv.delete(crate::stores::OLD_SESSION_KEY_KEY).await;
        let key_store: Rc<dyn SessionKeyStore> = match ports.session_keys.clone() {
            Some(store) => {
                ports.kv.delete(crate::stores::SESSION_KEYS_KEY).await;
                store
            }
            None => Rc::new(KvSessionKeyStore(Rc::clone(&ports.kv))),
        };
        let (session, changed) = SessionKeyRing::load(key_store.load().await.as_deref(), clock.now_ms());
        if changed {
            key_store.save(&session.encode()).await;
        }
        let keys = PhoneKeys::new(&config.identity.pubkey_hex(), &session.current);

        // A machine paired in a PRIOR run is already in `hydrated.stores.machines`
        // — nothing about a plain (re)connect ever calls `refresh_authors()` for
        // it (that only fires reactively, off a pairing-related route/intent
        // result), so seeding this empty and waiting for one would leave a
        // returning phone subscribed to nobody: `NostrClient::connect()` treats
        // an empty author list as vacuous and opens zero real subscriptions,
        // silently dropping every heartbeat and session update the bridge sends
        // from that point on. Seed it here from the same persisted state
        // `refresh_authors()` itself reads, so the very first `connect()` this
        // process makes already has the right subscription from cold start.
        let initial_authors = {
            let mut authors = hydrated.stores.machines.machine_pubkeys();
            if let Some(candidate) = &hydrated.stores.pairing.candidate {
                if !authors.contains(&candidate.pubkey_hex) {
                    authors.push(candidate.pubkey_hex.clone());
                }
            }
            authors
        };
        // A store that has never seen a stored response starts its cursor
        // now: everything already on the relays for this identity answered an
        // earlier install or login (session keys this one does not hold), and
        // whatever this one needs (a pair-ack, sync chunks) answers a request
        // it has yet to send. Without a cursor the relays would replay the
        // identity's whole history, each event handed to the signer in vain.
        let last_stored_seen = if hydrated.last_stored_seen > 0 {
            hydrated.last_stored_seen
        } else {
            let now = i64::try_from(clock.now_ms() / 1000).unwrap_or(0);
            let _ = tx.send(Msg::NoteStoredSeen(now));
            now
        };
        let host = Rc::new(LoopHost {
            tx: tx.clone(),
            machines: RefCell::new(initial_authors.clone()),
            cursor: RefCell::new(last_stored_seen),
        });
        let relay_set = hydrated.stores.relay_set();
        let ws = WsTransport::new(WsConfig {
            relays: relay_set.clone(),
            auth: Rc::new(IdentityAuth(Rc::clone(&config.identity))),
            proxy: if config.tor { config.proxy.clone() } else { None },
        });
        // The connected-relay set is reported as it changes, not only when
        // the watchdog next looks (with nothing subscribed yet, "connected"
        // comes before any relay is).
        let relays_tx = tx.clone();
        ws.on_relays_changed(Rc::new(move || {
            let _ = relays_tx.send(Msg::RelaysChanged);
        }));
        // The HTTP port's own boot-time proxy — mirrors `WsConfig.proxy` above.
        // Without this, a host that starts with Tor already on (e.g. Android
        // reading a persisted `tor_proxy_enabled: true` before this call) has
        // its Blossom uploads leak direct until the phone happens to toggle
        // `Intent::SetTorEnabled`, which is the only other place `http.set_proxy`
        // is ever called.
        if config.tor {
            ports.http.set_proxy(config.proxy.as_deref());
        }
        let nostr = NostrClient::new(
            ws.clone(),
            Rc::clone(&host),
            keys.identity_pubkey_hex.clone(),
        );
        let (signer_jobs, jobs_rx) = mpsc::unbounded_channel::<SignerJob>();
        tokio::task::spawn_local(run_signer(Rc::clone(&config.identity), jobs_rx, tx.clone()));
        let event_loop = Loop {
            reconnect: config.reconnect,
            signer: config.identity,
            session,
            key_store,
            keys,
            signer_jobs,
            grant_attempts: HashMap::new(),
            tor_proxy_address: config.proxy,
            clock,
            entropy,
            observer,
            conn: initial_connection_state(),
            nostr,
            ws,
            api: BridgeApi::new(),
            machines: initial_authors,
            relay_set,
            host,
            retry_timer: None,
            vis_timer: None,
            stale_timer: None,
            last_connected_relays: Vec::new(),
            pair_timer: None,
            undo_timer: None,
            machines_dirty: false,
            stored_seen_dirty: None,
            flush_timer: None,
            pending_acks: Vec::new(),
            ack_timer: None,
            links: HashMap::new(),
            links_up: HashMap::new(),
            links_on: false,
            link_ping: PING_EVERY,
            self_tx: tx.clone(),
            stores: hydrated.stores,
            kv: ports.kv,
            transcript_store: ports.transcript_store,
            notifier: ports.notifier,
            http: ports.http,
        };
        tokio::task::spawn_local(event_loop.run(rx));
        Self { tx }
    }

    /// Resolves when the event loop has ended. The loop holds senders to
    /// itself, so it never ends on its own: this resolving means the loop
    /// task panicked, and every later call on this handle is a silent no-op.
    /// A host watches it to fail loudly instead of rendering a dead core.
    pub async fn closed(&self) {
        self.tx.closed().await;
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

    /// Check the connection now and repair what is broken: ping every relay
    /// and drop those that stay silent, bring a pending reconnect forward,
    /// and run the dead-subscription check. Resolves when done (at most a
    /// few seconds). For a host that lets the device sleep and wakes it
    /// periodically instead: timers here count awake time only, so without
    /// this a dead socket or a due retry could wait for the next wake-up.
    pub async fn keepalive(&self) {
        let (reply, done) = oneshot::channel();
        if self.tx.send(Msg::Keepalive(reply)).is_ok() {
            let _ = done.await;
        }
    }
    /// `ConnectivityManager` says the network came / went.
    pub fn set_online(&self, online: bool) {
        let _ = self.tx.send(Msg::SetOnline(online));
    }
    /// The paired-machine list (subscription authors + the known-machine gate).
    pub fn set_machines(&self, machines: Vec<String>) {
        let _ = self.tx.send(Msg::SetMachines(machines));
    }

    /// Point the transport at `relays` until the paired machines' relays
    /// next change (the loop keeps it on their set otherwise). The transport
    /// re-dials the diff and, if connected, the subscription client re-REQs.
    pub fn set_relays(&self, relays: Vec<String>) {
        let _ = self.tx.send(Msg::SetRelays(relays));
    }

    /// Current connection status + the `needs pairing check` diagnostic +
    /// which configured relays have a live socket right now (Settings' own
    /// per-relay dot — not a subscription/publish-readiness signal, just
    /// "the socket is up"). A fresh read for a UI that just attached (the
    /// observer only reports changes).
    pub async fn connection_status(&self) -> (ConnectionStatus, bool, Vec<String>) {
        let (rtx, rrx) = oneshot::channel();
        if self.tx.send(Msg::QueryStatus(rtx)).is_err() {
            return (ConnectionStatus::Stopped, false, Vec::new());
        }
        rrx.await.unwrap_or((ConnectionStatus::Stopped, false, Vec::new()))
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

    /// Read-projection snapshots. Each answers off the loop's own
    /// store state, so a reader that just attached gets a consistent view.
    pub async fn machines_view(&self) -> MachinesView {
        self.query(ViewQuery::Machines).await.unwrap_or(MachinesView {
            machines: Default::default(),
            direct_up: Default::default(),
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
            unread_sessions: Default::default(),
            responded_cards: Default::default(),
            plan_approval_choices: Default::default(),
            credentials_status: Default::default(),
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
    QueryStatus(oneshot::Sender<(ConnectionStatus, bool, Vec<String>)>),
    RelayEvent(NostrEvent),
    SocketOpen,
    SocketClose,
    RetryDue,
    VisibilitySettled,
    StaleWatchdog,
    /// The host woke the device to check the connection.
    Keepalive(oneshot::Sender<()>),
    /// That check's relay probe finished.
    KeepaliveProbed(oneshot::Sender<()>),
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
    /// A relay's socket came up or went down.
    RelaysChanged,
    /// The connection FSM asked for a reconcile: after a (re)connect, or
    /// (`reconnected: false`) on a resume with the socket still up.
    RefreshReconcile { reconnected: bool },
    /// `LoopHost::note_stored_seen` advanced the cursor — persist it so a
    /// restart resumes the stored-response filter instead of replaying the
    /// relay's entire history for this identity. Deferred the same way every
    /// other host callback is: `note_stored_seen` itself is a synchronous
    /// trait method with no `Kv` access, called from inside the transport's
    /// own task.
    NoteStoredSeen(i64),
    /// The write-debounce window elapsed: flush what is dirty.
    FlushWrites,
    /// [`ACK_BATCH_WINDOW`] elapsed: send the held sync acks.
    FlushAcks,
    /// The identity's signer decrypted (or failed to) an event addressed to
    /// the identity.
    IdentityDecrypted {
        event: NostrEvent,
        plaintext: Result<String, SignerError>,
    },
    /// The identity's signer wrote (or failed to) a command.
    CommandSigned {
        machine: String,
        event: Result<SignedEvent, EgressError>,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    },
    /// A bridge's direct link delivered an event.
    DirectEvent(NostrEvent),
    /// A machine's direct link came up on an endpoint, or went down.
    DirectState {
        machine: String,
        endpoint: Option<String>,
    },
}

/// Work for the identity's signer. One task runs it in order, off the loop:
/// a signer may take seconds (another app, a prompt to the user), and the
/// order of commands and of a bridge's messages must hold.
enum SignerJob {
    /// Sign a command, its payload encrypted with `cipher`.
    Command {
        machine: String,
        msg: Box<PhoneToBridge>,
        cipher: Cipher,
        now: u64,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    },
    /// Decrypt a message the session key could not.
    Decrypt(NostrEvent),
}

async fn run_signer(
    signer: Rc<dyn IdentitySigner>,
    mut jobs: mpsc::UnboundedReceiver<SignerJob>,
    tx: mpsc::UnboundedSender<Msg>,
) {
    while let Some(job) = jobs.recv().await {
        let msg = match job {
            SignerJob::Command { machine, msg, cipher, now, reply, outbox_id } => Msg::CommandSigned {
                event: crate::signer::build_command(signer.as_ref(), &cipher, &machine, &msg, now).await,
                machine,
                reply,
                outbox_id,
            },
            SignerJob::Decrypt(event) => Msg::IdentityDecrypted {
                plaintext: signer.nip44_decrypt(&event.pubkey, &event.content).await,
                event,
            },
        };
        if tx.send(msg).is_err() {
            return;
        }
    }
}

/// A read-projection request answered off the loop's own store snapshot.
enum ViewQuery {
    Machines(oneshot::Sender<MachinesView>),
    Settings(oneshot::Sender<SettingsView>),
    Outbox(oneshot::Sender<OutboxView>),
    Pairing(oneshot::Sender<PairingView>),
    Connection(oneshot::Sender<ConnectionView>),
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
struct LoopHost {
    tx: mpsc::UnboundedSender<Msg>,
    machines: RefCell<Vec<String>>,
    /// `last_stored_seen` cursor (seconds) — the in-memory copy `authors()`'s
    /// caller reads synchronously. `note_stored_seen` also fires
    /// `Msg::NoteStoredSeen` to persist it through the `Kv` port, so a restart
    /// resumes the stored-response filter instead of replaying history.
    cursor: RefCell<i64>,
}

impl NostrClientHost for LoopHost {
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
            let _ = self.tx.send(Msg::NoteStoredSeen(ts));
        }
    }
}

struct Loop {
    reconnect: ReconnectConfig,
    signer: Rc<dyn IdentitySigner>,
    /// The local session keys: they key the payloads with bridges that hold
    /// one (see [`crate::signer`]).
    session: SessionKeyRing,
    key_store: Rc<dyn SessionKeyStore>,
    keys: PhoneKeys,
    signer_jobs: mpsc::UnboundedSender<SignerJob>,
    /// When each machine was last granted the session key (ms), to space
    /// out grants a bridge does not confirm.
    grant_attempts: HashMap<String, u64>,
    /// The SOCKS5 address to dial through WHEN Tor is on — remembered
    /// regardless of whether it's currently in use, so `Intent::SetTorEnabled`
    /// can toggle `self.ws`'s live proxy without the phone resending it.
    tor_proxy_address: Option<String>,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
    conn: ConnectionState,
    nostr: NostrClient<WsTransport, LoopHost>,
    ws: WsTransport,
    api: BridgeApi,
    machines: Vec<String>,
    /// The relays the transport was last pointed at from the stores (see
    /// [`Loop::sync_relays`]).
    relay_set: Vec<String>,
    host: Rc<LoopHost>,
    retry_timer: Option<AbortHandle>,
    vis_timer: Option<AbortHandle>,
    stale_timer: Option<AbortHandle>,
    /// Last set of relays reported to the observer (Settings' per-relay dot).
    /// Individual relay connect/disconnect (`Router::relay_connected`/
    /// `relay_disconnected`, driven straight from each relay's own WS task)
    /// never runs through `dispatch`'s status-transition gate below — the
    /// overall `ConnectionStatus` can stay `Connected` for the whole session
    /// while relays individually flap. Without this, the ONLY chances to see
    /// a change were an unrelated status transition (rare once connected) or
    /// a UI-triggered snapshot pull, and the very first snapshot could easily
    /// race relay dial-up and freeze on an empty set forever. The stale
    /// watchdog's existing 30s tick (below) is repurposed to notice this too.
    last_connected_relays: Vec<String>,
    /// CDX-040 pair-ack deadline.
    pair_timer: Option<AbortHandle>,
    /// The delete-controller's 4 s undo window.
    undo_timer: Option<AbortHandle>,
    /// The machines store changed since it was last written.
    machines_dirty: bool,
    /// A stored-event cursor not written yet.
    stored_seen_dirty: Option<i64>,
    /// Pending [`Msg::FlushWrites`] (see [`WRITE_DEBOUNCE`]).
    flush_timer: Option<AbortHandle>,
    /// Sync acks held for [`ACK_BATCH_WINDOW`]: per machine and sync, the
    /// chunk ranges to ack, in arrival order.
    pending_acks: Vec<(String, String, Vec<SeqRange>)>,
    /// Pending [`Msg::FlushAcks`].
    ack_timer: Option<AbortHandle>,
    /// A direct link per machine that has somewhere to try, with the target
    /// (endpoints, pin, proxy) it was started for.
    links: HashMap<String, (DirectTarget, DirectLink)>,
    /// The endpoint each machine's link is up on.
    links_up: HashMap<String, String>,
    /// Whether the core is started: links run only then.
    links_on: bool,
    /// The ping interval links use (foreground or background).
    link_ping: Duration,
    self_tx: mpsc::UnboundedSender<Msg>,
    // --- the composed store layer ---
    stores: CoreStores,
    kv: Rc<dyn Kv>,
    transcript_store: Rc<dyn TranscriptStore>,
    notifier: Rc<dyn Notifier>,
    http: Rc<dyn crate::attachments::HttpFetch>,
}

impl Loop {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Start => {
                    log::info!("core: Start (status was {:?})", self.conn.status);
                    self.dispatch(ConnectionEvent::ConnectRequested);
                    self.arm_stale_watchdog();
                    self.links_on = true;
                    self.sync_direct_links();
                }
                Msg::Stop => {
                    log::info!("core: Stop (status was {:?})", self.conn.status);
                    self.dispatch(ConnectionEvent::DisconnectRequested);
                    abort(&mut self.stale_timer);
                    self.links_on = false;
                    self.sync_direct_links();
                    self.flush_acks();
                    self.flush_writes().await;
                }
                Msg::Pause => {
                    // Backgrounded: the OS may kill the process from here on.
                    self.flush_acks();
                    self.flush_writes().await;
                    self.ws.set_ping_interval(BACKGROUND_PING_EVERY);
                    self.set_link_ping(BACKGROUND_PING_EVERY);
                    self.dispatch(ConnectionEvent::Visibility { visible: false });
                }
                Msg::Resume => {
                    self.ws.set_ping_interval(PING_EVERY);
                    self.set_link_ping(PING_EVERY);
                    self.dispatch(ConnectionEvent::Visibility { visible: true });
                    self.dispatch(ConnectionEvent::Resume);
                }
                Msg::Keepalive(reply) => {
                    let (ws, tx) = (self.ws.clone(), self.self_tx.clone());
                    tokio::task::spawn_local(async move {
                        let alive = ws.check_liveness(KEEPALIVE_PROBE).await;
                        log::debug!("keepalive: {alive} relay(s) answered");
                        let _ = tx.send(Msg::KeepaliveProbed(reply));
                    });
                }
                Msg::KeepaliveProbed(reply) => {
                    // A retry timer that stalled while the device slept is
                    // due by now; outside WaitingRetry this is a no-op.
                    self.dispatch(ConnectionEvent::RetryDue);
                    self.check_stale_heartbeats();
                    self.check_connected_relays_changed();
                    let _ = reply.send(());
                }
                Msg::SetOnline(true) => {
                    self.dispatch(ConnectionEvent::Online);
                    for (_, link) in self.links.values() {
                        link.retry_now();
                    }
                }
                Msg::SetOnline(false) => self.dispatch(ConnectionEvent::Offline),
                Msg::SetMachines(machines) => {
                    *self.host.machines.borrow_mut() = machines.clone();
                    self.machines = machines;
                    self.sync_direct_links();
                    if matches!(
                        self.conn.status,
                        ConnectionStatus::Connected | ConnectionStatus::Connecting
                    ) {
                        self.nostr.resubscribe();
                    }
                }
                Msg::SetRelays(relays) => self.nostr.set_relays(&relays),
                Msg::QueryStatus(reply) => {
                    let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
                    let _ = reply.send((self.conn.status, self.conn.needs_pairing_check, connected));
                }
                Msg::RetryDue => self.dispatch(ConnectionEvent::RetryDue),
                Msg::RelaysChanged => self.check_connected_relays_changed(),
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
                    self.check_stale_heartbeats();
                    self.check_connected_relays_changed();
                    if self.conn.status != ConnectionStatus::Stopped {
                        self.arm_stale_watchdog();
                    }
                }
                Msg::RelayEvent(event) => self.on_relay_event(event).await,
                Msg::NoteStoredSeen(ts) => {
                    self.stored_seen_dirty = Some(ts);
                    self.schedule_flush();
                }
                Msg::FlushWrites => self.flush_writes().await,
                Msg::FlushAcks => self.flush_acks(),
                Msg::Send { machine, msg, reply } => self.on_send(machine, *msg, reply),
                Msg::PairDeadline => self.on_pair_deadline(),
                Msg::Intent { intent, reply } => {
                    // An image send keeps the reply and answers it when the
                    // send finishes off the loop; everything else is done now.
                    if let Some(reply) = self.on_intent(*intent, reply).await {
                        let _ = reply.send(());
                    }
                }
                Msg::View(query) => self.answer_view(query).await,
                Msg::PublishSettled { id, result } => self.on_publish_settled(id, result).await,
                Msg::UndoTimerFired => self.on_undo_timer().await,
                Msg::RefreshReconcile { reconnected } => self.on_refresh_reconcile(reconnected).await,
                Msg::IdentityDecrypted { event, plaintext } => {
                    let incoming = incoming_of(&event);
                    let now = self.clock.now_ms();
                    let ingested = match plaintext {
                        Ok(text) => self.api.ingest_plaintext(&incoming, text, now),
                        Err(err) => self.api.decrypt_failed(&incoming, err.0),
                    };
                    self.on_ingested(&event, ingested, &Recipient::Identity).await;
                }
                Msg::CommandSigned { machine, event, reply, outbox_id } => self.publish_built(&machine, event, reply, outbox_id),
                Msg::DirectEvent(event) => self.nostr.deliver(&event),
                Msg::DirectState { machine, endpoint } => {
                    let changed = match endpoint {
                        Some(endpoint) => self.links_up.insert(machine, endpoint.clone()) != Some(endpoint),
                        None => self.links_up.remove(&machine).is_some(),
                    };
                    if changed {
                        self.state_changed(SliceId::Machines);
                    }
                }
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
            let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
            self.last_connected_relays = connected.clone();
            self.observer
                .connection_changed(self.conn.status, self.conn.needs_pairing_check, &connected);
            self.state_changed(SliceId::Connection);
        }
    }

    /// CDX-020: every paired machine's heartbeat went stale while
    /// "connected" — the subscriptions died without a socket close. Force
    /// the normal backoff/reconnect path.
    fn check_stale_heartbeats(&mut self) {
        let now = self.clock.now_ms();
        if heartbeats_all_stale(&self.conn, now, self.reconnect.heartbeat_stale_after_ms) {
            let random = Some(self.entropy.unit());
            self.dispatch(ConnectionEvent::SocketClose { random });
        }
    }

    /// Notice a per-relay connect/disconnect the status-transition gate in
    /// `dispatch` above cannot see on its own (see `last_connected_relays`'s
    /// own doc comment). `Router::connected` is a `BTreeSet`, so two reads
    /// collected into a `Vec` compare equal iff the same relays are up —
    /// order is never the source of a false difference here.
    fn check_connected_relays_changed(&mut self) {
        let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
        if connected == self.last_connected_relays {
            return;
        }
        self.last_connected_relays = connected.clone();
        self.observer
            .connection_changed(self.conn.status, self.conn.needs_pairing_check, &connected);
        self.state_changed(SliceId::Connection);
    }

    fn apply(&mut self, effect: ConnectionEffect) {
        match effect {
            ConnectionEffect::OpenSocket => {
                log::info!(
                    "connection: OpenSocket — dialing {} configured relay(s), proxy={:?}",
                    self.ws.relay_count(),
                    self.ws.current_proxy(),
                );
                self.ws.ensure_connected();
                self.nostr.connect();
            }
            ConnectionEffect::CloseSocket => {
                log::info!("connection: CloseSocket");
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
            // A (re)connect: reset stuck sync cycles, ask every machine for a
            // fresh list, reconcile from what we know. Deferred to a message so
            // this sync `apply` can stay non-blocking.
            ConnectionEffect::RefreshAndReconcile => {
                let _ = self.self_tx.send(Msg::RefreshReconcile { reconnected: true });
            }
            ConnectionEffect::ResumeReconcile => {
                let _ = self.self_tx.send(Msg::RefreshReconcile { reconnected: false });
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

        if !known {
            return;
        }
        // A bridge that holds a session key encrypts to it; try those
        // first, locally. Only what they cannot read goes to the identity's
        // signer.
        let now = self.clock.now_ms();
        let opened = self.session.keys(now).find_map(|key| {
            protocol::crypto::decrypt_from(&key.keypair.secret_key, &event.pubkey, &event.content)
                .ok()
                .map(|plaintext| (plaintext, Recipient::SessionKey(key.pubkey_hex().to_string())))
        });
        match opened {
            Some((plaintext, via)) => {
                let ingested = self.api.ingest_plaintext(&incoming_of(&event), plaintext, now);
                self.on_ingested(&event, ingested, &via).await;
            }
            None => {
                let _ = self.signer_jobs.send(SignerJob::Decrypt(event));
            }
        }
    }

    /// Carry on with an event `ingest` has decided about; `via` is the key it
    /// was encrypted to.
    async fn on_ingested(&mut self, event: &NostrEvent, ingested: Ingested, via: &Recipient) {
        match ingested {
            Ingested::Message(msg) => {
                // Fold the decoded message into the store layer, then carry
                // out its effects. The raw `bridge_message` observer callback
                // below is kept for hosts that want the decoded message too.
                let machine = event.pubkey.clone();
                let now = self.clock.now_ms();
                let visible = self.conn.visible;
                let notify_enabled = self.stores.settings.data.notifications_enabled;
                let mut router = Router::new(
                    &mut self.stores,
                    self.transcript_store.as_ref(),
                    &self.keys,
                    now,
                );
                router.visible = visible;
                router.notify_enabled = notify_enabled;
                // `CoreEvent::Ping` is the host's cue to play its chime, so
                // the router may decide one (`Router::new` defaults to not).
                router.ping_available = true;
                let result = router.route(&machine, &msg).await;
                // Ahead of the route's sends: a pair-ack encrypted to the
                // session key confirms the grant the pairing carried, so the
                // refresh it provokes already goes out under the key.
                let created_at = u64::try_from(event.created_at).unwrap_or(0);
                if self.stores.machines.note_heard_via(&machine, via, created_at) {
                    self.persist_store(StoreId::Machines).await;
                    if self.session.drop_unused_previous(&self.stores.machines, now) {
                        log::info!("session key: every bridge moved to the new key; the previous one is gone");
                        self.key_store.save(&self.session.encode()).await;
                    }
                }
                self.interpret_route(result).await;
                self.grant_session_key_if_due(&machine).await;
                self.observer.bridge_message(machine, *msg);
            }
            Ingested::DecryptFailed => {
                self.dispatch(ConnectionEvent::DecryptFailure);
                self.observer.action_failed(ActionFailedKind::DecryptFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailedKind::DecryptFailed,
                });
            }
            Ingested::DecodeFailed => {
                // Why, so a device log can tell an old or foreign payload from
                // a wire mismatch. The error is the decoder's (field names,
                // at most a short quoted value), cut short; never the payload.
                if let Some(record) = self.api.diagnostics().invalid.last() {
                    let error: String = record.error.chars().take(160).collect();
                    log::warn!(
                        "undecodable message from {} (kind {}, event {}): {error}",
                        record.machine.get(..8).unwrap_or(&record.machine),
                        record.kind,
                        record.event_id.get(..8).unwrap_or(&record.event_id),
                    );
                }
                self.observer.action_failed(ActionFailedKind::DecodeFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailedKind::DecodeFailed,
                });
            }
            Ingested::Buffered | Ingested::UnknownMachine => {}
        }
    }

    /// Grant `machine` the current session key if it honours session keys
    /// and has not confirmed it, at most once per [`REGRANT_EVERY_MS`]: the
    /// grant goes through the identity's signer.
    async fn grant_session_key_if_due(&mut self, machine: &str) {
        self.rotate_session_key_if_due().await;
        let now = self.clock.now_ms();
        if !self.stores.machines.wants_session_grant(machine, &self.session.current, now)
            || self
                .grant_attempts
                .get(machine)
                .is_some_and(|at| now.saturating_sub(*at) < REGRANT_EVERY_MS)
        {
            return;
        }
        self.grant_attempts.insert(machine.to_string(), now);
        self.stores.machines.note_session_grant_sent(machine, self.keys.grant_sent(now));
        self.persist_store(StoreId::Machines).await;
        log::info!("session key: granting it to {}...", machine.get(..8).unwrap_or(machine));
        self.on_send(
            machine.to_string(),
            PhoneToBridge::SessionKey(SessionKeyMsg {
                version: Default::default(),
                session_key: self.keys.grant_for(machine),
            }),
            None,
        );
    }

    /// Replace the session key with a fresh one when it is a month from
    /// lapsing; every bridge is then granted the new one as it is heard from.
    async fn rotate_session_key_if_due(&mut self) {
        let now = self.clock.now_ms();
        if !self.session.rotate_if_due(now) {
            return;
        }
        log::info!("session key: replaced by a fresh one");
        self.session.drop_unused_previous(&self.stores.machines, now);
        self.key_store.save(&self.session.encode()).await;
        self.keys = PhoneKeys::new(&self.keys.identity_pubkey_hex, &self.session.current);
        // The old key's grant attempts say nothing about the new one.
        self.grant_attempts.clear();
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
        // Ahead of the sends below — same reasoning as `interpret_intent`.
        self.sync_relays();
        // Also ahead of the sends: a send can provoke an immediate reply from
        // a machine this route just added (the refresh after a pair-ack), and
        // the subscription must already cover that machine when it arrives.
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if !r.notifies.is_empty() {
            self.state_changed(SliceId::Cards);
        }
        for effect in r.notifies {
            match effect {
                NotifyEffect::Notify { content, tag, kind } => {
                    self.notifier.notify(&content.title, &content.body, Some(&tag), &kind);
                }
                NotifyEffect::Ping => self.emit(CoreEvent::Ping),
            }
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
        if r.pending_sessions_changed {
            self.state_changed(SliceId::PendingSessions);
        }
        if r.ui_changed {
            self.state_changed(SliceId::Ui);
        }
        if let Some((machine, session_id)) = r.transcript_appended {
            self.emit(CoreEvent::TranscriptAppended { machine, session_id });
        }
        if let Some(m) = r.folder_ack {
            self.emit(CoreEvent::FolderAck {
                request_id: m.request_id,
                success: m.success,
                path: m.path,
                error: m.error,
            });
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
        // a heartbeat may have changed where a bridge can be reached.
        self.sync_direct_links();
    }

    /// Start, restart or stop each machine's direct link to match where it
    /// can be reached now (and the Orbot proxy, and whether the core runs).
    fn sync_direct_links(&mut self) {
        let proxy = self.ws.current_proxy();
        let wanted: HashMap<String, DirectTarget> = if self.links_on {
            self.machines
                .iter()
                .filter_map(|m| {
                    let (endpoints, pin) = self.stores.machines.direct_target(m)?;
                    Some((m.clone(), DirectTarget { endpoints, pin, proxy: proxy.clone() }))
                })
                .collect()
        } else {
            HashMap::new()
        };
        let stale: Vec<String> =
            self.links.iter().filter(|(m, (target, _))| wanted.get(*m) != Some(target)).map(|(m, _)| m.clone()).collect();
        for machine in stale {
            if let Some((_, link)) = self.links.remove(&machine) {
                link.stop();
            }
        }
        for (machine, target) in wanted {
            if self.links.contains_key(&machine) {
                continue;
            }
            let (events, states) = (self.self_tx.clone(), self.self_tx.clone());
            let name = machine.clone();
            let link = DirectLink::start(
                LinkConfig {
                    endpoints: target.endpoints.clone(),
                    cert_sha256: target.pin.clone(),
                    proxy: target.proxy.clone(),
                    auth: Rc::new(IdentityAuth(Rc::clone(&self.signer))),
                },
                DirectHandlers {
                    on_event: Rc::new(move |event| {
                        let _ = events.send(Msg::DirectEvent(event));
                    }),
                    on_state: Rc::new(move |endpoint| {
                        let _ = states.send(Msg::DirectState { machine: name.clone(), endpoint });
                    }),
                },
            );
            link.set_ping_interval(self.link_ping);
            self.links.insert(machine, (target, link));
        }
    }

    fn set_link_ping(&mut self, every: Duration) {
        self.link_ping = every;
        for (_, link) in self.links.values() {
            link.set_ping_interval(every);
        }
    }

    async fn persist_store(&mut self, id: StoreId) {
        let p = Persister::new(self.kv.as_ref());
        match id {
            StoreId::Machines => {
                self.machines_dirty = true;
                self.schedule_flush();
            }
            StoreId::Outbox => p.save_outbox(&self.stores.outbox).await,
            StoreId::Settings => p.save_settings(&self.stores.settings).await,
            StoreId::QuickPrompts => p.save_quick_prompts(&self.stores.quick_prompts).await,
        }
    }

    /// Arm the debounced flush unless one is already pending.
    fn schedule_flush(&mut self) {
        if self.flush_timer.is_none() {
            self.flush_timer = Some(self.arm(WRITE_DEBOUNCE.as_millis() as u64, Msg::FlushWrites));
        }
    }

    /// Write whatever [`WRITE_DEBOUNCE`] is holding back, now.
    async fn flush_writes(&mut self) {
        abort(&mut self.flush_timer);
        let p = Persister::new(self.kv.as_ref());
        if std::mem::take(&mut self.machines_dirty) {
            p.save_machines(&self.stores.machines).await;
        }
        if let Some(ts) = self.stored_seen_dirty.take() {
            p.save_last_stored_seen(ts).await;
        }
    }

    /// Point the transport at the stores' relay set when it changed: a
    /// pairing began or ended, a machine was added or removed, or its relays
    /// were edited.
    fn sync_relays(&mut self) {
        let relays = self.stores.relay_set();
        if relays != self.relay_set {
            log::info!("relays: {relays:?}");
            self.nostr.set_relays(&relays);
            self.relay_set = relays;
        }
    }

    /// Subscription authors = registered machines + the pairing candidate (its
    /// pair-ack must pass the filter). Push them to the `LoopHost` and, if
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

    /// Fold a user action into the stores and carry out its effects. Returns
    /// `reply` unless an image send took it over (see [`Self::spawn_session_file`]).
    async fn on_intent(
        &mut self,
        intent: Intent,
        reply: oneshot::Sender<()>,
    ) -> Option<oneshot::Sender<()>> {
        let mut reply = Some(reply);
        // A pairing grants the current key: never one about to be replaced.
        self.rotate_session_key_if_due().await;
        let ctx = IntentCtx {
            now: self.clock.now_ms(),
            visible: self.conn.visible,
        };
        let result = apply_intent(&mut self.stores, intent, &self.keys, ctx);
        let session_file_send = result.session_file_send.clone();
        self.interpret_intent(result).await;
        if let Some(send) = session_file_send {
            self.spawn_session_file(send, reply.take());
        }
        reply
    }

    /// The ports an image send needs, cloned out of the loop so the send can
    /// run as its own task.
    fn image_send_ctx(&self, machine: &str) -> FileSendCtx {
        FileSendCtx {
            signer: Rc::clone(&self.signer),
            cipher: self.cipher_for(machine),
            relays: self.stores.relays_for(machine),
            http: Rc::clone(&self.http),
            ws: self.ws.clone(),
            clock: Rc::clone(&self.clock),
            entropy: Rc::clone(&self.entropy),
            observer: Rc::clone(&self.observer),
            blossom_server: Some(self.stores.settings.data.blossom_server.trim().to_string()).filter(|s| !s.is_empty()),
        }
    }

    /// Runs [`FileSendCtx::send_session_file`] as its own task and answers
    /// `reply` when it finishes. An upload can take minutes (Blossom retries,
    /// then a paced chunk fallback); on the loop it would hold up relay
    /// events, reconnects and every view query for that long.
    fn spawn_session_file(&self, send: SessionFileSend, reply: Option<oneshot::Sender<()>>) {
        let ctx = self.image_send_ctx(&send.machine);
        tokio::task::spawn_local(async move {
            ctx.send_session_file(send).await;
            if let Some(reply) = reply {
                let _ = reply.send(());
            }
        });
    }

    async fn interpret_intent(&mut self, r: IntentResult) {
        for &id in &r.persist {
            self.persist_store(id).await;
            self.state_changed(slice_of(id));
        }
        // Relay/subscription reconfiguration runs BEFORE the sends below: a
        // pairing candidate's relays must reach the transport before its
        // `SendPairRequest` is dispatched, or a bridge reachable only over
        // one of them never sees the request.
        self.sync_relays();
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if let Some(o) = r.outbox_send {
            self.on_send_tracked(o.id, o.machine, o.msg);
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
        // CDX-026c: opening a session the user was notified about clears
        // every notification filed under its (coarser-than-delivery) tag.
        for effect in r.ui_effects {
            match effect {
                UiEffect::SessionViewed { machine, session_id } => {
                    self.notifier.cancel(&session_notify_tag(&machine, &session_id));
                }
            }
        }
        if let Some(on) = r.tor_changed {
            let proxy = if on { self.tor_proxy_address.clone() } else { None };
            self.nostr.set_proxy(proxy.clone());
            self.http.set_proxy(proxy.as_deref());
        }
        // Orbot toggled, a machine removed, or its endpoints edited.
        self.sync_direct_links();
    }

    /// Post-(re)connect reconcile. Port of `createPhoneCore`'s
    /// `refreshAndReconcile` handler. On a resume (`reconnected: false`) a
    /// machine heard from within [`RESUME_HEARD_WITHIN_MS`] is not asked for
    /// its list again, and the answers held for the connection stay good.
    async fn on_refresh_reconcile(&mut self, reconnected: bool) {
        // Reset any sync cycle a prior failure left stuck.
        self.stores.transcript.on_reconnect(None);
        if reconnected {
            // A push (provider profiles, say) may have been missed.
            self.stores.machines.fetches.forget_all();
        }

        let now = self.clock.now_ms();
        let machines = self.stores.machines.machine_pubkeys();
        for machine in &machines {
            let heard_lately = self
                .stores
                .machines
                .machine(machine)
                .and_then(|m| m.last_heartbeat_at)
                .is_some_and(|at| now.saturating_sub(at) < RESUME_HEARD_WITHIN_MS);
            if reconnected || !heard_lately {
                // Ask for a fresh session list (the stored 30515's seqHigh
                // goes stale — CDX-008).
                self.on_send(
                    machine.clone(),
                    PhoneToBridge::RefreshSessions(protocol::commands::BareMsg {
                        version: Default::default(),
                    }),
                    None,
                );
            }
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
                let mut view = MachinesView::from_stores(&self.stores);
                view.direct_up = self.links_up.iter().map(|(m, e)| (m.clone(), e.clone())).collect();
                let _ = reply.send(view);
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
                let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
                let _ = reply.send(ConnectionView::new(
                    self.conn.status,
                    self.conn.needs_pairing_check,
                    connected,
                ));
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
        self.sync_relays();
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
        match (msg, reply) {
            (PhoneToBridge::SyncAck(ack), None) => self.hold_ack(machine, ack),
            (msg, reply) => self.publish_command(machine, msg, reply, None),
        }
    }

    /// Hold `ack` for [`ACK_BATCH_WINDOW`], merged with the other acks of
    /// its sync.
    fn hold_ack(&mut self, machine: String, ack: SyncAckMsg) {
        match self.pending_acks.iter_mut().find(|(m, id, _)| *m == machine && *id == ack.sync_id) {
            Some((_, _, ranges)) => ranges.extend(ack.ranges),
            None => self.pending_acks.push((machine, ack.sync_id, ack.ranges)),
        }
        if self.ack_timer.is_none() {
            self.ack_timer = Some(self.arm(ACK_BATCH_WINDOW.as_millis() as u64, Msg::FlushAcks));
        }
    }

    /// Send the held acks now, one command per sync.
    fn flush_acks(&mut self) {
        abort(&mut self.ack_timer);
        for (machine, sync_id, ranges) in std::mem::take(&mut self.pending_acks) {
            let ack = SyncAckMsg { version: Default::default(), sync_id, ranges };
            self.publish_command(machine, PhoneToBridge::SyncAck(ack), None, None);
        }
    }

    /// Like [`Self::on_send`] but the publish outcome comes back as
    /// [`Msg::PublishSettled`] so the loop can settle an outbox item.
    fn on_send_tracked(&mut self, id: String, machine: String, msg: PhoneToBridge) {
        self.publish_command(machine, msg, None, Some(id));
    }

    /// What encrypts payloads for `machine`: the session key it confirmed,
    /// while the phone still holds it, else the identity.
    fn cipher_for(&self, machine: &str) -> Cipher {
        let now = self.clock.now_ms();
        match self.stores.machines.session_key_of(machine, now).and_then(|k| self.session.key(k, now)) {
            Some(key) => Cipher::SessionKey(key.keypair.clone()),
            None => Cipher::Identity,
        }
    }

    fn publish_command(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    ) {
        // Every command is signed by the identity, in order, through the
        // signer; `publish_built` takes it from there.
        let now = self.clock.now_ms();
        let cipher = match msg {
            // A pairing candidate does not know the session key yet.
            PhoneToBridge::PairRequest(_) => Cipher::Identity,
            _ => self.cipher_for(&machine),
        };
        let _ = self.signer_jobs.send(SignerJob::Command { machine, msg: Box::new(msg), cipher, now, reply, outbox_id });
    }

    /// Publish a built command, or report why it could not be built. It goes
    /// over `machine`'s direct link when that is up and the bridge answers,
    /// else to the relays.
    fn publish_built(
        &mut self,
        machine: &str,
        event: Result<SignedEvent, EgressError>,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    ) {
        let event = match event {
            Ok(event) => event,
            Err(err) => {
                self.observer.action_failed(ActionFailedKind::PublishRejected);
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
        // socket-close / lifecycle handling. Only to `machine`'s relays: the
        // other machines' relays have no use for it.
        let ws = self.ws.clone();
        let relays = self.stores.relays_for(machine);
        let link = self.links.get(machine).map(|(_, link)| link.clone());
        let observer = Rc::clone(&self.observer);
        let self_tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let direct = match &link {
                Some(link) => link.publish(&event, DIRECT_PUBLISH_WAIT).await,
                None => None,
            };
            let result = match direct {
                Some(result) => result,
                None => ws.publish_confirmed_to(&event, &relays, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS).await,
            };
            let failed = match result.verdict {
                PublishVerdict::Rejected => Some(ActionFailedKind::PublishRejected),
                PublishVerdict::Unreachable => Some(ActionFailedKind::PublishUnreachable),
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

/// The ports an image send needs, cloned out of the loop so the send runs
/// as its own task (see `Loop::spawn_session_file`). It never touches the
/// stores: everything it reports goes through the observer.
struct FileSendCtx {
    signer: Rc<dyn IdentitySigner>,
    /// The machine's payload cipher, decided when the send started.
    cipher: Cipher,
    /// The machine's relays (see `CoreStores::relays_for`).
    relays: Vec<String>,
    http: Rc<dyn crate::attachments::HttpFetch>,
    ws: WsTransport,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
    /// The Blossom server the user chose, if any.
    blossom_server: Option<String>,
}

impl FileSendCtx {
    /// Build + sign + publish one command inline (unlike [`Loop::publish_command`],
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
        match crate::signer::build_command(self.signer.as_ref(), &self.cipher, machine, &msg, now).await {
            Ok(event) => self.ws.publish_confirmed_to(&event, &self.relays, budget, attempts).await,
            Err(err) => PublishResult {
                verdict: PublishVerdict::Rejected,
                detail: Some(egress_detail(&err)),
            },
        }
    }

    /// A session attachment, through the user's Blossom server when one is
    /// set, else (or when it fails) through the relays in chunks. Two
    /// INDEPENDENT stages:
    /// stage 1 puts the bytes somewhere durable, stage 2 tells the bridge
    /// where they are. Only a stage-1 failure reaches the chunk fallback — once
    /// the bridge is told a URL, the bytes are already on the server, so a
    /// stage-2 rejection is a hard failure, never a reason to re-upload
    /// megabytes over the relays. No optimistic local echo: the image lands in
    /// the transcript only once the bridge injects it, like any other output.
    async fn send_session_file(
        &self,
        send: SessionFileSend,
    ) {
        let SessionFileSend { machine, session_id, text, data, filename, mime_type } = send;
        use client_core::image_chunks::{chunk_base64, IMAGE_CHUNK_BYTES, IMAGE_CHUNK_DELAY_MS};
        use protocol::commands::{
            UploadFileBlossomMsg, UploadFileChunkMsg, UploadFileMsg, VersionFields,
        };

        /// Overall wall clock for the whole send, all stages together.
        const SESSION_IMAGE_SEND_BUDGET_MS: u64 = 120_000;
        /// Budget for the chunk fallback, from the first chunk. Deliberately
        /// under the bridge's 60 s chunk-assembly window (armed on the first
        /// chunk) — past that point every further chunk is guaranteed waste,
        /// the tracker is already gone. PAIRED CONSTANT with the bridge side.
        const CHUNK_ASSEMBLY_BUDGET_MS: u64 = 55_000;
        use crate::attachments::MAX_FALLBACK_CHUNKS;

        let started_at = self.clock.now_ms();
        let size_bytes = data.len() as u64;

        let fail = |this: &Self| {
            this.observer.action_failed(ActionFailedKind::PublishRejected);
            this.observer
                .on_event(CoreEvent::ActionFailed { kind: ActionFailedKind::PublishRejected });
        };

        // --- Stage 1: the bytes, on the user's server when they chose one ---
        let uploaded = match self.blossom_server.as_deref() {
            Some(server) => {
                let opts = crate::attachments::UploadOptions::at(server, started_at);
                Some(crate::attachments::upload_encrypted_blob(&data, self.signer.as_ref(), self.http.as_ref(), opts).await)
            }
            None => None,
        };

        if let Some(Ok(reference)) = uploaded {
            // --- Stage 2: the reference ---
            let hash = client_core::image_chunks::blossom_hash_from_url(&reference.url).to_string();
            let msg = PhoneToBridge::UploadFile(UploadFileMsg::Blossom(UploadFileBlossomMsg {
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
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&data);
        let chunks = chunk_base64(&base64_data, IMAGE_CHUNK_BYTES);
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
            let msg = PhoneToBridge::UploadFile(UploadFileMsg::Chunk(UploadFileChunkMsg {
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

}

fn incoming_of(event: &NostrEvent) -> IncomingEvent<'_> {
    IncomingEvent {
        id: &event.id,
        pubkey: &event.pubkey,
        kind: event.kind,
        content: &event.content,
    }
}

fn abort(slot: &mut Option<AbortHandle>) {
    if let Some(handle) = slot.take() {
        handle.abort();
    }
}

fn slice_of(id: StoreId) -> SliceId {
    match id {
        StoreId::Machines => SliceId::Machines,
        StoreId::Outbox => SliceId::Outbox,
        StoreId::Settings => SliceId::Settings,
        StoreId::QuickPrompts => SliceId::QuickPrompts,
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
mod tests;
