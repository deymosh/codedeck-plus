//! The wire contract — a mirror of `packages/protocol` (which stays the
//! normative zod spec). Faithful to the schemas: an unknown message `type` or
//! an unknown enum value is a decode error, exactly as zod rejects them. The
//! forward-compatible `#[serde(other)]` leniency (plan §3) is a deliberate,
//! separately-tested layer on top, not part of this port.

pub mod capabilities;
pub mod codec;
pub mod commands;
pub mod common;
pub mod events;
pub mod kinds;
pub mod tristate;

pub use codec::{
    decode_bridge_to_phone, decode_phone_to_bridge, encode_bridge_to_phone, encode_phone_to_bridge,
    DecodeResult,
};
