//! CodeDeck+ client async host (migration plan §2.6). Wraps `client-core` with
//! the tokio reactor, the `Transport` driver, live `ChunkAssembler`, lifecycle
//! (`start`/`stop`/`pause`/`resume`) and the platform ports. The UniFFI
//! (Android) and `#[tauri::command]` (Desktop) bindings attach to this crate.
//!
//! F1: `nostr_client` (the epoch-guarded per-class subscription state machine)
//! is ported first, behind a `Transport` port. The real `tokio-tungstenite` +
//! SOCKS5 transport and the lifecycle handle land next.

pub mod nostr_client;
pub mod transport;

/// Re-export the pure core so hosts have one dependency edge.
pub use client_core;
