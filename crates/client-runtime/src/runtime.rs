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
use crate::intent::{apply as apply_intent, Intent, IntentCtx, IntentResult, SessionImageSend, UndoTimer};
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

pub struct CoreConfig {
    pub relays: Vec<String>,
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
    pub fn new(
        relays: Vec<String>,
        identity: Rc<dyn IdentitySigner>,
        proxy: Option<String>,
        tor: bool,
    ) -> Self {
        Self {
            relays,
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
        let host = Rc::new(LoopHost {
            tx: tx.clone(),
            machines: RefCell::new(initial_authors.clone()),
            cursor: RefCell::new(hydrated.last_stored_seen),
        });
        let ws = WsTransport::new(WsConfig {
            relays: config.relays.clone(),
            auth: Rc::new(IdentityAuth(Rc::clone(&config.identity))),
            proxy: if config.tor { config.proxy.clone() } else { None },
        });
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

    /// Replace the relay list (settings changed). The transport re-dials the
    /// diff and, if connected, the subscription client re-REQs.
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
    /// The connection FSM asked for a post-(re)connect reconcile.
    RefreshReconcile,
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
        event: Result<SignedEvent, EgressError>,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
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
                }
                Msg::Stop => {
                    log::info!("core: Stop (status was {:?})", self.conn.status);
                    self.dispatch(ConnectionEvent::DisconnectRequested);
                    abort(&mut self.stale_timer);
                    self.flush_acks();
                    self.flush_writes().await;
                }
                Msg::Pause => {
                    // Backgrounded: the OS may kill the process from here on.
                    self.flush_acks();
                    self.flush_writes().await;
                    self.ws.set_ping_interval(BACKGROUND_PING_EVERY);
                    self.dispatch(ConnectionEvent::Visibility { visible: false });
                }
                Msg::Resume => {
                    self.ws.set_ping_interval(PING_EVERY);
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
                    let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
                    let _ = reply.send((self.conn.status, self.conn.needs_pairing_check, connected));
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
                Msg::RefreshReconcile => self.on_refresh_reconcile().await,
                Msg::IdentityDecrypted { event, plaintext } => {
                    let incoming = incoming_of(&event);
                    let now = self.clock.now_ms();
                    let ingested = match plaintext {
                        Ok(text) => self.api.ingest_plaintext(&incoming, text, now),
                        Err(err) => self.api.decrypt_failed(&incoming, err.0),
                    };
                    self.on_ingested(&event, ingested, &Recipient::Identity).await;
                }
                Msg::CommandSigned { event, reply, outbox_id } => self.publish_built(event, reply, outbox_id),
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
        // Ahead of the sends below — same reasoning as `interpret_intent`:
        // a relay learned from the pairing candidate must reach the
        // transport before any send that depends on it goes out.
        if let Some(relays) = r.relays_changed {
            self.nostr.set_relays(&relays);
        }
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
    /// `reply` unless an image send took it over (see [`Self::spawn_session_image`]).
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
        let session_image_send = result.session_image_send.clone();
        self.interpret_intent(result).await;
        if let Some(send) = session_image_send {
            self.spawn_session_image(send, reply.take());
        }
        reply
    }

    /// The ports an image send needs, cloned out of the loop so the send can
    /// run as its own task.
    fn image_send_ctx(&self, machine: &str) -> ImageSendCtx {
        ImageSendCtx {
            signer: Rc::clone(&self.signer),
            cipher: self.cipher_for(machine),
            http: Rc::clone(&self.http),
            ws: self.ws.clone(),
            clock: Rc::clone(&self.clock),
            entropy: Rc::clone(&self.entropy),
            observer: Rc::clone(&self.observer),
        }
    }

    /// Runs [`ImageSendCtx::send_session_image`] as its own task and answers
    /// `reply` when it finishes. An upload can take minutes (Blossom retries,
    /// then a paced chunk fallback); on the loop it would hold up relay
    /// events, reconnects and every view query for that long.
    fn spawn_session_image(&self, send: SessionImageSend, reply: Option<oneshot::Sender<()>>) {
        let ctx = self.image_send_ctx(&send.machine);
        tokio::task::spawn_local(async move {
            ctx.send_session_image(send).await;
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
        // pairing-driven relay merge (`AddRelays`, or the pairing FSM's own
        // `NotifyCandidate` relay learning) must reach the transport before
        // a queued `SendPairRequest` is dispatched, or a bridge reachable
        // only over the newly-learned relay never sees the request.
        if let Some(relays) = r.relays_changed {
            self.nostr.set_relays(&relays);
        }
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

    /// Publish a built command, or report why it could not be built.
    fn publish_built(
        &mut self,
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
        // socket-close / lifecycle handling.
        let ws = self.ws.clone();
        let observer = Rc::clone(&self.observer);
        let self_tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let result = ws
                .publish_confirmed(&event, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS)
                .await;
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
/// as its own task (see `Loop::spawn_session_image`). It never touches the
/// stores: everything it reports goes through the observer.
struct ImageSendCtx {
    signer: Rc<dyn IdentitySigner>,
    /// The machine's payload cipher, decided when the send started.
    cipher: Cipher,
    http: Rc<dyn crate::attachments::HttpFetch>,
    ws: WsTransport,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
}

impl ImageSendCtx {
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
        &self,
        send: SessionImageSend,
    ) {
        let SessionImageSend { machine, session_id, text, image, filename, mime_type } = send;
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
            this.observer.action_failed(ActionFailedKind::PublishRejected);
            this.observer
                .on_event(CoreEvent::ActionFailed { kind: ActionFailedKind::PublishRejected });
        };

        // --- Stage 1: the bytes ---
        let opts = crate::attachments::UploadOptions::at(started_at);
        let uploaded =
            crate::attachments::upload_encrypted_image(&image, self.signer.as_ref(), self.http.as_ref(), opts)
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
mod tests {
    use super::*;
    use crate::ports::RecordingNotifier;
    use crate::transport::mock::{mock_relay, MockRelay};
    use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
    use protocol::codec::encode_bridge_to_phone;
    use protocol::commands::UploadImageMsg;
    use protocol::kinds::{LIVE_KIND, RESPONSE_KIND, SESSION_LIST_KIND};
    use crate::stores::LAST_STORED_SEEN_KEY;
    use crate::intent::SessionImageSend;
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
        Core::spawn(
            CoreConfig {
                relays: vec![mock.url.clone()],
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

                let core2 = core.clone();
                let upload = tokio::task::spawn_local(async move {
                    core2
                        .dispatch(Intent::SendSessionImage(SessionImageSend {
                            machine: "m".into(),
                            session_id: "s1".into(),
                            text: String::new(),
                            image: b"bytes".to_vec(),
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
                let mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let spy = Rc::new(Spy::default());
                let recording = Rc::new(RecordingHttp::default());
                let ports = CorePorts {
                    http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                    ..CorePorts::default()
                };
                let _core = Core::spawn(
                    CoreConfig {
                        relays: vec![mock.url.clone()],
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
                let mock = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let spy = Rc::new(Spy::default());
                let recording = Rc::new(RecordingHttp::default());
                let ports = CorePorts {
                    http: Rc::clone(&recording) as Rc<dyn crate::attachments::HttpFetch>,
                    ..CorePorts::default()
                };
                let _core = Core::spawn(
                    CoreConfig {
                        relays: vec![mock.url.clone()],
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
    /// subscription is dead — see `router::tests::
    /// eose_fires_once_after_every_live_relay_reports` for the same
    /// aggregate rule on the open side), so `dispatch`'s status-transition
    /// gate never runs. Without the periodic watchdog picking this up too,
    /// Settings' per-relay dot would freeze on the stale, fuller set forever
    /// — this is the "dots never show any color" report's root cause.
    #[tokio::test]
    async fn a_relay_dying_while_another_survives_is_caught_by_the_periodic_watchdog() {
        LocalSet::new()
            .run_until(async {
                let mut mock1 = mock_relay().await;
                let mut mock2 = mock_relay().await;
                let phone = keypair_from_secret_hex(SEC_PHONE).unwrap();
                let machine = generate_keypair();
                let spy = Rc::new(Spy::default());
                let core = Core::spawn(
                    CoreConfig {
                        relays: vec![mock1.url.clone(), mock2.url.clone()],
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

                core.set_machines(vec![machine.pubkey_hex.clone()]);
                core.start();

                eose_all(&mut mock1).await;
                eose_all(&mut mock2).await;
                settle().await;

                let before = spy.connected_relays.lock().unwrap().last().unwrap().clone();
                assert_eq!(before.len(), 2, "{before:?}");
                let before_status_calls = spy.statuses.lock().unwrap().len();

                mock2.close();
                settle().await; // real time — confirms the close registers on its own
                // The status-transition gate did NOT fire — confirms this
                // scenario actually needs the watchdog, not dispatch's own
                // path (which the previous test already covers).
                assert_eq!(spy.statuses.lock().unwrap().len(), before_status_calls, "{:?}", spy.statuses.lock().unwrap());

                // Fast-forward past the watchdog's 30s tick. Paused only NOW
                // (after the real socket close above already settled) so it
                // never races the mock relays' own real-time handshake.
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(31)).await;
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                }

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
                state.register_machine(&machine.pubkey_hex, "bridge", None, None);
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
                    r#"{"type":"output","sessionId":"s1","seq":1,"entry":{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}}"#,
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
                        {"id":"s1","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}
                    ],"agents":[],"protocolVersion":11}"#,
                )
                .unwrap();
                push_bridge_to_phone_event(&mock, &machine, &phone.pubkey_hex, &sub, &sessions_msg);
                settle().await;

                let msg = protocol::codec::decode_bridge_to_phone(
                    r#"{"type":"output","sessionId":"s1","seq":1,"entry":{"entryType":"text","role":"agent","text":"hi","timestamp":"t"}}"#,
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
                state.register_machine(&machine.pubkey_hex, "bridge", None, None);
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
                state.register_machine(&machine.pubkey_hex, "bridge", None, None);
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
                state.register_machine(&machine.pubkey_hex, "bridge", None, None);
                let kv = MemoryKv::seeded([(
                    crate::stores::MACHINES_KEY,
                    client_core::stores::machines::serialize_machines(&state.machines),
                )]);
                let signs = Rc::new(std::cell::Cell::new(0));
                let core = Core::spawn(
                    CoreConfig {
                        relays: vec![mock.url.clone()],
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
}
