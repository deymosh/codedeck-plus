//! CodeDeck+ client async host (migration plan §2.6). Wraps `client-core` with
//! the tokio reactor, the `Transport` driver, live `ChunkAssembler`, lifecycle
//! (`start`/`stop`/`pause`/`resume`) and the platform ports. The UniFFI
//! (Android) and `#[tauri::command]` (Desktop) bindings attach to this crate.
//!
//! Skeleton only in F1 increment 1 — modules land as the transport/crypto port
//! progresses.

/// Re-export the pure core so hosts have one dependency edge.
pub use client_core;
