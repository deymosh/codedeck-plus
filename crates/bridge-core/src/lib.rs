//! The bridge engine: everything the bridge decides, as one deterministic
//! state machine with no I/O of its own.
//!
//! The bridge sits between phones (Nostr, [`protocol`]) and the agent host
//! (a pipe, [`agent_protocol`]). This crate holds the logic in between —
//! sessions and their restarts, transcript seqs, the permission / question /
//! plan cards, transcript sync, pairing, command ingest, credentials and
//! provider profiles — and nothing that touches a socket, a process or a
//! timer. `bridge-runtime` owns those: it feeds [`Engine::handle`] one
//! [`Input`] at a time and carries out the [`Effect`]s it returns.
//!
//! Quick local reads and writes (storage, transcript files, workspace
//! folders, the clock) go through the [`ports`] traits; the in-memory
//! implementations in [`ports::memory`] make every behaviour testable
//! without a filesystem.
//!
//! Nothing here knows a particular agent: modes, efforts, credentials and
//! features come from the catalog the agent host reports, and agent-specific
//! translation lives in the host's drivers.

mod catalog;
mod engine;
pub mod ingest;
mod io;
mod out;
pub mod pairing;
pub mod ports;
pub mod registry;
pub mod session;
pub mod settings;
mod sync;
pub mod time;

pub use engine::{Config, Engine};
pub use sync::SyncConfig;
pub use io::*;
