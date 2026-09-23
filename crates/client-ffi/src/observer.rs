//! `CoreListener` — the foreign (Kotlin) callback interface, and
//! `UniffiObserver`, the adapter that implements the real
//! `client_runtime::core::CoreObserver` and forwards into it. Exactly the
//! role `apps/mobile/src-tauri/src/native_core.rs`'s `TauriObserver` plays for
//! Tauri — `client_runtime` itself stays binding-agnostic either way.

use std::sync::Arc;

use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::{ActionFailedKind, ConnectionView, CoreEvent, CoreObserver};
use protocol::events::BridgeToPhone;

/// Implemented in Kotlin. Every payload here is a REAL `client_runtime` type
/// (`ConnectionView`, `CoreEvent`, `ActionFailedKind` all derive `uniffi::Record`/
/// `uniffi::Enum` directly — see that crate's `uniffi` feature) — no parallel
/// DTO needed for the event stream, only for `Intent` (see `intent.rs`'s doc
/// comment for why that one differs). `ConnectionView.connected_relays` (the
/// per-relay status dot's data, F4.1.5) is the same real type too — added
/// straight to `ConnectionView` once Android's Settings screen actually
/// needed it, exactly as this comment used to say to do.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    fn connection_changed(&self, view: ConnectionView);
    fn on_event(&self, event: CoreEvent);
    fn action_failed(&self, kind: ActionFailedKind);
}

/// Runs one call into Kotlin from the core thread, containing a failure.
///
/// A foreign method that returns `()` has no error channel: when the Kotlin
/// side throws, uniffi panics in the calling Rust thread. On the core thread
/// that panic would unwind out of the event loop and end it for the rest of
/// the process — silently, since `dispatch` keeps succeeding and every view
/// falls back to its empty default. A callback that fails is logged and
/// skipped instead; the loop keeps running.
pub(crate) fn foreign_call(what: &str, f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        log::error!("foreign callback {what} failed; the core keeps running");
    }
}

pub struct UniffiObserver {
    pub listener: Arc<dyn CoreListener>,
}

impl CoreObserver for UniffiObserver {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, connected_relays: &[String]) {
        log::info!(
            "connection_changed: status={status:?} needs_pairing_check={needs_pairing_check} connected_relays={connected_relays:?}"
        );
        let view = ConnectionView::new(status, needs_pairing_check, connected_relays.to_vec());
        foreign_call("connection_changed", || self.listener.connection_changed(view));
    }

    /// Deferred (not dropped): F3's first slice drives the app through
    /// Views/Intents/CoreEvents only, never a raw wire message. Wire this up
    /// (with its own `protocol::events::BridgeToPhone` -> UniFFI mapping,
    /// mirroring `intent.rs`'s approach) the day a Kotlin call site actually
    /// needs it.
    fn bridge_message(&self, _machine: String, _msg: BridgeToPhone) {}

    fn action_failed(&self, kind: ActionFailedKind) {
        log::warn!("action_failed: {kind:?}");
        foreign_call("action_failed", || self.listener.action_failed(kind));
    }

    fn on_event(&self, event: CoreEvent) {
        foreign_call("on_event", || self.listener.on_event(event));
    }
}
