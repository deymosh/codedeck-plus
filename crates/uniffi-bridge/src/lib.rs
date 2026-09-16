//! F3: the Android UniFFI binding surface, wrapping the REAL
//! `client_runtime::core::Core` (not spike/uniffi-binding-probe's stand-in).
//! Every hard case that spike proved feasible — foreign callback, `async fn`
//! -> Kotlin `suspend fun`, typed error, object lifecycle with a background
//! task, concurrency — is re-proven here against production code
//! (`tests/real_core_over_ffi.rs`).
//!
//! `Core::spawn` must run inside a `tokio::task::LocalSet` (its internals use
//! `Rc`/`!Send` closures) — this crate's `Core::new` spins up a dedicated OS
//! thread with a current-thread runtime + `LocalSet` to host it, exactly the
//! pattern `apps/mobile/src-tauri/src/corebridge.rs`'s `core_init` already
//! uses for Tauri. The `client_runtime::Core` *handle* it produces is cheap
//! to clone and `Send` (just an `mpsc::UnboundedSender`), so every exported
//! method below can be called from any thread without hopping onto that one.
//!
//! F3.1's ports are all in-memory (`CorePorts::default()`) — no persistence,
//! no real network. Real SQLite/WS/HTTP ports are F3.2+'s job, once
//! `apps/android` exists to actually need them; wiring them here first with
//! nothing to drive them would be untested plumbing.

pub mod intent;
pub mod observer;
pub mod views;

use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use client_runtime::{
    Clock, ConnectionView, Core as RealCore, CoreConfig, CoreObserver, CorePorts, Entropy, SystemClock,
    TimeEntropy,
};
use protocol::crypto::keypair_from_secret_hex;
use tokio::sync::oneshot;

pub use intent::{UniffiIntent, UniffiIntentError};
pub use observer::CoreListener;
use observer::UniffiObserver;
pub use views::{
    UniffiMachinesView, UniffiOutboxView, UniffiQuickPromptsView, UniffiSettingsView,
    UniffiTranscriptRowsView, UniffiUiView,
};
use views::{
    build_uniffi_machines_view, build_uniffi_outbox_view, build_uniffi_quick_prompts_view,
    build_uniffi_settings_view, build_uniffi_transcript_view, build_uniffi_ui_view,
    responded_cards_for,
};

uniffi::setup_scaffolding!();

/// Returned by `Core::new` when the supplied identity secret doesn't parse —
/// the one thing that can go wrong before the background thread even starts.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreInitError {
    #[error("invalid identity secret: {detail}")]
    BadIdentity { detail: String },
    #[error("core thread failed to start: {detail}")]
    ThreadSpawn { detail: String },
}

#[derive(uniffi::Object)]
pub struct Core {
    handle: RealCore,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl Core {
    /// Builds the identity, spawns the dedicated core thread, and blocks
    /// (this call is sync — Kotlin sees a plain constructor, not a suspend
    /// fun) until the real `client_runtime::Core` has hydrated and is ready.
    #[uniffi::constructor]
    pub fn new(
        relays: Vec<String>,
        identity_secret_hex: String,
        listener: Arc<dyn CoreListener>,
    ) -> Result<Arc<Self>, CoreInitError> {
        let identity = keypair_from_secret_hex(&identity_secret_hex)
            .map_err(|e| CoreInitError::BadIdentity { detail: e.to_string() })?;
        let config = CoreConfig::new(relays, identity, None, false);

        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<RealCore>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = std::thread::Builder::new()
            .name("codedeck-uniffi-core".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build current-thread runtime");
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    let observer: Rc<dyn CoreObserver> = Rc::new(UniffiObserver { listener });
                    let clock: Rc<dyn Clock> = Rc::new(SystemClock);
                    let entropy: Rc<dyn Entropy> = Rc::new(TimeEntropy);
                    let core = RealCore::spawn(config, CorePorts::default(), observer, clock, entropy).await;
                    let _ = ready_tx.send(core);
                    // Keep the LocalSet alive (drives the loop/timers/socket
                    // tasks) until `Core::stop()` fires the shutdown signal —
                    // unlike Tauri's `core_init` (whose host process owns the
                    // thread for its whole lifetime), this crate's own tests
                    // need a clean, joinable teardown.
                    let _ = shutdown_rx.await;
                })
            })
            .map_err(|e| CoreInitError::ThreadSpawn { detail: e.to_string() })?;

        let handle = ready_rx
            .recv()
            .map_err(|_| CoreInitError::ThreadSpawn { detail: "core thread exited before it was ready".into() })?;

        Ok(Arc::new(Self {
            handle,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            join: Mutex::new(Some(join)),
        }))
    }

    pub fn start(&self) {
        self.handle.start();
    }

    pub fn stop(&self) {
        self.handle.stop();
    }

    /// `suspend fun dispatch(intent: UniffiIntent)` in Kotlin. Fire-and-forget,
    /// same as the real `Intent` — errors surface later via
    /// `CoreListener::on_event(CoreEvent::ActionFailed)`, not a `Result` here.
    pub async fn dispatch(&self, intent: UniffiIntent) -> Result<(), UniffiIntentError> {
        self.handle.dispatch(intent.try_into()?).await;
        Ok(())
    }

    pub async fn connection_view(&self) -> Option<ConnectionView> {
        self.handle.connection_view().await
    }

    pub async fn machines_view(&self) -> UniffiMachinesView {
        build_uniffi_machines_view(&self.handle.machines_view().await)
    }

    pub async fn outbox_view(&self) -> UniffiOutboxView {
        build_uniffi_outbox_view(&self.handle.outbox_view().await)
    }

    pub async fn ui_view(&self) -> UniffiUiView {
        build_uniffi_ui_view(&self.handle.ui_view().await)
    }

    pub async fn settings_view(&self) -> Option<UniffiSettingsView> {
        self.handle.settings_view().await.map(|v| build_uniffi_settings_view(&v))
    }

    pub async fn quick_prompts_view(&self) -> UniffiQuickPromptsView {
        build_uniffi_quick_prompts_view(&self.handle.quick_prompts_view().await)
    }

    /// The grouped, ready-to-render transcript for one session — see
    /// `views.rs`'s doc comment for why this crosses the already-ported
    /// `presentation::display_entries` grouping rather than raw rows.
    pub async fn transcript_view(&self, machine: String, session_id: String) -> UniffiTranscriptRowsView {
        let raw = self.handle.transcript_view(machine.clone(), session_id.clone()).await;
        let ui = self.handle.ui_view().await;
        let responded = responded_cards_for(&ui, &machine, &session_id);
        build_uniffi_transcript_view(&raw, responded)
    }

    /// Stops the loop and joins the dedicated thread — used by this crate's
    /// own tests for a clean teardown between cases; a long-lived Android
    /// process has no equivalent need (the thread lives for the app's life).
    pub fn shutdown(&self) {
        self.handle.stop();
        if let Some(tx) = self.shutdown_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.join.lock().unwrap().take() {
            let _ = h.join();
        }
    }
}
