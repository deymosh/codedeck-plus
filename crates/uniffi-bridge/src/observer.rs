//! `CoreListener` — the foreign (Kotlin) callback interface, and
//! `UniffiObserver`, the adapter that implements the real
//! `client_runtime::core::CoreObserver` and forwards into it. Exactly the
//! role `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriObserver` plays for
//! Tauri — `client_runtime` itself stays binding-agnostic either way.

use std::sync::Arc;

use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::{ActionFailed, ConnectionView, CoreEvent, CoreObserver};
use protocol::events::BridgeToPhone;

/// Implemented in Kotlin. Every payload here is a REAL `client_runtime` type
/// (`ConnectionView`, `CoreEvent`, `ActionFailed` all derive `uniffi::Record`/
/// `uniffi::Enum` directly — see that crate's `uniffi` feature) — no parallel
/// DTO needed for the event stream, only for `Intent` (see `intent.rs`'s doc
/// comment for why that one differs). `connected_relays` (the per-relay
/// status dot's data) isn't on `ConnectionView` yet — add it there, the same
/// real type, the day Android's Settings screen needs it; don't grow a
/// parallel view here to route around that.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    fn connection_changed(&self, view: ConnectionView);
    fn on_event(&self, event: CoreEvent);
    fn action_failed(&self, kind: ActionFailed);
}

pub struct UniffiObserver {
    pub listener: Arc<dyn CoreListener>,
}

impl CoreObserver for UniffiObserver {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, _connected_relays: &[String]) {
        self.listener.connection_changed(ConnectionView::new(status, needs_pairing_check));
    }

    /// Deferred (not dropped): F3's first slice drives the app through
    /// Views/Intents/CoreEvents only, never a raw wire message. Wire this up
    /// (with its own `protocol::events::BridgeToPhone` -> UniFFI mapping,
    /// mirroring `intent.rs`'s approach) the day a Kotlin call site actually
    /// needs it.
    fn bridge_message(&self, _machine: String, _msg: BridgeToPhone) {}

    fn action_failed(&self, kind: ActionFailed) {
        self.listener.action_failed(kind);
    }

    fn on_event(&self, event: CoreEvent) {
        self.listener.on_event(event);
    }
}
