//! CodeDeck+ shared client logic — the pure half of the Rust client
//! (migration plan §1.2 / §2.6). No `tokio`, no sockets, no threads, no I/O:
//! reducers, state machines, the protocol codec, crypto. Deterministic; every
//! part covered by native vector tests. `client-runtime` wraps this with an
//! async host and the platform ports.
//!
//! Ported module-by-module from `apps/mobile/src/core` + the consumed parts of
//! `packages/protocol`; each port keeps the TS behaviour as its contract.

pub mod chunking;
pub mod crypto;
pub mod ranges;
pub mod wire;
