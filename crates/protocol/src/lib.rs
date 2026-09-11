//! The wire contract — a mirror of `packages/protocol` (which stays the
//! normative zod spec; see that package's `fixtures/README.md` and this
//! crate's own `tests/codec_conformance.rs` for the anti-drift mechanism).
//! Faithful to the schemas: an unknown message `type` or an unknown enum
//! value is a decode error, exactly as zod rejects them. The
//! forward-compatible `#[serde(other)]` leniency (migration plan §3) is a
//! deliberate, separately-tested layer on top, not part of this port.
//!
//! Depends on nothing in this workspace — `client-core` depends on this
//! crate, never the other way around, so a future Rust bridge (`bridge-core`/
//! `bridge-runtime`) can consume it too without reorganizing anything here.
//! Also carries the crypto/event primitives the wire format itself needs
//! (NIP-44 encryption, NIP-42 AUTH signing, the flattened Nostr event shape)
//! — these are part of "how the wire is secured," not client domain logic,
//! so they live here rather than in `client-core`.

pub mod capabilities;
pub mod chunking;
pub mod codec;
pub mod commands;
pub mod common;
pub mod crypto;
pub mod events;
pub mod kinds;
pub mod nip42;
pub mod nostr_event;
pub mod ranges;
pub mod relays;
pub mod tristate;

pub use codec::{
    decode_bridge_to_phone, decode_phone_to_bridge, encode_bridge_to_phone, encode_phone_to_bridge,
    DecodeResult,
};
