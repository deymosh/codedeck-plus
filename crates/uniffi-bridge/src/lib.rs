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
//! F3.1's ports were all in-memory (`CorePorts::default()`) — no persistence,
//! no real network. F4.1.4 added the first real port, `notifier` (see
//! `notifier.rs`), the same "wire a port only once something actually drives
//! it" rule the rest still follow: real SQLite/WS/HTTP ports are still
//! `CorePorts::default()`'s in-memory/no-op stand-ins until a screen needs
//! them.

pub mod intent;
pub mod notifier;
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
pub use notifier::UniffiNotifier;
use notifier::NotifierAdapter;
pub use observer::CoreListener;
use observer::UniffiObserver;
pub use views::{
    UniffiMachinesView, UniffiOutboxView, UniffiPairingCandidateView, UniffiPairingView,
    UniffiPendingSessionsView, UniffiQuickPromptsView, UniffiSettingsView, UniffiTranscriptRowsView,
    UniffiUiView,
};
use views::{
    build_uniffi_machines_view, build_uniffi_outbox_view, build_uniffi_pairing_view,
    build_uniffi_pending_sessions_view, build_uniffi_quick_prompts_view, build_uniffi_settings_view,
    build_uniffi_transcript_view, build_uniffi_ui_view, responded_cards_for,
};

uniffi::setup_scaffolding!();

/// CDX-071 gate for a custom provider's base URL, exposed as a plain
/// function so Android validates against the same rule the bridge itself
/// enforces rather than a hand-duplicated regex.
#[uniffi::export]
fn is_valid_provider_base_url(raw: String) -> bool {
    protocol::common::is_valid_provider_base_url(&raw)
}

/// The error string to show next to [`is_valid_provider_base_url`]'s gate.
#[uniffi::export]
fn provider_base_url_error() -> String {
    protocol::common::PROVIDER_BASE_URL_ERROR.to_string()
}

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
    identity_npub: String,
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
        notifier: Arc<dyn UniffiNotifier>,
    ) -> Result<Arc<Self>, CoreInitError> {
        let identity = keypair_from_secret_hex(&identity_secret_hex)
            .map_err(|e| CoreInitError::BadIdentity { detail: e.to_string() })?;
        let identity_npub = identity.npub.clone();
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
                    let ports = CorePorts {
                        notifier: Rc::new(NotifierAdapter { notifier }),
                        ..CorePorts::default()
                    };
                    let core = RealCore::spawn(config, ports, observer, clock, entropy).await;
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
            identity_npub,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            join: Mutex::new(Some(join)),
        }))
    }

    /// The phone's own Nostr id in bech32 `npub1…` form — the manual-pairing
    /// fallback UI's "this is me" readout.
    pub fn identity_npub(&self) -> String {
        self.identity_npub.clone()
    }

    pub fn start(&self) {
        self.handle.start();
    }

    pub fn stop(&self) {
        self.handle.stop();
    }

    /// The OS backgrounded the app — debounced, never tears a healthy socket.
    /// Android's `platform/StayConnectedService.kt` calls this from a
    /// `ProcessLifecycleOwner` observer, the same "app visibility" signal
    /// `apps/mobile`'s `document.visibilitychange` drove on the web/WebView
    /// side.
    pub fn pause(&self) {
        self.handle.pause();
    }

    /// The OS foregrounded the app.
    pub fn resume(&self) {
        self.handle.resume();
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

    /// The two-phase session-creation placeholders — "starting…" cards and
    /// their failure states. Not persisted; re-fetch after a
    /// `CoreEvent` state change touching this slice.
    pub async fn pending_sessions_view(&self) -> UniffiPendingSessionsView {
        build_uniffi_pending_sessions_view(&self.handle.pending_sessions_view().await)
    }

    pub async fn pairing_view(&self) -> Option<UniffiPairingView> {
        self.handle.pairing_view().await.map(|v| build_uniffi_pairing_view(&v))
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

#[cfg(test)]
mod tests {
    use super::*;
    use client_runtime::{ActionFailedKind, CoreEvent};

    /// Same fixed-secret convention as `client-core`'s bridge_api tests: the
    /// derivation is fully deterministic, so the expected npub is computed
    /// from the same constant rather than hard-coded a second time.
    const SEC_PHONE: &str =
        "0000000000000000000000000000000000000000000000000000000000000001";

    struct NoopListener;
    impl CoreListener for NoopListener {
        fn connection_changed(&self, _view: ConnectionView) {}
        fn on_event(&self, _event: CoreEvent) {}
        fn action_failed(&self, _kind: ActionFailedKind) {}
    }

    struct NoopTestNotifier;
    impl UniffiNotifier for NoopTestNotifier {
        fn notify(&self, _title: String, _body: String, _tag: Option<String>) {}
        fn cancel(&self, _tag: String) {}
    }

    #[test]
    fn identity_npub_is_the_bech32_form_of_the_constructor_identity() {
        let core = Core::new(
            vec![],
            SEC_PHONE.to_string(),
            Arc::new(NoopListener),
            Arc::new(NoopTestNotifier),
        )
        .expect("core spawns");
        let expected = keypair_from_secret_hex(SEC_PHONE).unwrap();

        let npub = core.identity_npub();
        assert!(npub.starts_with("npub1"), "not a bech32 npub: {npub}");
        assert_eq!(npub, expected.npub);

        core.shutdown();
    }
}
