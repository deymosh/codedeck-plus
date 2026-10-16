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
use protocol::events::{BridgeToPhone, TerminalOutputMsg};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::host::{self, HostCommand, HostHandle};
use crate::relay::Relays;
use crate::state::StateFile;
use crate::terminal::Terminals;
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
    uploads: Rc<RefCell<Uploads>>,
    pairing_urls: Option<mpsc::UnboundedSender<String>>,
    direct: Option<crate::direct::Direct>,
    /// The ptys behind the terminals the engine decided to open, with their
    /// rings of output and their recordings. Empty unless the owner turned
    /// terminals on: the engine emits no terminal effect otherwise.
    terminals: Terminals,
    /// The terminal audit's writer thread.
    audit: audit::Audit,
    /// `<home>/terminal-allow.json`, shared with the periodic change check so
    /// its mtime is read once between the two.
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
    let direct = crate::direct::start(&config.direct, &config.home, keys.pubkey_hex.clone(), inputs.clone()).await?;
    engine_config.direct = direct.as_ref().map(|d| d.info.clone());
    let relays = Relays::start(
        config.relays.clone(),
        keys,
        config.tor_proxy.clone(),
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

    let nostr_http = work::NostrHttp::new(config.tor_proxy.as_deref())?;
    let terminals = Terminals::new(config.home.join("audit"), inputs.clone());
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
        uploads: Rc::new(RefCell::new(Uploads::new(&first_root))),
        pairing_urls: options.pairing_urls,
        direct,
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
/// file is read only when its mtime moved, and the same cache is shared with
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
        let effects = self.engine.handle(input);
        for effect in effects {
            if self.execute(effect) {
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

    /// Carry out one effect; true for [`Effect::Stopped`].
    fn execute(&mut self, effect: Effect) -> bool {
        match effect {
            Effect::Publish { to, message } => self.relays.publish(to, message),
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
                }
                self.relays.subscribe_commands(filter.authors, filter.since);
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
            Effect::RegisterPhone { pubkey_hex, label } => self.register_phone(pubkey_hex, label),
            Effect::ReadGitHead { session_id, cwd } => {
                let inputs = self.inputs.clone();
                tokio::task::spawn_local(async move {
                    let head = work::git_head(std::path::Path::new(&cwd)).await;
                    let _ = inputs.send(Input::GitHead { session_id, head });
                });
            }
            Effect::HandleFileUpload(UploadFileMsg::Chunk(chunk)) => {
                if let Some((session_id, text)) = self.uploads.borrow_mut().chunk(chunk) {
                    let _ = self.inputs.send(Input::FileReady { session_id, text });
                }
            }
            Effect::HandleFileUpload(UploadFileMsg::Blossom(msg)) => {
                let (inputs, uploads, http) = (self.inputs.clone(), Rc::clone(&self.uploads), self.nostr_http.clone());
                tokio::task::spawn_local(async move {
                    match uploads::fetch_blossom(&http, &msg).await {
                        Ok(data) => {
                            let delivery = uploads.borrow_mut().finish(&msg.session_id, &msg.filename, &msg.mime_type, &msg.text, &data, &msg.hash);
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
                // `None`: the owner has configured no `terminal.command`, so
                // the shell runs. A failure is answered as a refusal, not
                // left as a terminal that never appears.
                let result = self.terminals.spawn(&term, &cwd, cols, rows, self.config.terminal.command.as_deref());
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
                    let message = BridgeToPhone::TerminalOutput(TerminalOutputMsg {
                        term,
                        offset,
                        data: STANDARD.encode(data),
                    });
                    self.relays.publish(vec![client], message);
                }
            }
            Effect::TerminalClose { term } => self.terminals.close(&term),
            Effect::TerminalPending(pending) => {
                // Merge the refused devices with the approved ones as they are
                // on disk now (the owner may have run `terminal allow` since
                // this engine last read the file). The write goes to a thread
                // of its own — never the runtime's — and the engine is handed
                // the merged list, whose approved devices would otherwise be a
                // file change behind.
                let merged = self.allowlist.borrow().merge_pending(&pending);
                self.allowlist_writer.write(merged.clone());
                let _ = self.inputs.send(Input::TerminalAllowlist(merged));
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

    fn register_phone(&self, pubkey_hex: String, label: String) {
        let endpoints = [("relay", self.config.relay_register.clone()), ("image server", self.config.blossom_register.clone())];
        for (service, endpoint) in endpoints {
            let Some(endpoint) = endpoint else { continue };
            let (http, pubkey, label) = (self.nostr_http.clone(), pubkey_hex.clone(), label.clone());
            tokio::task::spawn_local(async move {
                match work::register_pubkey(&http, &endpoint, &pubkey).await {
                    Ok(status) => log::info!("[Runtime] Phone {}... {status} on the {service}", &pubkey[..8]),
                    Err(err) => log::warn!(
                        "Phone \"{label}\" paired, but registering it on the {service} failed ({err}) — it may not be able to use that {service}."
                    ),
                }
            });
        }
    }
}

fn present_pairing(info: &PairingWindowInfo) {
    let minutes = info.expires_at_ms.saturating_sub(RealSystem.now_ms()) / 60_000;
    say(&qr::render(&info.url));
    say(&format!("Pairing URL (valid for {minutes} min):\n{}\n", info.display_url));
}
