//! The event loop: one engine, fed one input at a time from the relays, the
//! agent host, timers, signals and finished background work; its effects
//! carried out in order.
//!
//! Everything runs on one thread (the relay transport is single-threaded),
//! so nothing here needs a lock.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use bridge_core::ports::{Ports, System};
use bridge_core::{Config as EngineConfig, Effect, Engine, Input, NotifyLevel, PairingCloseReason, PairingWindowInfo, TimerId};
use protocol::crypto::Keypair;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::host::{self, HostCommand, HostHandle};
use crate::relay::Relays;
use crate::state::StateFile;
use crate::transcripts::FileTranscripts;
use crate::workspace::FsWorkspace;
use crate::{qr, work};

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
    http: reqwest::Client,
    outcome: Outcome,
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
    engine_config.bridge_version = env!("CARGO_PKG_VERSION").to_string();
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
    let relays = Relays::start(config.relays.clone(), keys, config.machine.clone(), config.tor_proxy.clone(), inputs.clone());
    let host = host::supervise(
        HostCommand::node(&config.node_path, config.agent_host_path.clone(), config.host_env.clone()),
        inputs.clone(),
    );
    watch_signals(inputs.clone());

    let mut rt = Runtime {
        engine: Engine::new(engine_config, ports),
        config,
        mode: options.mode,
        pairing_window_ms: options.pairing_window_ms,
        relays,
        host,
        inputs,
        timers: HashMap::new(),
        http: work::http_client(),
        outcome: Outcome::Stopped,
    };

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
        let _ = self.inputs.send(Input::OpenPairing { duration_ms: self.pairing_window_ms, mesh: None });
    }

    /// Handle one input; true once the engine has stopped and everything is
    /// flushed.
    async fn step(&mut self, input: Input) -> bool {
        let effects = self.engine.handle(input);
        for effect in effects {
            if self.execute(effect) {
                self.relays.flush().await;
                self.host.stop().await;
                self.relays.shutdown();
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
                self.relays.subscribe_commands(filter.authors, filter.since);
            }
            Effect::OpenPairingSubscription { since } => self.relays.open_pairing(since),
            Effect::ClosePairingSubscription => self.relays.close_pairing(),
            Effect::PresentPairing(info) => present_pairing(&info),
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
            Effect::CheckProviderToken { ticket, base_url, token, model } => {
                let (inputs, http) = (self.inputs.clone(), self.http.clone());
                tokio::task::spawn_local(async move {
                    let valid = work::check_provider_token(&http, &base_url, token.expose(), &model).await;
                    let _ = inputs.send(Input::ProviderTokenChecked { ticket, valid });
                });
            }
            Effect::ReadGsd { session_id, .. } => {
                log::info!("[Runtime] GSD state for {session_id} is not available on this bridge yet");
            }
            Effect::RunHostTool { call_id, tool, .. } => {
                let _ = self.inputs.send(Input::HostToolDone {
                    call_id,
                    text: format!("the device tool '{tool}' is not available on this bridge"),
                    is_error: true,
                });
            }
            Effect::ApplyDeviceConfig { phone, .. } => {
                let _ = self.inputs.send(Input::DeviceConfigApplied {
                    phone,
                    result: Err("device configuration is not available on this bridge".into()),
                });
            }
            Effect::HandleImageUpload(_) => log::warn!("[Runtime] Image upload is not available on this bridge yet"),
            Effect::Stopped => return true,
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
            let (http, pubkey, label) = (self.http.clone(), pubkey_hex.clone(), label.clone());
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
