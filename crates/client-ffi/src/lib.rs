//! The Android UniFFI binding surface over `client_runtime::Core`: foreign
//! callbacks, `async fn` -> Kotlin `suspend fun`, typed errors, and an object
//! lifecycle with a background task, proven end to end in
//! `tests/real_core_over_ffi.rs`.
//!
//! `Core::spawn` must run inside a `tokio::task::LocalSet` (its internals use
//! `Rc`/`!Send` closures) — this crate's `Core::new` spins up a dedicated OS
//! thread with a current-thread runtime + `LocalSet` to host it. The
//! `client_runtime::Core` *handle* it produces is cheap to clone and `Send`
//! (just an `mpsc::UnboundedSender`), so every exported method below can be
//! called from any thread without hopping onto that one.
//!
//! Ports: persistence is SQLite (`db.rs`: the KV and the transcript store),
//! notifications go to a Kotlin [`UniffiNotifier`], and HTTP (Blossom image
//! uploads) to a Kotlin [`UniffiHttpFetch`] so it rides the app's own network
//! stack (`None` falls back to `NoHttpFetch`). The relay transport is the
//! runtime's own WebSocket driver.

mod android_log;
pub mod db;
pub mod intent;
pub mod notifier;
pub mod observer;
pub mod signer;
pub mod views;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use client_runtime::attachments::{HttpFetch, HttpResponse};
use client_runtime::ports::LocalBoxFuture;
use client_runtime::{
    Clock, ConnectionView, Core as RealCore, CoreConfig, CoreObserver, CorePorts, Entropy, SystemClock,
    TimeEntropy,
};
use protocol::crypto::npub_from_hex;
use tokio::sync::oneshot;

use db::{open_native_db, KvSqlite, TranscriptStoreSqlite};

pub use intent::{UniffiIntent, UniffiIntentError};
pub use notifier::UniffiNotifier;
use notifier::NotifierAdapter;
pub use observer::CoreListener;
pub use signer::{
    local_identity_signer, npub_of, pubkey_hex_of, secret_hex_of, UniffiIdentitySigner, UniffiSessionKeyStore,
    UniffiSignerError,
};
use observer::UniffiObserver;
pub use views::{
    UniffiMachinesView, UniffiOutboxView, UniffiPairingCandidateView, UniffiPairingView,
    UniffiPendingSessionsView, UniffiQuickPromptsView, UniffiSettingsView, UniffiTranscriptDelta,
    UniffiUiView,
};
use views::{
    build_uniffi_machines_view, build_uniffi_outbox_view, build_uniffi_pairing_view,
    build_uniffi_pending_sessions_view, build_uniffi_quick_prompts_view, build_uniffi_settings_view,
    build_uniffi_transcript_delta, build_uniffi_ui_view, responded_cards_for, TranscriptDeltaBase,
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

/// Whether the user may add `url` as a machine's direct endpoint: `wss://`
/// to any host, `ws://` only to an onion service — the rule the core applies
/// to `SetDirectEndpoints`.
#[uniffi::export]
fn is_direct_endpoint(url: String) -> bool {
    client_runtime::client_core::stores::machines::is_direct_endpoint(url.trim())
}

/// Whether the user may add `url` as a machine's relay: `wss://` to any
/// host, `ws://` only to an onion service — the rule the core applies to
/// `SetMachineRelays` and pairing.
#[uniffi::export]
fn is_relay_url(url: String) -> bool {
    client_runtime::client_core::stores::pairing::is_relay_url(url.trim())
}

/// Whether Orbot routing was on when settings were last saved, for
/// [`Core::new`]'s `tor` argument. Pure read, safe before any `Core` exists:
/// the proxy must be known before the first relay or Blossom connection,
/// which `Core::spawn` makes before anything could ask a running core.
/// `false` (the shipped default) on any read failure.
#[uniffi::export]
fn persisted_tor_proxy_enabled(db_path: String) -> bool {
    match open_native_db(&PathBuf::from(db_path)) {
        Ok(conn) => db::tor_proxy_enabled_from_kv(&conn),
        Err(_) => false,
    }
}

/// One request header. A plain Rust `(String, String)` tuple is not a
/// UniFFI-crossable type (no `FfiConverter` for tuples in proc-macro
/// mode), so the ordered header list crosses as this record
/// instead — order and duplicates preserved, same as the core's own
/// `Vec<(String, String)>` shape.
#[derive(uniffi::Record)]
pub struct UniffiHttpHeader {
    pub name: String,
    pub value: String,
}

/// Why a [`UniffiHttpFetch`] call failed to complete. A bare `String` is not
/// a UniFFI-throwable type (codegen rejects it), so the message travels in
/// this single-variant enum — `HttpFetchAdapter` flattens it back to the
/// plain string the `HttpFetch` port carries. The field is named `detail`
/// like every other error here: a `message` field collides with Kotlin's
/// own `Exception.message` in the generated subclass.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UniffiHttpError {
    #[error("{detail}")]
    Failed { detail: String },
}

/// One completed HTTP exchange, as the [`UniffiHttpFetch`] callback reports
/// it back across the FFI. Non-2xx statuses are still a `Result::Ok` here —
/// the caller distinguishes success from failure by `status` and reads the
/// server's error body; only a failure to reach the server at all is an
/// `Err`.
#[derive(uniffi::Record)]
pub struct UniffiHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The Kotlin side of the `HttpFetch` port (`crates/client-runtime/src/
/// attachments.rs`) — the real transport for Blossom image upload/download.
/// Same shape as `UniffiNotifier` in `notifier.rs`: the core decides WHAT to
/// fetch (URLs, headers, BUD-02 auth headers it signs itself); this trait
/// only carries the byte-moving call across the FFI boundary.
///
/// Every method is blocking from Rust's point of view and is invoked on a
/// worker thread (`HttpFetchAdapter` hops to `spawn_blocking` first) — the
/// implementation must not touch Android main-thread state and may take
/// minutes on a slow Tor path. Failures throw `UniffiHttpException.Failed`
/// (the generated Kotlin shape of [`UniffiHttpError`]): the adapter flattens
/// the message into the `Result::Err` string the `HttpFetch` port carries.
#[uniffi::export(with_foreign)]
pub trait UniffiHttpFetch: Send + Sync {
    fn put(
        &self,
        url: String,
        headers: Vec<UniffiHttpHeader>,
        body: Vec<u8>,
    ) -> Result<UniffiHttpResponse, UniffiHttpError>;
    /// Rebuild the underlying client through the (possibly new) SOCKS5 proxy,
    /// or `None` to go direct — the HTTP twin of the WS transport's own
    /// proxy switch. The string is the SAME bare `host:port` form every
    /// other consumer of `CoreConfig::proxy` sees (e.g. `127.0.0.1:9050` for
    /// Orbot) — NO `socks5://` scheme prefix: the WS transport feeds it to
    /// `Socks5Stream::connect` (a socket address) and Tauri's
    /// `ReqwestHttpFetch` prepends the scheme itself, so an implementation
    /// parses `host:port` into its own proxy type rather than treating it
    /// as a URL.
    fn set_proxy(&self, proxy: Option<String>);
}

/// The `Rc`-local adapter `Core::new` hands to `CorePorts`: holds the foreign
/// `Arc<dyn UniffiHttpFetch>` and implements the real `HttpFetch` around it.
/// `put` runs the (blocking) callback on tokio's blocking pool and wrap
/// the joined result in a ready future — the core's loop shares one
/// current-thread runtime, so a multi-megabyte upload executed inline would
/// stall every relay socket, timer, and sync tick behind it.
struct HttpFetchAdapter(Arc<dyn UniffiHttpFetch>);

/// Flatten the FFI error back to the message string the `HttpFetch` port
/// carries; a failed join (callback panicked or the foreign runtime died)
/// becomes an error string too, never a panic on the core thread.
fn flatten_http_error(r: Result<Result<UniffiHttpResponse, UniffiHttpError>, tokio::task::JoinError>) -> Result<HttpResponse, String> {
    match r {
        Ok(Ok(resp)) => Ok(HttpResponse { status: resp.status, body: resp.body }),
        Ok(Err(UniffiHttpError::Failed { detail })) => Err(detail),
        Err(join) => Err(format!("http callback failed: {join}")),
    }
}

impl HttpFetch for HttpFetchAdapter {
    fn put(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
        let cb = Arc::clone(&self.0);
        let url = url.to_string();
        let headers = headers
            .into_iter()
            .map(|(name, value)| UniffiHttpHeader { name, value })
            .collect();
        let join = tokio::task::spawn_blocking(move || cb.put(url, headers, body));
        Box::pin(async move { flatten_http_error(join.await) })
    }

    fn set_proxy(&self, proxy: Option<&str>) {
        // Reconfiguration only, no network I/O — safe to run inline on the
        // core thread, but guarded like every other inline foreign call.
        let proxy = proxy.map(str::to_string);
        crate::observer::foreign_call("set_proxy", || self.0.set_proxy(proxy));
    }
}

/// Returned by `Core::new` (and [`local_identity_signer`]) when something goes
/// wrong before the core runs.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreInitError {
    #[error("invalid identity: {detail}")]
    BadIdentity { detail: String },
    #[error("core thread failed to start: {detail}")]
    ThreadSpawn { detail: String },
    #[error("failed to open the local database: {detail}")]
    DbOpen { detail: String },
}

#[derive(uniffi::Object)]
pub struct Core {
    handle: RealCore,
    identity_npub: String,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    join: Mutex<Option<JoinHandle<()>>>,
    /// The transcript rows last handed out, for the next delta.
    transcript_base: Mutex<Option<TranscriptDeltaBase>>,
}

// TEMPORARY (see `diag.rs`) — proves/disproves a premature Kotlin-side GC of
// the `Arc<Core>` UniFFI object as the reason the dedicated core thread stops
// running shortly after construction.
impl Drop for Core {
    fn drop(&mut self) {
        log::info!("Core::drop: uniffi Core object dropped — its dedicated thread is about to see shutdown_rx close");
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl Core {
    /// Reads the identity's public key, spawns the dedicated core thread, and blocks
    /// (this call is sync — Kotlin sees a plain constructor, not a suspend
    /// fun) until the real `client_runtime::Core` has hydrated and is ready.
    /// Hydration reads the whole local database, so this can take seconds on
    /// a slow device: never call it on a UI or service main thread.
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        // The phone's identity: signs every event; see `signer.rs`.
        identity: Arc<dyn UniffiIdentitySigner>,
        // Where the session keys are kept; `None` keeps them in the database.
        session_keys: Option<Arc<dyn UniffiSessionKeyStore>>,
        listener: Arc<dyn CoreListener>,
        notifier: Arc<dyn UniffiNotifier>,
        http: Option<Arc<dyn UniffiHttpFetch>>,
        // Absolute path to the app's SQLite file — Kotlin resolves this via
        // `Context.getDatabasePath`, same role as `native_core.rs`'s
        // `AppHandle::path().app_config_dir()`. Opened on the dedicated core
        // thread below (`rusqlite::Connection` isn't `Send`), not here.
        db_path: String,
        // SOCKS5 `host:port` (Orbot) — `None`/`tor: false` at first boot
        // before Settings has ever been touched.
        proxy: Option<String>,
        tor: bool,
    ) -> Result<Arc<Self>, CoreInitError> {
        android_log::install();
        log::info!("Core::new: tor={tor} proxy={proxy:?} db_path={db_path}");
        let identity_pubkey = identity.pubkey_hex();
        let identity_npub =
            npub_from_hex(&identity_pubkey).map_err(|e| CoreInitError::BadIdentity { detail: e.to_string() })?;
        let db_path = PathBuf::from(db_path);

        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<RealCore, String>>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let join = std::thread::Builder::new()
            .name("codedeck-uniffi-core".to_string())
            .spawn(move || {
                log::debug!("core thread: started");
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build current-thread runtime");
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    let observer: Rc<dyn CoreObserver> = Rc::new(UniffiObserver { listener });
                    let clock: Rc<dyn Clock> = Rc::new(SystemClock);
                    let entropy: Rc<dyn Entropy> = Rc::new(TimeEntropy);
                    let signer = Rc::new(signer::SignerAdapter::new(identity, identity_pubkey));
                    let config = CoreConfig::new(signer, proxy, tor);

                    let conn = match open_native_db(&db_path) {
                        Ok(conn) => Rc::new(RefCell::new(conn)),
                        Err(e) => {
                            log::error!("core thread: open_native_db failed: {e}");
                            let _ = ready_tx.send(Err(format!("open native db: {e}")));
                            return;
                        }
                    };
                    log::debug!("core thread: db opened, spawning RealCore");
                    // Real, persistent Kv + TranscriptStore — pairing,
                    // machines, sessions, settings, and identity all survive
                    // a process restart from here on, instead of resetting on
                    // every app relaunch the way `CorePorts::default()`'s
                    // in-memory stand-ins did.
                    let ports = CorePorts {
                        kv: Rc::new(KvSqlite::new(conn.clone())),
                        transcript_store: Rc::new(TranscriptStoreSqlite::new(conn)),
                        notifier: Rc::new(NotifierAdapter { notifier }),
                        http: match http {
                            Some(cb) => Rc::new(HttpFetchAdapter(cb)),
                            None => Rc::new(client_runtime::attachments::NoHttpFetch),
                        },
                        session_keys: session_keys
                            .map(|store| Rc::new(signer::SessionKeyStoreAdapter(store)) as Rc<dyn client_runtime::SessionKeyStore>),
                    };
                    let core = RealCore::spawn(config, ports, observer, clock, entropy).await;
                    log::info!("core thread: RealCore::spawn ready");
                    let watched = core.clone();
                    let _ = ready_tx.send(Ok(core));
                    // Keep the LocalSet alive (drives the loop/timers/socket
                    // tasks) until `Core::stop()` fires the shutdown signal —
                    // unlike Tauri's `core_init` (whose host process owns the
                    // thread for its whole lifetime), this crate's own tests
                    // need a clean, joinable teardown. Logged because this
                    // thread ending is exactly what would silently strand
                    // every relay socket and every future Kotlin call: a
                    // caller that unexpectedly drops its `Arc<Core>` (see the
                    // `Drop` impl above) or ever adds an unwanted early
                    // `Core::stop()` shows up here.
                    tokio::select! {
                        shutdown_result = shutdown_rx => {
                            log::warn!("core thread: shutdown_rx resolved ({shutdown_result:?}) — LocalSet exiting, core is now dead");
                        }
                        // The event loop panicked. Carrying on would leave
                        // the app on a plausible but frozen UI (every view
                        // query answers empty, no relay traffic) with
                        // nothing telling the user; aborting lets the OS
                        // restart the process onto a freshly hydrated core.
                        () = watched.closed() => {
                            log::error!("core thread: the core event loop died (panic) — aborting the process");
                            std::process::abort();
                        }
                    }
                })
            })
            .map_err(|e| CoreInitError::ThreadSpawn { detail: e.to_string() })?;

        let handle = ready_rx
            .recv()
            .map_err(|_| CoreInitError::ThreadSpawn { detail: "core thread exited before it was ready".into() })?
            .map_err(|detail| CoreInitError::DbOpen { detail })?;

        Ok(Arc::new(Self {
            handle,
            identity_npub,
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            join: Mutex::new(Some(join)),
            transcript_base: Mutex::new(None),
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

    /// Check the relay connections now and repair what is broken; resolves
    /// within a few seconds. Android calls it from a periodic alarm, holding
    /// a wake lock only for the call, instead of keeping the CPU awake.
    pub async fn keepalive(&self) {
        self.handle.keepalive().await;
    }

    /// Whether the device has a usable network. Offline parks the connection
    /// (no retries against a dead radio); coming back online reconnects at
    /// once with a fresh backoff instead of waiting out the current delay.
    /// Call it with `true` again when the network changed or regained
    /// internet access while staying up: whatever is down redials at once.
    pub fn set_online(&self, online: bool) {
        self.handle.set_online(online);
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

    /// The grouped, ready-to-render transcript for one session, as a change
    /// against revision `since` (0: none yet) — see `views.rs`'s doc comment
    /// for why this crosses the `presentation::display_entries` grouping
    /// rather than raw rows.
    pub async fn transcript_delta(&self, machine: String, session_id: String, since: u64) -> UniffiTranscriptDelta {
        let raw = self.handle.transcript_view(machine.clone(), session_id.clone()).await;
        let ui = self.handle.ui_view().await;
        let responded = responded_cards_for(&ui, &machine, &session_id);
        let mut base = self.transcript_base.lock().unwrap();
        build_uniffi_transcript_delta(&raw, responded, &mut base, &machine, &session_id, since)
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
        fn notify(&self, _title: String, _body: String, _tag: Option<String>, _kind: String) {}
        fn cancel(&self, _tag: String) {}
    }

    /// `_dir` must outlive the `Core` under test — dropping it early deletes
    /// the file the core thread's `rusqlite::Connection` still has open.
    fn temp_db_path() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("codedeck-test.db");
        (dir, path.to_string_lossy().into_owned())
    }

    #[test]
    fn identity_npub_is_the_bech32_form_of_the_constructor_identity() {
        let (_dir, db_path) = temp_db_path();
        let core = Core::new(
            local_identity_signer(SEC_PHONE.to_string()).unwrap(),
            None,
            Arc::new(NoopListener),
            Arc::new(NoopTestNotifier),
            None,
            db_path,
            None,
            false,
        )
        .expect("core spawns");
        let expected = protocol::crypto::keypair_from_secret_hex(SEC_PHONE).unwrap();

        let npub = core.identity_npub();
        assert!(npub.starts_with("npub1"), "not a bech32 npub: {npub}");
        assert_eq!(npub, expected.npub);

        core.shutdown();
    }

    /// The whole point of a real (not `CorePorts::default()`'s in-memory)
    /// `Kv`: a setting changed in one process lifetime is still there after
    /// the app (and its `Core`) restarts, against the same db file.
    #[tokio::test]
    async fn settings_persist_across_a_restart_against_the_same_db_file() {
        let (_dir, db_path) = temp_db_path();
        let spawn = |db_path: String| {
            Core::new(
                local_identity_signer(SEC_PHONE.to_string()).unwrap(),
                None,
                Arc::new(NoopListener),
                Arc::new(NoopTestNotifier),
                None,
                db_path,
                None,
                false,
            )
        };
        let core = spawn(db_path.clone()).expect("core spawns");
        core.dispatch(UniffiIntent::SetUiScale { scale: 1.2 }).await.expect("dispatch succeeds");
        // The store's persist-to-kv runs on the core's own loop, not inline
        // with `dispatch`'s send — give it a moment before tearing the core
        // down under it.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        core.shutdown();

        let core2 = spawn(db_path).expect("core re-spawns against the same db");
        let settings = core2.settings_view().await.expect("settings hydrated from the db");
        assert_eq!(settings.ui_scale, 1.2);
        core2.shutdown();
    }

    #[tokio::test]
    async fn persisted_tor_proxy_enabled_reflects_a_toggle_from_a_prior_core_lifetime() {
        let (_dir, db_path) = temp_db_path();
        let core = Core::new(
            local_identity_signer(SEC_PHONE.to_string()).unwrap(),
            None,
            Arc::new(NoopListener),
            Arc::new(NoopTestNotifier),
            None,
            db_path.clone(),
            None,
            false,
        )
        .expect("core spawns");
        assert!(!persisted_tor_proxy_enabled(db_path.clone()));

        core.dispatch(UniffiIntent::SetTorEnabled { enabled: true }).await.expect("dispatch succeeds");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        core.shutdown();

        assert!(persisted_tor_proxy_enabled(db_path));
    }
}
