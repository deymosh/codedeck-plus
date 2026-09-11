//! CodeDeck+ shared client logic — the pure half of the Rust client
//! (migration plan §1.2 / §2.6). No `tokio`, no sockets, no threads, no I/O:
//! reducers, state machines, domain stores. Deterministic; every part covered
//! by native vector tests. `client-runtime` wraps this with an async host and
//! the platform ports.
//!
//! The wire contract itself (codec, schemas, ranges, chunking, NIP-42/crypto
//! primitives) lives in the `protocol` crate, not here — this crate depends
//! on it, never redefines it. See `protocol`'s own doc comment for why.
//!
//! Ported module-by-module from `apps/mobile/src/core` + the consumed parts of
//! `packages/protocol`; each port keeps the TS behaviour as its contract.

pub mod bridge_api;
pub mod connection;
pub mod default_session_mode;
pub mod delete_controller;
pub mod dm_attachments;
pub mod image_chunks;
#[cfg(feature = "marmot")]
pub mod marmot_engine;
pub mod mode_cycle;
pub mod notifications;
pub mod presentation;
pub mod selection_persistence;
pub mod session_needs_attention;
pub mod stores;
