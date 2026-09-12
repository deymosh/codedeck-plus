//! Nostr event kinds for the CodeDeck protocol v10. Port of
//! `packages/protocol/src/kinds.ts`.
//!
//! Traffic is split by storage class so the client's stored-event subscription
//! stays low-frequency — this is what structurally fixes the old since-filter
//! starvation bug (high-frequency live output no longer advances the
//! stored-event cursor past the session-list heartbeat).

/// Session-list heartbeat. NIP-33 parameterized replaceable (`d` = machine
/// name). Subscribers always fetch current — never with a `since` filter.
pub const SESSION_LIST_KIND: u16 = 30515;

/// Phone → bridge commands. Stored, so a briefly-offline bridge still receives
/// them on resubscribe. NIP-40 expiry: [`COMMAND_EXPIRY_SECONDS`].
pub const COMMAND_KIND: u16 = 4515;

/// Bridge → phone stored responses: sync chunks, acks, pairing/control replies.
/// Stored so a briefly-offline phone still receives them. NIP-40 expiry:
/// [`RESPONSE_EXPIRY_SECONDS`].
pub const RESPONSE_KIND: u16 = 4516;

/// Bridge → phone live output/status/usage. Ephemeral (20000–29999): relays
/// broadcast but never store. Loss is acceptable by design — transcript sync
/// recovers anything missed.
pub const LIVE_KIND: u16 = 24515;

/// NIP-40 expiration applied to [`COMMAND_KIND`] events (seconds).
pub const COMMAND_EXPIRY_SECONDS: u64 = 60 * 60;

/// NIP-40 expiration applied to [`RESPONSE_KIND`] events (seconds).
pub const RESPONSE_EXPIRY_SECONDS: u64 = 60 * 60;

/// All kinds a CodeDeck relay must accept from registered agents.
pub const CODEDECK_KINDS: [u16; 4] =
    [SESSION_LIST_KIND, COMMAND_KIND, RESPONSE_KIND, LIVE_KIND];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_values_match_protocol_v10() {
        assert_eq!(SESSION_LIST_KIND, 30515);
        assert_eq!(COMMAND_KIND, 4515);
        assert_eq!(RESPONSE_KIND, 4516);
        assert_eq!(LIVE_KIND, 24515);
        assert_eq!(COMMAND_EXPIRY_SECONDS, 3600);
        assert_eq!(RESPONSE_EXPIRY_SECONDS, 3600);
        assert_eq!(CODEDECK_KINDS, [30515, 4515, 4516, 24515]);
    }

    #[test]
    fn live_kind_is_in_the_ephemeral_range() {
        assert!((20000..30000).contains(&LIVE_KIND));
    }

    #[test]
    fn session_list_kind_is_addressable_replaceable() {
        assert!((30000..40000).contains(&SESSION_LIST_KIND));
    }
}
