//! NIP-42 relay AUTH — port of `packages/protocol/src/nip42.ts`.
//!
//! Both the bridge and the phone answer a relay's `["AUTH", challenge]` with a
//! kind-22242 event signed by their OWN identity keypair — the same pubkey
//! already used for pairing and publishing — so a private / Haven relay only
//! needs ONE allowlisted pubkey per side, with no separate auth-only credential.
//!
//! Where the TS signer takes a template nostr-tools has already built, the Rust
//! transport builds the event itself; this is that one call. A relay that never
//! challenges never triggers it.

use nostr::key::Keys;
use nostr::{EventBuilder, RelayUrl, Timestamp};

use crate::crypto::{CryptoError, Keypair};
use crate::nostr_event::SignedEvent;

/// Build + sign the kind-22242 AUTH event answering `challenge` from
/// `relay_url`. `now_ms` is injected wall-clock (ms); `created_at` is
/// `now_ms / 1000`.
pub fn build_auth_event(
    identity: &Keypair,
    relay_url: &str,
    challenge: &str,
    now_ms: u64,
) -> Result<SignedEvent, CryptoError> {
    let relay = RelayUrl::parse(relay_url)
        .map_err(|e| CryptoError::Nip44(format!("bad relay url {relay_url:?}: {e}")))?;
    let keys = Keys::new(identity.secret_key.clone());
    let event = EventBuilder::auth(challenge, relay)
        .custom_created_at(Timestamp::from(now_ms / 1000))
        .sign_with_keys(&keys)
        .map_err(|e| CryptoError::Nip44(e.to_string()))?;
    Ok(SignedEvent::from_nostr(&event))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::keypair_from_secret_hex;

    const SEC: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    fn tag<'a>(e: &'a SignedEvent, name: &str) -> Option<&'a str> {
        e.tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))
            .and_then(|t| t.get(1))
            .map(String::as_str)
    }

    #[test]
    fn auth_event_is_kind_22242_with_relay_and_challenge() {
        let id = keypair_from_secret_hex(SEC).unwrap();
        let e = build_auth_event(&id, "wss://haven.example", "chal-abc", 1_700_000_000_500).unwrap();
        assert_eq!(e.kind, 22242);
        assert_eq!(e.pubkey, id.pubkey_hex);
        assert_eq!(e.created_at, 1_700_000_000);
        assert_eq!(tag(&e, "challenge"), Some("chal-abc"));
        // nostr normalizes the relay URL (adds a trailing slash).
        assert!(tag(&e, "relay").unwrap().starts_with("wss://haven.example"));
        assert_eq!(e.content, "");
        assert_eq!(e.sig.len(), 128); // 64-byte schnorr sig, hex
    }

    #[test]
    fn a_different_challenge_is_a_different_event() {
        let id = keypair_from_secret_hex(SEC).unwrap();
        let a = build_auth_event(&id, "wss://r.example", "one", 1_000).unwrap();
        let b = build_auth_event(&id, "wss://r.example", "two", 1_000).unwrap();
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn a_bad_relay_url_is_an_error_not_a_panic() {
        let id = keypair_from_secret_hex(SEC).unwrap();
        assert!(build_auth_event(&id, "not a url", "c", 0).is_err());
    }
}
