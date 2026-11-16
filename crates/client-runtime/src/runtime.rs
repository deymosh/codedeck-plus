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

use std::collections::{BTreeMap, HashMap};

use client_core::bridge_api::{BridgeApi, EgressError, IncomingEvent};
use client_core::stores::session_key::{Recipient, SessionKeyRing};
use nostr_transport::direct::DirectLink;
use nostr_transport::{PublishResult, PublishVerdict};
use client_core::connection::{
    initial_connection_state, ConnectionEvent, ConnectionState, ConnectionStatus, ReconnectConfig,
    DEFAULT_RECONNECT_CONFIG, TOR_RECONNECT_CONFIG,
};
use protocol::commands::PhoneToBridge;
use protocol::ranges::SeqRange;
use protocol::nostr_event::SignedEvent;
use protocol::events::BridgeToPhone;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use crate::dispatch::StoreId;
use crate::intent::Intent;
use crate::nostr_client::{NostrClient, NostrClientHost, NostrEvent};
use crate::ports::{
    Kv, KvSessionKeyStore, MemoryKv, MemoryTranscriptStore, NullNotifier, Notifier, SessionKeyStore, TranscriptStore,
};
use crate::signer::{sanitize_device_label, Cipher, IdentityAuth, IdentitySigner, PhoneKeys, SignerError};
use crate::stores::{hydrate, CoreStores, Persister, StoresConfig};
use client_core::stores::backup::ConfigBackup;
use crate::transport::ws::{WsConfig, WsTransport, PING_EVERY};
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
/// The longest a stop waits for its `away` to go out.
const AWAY_WAIT: Duration = Duration::from_secs(2);
/// How long a change of what this client watches is coalesced before it is
/// sent: flicking through sessions sends one `presence`, not one per tap.
const WATCH_SETTLE_MS: u64 = 300;
/// Relay ping interval while the app is in the background. Every ping is a
/// radio wake-up per relay round; in the background the host's periodic
/// [`Core::keepalive`] is what checks the sockets.
const BACKGROUND_PING_EVERY: Duration = Duration::from_secs(150);
/// How long [`Core::keepalive`] waits for the relays to answer its ping.
const KEEPALIVE_PROBE: Duration = Duration::from_secs(10);
/// How long the machines store and the stored-event cursor may stay dirty in
/// memory. Heartbeats and usage updates each change the machines store,
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

/// What one `presence` tells a machine this client is showing: the session
/// whose live text it draws, and the terminal whose output it draws. Both are
/// `None` for a machine it shows neither of, which is how a bridge is told to
/// stop sending them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Watch {
    session: Option<String>,
    terminal: Option<String>,
}

/// Where a machine's direct link goes: its endpoints, the certificate pin,
/// and the proxy (Orbot) in force.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectTarget {
    endpoints: Vec<String>,
    pin: Option<String>,
    proxy: Option<String>,
    /// The recipient tags the link asks for: a key rotating restarts it.
    recipients: Vec<String>,
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
    /// A reply the agent is still writing, in the session on screen: live
    /// row `key`'s whole text now, or `None` once the row is gone (its entry
    /// landed, or the session stopped running). Shown after the transcript's
    /// rows; never stored.
    LiveText { machine: String, session_id: String, key: String, text: Option<String> },
    /// Output a terminal on screen produced: `bytes` (already base64-decoded)
    /// start at `offset`, a byte offset into everything that terminal has
    /// written. On its own event, never a view: a shell can produce megabytes
    /// a second, and a view snapshot per frame would slow every other slice
    /// down. The consumer draws the bytes and advances its own cursor.
    TerminalOutput { machine: String, term: String, offset: u64, bytes: Vec<u8> },
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

/// What an input step asks the loop's flush timer to do — the timer twin of
/// `client_core::stores::terminals::InputStep::flush_at_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalFlush {
    /// Arm (or re-arm) the flush at this absolute ms deadline.
    Arm { at_ms: u64 },
    /// Nothing is waiting: stop the timer.
    Clear,
}

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
    /// The phone's own name, sent on every session-key grant as
    /// `SessionKeyGrant::label`: what a person reads in the bridge's terminal
    /// allowlist (`codedeck-bridge terminal pending`) and in a refusal to open
    /// a terminal. Sanitized by [`sanitize_device_label`] — at most
    /// [`crate::signer::DEVICE_LABEL_MAX`] characters, control characters
    /// stripped, trimmed, and empty becomes `None`. Display only: the bridge
    /// trusts the device id derived from the first key, never this name.
    pub device_label: Option<String>,
    /// Backoff / stale-window timing. [`CoreConfig::new`] picks the Tor variant
    /// when `tor` is set; tests override directly. The loop re-derives it the
    /// same way whenever `Intent::SetTorEnabled` changes the transport at
    /// runtime.
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
    /// `device_label` is the phone's name for the bridge (see the field doc);
    /// it is sanitized here, so an empty or whitespace-only name is stored as
    /// `None` and a long one is capped before it ever reaches a grant.
    pub fn new(
        identity: Rc<dyn IdentitySigner>,
        proxy: Option<String>,
        tor: bool,
        device_label: Option<String>,
    ) -> Self {
        Self {
            identity,
            proxy,
            tor,
            device_label: device_label.as_deref().and_then(sanitize_device_label),
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
        let keys = PhoneKeys::new(&config.identity.pubkey_hex(), &session.current, config.device_label.clone());

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
            recipients: RefCell::new(recipients_of(&session, &keys.identity_pubkey_hex, &initial_authors, clock.now_ms())),
            relays: RefCell::new(hydrated.stores.bridge_relays()),
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
        let mut stores = hydrated.stores;
        // The device this install is, as a bridge names it in a terminal's
        // `writer` and in every `terminal-event`: a hash of the first session
        // key it ever made, so a terminal can tell this phone's input from
        // another client's.
        stores.terminals.set_device_id(session.device_id());
        let event_loop = Loop {
            reconnect: config.reconnect,
            signer: config.identity,
            session,
            key_store,
            keys,
            signer_jobs,
            grant_attempts: HashMap::new(),
            last_command_ms: HashMap::new(),
            stop_epoch: 0,
            tor_proxy_address: config.proxy,
            clock,
            entropy,
            observer,
            conn: initial_connection_state(),
            connecting_since: None,
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
            unanswered_timer: None,
            watch_timer: None,
            watch_sent: BTreeMap::new(),
            terminal_flush_timer: None,
            undo_timer: None,
            backup_timer: None,
            backup_busy: false,
            backup_created_at: 0,
            backup_sub: None,
            backup_sub_seq: 0,
            backup_heard: false,
            backup_found: false,
            backup_seen_at: 0,
            backup_seen_ids: Vec::new(),
            backup_opening: 0,
            backup_epoch: 0,
            backup_unreadable: false,
            backup_wait_timer: None,
            backup_retry_timer: None,
            backup_retry_ms: 0,
            machines_dirty: false,
            stored_seen_dirty: None,
            flush_timer: None,
            pending_acks: Vec::new(),
            ack_timer: None,
            grant_waits: HashMap::new(),
            grant_seq: 0,
            links: HashMap::new(),
            links_up: HashMap::new(),
            links_on: false,
            link_ping: PING_EVERY,
            self_tx: tx.clone(),
            stores,
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

    #[cfg(test)]
    pub(crate) fn tick(&self) {
        let _ = self.tx.send(Msg::StaleWatchdog);
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
    /// `ConnectivityManager` says the network came / went. Repeating `true`
    /// says it changed or regained internet access: whatever is down is
    /// dialled again at once.
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
            agent_styles: Default::default(),
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
        self.transcript_view_after(machine, session_id, 0).await
    }
    /// [`Self::transcript_view`] with only the rows past `after` — for a
    /// caller that keeps the ones up to it (see `TranscriptRowsView::load`).
    pub async fn transcript_view_after(&self, machine: String, session_id: String, after: u64) -> TranscriptRowsView {
        self.query(|reply| ViewQuery::Transcript { machine, session_id, after, reply })
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
            web_sign_in: Default::default(),
            web_browsers: Default::default(),
            undo_toast: None,
            terminals: Default::default(),
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
    /// The coalescing window for a change of what this client watches closed.
    WatchSettle,
    /// The terminal input batching window closed, or the relay rate cap
    /// lifted: send whatever is still waiting.
    TerminalFlush,
    StaleWatchdog,
    /// The host woke the device to check the connection.
    Keepalive(oneshot::Sender<()>),
    /// That check's relay probe finished.
    KeepaliveProbed(oneshot::Sender<()>),
    PairDeadline,
    /// The earliest machine-settings change waiting for an answer is due to
    /// be given up on.
    UnansweredDeadline,
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
        quiet: bool,
    },
    /// The `away` sent on a stop settled (or ran out of time): stop now,
    /// unless a start since (`epoch`) took it back.
    Stopped { epoch: u64 },
    /// A bridge's direct link delivered an event.
    DirectEvent(NostrEvent),
    /// Time to save the config backup.
    BackupDue,
    /// A look on the backup relay finished.
    BackupFetched { epoch: u64, found: backup::Fetched },
    /// A version of the backup came in on its subscription.
    BackupEvent(NostrEvent),
    /// The backup relay sent all it has, on subscription `sub`.
    BackupEose { sub: u64 },
    /// The backup relay ended subscription `sub`, or every socket to it dropped.
    BackupClosed { sub: u64, reason: Option<String> },
    /// The backup relay has not said what it holds a while after
    /// subscription `sub` was made.
    BackupNoAnswer { sub: u64 },
    /// Time to subscribe to the backup again after it was closed.
    BackupRetry,
    /// A backup save finished: when it was made and what it held, or why
    /// it failed.
    BackupSaved { epoch: u64, saved: Result<backup::Saved, String> },
    /// The backup's deletion was sent (or given up on).
    BackupDeleted,
    /// A machine's direct link came up on an endpoint, or went down.
    DirectState {
        machine: String,
        endpoint: Option<String>,
    },
    /// The grant `machine` is waiting on (`seq`) reached a relay, or did not.
    GrantPublished { machine: String, seq: u64, delivered: bool },
    /// `machine` did not confirm the grant `seq` in [`grant::GRANT_WAIT`].
    GrantWaitOver { machine: String, seq: u64 },
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
        /// Housekeeping the user did not ask for: a failure is not shown.
        quiet: bool,
    },
    /// Decrypt a message the session key could not.
    Decrypt(NostrEvent),
    /// Open the identity's config backup.
    OpenBackup {
        event: NostrEvent,
        reply: oneshot::Sender<Result<ConfigBackup, String>>,
    },
    /// Seal the config backup into a signed event.
    SealBackup {
        backup: Box<ConfigBackup>,
        created_at: u64,
        reply: oneshot::Sender<Result<SignedEvent, String>>,
    },
    /// Sign the deletion of the config backup.
    SealDeletion {
        created_at: u64,
        reply: oneshot::Sender<Result<SignedEvent, String>>,
    },
    /// Sign the empty version that replaces a deleted config backup.
    SealRemoved {
        created_at: u64,
        reply: oneshot::Sender<Result<SignedEvent, String>>,
    },
}

async fn run_signer(
    signer: Rc<dyn IdentitySigner>,
    mut jobs: mpsc::UnboundedReceiver<SignerJob>,
    tx: mpsc::UnboundedSender<Msg>,
) {
    while let Some(job) = jobs.recv().await {
        let msg = match job {
            SignerJob::Command { machine, msg, cipher, now, reply, outbox_id, quiet } => Msg::CommandSigned {
                event: crate::signer::build_command(signer.as_ref(), &cipher, &machine, &msg, now).await,
                machine,
                reply,
                outbox_id,
                quiet,
            },
            SignerJob::Decrypt(event) => Msg::IdentityDecrypted {
                plaintext: signer.nip44_decrypt(&event.pubkey, &event.content).await,
                event,
            },
            // The backup's own task waits for these.
            SignerJob::OpenBackup { event, reply } => {
                let _ = reply.send(crate::backup::open_backup(signer.as_ref(), &event).await);
                continue;
            }
            SignerJob::SealBackup { backup, created_at, reply } => {
                let _ = reply.send(crate::backup::seal_backup(signer.as_ref(), &backup, created_at).await);
                continue;
            }
            SignerJob::SealDeletion { created_at, reply } => {
                let _ = reply.send(crate::backup::seal_deletion(signer.as_ref(), created_at).await);
                continue;
            }
            SignerJob::SealRemoved { created_at, reply } => {
                let _ = reply.send(crate::backup::seal_removed(signer.as_ref(), created_at).await);
                continue;
            }
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
        after: u64,
        reply: oneshot::Sender<TranscriptRowsView>,
    },
}

/// [`NostrClientHost`] that forwards every callback into the loop as a [`Msg`]
/// (decoupling reentrancy — a callback fires inside the transport's task).
/// The recipient tags of this client's copies from each of `machines`.
fn recipients_of(session: &SessionKeyRing, identity: &str, machines: &[String], now_ms: u64) -> Vec<String> {
    machines.iter().flat_map(|m| session.recipient_tags(m, identity, now_ms)).collect()
}

struct LoopHost {
    tx: mpsc::UnboundedSender<Msg>,
    machines: RefCell<Vec<String>>,
    /// The recipient tags of this client's copies from `machines`.
    recipients: RefCell<Vec<String>>,
    /// The relays `machines` use, which their subscriptions go to.
    relays: RefCell<Vec<String>>,
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
    fn recipients(&self) -> Vec<String> {
        self.recipients.borrow().clone()
    }
    fn relays(&self) -> Vec<String> {
        self.relays.borrow().clone()
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
    /// When a command last went to each machine (ms): any command keeps
    /// this client present there, so a `presence` is only sent after a
    /// quiet [`PRESENCE_RENEW_SECS`](protocol::commands::PRESENCE_RENEW_SECS).
    last_command_ms: HashMap<String, u64>,
    /// Bumped by each start and stop: a stop's deferred end (after its
    /// `away`) only goes ahead if nothing came since.
    stop_epoch: u64,
    /// The SOCKS5 address to dial through WHEN Tor is on — remembered
    /// regardless of whether it's currently in use, so `Intent::SetTorEnabled`
    /// can toggle `self.ws`'s live proxy without the phone resending it.
    tor_proxy_address: Option<String>,
    clock: Rc<dyn Clock>,
    entropy: Rc<dyn Entropy>,
    observer: Rc<dyn CoreObserver>,
    conn: ConnectionState,
    /// When the current `Connecting` attempt began (ms); `None` in every other
    /// status. [`CONNECT_DEADLINE_MS`] turns an attempt that never reaches EOSE
    /// into the ordinary close/backoff path.
    connecting_since: Option<u64>,
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
    /// When the earliest machine-settings change still waiting for an answer
    /// gives up (see [`client_core::stores::machines::SETTINGS_ANSWER_TIMEOUT_MS`]).
    unanswered_timer: Option<AbortHandle>,
    /// The coalescing window for a change of what this client watches (see
    /// [`Loop::watch_changed`]).
    watch_timer: Option<AbortHandle>,
    /// The machine last told what this client watches, and what: what a
    /// change is measured against.
    watch_sent: BTreeMap<String, Watch>,
    /// The terminal input batching window, or the relay rate cap lifting
    /// (see `client_core::stores::terminals`).
    terminal_flush_timer: Option<AbortHandle>,
    /// The delete-controller's 4 s undo window.
    undo_timer: Option<AbortHandle>,
    /// The pending config backup save (see `runtime::backup`).
    backup_timer: Option<AbortHandle>,
    /// A backup look, save or deletion is under way.
    backup_busy: bool,
    /// The `created_at` (s) of the last backup event made.
    backup_created_at: u64,
    /// The subscription following the backup on its relay, while backup is
    /// on and the core runs.
    backup_sub: Option<Box<dyn nostr_transport::TransportSub>>,
    /// Counts the backup subscriptions made, so what an old one reports is
    /// told apart.
    backup_sub_seq: u64,
    /// Whether the backup relay has said what it holds since subscribing:
    /// nothing is saved before, so a device merges before it writes.
    backup_heard: bool,
    /// Whether the relay holds a backup, as far as this subscription heard.
    backup_found: bool,
    /// The newest version of the backup seen (`created_at`, seconds), and
    /// the events of that second seen: another device may save in the same
    /// second as this one.
    backup_seen_at: i64,
    backup_seen_ids: Vec<String>,
    /// Versions of the backup being opened: nothing is saved meanwhile.
    backup_opening: u32,
    /// Counts the backup relays set (and turnings off), so an opening or a
    /// save started for an earlier one is dropped when it ends.
    backup_epoch: u64,
    /// The newest version could not be opened (another key, a newer app):
    /// nothing is saved over it.
    backup_unreadable: bool,
    /// Gives up waiting for the backup relay to say what it holds.
    backup_wait_timer: Option<AbortHandle>,
    /// Subscribes again after the backup relay closed the subscription, and
    /// how long the next wait is.
    backup_retry_timer: Option<AbortHandle>,
    backup_retry_ms: u64,
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
    /// Per machine, the grant it has to confirm before this client talks to
    /// it with the identity (see `runtime::grant`).
    grant_waits: HashMap<String, grant::GrantWait>,
    /// Counts the grant waits begun, so what an ended one reports is dropped.
    grant_seq: u64,
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
                    // A stop still waiting on its `away` is taken back.
                    self.stop_epoch += 1;
                    // The transition into `Connecting` arms the watchdog; a
                    // second start while already connecting/connected leaves
                    // the one already armed alone.
                    self.dispatch(ConnectionEvent::ConnectRequested);
                    self.links_on = true;
                    self.sync_direct_links();
                    self.sync_backup_sub();
                }
                Msg::Stop => {
                    log::info!("core: Stop (status was {:?})", self.conn.status);
                    self.say_away();
                }
                Msg::Pause => {
                    // Backgrounded: the OS may kill the process from here on.
                    // A delete still in its undo window is committed now —
                    // its toast is out of sight, and the window lives only
                    // in memory: a process killed before it closed would
                    // never send the `close-session`, and the session would
                    // come back once its dismissal expired.
                    if self.stores.delete_controller.is_pending() {
                        self.on_undo_timer().await;
                    }
                    self.flush_acks();
                    self.flush_writes().await;
                    self.ws.set_ping_interval(BACKGROUND_PING_EVERY);
                    self.set_link_ping(BACKGROUND_PING_EVERY);
                    self.dispatch(ConnectionEvent::Visibility { visible: false });
                    // Hiding is debounced, so the watch is settled when it
                    // really takes effect (`Msg::VisibilitySettled`).
                }
                Msg::Resume => {
                    self.ws.set_ping_interval(PING_EVERY);
                    self.set_link_ping(PING_EVERY);
                    self.dispatch(ConnectionEvent::Visibility { visible: true });
                    self.dispatch(ConnectionEvent::Resume);
                    self.watch_changed();
                    // Back on the session it showed: what came for it while
                    // the app was hidden is seen now.
                    let viewed = self.stores.ui.resume_viewing();
                    if !viewed.is_empty() {
                        self.state_changed(SliceId::Ui);
                        self.apply_ui_effects(viewed);
                    }
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
                    // due by now; outside WaitingRetry this is a no-op. The
                    // transport's own dial deadlines and redials stalled the
                    // same way.
                    self.dispatch(ConnectionEvent::RetryDue);
                    self.ws.catch_up();
                    self.check_stale_heartbeats();
                    self.check_connected_relays_changed();
                    let _ = reply.send(());
                }
                Msg::SetOnline(true) => {
                    // Also when already online (the network changed or its
                    // internet access came back) and whatever the FSM's
                    // state: every relay that is down is dialled now. First,
                    // so the dials an Offline → Online reconnect starts
                    // below are not the ones it abandons.
                    self.ws.retry_now();
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
                Msg::VisibilitySettled => {
                    self.dispatch(ConnectionEvent::VisibilitySettled);
                    // The app really is hidden now: the bridge stops sending
                    // this client live text.
                    self.watch_changed();
                }
                Msg::WatchSettle => {
                    abort(&mut self.watch_timer);
                    self.settle_watch();
                }
                Msg::TerminalFlush => self.on_terminal_flush(),
                Msg::SocketOpen => {
                    let at = self.clock.now_ms();
                    self.dispatch(ConnectionEvent::SocketOpen { at });
                }
                Msg::SocketClose => {
                    let random = Some(self.entropy.unit());
                    self.dispatch(ConnectionEvent::SocketClose { random });
                }
                Msg::StaleWatchdog => {
                    self.check_connect_deadline();
                    self.check_stale_heartbeats();
                    self.check_connected_relays_changed();
                    self.check_sync_stalls();
                    self.renew_presence();
                    self.sync_stale_watchdog();
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
                Msg::UnansweredDeadline => {
                    if self.stores.machines.expire_unanswered(self.clock.now_ms()) {
                        self.state_changed(SliceId::Machines);
                    }
                    self.rearm_unanswered_timer();
                }
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
                Msg::CommandSigned { machine, event, reply, outbox_id, quiet } => {
                    self.publish_built(&machine, event, reply, outbox_id, quiet)
                }
                Msg::Stopped { epoch } => {
                    if epoch == self.stop_epoch {
                        self.stop_now().await;
                    }
                }
                Msg::DirectEvent(event) => self.nostr.deliver(&event),
                Msg::BackupDue => self.on_backup_due(),
                Msg::BackupFetched { epoch, found } => self.on_backup_fetched(epoch, found).await,
                Msg::BackupEvent(event) => self.on_backup_event(event).await,
                Msg::BackupEose { sub } => self.on_backup_eose(sub),
                Msg::BackupClosed { sub, reason } => self.on_backup_closed(sub, reason),
                Msg::BackupNoAnswer { sub } => self.on_backup_no_answer(sub),
                Msg::BackupRetry => {
                    self.backup_retry_timer = None;
                    self.sync_backup_sub();
                }
                Msg::BackupSaved { epoch, saved } => self.on_backup_saved(epoch, saved).await,
                Msg::BackupDeleted => self.forget_backup_relay().await,
                Msg::GrantPublished { machine, seq, delivered } => self.on_grant_published(&machine, seq, delivered),
                Msg::GrantWaitOver { machine, seq } => self.on_grant_wait_over(&machine, seq),
                Msg::DirectState { machine, endpoint } => {
                    let changed = match endpoint {
                        Some(endpoint) => self.links_up.insert(machine, endpoint.clone()) != Some(endpoint),
                        None => self.links_up.remove(&machine).is_some(),
                    };
                    if changed {
                        self.state_changed(SliceId::Machines);
                        // Only arm a watchdog that is not ticking yet: a link
                        // flapping faster than its period must not keep
                        // pushing the next tick, and the presence it renews,
                        // out of reach.
                        if self.stale_timer.as_ref().is_none_or(|t| t.is_finished()) {
                            self.sync_stale_watchdog();
                        }
                    }
                }
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

    fn emit(&self, event: CoreEvent) {
        self.observer.on_event(event);
    }

    fn state_changed(&self, slice: SliceId) {
        self.emit(CoreEvent::StateChanged { slice });
    }

    async fn persist_store(&mut self, id: StoreId) {
        // What these hold goes in the config backup; the style cache is
        // fetched again whenever it is missing.
        if !matches!(id, StoreId::Outbox | StoreId::AgentStyles) {
            self.backup_changed();
        }
        let p = Persister::new(self.kv.as_ref());
        match id {
            StoreId::Machines => {
                self.machines_dirty = true;
                self.schedule_flush();
            }
            StoreId::AgentStyles => p.save_agent_styles(&self.stores.machines.agent_styles).await,
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
            ViewQuery::Transcript { machine, session_id, after, reply } => {
                let view = TranscriptRowsView::load(
                    &self.stores.transcript,
                    self.transcript_store.as_ref(),
                    &machine,
                    &session_id,
                    after,
                )
                .await;
                let _ = reply.send(view);
            }
        }
    }
}

/// The watchdog has useful work only while an attempt is in flight or a
/// socket is live.
fn stale_watchdog_needed(status: ConnectionStatus) -> bool {
    matches!(status, ConnectionStatus::Connecting | ConnectionStatus::Connected)
}

/// True when a `Connecting` attempt has outlived `deadline_ms`.
fn connect_attempt_expired(status: ConnectionStatus, since: Option<u64>, now: u64, deadline_ms: u64) -> bool {
    status == ConnectionStatus::Connecting
        && since.is_some_and(|at| now.saturating_sub(at) >= deadline_ms)
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
        StoreId::Machines | StoreId::AgentStyles => SliceId::Machines,
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

mod actions;
mod backup;
mod connection;
mod grant;
mod ingest;
mod links;
mod publish;
mod session_file;
mod watch;
#[cfg(test)]
mod tests;
