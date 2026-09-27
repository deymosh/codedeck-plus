//! stores — domain state as pure state machines. No zustand, no
//! I/O; the runtime owns wiring + persistence.

pub mod session_key;
pub mod fetches;
pub mod machines;
pub mod outbox;
pub mod pairing;
pub mod pending_sessions;
pub mod quick_prompts;
pub mod settings;
pub mod transcript;
pub mod ui;
