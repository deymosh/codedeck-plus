//! The Desktop side of the same `client-core` API. A real `apps/desktop` would:
//!   1. `app.manage(Arc::new(Core::new()))` at setup
//!   2. `wire_events(app.handle().clone(), &core)` to bridge `CoreEvent` -> `emit`
//!   3. register `commands::{dispatch, snapshot, start, stop}` in `invoke_handler!`
//!
//! Note the total glue: the boundary types (`Intent`, `CoreEvent`, `ProbeView`,
//! `CoreError`) carry `serde` derives alongside their `uniffi` derives, so ONE
//! definition serves both bindings. `cargo check` only — no webview here.
//!
//! Spike finding: `#[tauri::command]` must live in a submodule, not at a
//! library crate's root — its `#[macro_export]` collides with its own re-export
//! there. `apps/desktop` will have a `commands` module anyway, so this is a
//! non-issue in practice; noted so the real code starts that way.

use std::sync::Arc;

use client_core_probe::{Core, CoreEvent};
use tauri::Emitter;

pub mod commands {
    use std::sync::Arc;

    use client_core_probe::{Core, CoreError, Intent, ProbeView};
    use tauri::State;

    /// Desktop registers `Arc<Core>` as managed state once.
    type CoreState<'a> = State<'a, Arc<Core>>;

    /// Async command -> the JS side `await invoke("dispatch", { intent })`.
    /// The typed `CoreError` serializes straight to the JS rejection value.
    #[tauri::command]
    pub async fn dispatch(core: CoreState<'_>, intent: Intent) -> Result<(), CoreError> {
        core.inner().clone().dispatch(intent).await
    }

    /// Sync command returning a plain-data view -> `await invoke("snapshot")`.
    #[tauri::command]
    pub fn snapshot(core: CoreState<'_>) -> ProbeView {
        core.snapshot()
    }

    #[tauri::command]
    pub fn start(core: CoreState<'_>) {
        core.inner().clone().start();
    }

    #[tauri::command]
    pub fn stop(core: CoreState<'_>) {
        core.inner().clone().stop();
    }
}

/// The `subscribe` callback becomes a Tauri event stream the frontend listens to
/// with `listen("core-event", ...)`. `CoreEvent`'s `serde` derive does the rest.
pub fn wire_events(app: tauri::AppHandle<tauri::Wry>, core: &Arc<Core>) {
    struct Emit(tauri::AppHandle<tauri::Wry>);
    impl client_core_probe::CoreListener for Emit {
        fn on_event(&self, event: CoreEvent) {
            let _ = self.0.emit("core-event", event);
        }
    }
    core.subscribe(Arc::new(Emit(app.clone())));
}
