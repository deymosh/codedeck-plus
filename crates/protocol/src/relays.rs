//! Default relay lists. Originally mirrored from the TypeScript protocol package.

pub const PRIMARY_RELAY: &str = "wss://relay2.descendant.io";
pub const PAIRING_RELAY: &str = "wss://relay.primal.net";
pub const FALLBACK_RELAY: &str = "wss://nostr.oxtr.dev";

/// The transport relay list shared by both peers.
pub const DEFAULT_RELAYS: [&str; 3] = [PRIMARY_RELAY, PAIRING_RELAY, FALLBACK_RELAY];
