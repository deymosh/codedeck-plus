//! Default relay lists. Mirror of `packages/protocol/src/relays.ts`.
//!
//! Changing `DEFAULT_RELAYS`? `LEGACY_DEFAULT_RELAY_SETS` in
//! `client_core::stores::settings` must gain the OUTGOING default in the same
//! commit, or every install that merely took the old default is read as a
//! customised list and stranded on the relay you just removed.

pub const PRIMARY_RELAY: &str = "wss://relay2.descendant.io";
pub const PAIRING_RELAY: &str = "wss://relay.primal.net";
pub const FALLBACK_RELAY: &str = "wss://nostr.oxtr.dev";

/// The transport relay list shared by both peers.
pub const DEFAULT_RELAYS: [&str; 3] = [PRIMARY_RELAY, PAIRING_RELAY, FALLBACK_RELAY];

/// CDX-100: Marmot-only relays — added to the PHONE's default list only (the
/// bridge speaks no MLS kind). Marmot lives on its own relay island.
pub const MARMOT_RELAYS: [&str; 2] = [
    "wss://relay.us.whitenoise.chat",
    "wss://relay.eu.whitenoise.chat",
];
