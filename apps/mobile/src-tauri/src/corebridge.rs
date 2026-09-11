//! F1/F2b: the Rust `client-runtime` hosted IN the app process, behind the
//! `native-core` Cargo feature.
//!
//! With the feature off, this module is not compiled and the crate builds
//! byte-identical to before — the WebView `src/core` keeps owning the Nostr
//! sockets. With it on and the WebView opting in (`core_init`), the sockets +
//! crypto + connection FSM + every store (F2b: over real SQLite persistence,
//! `native_ports.rs`) run here, on a dedicated thread inside the
//! stay-connected foreground service. The WebView receives the semantic
//! `CoreEvent` stream + already-decoded bridge→phone messages over Tauri
//! events, and drives user actions through `core_dispatch(Intent)` and the
//! `core_*_view` queries (plan §2) — this is the full surface the re-point
//! consumes, replacing `src/core`'s direct-socket path entirely.
//!
//! Threading: `client_runtime::Core` drives a `!Send` event loop
//! (`Rc`-based, mirroring the TS `this` model), so it lives on this thread's
//! `LocalSet`. The `Core` *handle* is `Send` (its only field is an mpsc sender
//! of `Send` messages) and is handed back to Tauri's `State` for the commands
//! to call.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Mutex;
use std::thread;

use client_runtime::client_core::bridge_api::PublishVerdict;
use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::client_core::crypto::keypair_from_secret_hex;
use client_runtime::client_core::wire::codec::decode_phone_to_bridge;
use client_runtime::client_core::wire::events::BridgeToPhone;
use client_runtime::core::{
    ActionFailed, Clock, CoreObserver, CorePorts, Entropy, SystemClock, TimeEntropy,
};
use client_runtime::{
    Core, CoreConfig, CoreEvent, DmView, Intent, MachinesView, MarmotView, Notifier, OutboxView,
    PairingView, PendingSessionsView, QuickPromptsView, SettingsView, TranscriptRowsView, UiView,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::native_http::ReqwestHttpFetch;
use crate::native_ports::{open_native_db, KvSqlite, TranscriptStoreSqlite};
use crate::sqlstore::DB_FILE;

/// Managed Tauri state: `Some` once `core_init` has spun the bridge thread.
#[derive(Default)]
pub struct CoreBridge(Mutex<Option<Core>>);

const EV_CONNECTION: &str = "core://connection";
const EV_MESSAGE: &str = "core://message";
const EV_ACTION_FAILED: &str = "core://action-failed";
/// The full semantic event stream (plan §2.3), forwarded verbatim as JSON —
/// see `CoreEvent`'s own doc comment for the wire shape. Additive to the
/// three events above (kept for the WebView listeners already wired to
/// them); a consumer migrating to the plan's View/Intent/CoreEvent surface
/// needs only this one channel.
const EV_CORE_EVENT: &str = "core://event";

fn status_str(status: ConnectionStatus) -> &'static str {
    match status {
        ConnectionStatus::Idle => "idle",
        ConnectionStatus::Connecting => "connecting",
        ConnectionStatus::Connected => "connected",
        ConnectionStatus::WaitingRetry => "waiting-retry",
        ConnectionStatus::Offline => "offline",
        ConnectionStatus::Stopped => "stopped",
    }
}

fn action_str(kind: ActionFailed) -> &'static str {
    match kind {
        ActionFailed::DecryptFailed => "decrypt-failed",
        ActionFailed::DecodeFailed => "decode-failed",
        ActionFailed::PublishRejected => "publish-rejected",
        ActionFailed::PublishUnreachable => "publish-unreachable",
    }
}

#[derive(Serialize, Clone)]
pub struct ConnectionPayload {
    status: &'static str,
    needs_pairing_check: bool,
}

#[derive(Serialize, Clone)]
struct MessagePayload {
    machine: String,
    /// The decoded bridge→phone message, in its wire JSON shape — the WebView
    /// feeds it straight to the same handlers its TS decoder produced.
    message: BridgeToPhone,
}

/// `CoreObserver` that fans the semantic events out as Tauri events. No UI
/// strings — the WebView writes copy.
struct TauriObserver {
    app: AppHandle,
}

impl CoreObserver for TauriObserver {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool) {
        let _ = self.app.emit(
            EV_CONNECTION,
            ConnectionPayload {
                status: status_str(status),
                needs_pairing_check,
            },
        );
    }

    fn bridge_message(&self, machine: String, msg: BridgeToPhone) {
        let _ = self.app.emit(
            EV_MESSAGE,
            MessagePayload {
                machine,
                message: msg,
            },
        );
    }

    fn action_failed(&self, kind: ActionFailed) {
        let _ = self.app.emit(EV_ACTION_FAILED, action_str(kind));
    }

    fn on_event(&self, event: CoreEvent) {
        let _ = self.app.emit(EV_CORE_EVENT, event);
    }
}

/// Delivers the `Notifier` port through `tauri-plugin-notification`'s Rust
/// API — the same plugin `apps/mobile/src/platform/notifier.ts` drives over
/// its JS bindings for the WebView path, called directly from the core's own
/// thread instead of round-tripping through the frontend. Without this the
/// native-core `CorePorts` default (`NullNotifier`) would silently drop every
/// OS notification (DMs, turn-finished, permission prompts) under F2b.
///
/// CDX-026c cancellation: the plugin's remove-by-id call
/// (`Notification::remove_active`) exists on mobile only — desktop's Rust API
/// has no equivalent at all — and it needs OUR ids, not tags, so this mirrors
/// `platform/notifier.ts`'s own approach: assign an id per delivery, remember
/// it per cancellation tag (capped so a pathological stream can't leak
/// memory), and remove them all when that tag is cancelled. Ids survive only
/// this app run, same limitation the JS notifier documents.
struct TauriNotifier {
    app: AppHandle,
    next_id: Cell<i32>,
    ids_by_tag: RefCell<HashMap<String, Vec<i32>>>,
}

/// Per-tag bookkeeping cap — mirrors `platform/notifier.ts`'s own
/// `MAX_IDS_PER_TAG`: a tag rarely accumulates more than a couple of live
/// notifications, so this only bounds memory on a pathological stream.
const MAX_NOTIFICATION_IDS_PER_TAG: usize = 16;

impl TauriNotifier {
    fn new(app: AppHandle) -> Self {
        // 32-bit-safe seed; per-run uniqueness is all cancellation needs, same
        // as the JS notifier's `Date.now() & 0x0fffffff`.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| (d.as_millis() as i32) & 0x0fff_ffff)
            .unwrap_or(0);
        Self {
            app,
            next_id: Cell::new(seed),
            ids_by_tag: RefCell::new(HashMap::new()),
        }
    }
}

impl Notifier for TauriNotifier {
    fn notify(&self, title: &str, body: &str, tag: Option<&str>) {
        let id = self.next_id.get().wrapping_add(1);
        self.next_id.set(id);
        let shown = self
            .app
            .notification()
            .builder()
            .id(id)
            .title(title)
            .body(body)
            .show()
            .is_ok();
        if shown {
            if let Some(tag) = tag {
                let mut ids_by_tag = self.ids_by_tag.borrow_mut();
                let ids = ids_by_tag.entry(tag.to_string()).or_default();
                ids.push(id);
                if ids.len() > MAX_NOTIFICATION_IDS_PER_TAG {
                    ids.remove(0);
                }
            }
        }
    }

    fn cancel(&self, tag: &str) {
        let Some(ids) = self.ids_by_tag.borrow_mut().remove(tag) else {
            return;
        };
        #[cfg(mobile)]
        {
            let _ = self.app.notification().remove_active(ids);
        }
        #[cfg(not(mobile))]
        {
            // Desktop's Rust API has no remove-by-id call at all (mobile-only)
            // — best-effort no-op.
            let _ = ids;
        }
    }
}

/// `core_init` argument. `identity_secret_hex` is the phone's persisted nsec —
/// a secret: it is consumed into the keypair here and never logged or echoed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitConfig {
    pub relays: Vec<String>,
    pub identity_secret_hex: String,
    /// SOCKS5 `host:port` (Orbot). `None` = direct.
    pub proxy: Option<String>,
    pub tor: bool,
}

/// Cheap presence probe: succeeds iff this APK was built with `native-core`
/// (the command is otherwise absent and `invoke` rejects). Needs no state, so
/// the WebView can call it BEFORE `core_init` to decide whether to use the
/// in-process path at all.
#[tauri::command]
pub fn core_available() -> bool {
    true
}

/// Spin the bridge thread + `Core`. Idempotent — a second call is a no-op.
#[tauri::command]
pub fn core_init(app: AppHandle, bridge: State<'_, CoreBridge>, config: InitConfig) -> Result<(), String> {
    let mut slot = bridge.0.lock().map_err(|_| "core bridge lock poisoned")?;
    if slot.is_some() {
        return Ok(());
    }

    let identity = keypair_from_secret_hex(&config.identity_secret_hex)
        .map_err(|e| format!("identity secret: {e}"))?;
    // Cloned before `CoreConfig::new` consumes `config.proxy` — the SAME
    // `host:port` also configures `ReqwestHttpFetch`'s SOCKS5 proxy below, so
    // a Blossom upload routes through Orbot exactly when the relay sockets do.
    let http_proxy = config.proxy.clone();
    let core_config = CoreConfig::new(config.relays, identity, config.proxy, config.tor);
    let observer_app = app.clone();
    let notifier_app = app.clone();

    // Resolve the SAME db path `sqlstore::sql_open` uses, on the main thread
    // (`Manager::path()` needs the `AppHandle`) — but open the connection
    // ITSELF on the core thread below: `rusqlite::Connection` isn't `Send`,
    // and every other `client_runtime` port lives behind an `Rc`, matching
    // the Core's single-threaded design.
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app config dir: {e}"))?
        .join(DB_FILE);
    // The SAME path + file name `marmot.rs`'s `marmot_init` command already
    // uses for the WebView path's engine — an install switching between the
    // two must keep its MLS group state (losing it means every Marmot chat
    // needs a fresh invite, unrecoverably).
    let marmot_db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("marmot.db");

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Core, String>>();
    thread::Builder::new()
        .name("codedeck-core".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build current-thread runtime");
            let local = tokio::task::LocalSet::new();
            local.block_on(&runtime, async move {
                let observer: Rc<dyn CoreObserver> = Rc::new(TauriObserver { app: observer_app });
                let clock: Rc<dyn Clock> = Rc::new(SystemClock);
                let entropy: Rc<dyn Entropy> = Rc::new(TimeEntropy);

                let conn = match open_native_db(&db_path) {
                    Ok(conn) => Rc::new(RefCell::new(conn)),
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("open native db: {e}")));
                        return;
                    }
                };
                let http = match ReqwestHttpFetch::new(http_proxy.as_deref()) {
                    Ok(f) => Rc::new(f),
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("build http client: {e}")));
                        return;
                    }
                };
                // Real, persistent Kv + TranscriptStore — the SAME
                // `codedeck.db` / schema `sqlstore.rs`'s SqlExecutor seam
                // serves the WebView, so an install upgrading onto this path
                // keeps its pairing, sessions, and transcript history. Real
                // OS-notification delivery via `TauriNotifier`; real Blossom
                // upload/download via `ReqwestHttpFetch`; real Marmot (MDK/
                // MLS) via `MarmotEngineImpl`, over the SAME `marmot.db` the
                // WebView path's `marmot_init` command already uses.
                let ports = CorePorts {
                    kv: Rc::new(KvSqlite::new(conn.clone())),
                    transcript_store: Rc::new(TranscriptStoreSqlite::new(conn)),
                    notifier: Rc::new(TauriNotifier::new(notifier_app)),
                    http,
                    marmot: Rc::new(client_runtime::marmot::MarmotEngineImpl::new(marmot_db_path)),
                };
                let core = Core::spawn(core_config, ports, observer, clock, entropy).await;
                let _ = ready_tx.send(Ok(core));
                // Keep the LocalSet alive: it drives the Core loop, its timers,
                // and the per-relay socket tasks.
                std::future::pending::<()>().await;
            });
        })
        .map_err(|e| format!("spawn core thread: {e}"))?;

    let core = ready_rx
        .recv()
        .map_err(|_| "core thread exited before init".to_string())??;
    *slot = Some(core);
    Ok(())
}

fn with_core<R>(
    bridge: &State<'_, CoreBridge>,
    f: impl FnOnce(&Core) -> R,
) -> Result<R, String> {
    let slot = bridge.0.lock().map_err(|_| "core bridge lock poisoned")?;
    let core = slot.as_ref().ok_or("core not initialised (call core_init)")?;
    Ok(f(core))
}

#[tauri::command]
pub fn core_start(bridge: State<'_, CoreBridge>) -> Result<(), String> {
    with_core(&bridge, Core::start)
}

#[tauri::command]
pub fn core_stop(bridge: State<'_, CoreBridge>) -> Result<(), String> {
    with_core(&bridge, Core::stop)
}

#[tauri::command]
pub fn core_pause(bridge: State<'_, CoreBridge>) -> Result<(), String> {
    with_core(&bridge, Core::pause)
}

#[tauri::command]
pub fn core_resume(bridge: State<'_, CoreBridge>) -> Result<(), String> {
    with_core(&bridge, Core::resume)
}

#[tauri::command]
pub fn core_set_online(bridge: State<'_, CoreBridge>, online: bool) -> Result<(), String> {
    with_core(&bridge, |c| c.set_online(online))
}

#[tauri::command]
pub fn core_set_machines(bridge: State<'_, CoreBridge>, machines: Vec<String>) -> Result<(), String> {
    with_core(&bridge, |c| c.set_machines(machines))
}

#[tauri::command]
pub fn core_set_relays(bridge: State<'_, CoreBridge>, relays: Vec<String>) -> Result<(), String> {
    with_core(&bridge, |c| c.set_relays(relays))
}

/// Fire-and-forget send. `message` is a phone→bridge command in wire JSON — the
/// same object the WebView's TS encoder builds.
#[tauri::command]
pub fn core_send(
    bridge: State<'_, CoreBridge>,
    machine: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let msg = decode_phone_to_bridge(&message.to_string())?;
    with_core(&bridge, |c| c.send(machine, msg))
}

fn verdict_str(verdict: PublishVerdict) -> &'static str {
    match verdict {
        PublishVerdict::Accepted => "accepted",
        PublishVerdict::Unconfirmed => "unconfirmed",
        PublishVerdict::Rejected => "rejected",
        PublishVerdict::Unreachable => "unreachable",
    }
}

/// Send and await the CDX-086 publish verdict (`accepted` / `unconfirmed` /
/// `rejected` / `unreachable`).
#[tauri::command]
pub async fn core_publish(
    bridge: State<'_, CoreBridge>,
    machine: String,
    message: serde_json::Value,
) -> Result<String, String> {
    let msg = decode_phone_to_bridge(&message.to_string())?;
    let core = with_core(&bridge, |c| c.clone())?;
    let result = core.publish_confirmed(machine, msg).await;
    Ok(verdict_str(result.verdict).to_string())
}

#[tauri::command]
pub async fn core_connection_status(
    bridge: State<'_, CoreBridge>,
) -> Result<ConnectionPayload, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    let (status, needs_pairing_check) = core.connection_status().await;
    Ok(ConnectionPayload {
        status: status_str(status),
        needs_pairing_check,
    })
}

// --- F2b: the plan §2 View/Intent surface -----------------------------

/// Dispatch one user action (plan §2.2). `intent` is `Intent`'s own JSON
/// shape (externally tagged, camelCase — see its doc comment); Tauri
/// deserializes it directly, no hand-rolled decoding on either side.
#[tauri::command]
pub async fn core_dispatch(bridge: State<'_, CoreBridge>, intent: Intent) -> Result<(), String> {
    let core = with_core(&bridge, |c| c.clone())?;
    core.dispatch(intent).await;
    Ok(())
}

#[tauri::command]
pub async fn core_machines_view(bridge: State<'_, CoreBridge>) -> Result<MachinesView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.machines_view().await)
}

#[tauri::command]
pub async fn core_settings_view(
    bridge: State<'_, CoreBridge>,
) -> Result<Option<SettingsView>, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.settings_view().await)
}

#[tauri::command]
pub async fn core_outbox_view(bridge: State<'_, CoreBridge>) -> Result<OutboxView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.outbox_view().await)
}

#[tauri::command]
pub async fn core_pairing_view(
    bridge: State<'_, CoreBridge>,
) -> Result<Option<PairingView>, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.pairing_view().await)
}

#[tauri::command]
pub async fn core_dm_view(bridge: State<'_, CoreBridge>) -> Result<Option<DmView>, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.dm_view().await)
}

#[tauri::command]
pub async fn core_marmot_view(bridge: State<'_, CoreBridge>) -> Result<Option<MarmotView>, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.marmot_view().await)
}

#[tauri::command]
pub async fn core_quick_prompts_view(
    bridge: State<'_, CoreBridge>,
) -> Result<QuickPromptsView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.quick_prompts_view().await)
}

#[tauri::command]
pub async fn core_pending_sessions_view(
    bridge: State<'_, CoreBridge>,
) -> Result<PendingSessionsView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.pending_sessions_view().await)
}

#[tauri::command]
pub async fn core_ui_view(bridge: State<'_, CoreBridge>) -> Result<UiView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.ui_view().await)
}

#[tauri::command]
pub async fn core_transcript_view(
    bridge: State<'_, CoreBridge>,
    machine: String,
    session_id: String,
) -> Result<TranscriptRowsView, String> {
    let core = with_core(&bridge, |c| c.clone())?;
    Ok(core.transcript_view(machine, session_id).await)
}
