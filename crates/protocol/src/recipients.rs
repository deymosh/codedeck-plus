//! Which client a bridge's event is for.
//!
//! An identity may run several clients (a phone, a desktop), each holding its
//! own session key. A bridge encrypts each message once per client, to that
//! client's newest key (to the identity itself when it has granted none),
//! and tags the event with that copy's recipient tag ([`RECIPIENT_TAG`]):
//!
//! - a client subscribes with its own tags (`#c`), so a relay hands it its
//!   own copies only, and it never tries to decrypt another client's;
//! - the session-list heartbeat is addressable by its recipient tag (`d`),
//!   so each client's latest heartbeat stays on the relay instead of
//!   replacing another client's; a heartbeat split into fragments gives
//!   each fragment its own `d` ([`fragment_d`]).
//!
//! A tag is a hash of the bridge and the recipient key, so it is the same on
//! both ends, and tags for different bridges, or for a client's key before
//! and after it rotates, cannot be told to belong together. What a relay
//! does learn is what copies inherently show: how many clients of an
//! identity a bridge is serving, and while each heartbeat is renewed, when
//! each is listening.

use nostr::hashes::{sha256, Hash};

/// The event tag naming a copy's recipient.
pub const RECIPIENT_TAG: &str = "c";

/// The recipient tag of a copy `bridge_pubkey_hex` encrypts to `key_hex` (a
/// client's session key, or the identity): 32 lowercase hex characters.
pub fn recipient_tag(bridge_pubkey_hex: &str, key_hex: &str) -> String {
    digest(&["codedeck/recipient", &bridge_pubkey_hex.to_ascii_lowercase(), &key_hex.to_ascii_lowercase()])
}

/// The `d` of fragment `index` of a heartbeat for `recipient_tag`. Fragment
/// `i` of the next heartbeat replaces fragment `i` of this one; fragments a
/// shorter heartbeat leaves behind lapse with the heartbeat's expiry.
pub fn fragment_d(recipient_tag: &str, index: usize) -> String {
    digest(&["codedeck/fragment", recipient_tag, &index.to_string()])
}

/// The id of the device a client is: the first 16 bytes, in hex, of
/// `sha256("codedeck/device\0" + first_session_key_hex + "\0")`, where the
/// key is the FIRST session key this client ever granted the bridge — the
/// one its later [`SessionKeyGrant::replaces`](crate::commands::SessionKeyGrant::replaces)
/// chains back to. The bridge derives it once per client and names it in a
/// terminal's `writer`, in every `terminal-event`, and in its audit and
/// allowlist, so a device keeps one identity while its key rotates; what a
/// signed grant calls itself (`label`) never takes part. Re-pairing, or
/// reinstalling with a fresh identity, makes a new device — the old chain of
/// keys is gone. Case-blind: both ends lowercase the key, as the recipient
/// tag does.
pub fn device_id(first_session_key_hex: &str) -> String {
    digest(&["codedeck/device", &first_session_key_hex.to_ascii_lowercase()])
}

/// The first 16 bytes of the SHA-256 of `parts`, each ended by a NUL (none
/// of them holds one), as hex.
fn digest(parts: &[&str]) -> String {
    let mut input = Vec::new();
    for part in parts {
        input.extend_from_slice(part.as_bytes());
        input.push(0);
    }
    hex::encode(&sha256::Hash::hash(&input).to_byte_array()[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRIDGE: &str = "aa11";
    const KEY: &str = "bb22";

    #[test]
    fn a_tag_is_the_same_on_both_ends_and_case_blind() {
        let tag = recipient_tag(BRIDGE, KEY);
        assert_eq!(tag.len(), 32);
        assert!(tag.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(recipient_tag("AA11", "BB22"), tag);
    }

    #[test]
    fn a_tag_differs_per_bridge_and_per_key() {
        let tag = recipient_tag(BRIDGE, KEY);
        assert_ne!(recipient_tag("aa12", KEY), tag);
        assert_ne!(recipient_tag(BRIDGE, "bb23"), tag);
        // The parts cannot run into each other.
        assert_ne!(recipient_tag("aa", "11bb22"), recipient_tag("aa11", "bb22"));
    }

    #[test]
    fn each_fragment_has_its_own_d() {
        let tag = recipient_tag(BRIDGE, KEY);
        let ds: Vec<String> = (0..3).map(|i| fragment_d(&tag, i)).collect();
        assert!(ds.iter().all(|d| d != &tag && d.len() == 32));
        assert_ne!(ds[0], ds[1]);
        assert_ne!(ds[1], ds[2]);
        assert_eq!(fragment_d(&tag, 1), ds[1]);
    }

    #[test]
    fn the_tags_are_pinned() {
        // Any other implementation must derive the same values:
        // sha256("codedeck/recipient\0aa11\0bb22\0")[..16] and
        // sha256("codedeck/fragment\0<tag>\02\0")[..16].
        let tag = recipient_tag(BRIDGE, KEY);
        assert_eq!(tag, "4a7ce9e7ef864a34441d699f45429335");
        assert_eq!(fragment_d(&tag, 2), "596da8b0093949098d6a58c85b4145cc");
    }

    #[test]
    fn a_device_id_is_pinned_and_case_blind() {
        // The pin: sha256("codedeck/device\0" + first key + "\0")[..16].
        const FIRST_KEY: &str = "d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef";
        assert_eq!(device_id(FIRST_KEY), "bf1f111943b3930a4c64a5c06d9153b2");
        assert_eq!(device_id("D0D1D2D3D4D5D6D7D8D9DADBDCDDDEDFE0E1E2E3E4E5E6E7E8E9EAEBECEDEEEF"), "bf1f111943b3930a4c64a5c06d9153b2");
        // A different first key is a different device.
        assert_ne!(device_id("aa11"), device_id(FIRST_KEY));
        // The parts cannot run into each other, as for the recipient tag.
        assert_ne!(device_id("aa"), device_id("aa00"));
    }
}
