//! The event loop: one engine, fed one input at a time from the relays, the
//! agent host, timers, signals and finished background work; its effects
//! carried out in order.
//!
//! Everything runs on one thread (the relay transport is single-threaded),
//! so nothing here needs a lock.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use bridge_core::ports::{Ports, System};
use bridge_core::{
    Config as EngineConfig, Effect, Engine, Input, NotifyLevel, PairingCloseReason, PairingWindowInfo, TerminalConfig,
    TimerId,
};
use protocol::commands::UploadFileMsg;
use protocol::crypto::Keypair;
use protocol::events::{BridgeToPhone, TerminalOutputMsg, WebBrowserInfo, WebBrowsersMsg};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::host::{self, HostCommand, HostHandle};
use crate::relay::Relays;
use crate::state::StateFile;
use crate::terminal::{Cast, Terminals};
use crate::terminal_allow::{self, Cache as AllowlistCache};
use crate::transcripts::FileTranscripts;
use crate::workspace::FsWorkspace;
use crate::uploads::{self, Uploads};
use crate::{audit, qr, work};

/// The real clock, ids and environment.
pub struct RealSystem;

impl System for RealSystem {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
    fn new_id(&mut self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn new_token(&mut self) -> String {
        hex::encode(rand::random::<[u8; 16]>())
    }
    fn env_is_set(&self, name: &str) -> bool {
        std::env::var(name).is_ok_and(|v| !v.is_empty())
    }
}

/// What the bridge is running for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Serve paired phones until stopped; while none is paired, keep a
    /// pairing window open.
    Run,
    /// Open one pairing window and stop when it closes.
    Pair,
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Stopped,
    Paired,
    PairingFailed,
}

pub struct Options {
    pub mode: Mode,
    pub pairing_window_ms: Option<u64>,
    /// Where the transcripts live (default `<home>/sessions/transcripts`).
    pub transcripts_dir: Option<PathBuf>,
    /// Stop on SIGINT / SIGTERM (off when embedded, e.g. in tests).
    pub signals: bool,
    /// Stops the bridge when it fires (or is dropped).
    pub stop: Option<tokio::sync::oneshot::Receiver<()>>,
    /// Also receives every pairing URL shown to the operator.
    pub pairing_urls: Option<mpsc::UnboundedSender<String>>,
}

impl Options {
    pub fn new(mode: Mode) -> Self {
        Self { mode, pairing_window_ms: None, transcripts_dir: None, signals: true, stop: None, pairing_urls: None }
    }
}

struct Runtime {
    engine: Engine,
    config: Config,
    mode: Mode,
    pairing_window_ms: Option<u64>,
    relays: Relays,
    host: HostHandle,
    inputs: mpsc::UnboundedSender<Input>,
    timers: HashMap<TimerId, JoinHandle<()>>,
    nostr_http: work::NostrHttp,
    outcome: Outcome,
    /// Chunk assembly, base64 decoding and the file writes. Shared with the
    /// blocking pool: decoding a 25 MB attachment and writing it to disk is
    /// not work for the bridge's one thread.
    uploads: Arc<Mutex<Uploads>>,
    pairing_urls: Option<mpsc::UnboundedSender<String>>,
    direct: Option<crate::direct::Direct>,
    /// Whether the relay subscription also carries the live kind, so a paired
    /// phone's terminal input reaches the bridge over a relay. True only when
    /// the owner allows a terminal over relays.
    terminals_on_relays: bool,
    /// The ptys behind the terminals the engine decided to open, with their
    /// rings of output and their recordings. Empty unless the owner turned
    /// terminals on: the engine emits no terminal effect otherwise.
    terminals: Terminals,
    /// The terminal audit's writer thread.
    audit: audit::Audit,
    /// `<home>/terminal-allow.json`, shared with the periodic change check so
    /// its metadata is read once between the two.
    allowlist: Rc<RefCell<AllowlistCache>>,
    /// Writes the allowlist file, on a thread of its own: the runtime's single
    /// thread never writes it.
    allowlist_writer: terminal_allow::Writer,
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Run the bridge until it is stopped (a signal, or the pairing outcome in
/// [`Mode::Pair`]). Must be called inside a `LocalSet`.
pub async fn run(config: Config, state: StateFile, keys: Keypair, options: Options) -> Result<Outcome, String> {
    let transcripts_dir = options.transcripts_dir.unwrap_or_else(|| config.home.join("sessions").join("transcripts"));
    let mut engine_config = EngineConfig::new(keys.clone(), config.machine.clone());
    engine_config.host_kind = Some(config.host_kind);
    engine_config.relays = config.relays.clone();
    engine_config.bridge_version = crate::version().to_string();
    // The owner's decision about terminals, and the devices already approved.
    // The allowlist file is read once here (the cache's first check) and again
    // whenever its mtime moves.
    let mut allowlist_cache = AllowlistCache::new(&config.home);
    let allowlist = allowlist_cache.changed().unwrap_or_default();
    engine_config.terminal = TerminalConfig {
        enabled: config.terminal.enabled,
        relays_allowed: config.terminal.relays_allowed,
        max_terminals: config.terminal.max_terminals,
        idle_secs: config.terminal.idle_minutes * 60,
        allowlist,
    };
    // Whether the bridge must hear a phone's keystrokes over a relay as well
    // as its own link. Off unless the owner allows a terminal over relays, so
    // a bridge without that never subscribes to the live kind and a relay
    // never sees one.
    let terminals_on_relays = config.terminal.enabled && config.terminal.relays_allowed;
    let first_root = config.workspace_roots[0].clone();
    if let Some(keep) = config.transcript_keep_last {
        engine_config.transcript_keep_last = keep;
    }
    let ports = Ports {
        system: Box::new(RealSystem),
        store: Box::new(state),
        transcripts: Box::new(FileTranscripts::open(&transcripts_dir)?),
        workspace: Box::new(FsWorkspace::new(config.workspace_roots.clone())),
    };

    let (inputs, mut rx) = mpsc::unbounded_channel();
    let web_config = crate::web::ConfigView { path: config.config_file.clone(), fields: crate::config::web_config_fields(&config) };
    let direct = crate::direct::start(&config.direct, &config.home, keys.pubkey_hex.clone(), inputs.clone(), web_config).await?;
    engine_config.direct = direct.as_ref().map(|d| d.info.clone());
    // The relays and the Blossom client share one routing decision, so a
    // configured Tor proxy cannot apply to one and not the other.
    let nostr = work::NostrTransports::from_config(&config)?;
    let relays = Relays::start_with(
        &nostr,
        keys,
        inputs.clone(),
        direct.as_ref().map(|d| Rc::clone(&d.hub)),
    );
    let host = host::supervise(
        HostCommand::node(&config.node_path, config.agent_host_path.clone(), config.host_env.clone()),
        inputs.clone(),
    );
    if options.signals {
        watch_signals(inputs.clone());
    }
    if let Some(stop) = options.stop {
        let inputs = inputs.clone();
        tokio::task::spawn_local(async move {
            let _ = stop.await;
            let _ = inputs.send(Input::Shutdown);
        });
    }

    let nostr_http = nostr.http;
    let terminals = Terminals::new(config.home.join("audit"), config.home.clone(), inputs.clone());
    // The audit's writer thread, fed by a channel: the runtime never touches
    // the log file itself.
    let audit = audit::Audit::open(
        &config.home,
        config.audit.syslog,
        audit::Retention { max_days: config.audit.max_days, max_bytes: config.audit.max_bytes },
    );
    let allowlist_writer = terminal_allow::Writer::start(terminal_allow::path_in(&config.home));
    let mut rt = Runtime {
        engine: Engine::new(engine_config, ports),
        config,
        mode: options.mode,
        pairing_window_ms: options.pairing_window_ms,
        relays,
        host,
        inputs,
        timers: HashMap::new(),
        nostr_http,
        outcome: Outcome::Stopped,
        uploads: Arc::new(Mutex::new(Uploads::new(&first_root))),
        pairing_urls: options.pairing_urls,
        direct,
        terminals_on_relays,
        terminals,
        audit,
        allowlist: Rc::new(RefCell::new(allowlist_cache)),
        allowlist_writer,
    };
    // The periodic half of the allowlist check: a `terminal disallow` with no
    // terminal message arriving still closes a terminal, within a few seconds.
    // With terminals off there is no terminal to close.
    if rt.config.terminal.enabled {
        watch_allowlist(Rc::clone(&rt.allowlist), rt.inputs.clone());
    }

    rt.step(Input::Start).await;
    if rt.mode == Mode::Pair || rt.engine.paired_phones().is_empty() {
        if rt.mode == Mode::Run {
            say("No phones paired yet — opening a pairing window. Scan the QR with the CodeDeck app.\nThe bridge keeps running; a new window opens until a phone pairs.");
        }
        rt.open_pairing();
    }
    while let Some(input) = rx.recv().await {
        if rt.step(input).await {
            break;
        }
    }
    Ok(rt.outcome)
}

/// Watch the terminal allowlist file for a change every few seconds, so a
/// `terminal disallow` closes a device's terminals even when no terminal
/// message arrives to carry the check. The check is one `metadata` call; the
/// file is read only when its stamp moved, and the same cache is shared with
/// the per-message check, so the change is noticed and read once.
fn watch_allowlist(cache: Rc<RefCell<AllowlistCache>>, inputs: mpsc::UnboundedSender<Input>) {
    tokio::task::spawn_local(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is immediate; the start-up read already happened.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Some(list) = cache.borrow_mut().changed() {
                if inputs.send(Input::TerminalAllowlist(list)).is_err() {
                    return;
                }
            }
        }
    });
}

fn watch_signals(inputs: mpsc::UnboundedSender<Input>) {
    tokio::task::spawn_local(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => say("Received SIGINT — shutting down..."),
                _ = term.recv() => say("Received SIGTERM — shutting down..."),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            say("Received Ctrl-C — shutting down...");
        }
        let _ = inputs.send(Input::Shutdown);
    });
}

impl Runtime {
    fn open_pairing(&mut self) {
        let _ = self.inputs.send(Input::OpenPairing { duration_ms: self.pairing_window_ms });
    }

    /// Handle one input; true once the engine has stopped and everything is
    /// flushed.
    async fn step(&mut self, input: Input) -> bool {
        // The shell is gone: the pty is dropped before the engine hears
        // about it. `forget` does not signal it — it has already exited, and
        // by then its pid may belong to another process.
        if let Input::TerminalExited { term, .. } = &input {
            self.terminals.forget(term);
        }
        // A terminal command can arrive between the periodic checks, so the
        // allowlist's mtime is checked here too, before the command is routed:
        // `terminal disallow` then takes effect on the very next command, not
        // up to five seconds later. The runtime cannot tell which commands are
        // terminal ones — they are NIP-44 ciphertext until the engine decrypts
        // them — so this covers every inbound event, at the cost of one
        // `metadata` call each and a read only when the file moved. A bridge
        // with terminals off (the default) has nothing to check.
        let changed = if self.config.terminal.enabled && matches!(input, Input::RelayEvent { .. }) {
            self.allowlist.borrow_mut().changed()
        } else {
            None
        };
        if let Some(list) = changed {
            if self.dispatch(Input::TerminalAllowlist(list)).await {
                return true;
            }
        }
        self.dispatch(input).await
    }

    /// Feed one input to the engine and carry out its effects in order.
    async fn dispatch(&mut self, input: Input) -> bool {
        // A timer that fired has done its work: drop the finished task so a
        // bridge that arms timers for the whole of a long run does not keep
        // one handle per firing. An engine that re-arms the same id replaces
        // this entry with the new handle below.
        if let Input::Timer(id) = &input {
            self.timers.remove(id);
        }
        let effects = self.engine.handle(input);
        for effect in effects {
            if self.execute(effect).await {
                self.relays.flush().await;
                self.host.stop().await;
                self.relays.shutdown();
                if let Some(direct) = &mut self.direct {
                    direct.shutdown();
                }
                for (_, timer) in self.timers.drain() {
                    timer.abort();
                }
                return true;
            }
        }
        false
    }

    /// The browsers signed in to the web page, as the page itself lists them
    /// (`Web::browsers`). Empty when this bridge runs no page — no direct
    /// link — so a request is still answered, with the truth.
    fn web_browsers(&self) -> Vec<WebBrowserInfo> {
        self.direct.as_ref().map(|direct| direct.web.browsers()).unwrap_or_default()
    }

    /// Carry out one effect; true for [`Effect::Stopped`]. Async because one
    /// effect does blocking file work that must not run here: opening a
    /// terminal's recording, which is handed to a blocking task before its
    /// shell is started.
    async fn execute(&mut self, effect: Effect) -> bool {
        match effect {
            Effect::Publish { to, message } => {
                if let (protocol::events::BridgeToPhone::Sessions(list), Some(direct)) = (&message, &self.direct) {
                    direct.web.set_heartbeat(list);
                    // The devices API follows the heartbeat: the paired
                    // phones are cheap to hand over, and this is where they
                    // change.
                    direct.web.set_devices(self.engine.paired_phones());
                }
                self.relays.publish(to, message)
            }
            Effect::WebSignedIn { code, by } => {
                if let Some(direct) = &self.direct {
                    direct.web.signed_in(&code, &by);
                }
            }
            // The page alone holds the list of signed-in browsers, so the
            // runtime answers both from it: a request with what it has, a
            // sign-out by ending that browser and then answering with the
            // fresh list. Both go to the asking client alone.
            Effect::WebBrowsers { client } => {
                let message = BridgeToPhone::WebBrowsers(WebBrowsersMsg { browsers: self.web_browsers() });
                self.relays.publish(vec![client], message);
            }
            Effect::WebBrowserSignOut { id, client } => {
                // `revoke` persists through the web page's own writer thread,
                // so ending a browser never blocks the bridge's one thread.
                if let Some(direct) = &self.direct {
                    direct.web.revoke(&id);
                }
                let message = BridgeToPhone::WebBrowsers(WebBrowsersMsg { browsers: self.web_browsers() });
                self.relays.publish(vec![client], message);
            }
            Effect::Host(frame) => self.host.send(&frame),
            Effect::SetTimer { id, after_ms } => {
                let inputs = self.inputs.clone();
                let task = tokio::task::spawn_local(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(after_ms)).await;
                    let _ = inputs.send(Input::Timer(id));
                });
                self.timers.insert(id, task);
            }
            Effect::CancelTimer(id) => {
                if let Some(task) = self.timers.remove(&id) {
                    task.abort();
                }
            }
            Effect::Resubscribe => {
                let filter = self.engine.commands_filter();
                if let Some(direct) = &self.direct {
                    direct.hub.set_paired(&filter.authors);
                    // Pairing changed (this effect rebuilds the command
                    // subscription): keep the devices API in step at once.
                    direct.web.set_devices(self.engine.paired_phones());
                }
                self.relays.subscribe_commands(filter.authors, filter.since, self.terminals_on_relays);
            }
            Effect::OpenPairingSubscription { since } => self.relays.open_pairing(since),
            Effect::ClosePairingSubscription => self.relays.close_pairing(),
            Effect::PresentPairing(info) => {
                present_pairing(&info);
                if let Some(urls) = &self.pairing_urls {
                    let _ = urls.send(info.url);
                }
            }
            Effect::PairingClosed { reason, phone } => self.pairing_closed(reason, phone.map(|p| format!("\"{}\" ({})", p.label, p.npub))),
            Effect::Notify { level, text } => match level {
                NotifyLevel::Info => {
                    log::info!("{text}");
                    say(&text);
                }
                NotifyLevel::Warn => log::warn!("{text}"),
            },
            Effect::ReadGitHead { session_id, cwd } => {
                let inputs = self.inputs.clone();
                tokio::task::spawn_local(async move {
                    let head = work::git_head(std::path::Path::new(&cwd)).await;
                    let _ = inputs.send(Input::GitHead { session_id, head });
                });
            }
            Effect::HandleFileUpload(UploadFileMsg::Chunk(chunk)) => {
                // Reassembling the chunks decodes up to 25 MB of base64 and
                // writes the file; both belong on the blocking pool, and the
                // answer comes back as the same finished-work input a
                // Blossom upload uses.
                let (inputs, uploads) = (self.inputs.clone(), Arc::clone(&self.uploads));
                tokio::task::spawn_blocking(move || {
                    let delivery = uploads.lock().unwrap_or_else(|p| p.into_inner()).chunk(chunk);
                    if let Some((session_id, text)) = delivery {
                        let _ = inputs.send(Input::FileReady { session_id, text });
                    }
                });
            }
            Effect::HandleFileUpload(UploadFileMsg::Blossom(msg)) => {
                let (inputs, uploads, http) = (self.inputs.clone(), Arc::clone(&self.uploads), self.nostr_http.clone());
                tokio::task::spawn_local(async move {
                    match uploads::fetch_blossom(&http, &msg).await {
                        Ok(data) => {
                            // The download and decryption are done; saving the
                            // file is disk work and goes to the blocking pool
                            // like a chunked upload's.
                            let delivery = tokio::task::spawn_blocking(move || {
                                uploads.lock().unwrap_or_else(|p| p.into_inner()).finish(
                                    &msg.session_id,
                                    &msg.filename,
                                    &msg.mime_type,
                                    &msg.text,
                                    &data,
                                    &msg.hash,
                                )
                            })
                            .await
                            .ok()
                            .flatten();
                            if let Some((session_id, text)) = delivery {
                                let _ = inputs.send(Input::FileReady { session_id, text });
                            }
                        }
                        Err(err) => log::warn!("[Runtime] Image for {} not delivered: {err}", msg.session_id),
                    }
                });
            }
            Effect::Stopped => return true,
            // The engine decides terminals and the runtime serves them: the
            // ptys, the per-terminal ring of output and the recordings
            // (`crate::terminal`). With terminals switched off — the only
            // state a configuration leaves them in — the engine emits none of
            // these effects, so a bridge without terminals starts no shell.
            Effect::TerminalSpawn { term, cwd, cols, rows } => {
                // Opening the recording is blocking file work — create the
                // audit directory, open the file, write and flush the header —
                // and the bridge's one thread must not do it, so it goes to a
                // blocking task. It is awaited before the pty is opened: no
                // shell ever runs without its recording, and a recording that
                // cannot be opened is answered as a refusal, not left as a
                // terminal that never appears. `None` is the owner's
                // configured `terminal.command`: with none, the shell runs.
                let path = self.terminals.recording_path(&term);
                let opened = tokio::task::spawn_blocking(move || Cast::open(&path, cols, rows)).await;
                let result = match opened {
                    Ok(Ok(cast)) => {
                        self.terminals.spawn(&term, &cwd, cols, rows, self.config.terminal.command.as_deref(), cast)
                    }
                    Ok(Err(e)) => Err(format!("could not open the recording: {e}")),
                    Err(e) => Err(format!("could not open the recording: {e}")),
                };
                let _ = match result {
                    Ok(shell) => self.inputs.send(Input::TerminalSpawned { term, shell }),
                    Err(note) => self.inputs.send(Input::TerminalSpawnFailed { term, note }),
                };
            }
            Effect::TerminalWrite { term, bytes } => self.terminals.write(&term, &bytes),
            Effect::TerminalResize { term, cols, rows } => self.terminals.resize(&term, cols, rows),
            Effect::TerminalReplay { term, from, client } => {
                // The engine named the one client this goes to (a terminal's
                // output is not a broadcast); the runtime only serves the
                // ring it keeps. An oversize replay is split into `chunk`
                // fragments by the transport, like any other message.
                if let Some((offset, data)) = self.terminals.replay(&term, from) {
                    // `replay` marks this as the answer to `terminal-replay`:
                    // `offset` is the ring's start, which may be past the
                    // requested `from`, and the phone takes it from there
                    // instead of asking again.
                    let message = BridgeToPhone::TerminalOutput(TerminalOutputMsg {
                        term,
                        offset,
                        data: STANDARD.encode(data),
                        replay: Some(true),
                    });
                    self.relays.publish(vec![client], message);
                }
            }
            Effect::TerminalClose { term } => self.terminals.close(&term),
            Effect::TerminalDevices(devices) => {
                // The devices go to the allowlist's writer thread, which
                // reads the file, replaces `pending`, drops the approved
                // devices no client is any more, and writes it — never the runtime's thread, which an unapproved
                // device spamming `terminal-open` would otherwise stall with a
                // read per message. The engine already holds its own pending
                // list, and the write's new mtime reaches it through the
                // per-message and periodic allowlist checks, so nothing is
                // sent back to it here.
                self.allowlist_writer.set(devices);
            }
            Effect::Audit(record) => self.audit.record(record),
        }
        false
    }

    fn pairing_closed(&mut self, reason: PairingCloseReason, phone: Option<String>) {
        match (self.mode, reason) {
            (_, PairingCloseReason::Paired) => {
                say(&format!("Phone {} paired.", phone.unwrap_or_default()));
                if self.mode == Mode::Pair {
                    self.outcome = Outcome::Paired;
                    let _ = self.inputs.send(Input::Shutdown);
                }
            }
            (Mode::Run, PairingCloseReason::Expired) if self.engine.paired_phones().is_empty() => {
                say("Pairing window expired with no phone paired — opening a fresh one.");
                self.open_pairing();
            }
            (Mode::Run, _) => {}
            (Mode::Pair, _) => {
                say("Pairing window closed — no phone paired. Run `codedeck-bridge pair` again.");
                self.outcome = Outcome::PairingFailed;
                let _ = self.inputs.send(Input::Shutdown);
            }
        }
    }

}

fn present_pairing(info: &PairingWindowInfo) {
    let minutes = info.expires_at_ms.saturating_sub(RealSystem.now_ms()) / 60_000;
    say(&qr::render(&info.url));
    say(&format!("Pairing URL (valid for {minutes} min):\n{}\n", info.display_url));
}
