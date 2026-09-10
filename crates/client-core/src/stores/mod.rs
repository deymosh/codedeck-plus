//! stores — domain state as pure state machines (plan F2a). No zustand, no
//! I/O; the runtime owns wiring + persistence.

pub mod machines;
pub mod outbox;
pub mod pairing;
