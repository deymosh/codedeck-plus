//! The bridge engine: one state machine between the phones (over Nostr) and
//! the agent host (over a pipe).
//!
//! ```text
//!  phone ─relay─▶ Input::RelayEvent ─▶ ingest ─▶ commands (phone.rs) ─┐
//!                                                                     ├─▶ sessions, cards, sync
//!  host ──pipe──▶ Input::HostFrame ─▶ replies, requests, events (host.rs) ┘
//!                                                        │
//!             Effect::Publish ◀── transcript + heartbeat ┘──▶ Effect::Host
//! ```
//!
//! Guarantees kept from the TypeScript bridge this replaces:
//! - every transcript entry gets its seq from here, once, never renumbered;
//!   seqs continue across restarts from what the transcript store holds;
//! - every registry session is resumed when the bridge starts;
//! - the heartbeat always carries the full session list (plus tombstones for
//!   removed sessions), and a clean shutdown publishes it with every session
//!   `offline` — never an empty list;
//! - every card the phone sees is closed by exactly one `resolved` entry;
//! - secrets are never logged and never sent to a phone.

mod host;
mod pairing;
mod phone;
mod settings;

use std::collections::BTreeMap;

use agent_protocol::HostToolSpec;
use protocol::capabilities::{BridgeHostKind, ALL_BRIDGE_CAPABILITIES, PROTOCOL_VERSION};
use protocol::common::{OutputEntry, RemoteSessionInfo};
use protocol::crypto::Keypair;
use protocol::events::{BridgeToPhone, OutputMsg, SessionListMsg};

use crate::catalog::Catalog;
use crate::ingest::{since_for_connect, CommandsFilter, Ingest};
use crate::io::{store_keys, Effect, Input, PairedPhone};
use crate::out::{Out, TimerKind};
use crate::pairing::{NackBudget, DEFAULT_PAIRING_WINDOW_MS};
use crate::ports::{Ports, Store, System, Transcripts, Workspace};
use crate::registry::{RegistryDoc, Tombstones};
use crate::session::{Phase, Runner, Session, StartKind};
use crate::settings::{load_or_default, ProviderProfile, StoredCredentials, StoredProfiles};
use crate::sync::{SyncConfig, SyncServer, SyncTimer};
use crate::time::iso;

use host::HostCall;

pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 60_000;
/// How often a session's `committed` flag is checked against git (catches
/// commits made by hand in a terminal; the agent's own are caught at once).
pub const DEFAULT_GIT_POLL_INTERVAL_MS: u64 = 10_000;
/// Per-session transcript cap: several days of heavy use, far beyond what
/// the phone renders. Pruning keeps seqs, so sync stays coherent.
pub const DEFAULT_TRANSCRIPT_KEEP_LAST: usize = 5000;
pub const DEFAULT_RETENTION_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
/// How long a card may wait on the user before it is cancelled.
pub const DEFAULT_CARD_TIMEOUT_MS: u64 = 60 * 60 * 1000;

pub struct Config {
    /// The bridge identity: decrypts commands, names the bridge in pairing.
    pub keys: Keypair,
    pub machine: String,
    pub host_kind: Option<BridgeHostKind>,
    /// Relays the bridge listens on — told to a phone when it pairs.
    pub relays: Vec<String>,
    /// Reported to the agent host at `initialize`.
    pub bridge_version: String,
    /// The tools a device-test session's agent gets (run by the runtime).
    pub device_tools: Vec<HostToolSpec>,
    /// 0 disables the periodic heartbeat (tests).
    pub heartbeat_interval_ms: u64,
    /// 0 disables the git poll.
    pub git_poll_interval_ms: u64,
    /// 0 disables the periodic sweep (the start-up sweep still runs).
    pub retention_interval_ms: u64,
    /// 0 disables transcript retention entirely.
    pub transcript_keep_last: usize,
    pub card_timeout_ms: u64,
    pub pairing_window_ms: u64,
    pub sync: SyncConfig,
}

impl Config {
    pub fn new(keys: Keypair, machine: impl Into<String>) -> Self {
        Self {
            keys,
            machine: machine.into(),
            host_kind: None,
            relays: Vec::new(),
            bridge_version: String::new(),
            device_tools: Vec::new(),
            heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
            git_poll_interval_ms: DEFAULT_GIT_POLL_INTERVAL_MS,
            retention_interval_ms: DEFAULT_RETENTION_INTERVAL_MS,
            transcript_keep_last: DEFAULT_TRANSCRIPT_KEEP_LAST,
            card_timeout_ms: DEFAULT_CARD_TIMEOUT_MS,
            pairing_window_ms: DEFAULT_PAIRING_WINDOW_MS,
            sync: SyncConfig::default(),
        }
    }
}

/// The agent host link: whether it is up, and the requests it owes a reply.
#[derive(Default)]
struct HostLink {
    up: bool,
    /// `initialized` arrived: the catalog is current and sessions may start.
    initialized: bool,
    next_id: u64,
    calls: BTreeMap<String, HostCall>,
    /// `call-host-tool` requests being run, by host frame id → session id.
    tool_calls: BTreeMap<String, String>,
}

struct PairingWindow {
    token: String,
    epoch: u64,
    timer: crate::io::TimerId,
}

pub struct Engine {
    config: Config,
    system: Box<dyn System>,
    store: Box<dyn Store>,
    transcripts: Box<dyn Transcripts>,
    workspace: Box<dyn Workspace>,
    out: Out,
    ingest: Ingest,
    paired: Vec<PairedPhone>,
    sessions: BTreeMap<String, Session>,
    tombstones: Tombstones,
    /// Highest seq per transcript — including sessions that failed to start
    /// (their transcripts stay until the retention sweep).
    seq_highs: BTreeMap<String, u64>,
    catalog: Catalog,
    host: HostLink,
    credentials: StoredCredentials,
    /// The provider's verdict on a stored credential, by (scope, id). Not
    /// persisted; absent = not checked since the value last changed.
    credential_valid: BTreeMap<(Option<String>, String), bool>,
    profiles: BTreeMap<String, ProviderProfile>,
    /// set-credentials waiting on checks: ticket → the ack to send.
    credential_acks: BTreeMap<u64, settings::CredentialAck>,
    /// set-provider-profile waiting on the token check: ticket → (phone, profile id).
    profile_acks: BTreeMap<u64, (String, String)>,
    next_ticket: u64,
    sync: SyncServer,
    pairing: Option<PairingWindow>,
    pairing_epoch: u64,
    nacks: NackBudget,
    started: bool,
    stopped: bool,
    /// Publish the heartbeat once the current input is handled.
    list_dirty: bool,
    /// Store the registry once the current input is handled.
    registry_dirty: bool,
    /// Only `last_activity` changed since the registry was stored: written
    /// with the next heartbeat (or any structural change, or shutdown) rather
    /// than per output batch — each store rewrites and syncs the whole state
    /// file, credentials included, and a busy session appends many times a
    /// second. A crash loses at most one heartbeat's worth of that timestamp.
    activity_dirty: bool,
}

impl Engine {
    pub fn new(config: Config, ports: Ports) -> Self {
        let sync = SyncServer::new(config.sync);
        Self {
            config,
            system: ports.system,
            store: ports.store,
            transcripts: ports.transcripts,
            workspace: ports.workspace,
            out: Out::default(),
            ingest: Ingest::new(0, Vec::new()),
            paired: Vec::new(),
            sessions: BTreeMap::new(),
            tombstones: Tombstones::default(),
            seq_highs: BTreeMap::new(),
            catalog: Catalog::default(),
            host: HostLink::default(),
            credentials: StoredCredentials::default(),
            credential_valid: BTreeMap::new(),
            profiles: BTreeMap::new(),
            credential_acks: BTreeMap::new(),
            profile_acks: BTreeMap::new(),
            next_ticket: 0,
            sync,
            pairing: None,
            pairing_epoch: 0,
            nacks: NackBudget::default(),
            started: false,
            stopped: false,
            list_dirty: false,
            registry_dirty: false,
            activity_dirty: false,
        }
    }

    /// Handle one input; the effects to carry out, in order.
    pub fn handle(&mut self, input: Input) -> Vec<Effect> {
        if self.stopped {
            log::debug!("[Engine] Stopped — ignoring {input:?}");
            return Vec::new();
        }
        if !self.started {
            self.start();
        }
        match input {
            Input::Start => {}
            Input::RelayEvent { event, via } => self.on_relay_event(&event, via),
            Input::HostUp => self.on_host_up(),
            Input::HostFrame(frame) => self.on_host_frame(frame),
            Input::HostDown { reason } => self.on_host_down(&reason),
            Input::Timer(id) => self.on_timer(id),
            Input::GitHead { session_id, head } => self.on_git_head(&session_id, head),
            Input::Gsd { session_id, gsd } => {
                self.publish_all(BridgeToPhone::GsdState(protocol::events::GsdStateMsg { session_id, gsd }));
            }
            Input::HostToolDone { call_id, text, is_error } => self.on_host_tool_done(call_id, text, is_error),
            Input::ProviderTokenChecked { ticket, valid } => self.on_provider_token_checked(ticket, valid),
            Input::DeviceConfigApplied { phone, result } => self.on_device_config_applied(&phone, result),
            Input::ImageReady { session_id, text } => {
                if !self.send_input(&session_id, text) {
                    log::warn!("[Engine] Uploaded image for {session_id} could not be delivered: no live session");
                }
            }
            Input::SessionEntry { session_id, entry } => {
                if self.sessions.contains_key(&session_id) {
                    self.append(&session_id, vec![entry]);
                } else {
                    log::warn!("[Engine] Entry for unknown session {session_id} dropped");
                }
            }
            Input::OpenPairing { duration_ms, mesh } => self.open_pairing(duration_ms, mesh),
            Input::ClosePairing => self.close_pairing(crate::io::PairingCloseReason::Closed, None),
            Input::WorkspaceChanged => self.list_dirty = true,
            Input::Shutdown => self.shutdown(),
        }
        self.flush();
        std::mem::take(&mut self.out.effects)
    }

    /// The command subscription to hold: paired phones as authors, starting
    /// at the ingest cursor. Asked for at every (re)connect and after
    /// [`Effect::Resubscribe`].
    pub fn commands_filter(&self) -> CommandsFilter {
        CommandsFilter {
            authors: self.phones(),
            since: since_for_connect(self.ingest.last_seen(), self.system.now_ms() / 1000),
        }
    }

    pub fn paired_phones(&self) -> &[PairedPhone] {
        &self.paired
    }

    pub fn keys(&self) -> &Keypair {
        &self.config.keys
    }

    /// Sessions with a live runner (diagnostics).
    pub fn running_sessions(&self) -> usize {
        self.sessions.values().filter(|s| s.run.is_some()).count()
    }

    /// Whether a pairing window is open.
    pub fn pairing_open(&self) -> bool {
        self.pairing.is_some()
    }

    // --- start and stop ---

    fn start(&mut self) {
        self.started = true;
        self.paired = load_or_default(self.store.get(store_keys::PAIRED_PHONES), "paired phones");
        self.credentials = load_or_default(self.store.get(store_keys::CREDENTIALS), "credentials");
        let profiles: StoredProfiles = load_or_default(self.store.get(store_keys::PROVIDER_PROFILES), "provider profiles");
        self.profiles = profiles.profiles.into_iter().map(|p| (p.id.clone(), p)).collect();
        let last_seen = self.store.get(store_keys::LAST_SEEN).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let processed: Vec<String> = load_or_default(self.store.get(store_keys::PROCESSED_IDS), "processed event ids");
        self.ingest = Ingest::new(last_seen, processed);

        let doc = self.store.get(store_keys::REGISTRY).map(|raw| RegistryDoc::load(&raw)).unwrap_or_default();
        self.tombstones = Tombstones::new(doc.removed_sessions);
        for rec in doc.sessions {
            // Resumed once the agent host is up.
            let run = Runner::new(Phase::Ready, StartKind::Resume, rec.title.is_some());
            self.sessions.insert(rec.session_id.clone(), Session { rec, listed: true, run: Some(run) });
        }
        match self.transcripts.load() {
            Ok(highs) => self.seq_highs = highs,
            Err(err) => log::error!("[Engine] Could not read the transcripts: {err}"),
        }
        log::info!(
            "[Engine] Started: {} paired phone(s), {} session(s) to resume",
            self.paired.len(),
            self.sessions.len()
        );

        self.run_retention();
        self.arm(self.config.heartbeat_interval_ms, TimerKind::Heartbeat);
        self.arm(self.config.git_poll_interval_ms, TimerKind::GitPoll);
        self.arm(self.config.retention_interval_ms, TimerKind::Retention);
        self.out.push(Effect::Resubscribe);
        self.list_dirty = true;
    }

    /// End every session, publish the offline heartbeat, stop.
    fn shutdown(&mut self) {
        log::info!("[Engine] Shutting down");
        self.close_pairing(crate::io::PairingCloseReason::Closed, None);
        self.sync.close(&mut self.out);
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.close_runner(&id, "Session closed");
        }
        let timers: Vec<_> = self.out.timers.keys().copied().collect();
        for timer in timers {
            self.out.cancel_timer(timer);
        }
        self.persist_cursor();
        self.persist_registry();
        self.publish_list(true);
        self.stopped = true;
        self.out.push(Effect::Stopped);
    }

    // --- timers ---

    fn arm(&mut self, interval_ms: u64, kind: TimerKind) {
        if interval_ms > 0 {
            self.out.set_timer(interval_ms, kind);
        }
    }

    fn on_timer(&mut self, id: crate::io::TimerId) {
        let Some(kind) = self.out.take_timer(id) else { return };
        match kind {
            TimerKind::Heartbeat => {
                self.persist_cursor();
                self.registry_dirty |= self.activity_dirty;
                self.list_dirty = true;
                self.arm(self.config.heartbeat_interval_ms, TimerKind::Heartbeat);
            }
            TimerKind::GitPoll => {
                self.poll_git();
                self.arm(self.config.git_poll_interval_ms, TimerKind::GitPoll);
            }
            TimerKind::Retention => {
                self.run_retention();
                self.arm(self.config.retention_interval_ms, TimerKind::Retention);
            }
            TimerKind::Card { session_id, request_id } => self.card_timed_out(&session_id, &request_id),
            TimerKind::SyncAck(sync_id) => {
                self.sync.timer_fired(&mut self.out, self.transcripts.as_ref(), &sync_id, SyncTimer::Ack);
            }
            TimerKind::SyncIdle(sync_id) => {
                self.sync.timer_fired(&mut self.out, self.transcripts.as_ref(), &sync_id, SyncTimer::Idle);
            }
            TimerKind::PairingExpiry { epoch } => {
                if self.pairing.as_ref().is_some_and(|w| w.epoch == epoch) {
                    log::info!("[Engine] Pairing window expired");
                    self.close_pairing(crate::io::PairingCloseReason::Expired, None);
                }
            }
        }
    }

    /// Delete transcripts of sessions that no longer exist, and cap the rest.
    fn run_retention(&mut self) {
        let keep_last = self.config.transcript_keep_last;
        if keep_last == 0 {
            return;
        }
        let ids: Vec<String> = self.seq_highs.keys().cloned().collect();
        for id in ids {
            if self.sessions.contains_key(&id) {
                if let Err(err) = self.transcripts.prune(&id, keep_last) {
                    log::warn!("[Engine] Retention: pruning {id} failed: {err}");
                }
            } else {
                log::info!("[Engine] Retention: removing orphaned transcript {id}");
                match self.transcripts.remove(&id) {
                    Ok(()) => {
                        self.seq_highs.remove(&id);
                    }
                    Err(err) => log::warn!("[Engine] Retention: removing {id} failed: {err}"),
                }
            }
        }
    }

    // --- git commit detection ---

    fn poll_git(&mut self) {
        let due: Vec<(String, String)> = self
            .sessions
            .values()
            .filter(|s| !s.rec.committed && s.run.as_ref().is_some_and(|r| r.base_head.is_some()))
            .map(|s| (s.rec.session_id.clone(), s.rec.cwd.clone()))
            .collect();
        for (session_id, cwd) in due {
            self.out.push(Effect::ReadGitHead { session_id, cwd });
        }
    }

    fn on_git_head(&mut self, session_id: &str, head: Option<String>) {
        let Some(head) = head else { return };
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let Some(run) = session.run.as_mut() else { return };
        if session.rec.committed {
            return;
        }
        match &run.base_head {
            None => run.base_head = Some(head),
            Some(base) if *base != head => {
                log::info!("[Engine] Git commit detected in session {session_id}");
                session.rec.committed = true;
                self.registry_dirty = true;
                self.list_dirty = true;
            }
            Some(_) => {}
        }
    }

    // --- output ---

    fn now(&self) -> u64 {
        self.system.now_ms()
    }

    fn now_iso(&self) -> String {
        iso(self.now())
    }

    fn phones(&self) -> Vec<String> {
        self.paired.iter().map(|p| p.pubkey_hex.clone()).collect()
    }

    fn publish_all(&mut self, message: BridgeToPhone) {
        let to = self.phones();
        self.out.publish(to, message);
    }

    fn publish_to(&mut self, phone: &str, message: BridgeToPhone) {
        self.out.publish(vec![phone.to_string()], message);
    }

    /// Give entries their seqs, store them and send them live. A store
    /// failure costs durability (a later sync cannot resend the entry), never
    /// the live send.
    fn append(&mut self, session_id: &str, entries: Vec<OutputEntry>) {
        if entries.is_empty() {
            return;
        }
        for entry in entries {
            let seq = self.seq_highs.get(session_id).copied().unwrap_or(0) + 1;
            self.seq_highs.insert(session_id.to_string(), seq);
            if let Err(err) = self.transcripts.append(session_id, seq, &entry) {
                log::error!("[Engine] Transcript append failed for {session_id} (seq {seq}): {err}");
            }
            self.publish_all(BridgeToPhone::Output(OutputMsg { session_id: session_id.to_string(), seq, entry }));
        }
        let now = self.now_iso();
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.rec.last_activity = now;
            self.activity_dirty |= session.listed;
        }
    }

    fn entry(&self, body: protocol::common::EntryBody) -> OutputEntry {
        OutputEntry::new(self.now_iso(), body)
    }

    // --- persistence and the heartbeat ---

    fn flush(&mut self) {
        if self.registry_dirty {
            self.persist_registry();
        }
        if self.list_dirty && !self.stopped {
            self.publish_list(false);
        }
    }

    fn persist_registry(&mut self) {
        self.registry_dirty = false;
        self.activity_dirty = false;
        let doc = RegistryDoc {
            sessions: self.sessions.values().filter(|s| s.listed).map(|s| s.rec.clone()).collect(),
            removed_sessions: self.tombstones.ids(),
        };
        let json = serde_json::to_string(&doc).expect("the registry serializes");
        if let Err(err) = self.store.set(store_keys::REGISTRY, &json) {
            log::error!("[Engine] Could not store the session registry: {err}");
        }
    }

    fn persist_cursor(&mut self) {
        let processed = serde_json::to_string(&self.ingest.processed_ids()).expect("ids serialize");
        let last_seen = self.ingest.last_seen().to_string();
        for (key, value) in [(store_keys::LAST_SEEN, last_seen), (store_keys::PROCESSED_IDS, processed)] {
            if let Err(err) = self.store.set(key, &value) {
                log::warn!("[Engine] Could not store the ingest cursor: {err}");
            }
        }
    }

    fn remote_info(&self, session: &Session) -> RemoteSessionInfo {
        let seq_high = self.seq_highs.get(&session.rec.session_id).copied().unwrap_or(0);
        // A deleted profile still shows its id rather than vanishing.
        let label = session
            .rec
            .provider_id
            .as_ref()
            .map(|id| self.profiles.get(id).map_or_else(|| id.clone(), |p| p.label.clone()));
        session.rec.remote_info(seq_high, session.state(self.stopped), label)
    }

    /// The session-list heartbeat: sessions, agents, credentials,
    /// capabilities, folders and tombstones.
    fn publish_list(&mut self, offline: bool) {
        self.list_dirty = false;
        if self.paired.is_empty() {
            return;
        }
        let mut sessions: Vec<RemoteSessionInfo> =
            self.sessions.values().filter(|s| s.listed).map(|s| self.remote_info(s)).collect();
        if offline {
            for s in &mut sessions {
                s.state = Some(protocol::common::SessionState::Offline);
            }
        }
        let agents = self.catalog.descriptors(|a| self.agent_credentials(a));
        let credentials = self.bridge_credentials();
        let removed = self.tombstones.ids();
        let message = BridgeToPhone::Sessions(SessionListMsg {
            machine: self.config.machine.clone(),
            host: self.config.host_kind,
            sessions,
            agents,
            credentials,
            protocol_version: PROTOCOL_VERSION,
            capabilities: Some(ALL_BRIDGE_CAPABILITIES.iter().map(|c| c.to_string()).collect()),
            folders: Some(self.workspace.folders()),
            roots: Some(self.workspace.roots()),
            removed_sessions: (!removed.is_empty()).then_some(removed),
            machine_offline: offline.then_some(true),
        });
        self.publish_all(message);
    }
}
