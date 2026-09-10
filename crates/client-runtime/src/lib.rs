//! CodeDeck+ client async host (migration plan §2.6). Wraps `client-core` with
//! the tokio reactor, the `Transport` driver, live `ChunkAssembler`, lifecycle
//! (`start`/`stop`/`pause`/`resume`) and the platform ports. The UniFFI
//! (Android) and `#[tauri::command]` (Desktop) bindings attach to this crate.
//!
//! F1 layering: `nostr_client` (epoch-guarded per-class subscription FSM) sits
//! behind a `Transport` port; `transport::ws` is the real WebSocket + SOCKS5
//! driver; `core::Core` composes them with the connection FSM and `bridge_api`
//! behind one tokio event loop — the handle the bindings attach to.

pub mod core;
pub mod deadline;
pub mod dispatch;
pub mod nostr_client;
pub mod ports;
pub mod stores;
pub mod transport;
pub mod view;

pub use core::{Core, CoreConfig, CoreObserver};
pub use ports::{Kv, Notifier, TranscriptStore};
pub use stores::{CoreStores, HydratedCore};

/// Re-export the pure core so hosts have one dependency edge.
pub use client_core;
