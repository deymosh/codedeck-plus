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

use bridge_core::ports::{Ports, System};
use bridge_core::{Config as EngineConfig, Effect, Engine, Input, MeshJoin, NotifyLevel, PairingCloseReason, PairingWindowInfo, TimerId};
use protocol::commands::UploadImageMsg;
use protocol::crypto::Keypair;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::config::Config;
use crate::host::{self, HostCommand, HostHandle};
use crate::relay::Relays;
use crate::state::StateFile;
use crate::transcripts::FileTranscripts;
use crate::workspace::FsWorkspace;
use crate::devices::{self, Devices};
use crate::gsd::Gsd;
use crate::images::{self, Images};
use crate::mesh::Mesh;
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
    http: reqwest::Client,
    outcome: Outcome,
    state: StateFile,
    images: Rc<RefCell<Images>>,
    gsd: Rc<Gsd>,
    // One device call at a time: adb connection recovery is stateful.
    devices: Rc<tokio::sync::Mutex<Devices>>,
    mesh: Rc<Mesh>,
    /// Mesh join info for the pairing QR (`pair` only).
    mesh_join: Option<MeshJoin>,
    pairing_urls: Option<mpsc::UnboundedSender<String>>,
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
    engine_config.device_tools = devices::tool_specs();
    let user_home = crate::config::user_home();
    let first_root = config.workspace_roots[0].clone();
    let kept_state = state.clone();
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

    let gsd = Gsd::new(config.node_path.clone(), &user_home);
    let devices = Devices::new(config.adb_path.clone(), &user_home);
    let mesh = Mesh::new(config.nvpn_path.clone(), config.mesh_admin_enabled, &user_home);
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
        state: kept_state,
        images: Rc::new(RefCell::new(Images::new(&first_root))),
        gsd: Rc::new(gsd),
        devices: Rc::new(tokio::sync::Mutex::new(devices)),
        mesh: Rc::new(mesh),
        mesh_join: None,
        pairing_urls: options.pairing_urls,
    };

    rt.step(Input::Start).await;
    if rt.mode == Mode::Pair {
        // The pairing QR can also let the phone join the mesh.
        rt.mesh_join = rt.mesh.onboarding().await.map(|o| {
            say(&format!("The pairing QR includes mesh join info for network {}.", o.network_id));
            MeshJoin { admin_device_id: o.admin_device_id, netid: o.network_id }
        });
    }
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
        let _ = self.inputs.send(Input::OpenPairing { duration_ms: self.pairing_window_ms, mesh: self.mesh_join.clone() });
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
            Effect::CheckProviderToken { ticket, base_url, token, model } => {
                let (inputs, http) = (self.inputs.clone(), self.http.clone());
                tokio::task::spawn_local(async move {
                    let valid = work::check_provider_token(&http, &base_url, token.expose(), &model).await;
                    let _ = inputs.send(Input::ProviderTokenChecked { ticket, valid });
                });
            }
            Effect::ReadGsd { session_id, cwd } => {
                let (inputs, gsd) = (self.inputs.clone(), Rc::clone(&self.gsd));
                tokio::task::spawn_local(async move {
                    let gsd = gsd.state(&cwd).await;
                    let _ = inputs.send(Input::Gsd { session_id, gsd });
                });
            }
            Effect::RunHostTool { call_id, session_id, tool, args } => {
                let (inputs, devices) = (self.inputs.clone(), Rc::clone(&self.devices));
                tokio::task::spawn_local(async move {
                    let result = devices.lock().await.run(&tool, &args).await;
                    if let Some(entry) = result.entry {
                        let _ = inputs.send(Input::SessionEntry { session_id, entry });
                    }
                    let _ = inputs.send(Input::HostToolDone { call_id, text: result.text, is_error: result.is_error });
                });
            }
            Effect::ApplyDeviceConfig { phone, config } => {
                let (inputs, mesh, state) = (self.inputs.clone(), Rc::clone(&self.mesh), self.state.clone());
                let first_root = self.config.workspace_roots[0].clone();
                tokio::task::spawn_local(async move {
                    let result = mesh.apply(&state, &first_root, &phone, config).await.map(|notice| {
                        if let Some(notice) = notice {
                            say(&notice);
                        }
                    });
                    let _ = inputs.send(Input::DeviceConfigApplied { phone, result });
                });
            }
            Effect::HandleImageUpload(UploadImageMsg::Chunk(chunk)) => {
                if let Some((session_id, text)) = self.images.borrow_mut().chunk(chunk) {
                    let _ = self.inputs.send(Input::ImageReady { session_id, text });
                }
            }
            Effect::HandleImageUpload(UploadImageMsg::Blossom(msg)) => {
                let (inputs, images, http) = (self.inputs.clone(), Rc::clone(&self.images), self.http.clone());
                tokio::task::spawn_local(async move {
                    match images::fetch_blossom(&http, &msg).await {
                        Ok(data) => {
                            let delivery = images.borrow_mut().finish(&msg.session_id, &msg.filename, &msg.mime_type, &msg.text, &data, &msg.hash);
                            if let Some((session_id, text)) = delivery {
                                let _ = inputs.send(Input::ImageReady { session_id, text });
                            }
                        }
                        Err(err) => log::warn!("[Runtime] Image for {} not delivered: {err}", msg.session_id),
                    }
                });
            }
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
