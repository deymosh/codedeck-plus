//! CodeDeck+ client async host (migration plan §2.6). Wraps `client-core` with
//! the tokio reactor, the `Transport` driver, live `ChunkAssembler`, lifecycle
//! (`start`/`stop`/`pause`/`resume`), the platform ports, and the composed
//! store layer. The UniFFI (Android) and `#[tauri::command]` (Desktop)
//! bindings attach to this crate.
//!
//! Layering: `nostr_client` (epoch-guarded per-class subscription FSM) sits
//! behind a `Transport` port; `transport::ws` is the real WebSocket + SOCKS5
//! driver; `core::Core` composes the connection FSM, `bridge_api`, the
//! `dispatch::Router` over every store, the `intent` surface, the `view`
//! projections, the `CoreEvent` stream and the NIP-17 DM runtime behind one
//! tokio event loop — the handle the bindings attach to.

pub mod attachments;
pub mod core;
pub mod deadline;
pub mod dispatch;
pub mod giftwrap;
pub mod intent;
pub mod marmot;
pub mod nostr_client;
pub mod ports;
pub mod stores;
pub mod transport;
pub mod view;

pub use core::{
    ActionFailed, Clock, Core, CoreConfig, CoreEvent, CoreObserver, CorePorts, Entropy, SliceId,
    SystemClock, TimeEntropy,
};
pub use dispatch::StoreId;
pub use intent::{Intent, IntentCtx};
pub use ports::{Kv, MemoryKv, MemoryTranscriptStore, Notifier, NullNotifier, TranscriptStore};
pub use stores::{CoreStores, HydratedCore};
pub use view::{
    ConnectionView, DmView, MachinesView, OutboxView, PairingView, SettingsView, TranscriptSyncView,
};

/// Re-export the pure core so hosts have one dependency edge.
pub use client_core;
