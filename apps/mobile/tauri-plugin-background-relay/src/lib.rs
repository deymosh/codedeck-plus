//! CodeDeck stay-connected foreground service (Phase 5c, plan §5).
//!
//! Rebuild of the old notification-only stub as a REAL service:
//! - START_STICKY + persistent notification (Android 14+ type: dataSync)
//! - partial WakeLock + WifiLock held while running, released on stop
//! - notification text mirrors the true connection-FSM state, pushed from JS
//!   via `update_state` — the service only displays, it decides nothing
//!
//! The service does NOT own sockets: the WebView keeps them (cheap
//! resync-on-resume already exists); its whole job is keeping the process and
//! the radio alive while the "stay connected" toggle is on. A native Kotlin
//! socket is a Phase-7 stretch goal ONLY. Desktop: everything is a no-op —
//! desktop sockets survive backgrounding fine.

mod commands;
mod models;

#[cfg(mobile)]
mod mobile;

#[cfg(not(mobile))]
mod desktop;

pub use models::*;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(mobile)]
type BackgroundRelayImpl<R> = mobile::BackgroundRelay<R>;

#[cfg(not(mobile))]
type BackgroundRelayImpl<R> = desktop::BackgroundRelay<R>;

pub trait BackgroundRelayExt<R: Runtime> {
    fn background_relay(&self) -> &BackgroundRelayImpl<R>;
}

impl<R: Runtime, T: Manager<R>> BackgroundRelayExt<R> for T {
    fn background_relay(&self) -> &BackgroundRelayImpl<R> {
        self.state::<BackgroundRelayImpl<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("background-relay")
        .invoke_handler(tauri::generate_handler![
            commands::start_service,
            commands::stop_service,
            commands::is_running,
            commands::update_state,
            commands::get_connectivity,
            commands::watch_connectivity,
            commands::unwatch_connectivity,
        ])
        .setup(|app, _api| {
            #[cfg(mobile)]
            {
                let br = mobile::init(app, _api)?;
                app.manage(br);
            }
            #[cfg(not(mobile))]
            {
                let br = desktop::init(app)?;
                app.manage(br);
            }
            Ok(())
        })
        .build()
}
