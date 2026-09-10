//! stores — domain state as pure state machines (plan F2a). No zustand, no
//! I/O; the runtime owns wiring + persistence.

pub mod dm;
pub mod identity;
pub mod machines;
pub mod marmot;
pub mod outbox;
pub mod pairing;
pub mod pending_sessions;
pub mod quick_prompts;
pub mod settings;
pub mod transcript;
pub mod ui;
