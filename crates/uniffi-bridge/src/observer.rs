//! `CoreListener` — the foreign (Kotlin) callback interface, and
//! `UniffiObserver`, the adapter that implements the real
//! `client_runtime::core::CoreObserver` and forwards into it. Exactly the
//! role `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriObserver` plays for
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

pub struct UniffiObserver {
    pub listener: Arc<dyn CoreListener>,
}

impl CoreObserver for UniffiObserver {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, connected_relays: &[String]) {
        self.listener
            .connection_changed(ConnectionView::new(status, needs_pairing_check, connected_relays.to_vec()));
    }

    /// Deferred (not dropped): F3's first slice drives the app through
    /// Views/Intents/CoreEvents only, never a raw wire message. Wire this up
    /// (with its own `protocol::events::BridgeToPhone` -> UniFFI mapping,
    /// mirroring `intent.rs`'s approach) the day a Kotlin call site actually
    /// needs it.
    fn bridge_message(&self, _machine: String, _msg: BridgeToPhone) {}

    fn action_failed(&self, kind: ActionFailedKind) {
        self.listener.action_failed(kind);
    }

    fn on_event(&self, event: CoreEvent) {
        self.listener.on_event(event);
    }
}
