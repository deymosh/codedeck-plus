//! `UniffiNotifier` — the foreign (Kotlin) callback interface for OS
//! notification delivery, and `NotifierAdapter`, the adapter that implements
//! the real `client_runtime::ports::Notifier` and forwards into it. Same
//! shape as `observer.rs`'s `CoreListener`/`UniffiObserver` split: the
//! *decision* of when to notify already lives in `client-core`
//! (`notifications`/`notificationsCoordinator`, ported from
//! `apps/mobile/src/core/{notifications,notificationsCoordinator}.ts`) —
//! this crate only carries the *delivery* call across the FFI boundary, the
//! same "core decides, platform delivers" split `apps/mobile/src-tauri/src/
//! corebridge.rs`'s `TauriNotifier` already has for Tauri.
//!
//! `client_runtime::ports::Notifier` is `Rc`-bound (the real `Core` runs
//! entirely on one `LocalSet` thread, so its ports don't need `Send`/`Sync`)
//! — but a UniFFI foreign callback interface always does need `Send + Sync`
//! (Kotlin can invoke it from any thread the runtime happens to use). This
//! file is exactly where that seam is crossed: `UniffiNotifier` is the
//! `Send + Sync` Kotlin-facing trait; `NotifierAdapter` is the local,
//! non-`Send` wrapper `Core::new` hands to `CorePorts` that holds an
//! `Arc<dyn UniffiNotifier>` and forwards each call through it.

use std::sync::Arc;

use client_runtime::Notifier;

/// Implemented in Kotlin (`platform/Notifier.kt`) via `NotificationManagerCompat`.
/// `tag` is the same per-session/per-peer key `client-core`'s own notification
/// coordinator already computes (`session_notify_tag`/`dm_notify_tag`) — used
/// for `cancel`-by-tag, not for anything UniFFI needs to interpret.
#[uniffi::export(with_foreign)]
pub trait UniffiNotifier: Send + Sync {
    fn notify(&self, title: String, body: String, tag: Option<String>);
    fn cancel(&self, tag: String);
}

pub struct NotifierAdapter {
    pub notifier: Arc<dyn UniffiNotifier>,
}

impl Notifier for NotifierAdapter {
    fn notify(&self, title: &str, body: &str, tag: Option<&str>) {
        self.notifier.notify(title.to_string(), body.to_string(), tag.map(str::to_string));
    }

    fn cancel(&self, tag: &str) {
        self.notifier.cancel(tag.to_string());
    }
}
