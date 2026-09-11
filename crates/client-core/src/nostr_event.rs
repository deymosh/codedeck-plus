//! `SignedEvent` — a signed Nostr event as plain serializable data, and the one
//! place a `nostr::Event` is flattened into it. Shared by [`crate::bridge_api`]
//! (phone→bridge commands) and [`crate::nip42`] (relay AUTH). The transport
//! serializes it straight into a relay `["EVENT", …]` frame.

use serde::{Deserialize, Serialize};

/// A signed Nostr event, ready for the wire. Field set and names match the
/// canonical Nostr event JSON, so `serde_json::to_value(&e)` is a publishable
/// event object — and `serde_json::from_value` round-trips one the `nostr`
/// crate (or a relay) produced (`client-runtime` publishes the Marmot engine's
/// event JSON this way).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

impl SignedEvent {
    /// Flatten a fully built `nostr::Event`. `pub` so `client-runtime` can wrap
    /// the NIP-17 / Marmot gift-wrap events it builds with the `nostr` crate.
    pub fn from_nostr(event: &nostr::Event) -> Self {
        Self {
            id: event.id.to_hex(),
            pubkey: event.pubkey.to_hex(),
            created_at: event.created_at.as_secs(),
            kind: event.kind.as_u16(),
            tags: event.tags.iter().map(|t| t.as_slice().to_vec()).collect(),
            content: event.content.clone(),
            sig: event.sig.to_string(),
        }
    }
}
