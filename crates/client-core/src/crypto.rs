//! NIP-44 v2 crypto + keypair — a faithful port of
//! `packages/core/src/nostr/crypto.ts` (mirrored, never imported, in
//! `apps/mobile/src/core/crypto.ts`). Every protocol payload crosses the relay
//! NIP-44-encrypted between the bridge keypair and one client keypair; the
//! relay only ever sees ciphertext.
//!
//! Backed by the `nostr` crate's vetted NIP-44 v2 implementation (F0
//! `uniffi-binding-probe` sized its dependency tree — tight with minimal
//! features). The `decrypt_from` path is total from the caller's side: it
//! returns `Err`, never panics, on garbage / tampered / not-for-us ciphertext,
//! and ingest code drops those.

use nostr::key::{Keys, PublicKey, SecretKey};
use nostr::nips::nip19::ToBech32;
use nostr::nips::nip44::{self, Version};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("invalid hex string")]
    InvalidHex,
    #[error("invalid key")]
    InvalidKey,
    #[error("nip44: {0}")]
    Nip44(String),
}

/// A bridge/client identity. Hosts persist `secret_hex()`; `pubkey_hex` is the
/// Nostr event author id; `npub` is for the manual-pairing fallback UI.
#[derive(Debug, Clone)]
pub struct Keypair {
    pub secret_key: SecretKey,
    pub pubkey_hex: String,
    pub npub: String,
}

impl Keypair {
    pub fn secret_hex(&self) -> String {
        self.secret_key.to_secret_hex()
    }
}

fn from_keys(keys: Keys) -> Keypair {
    let pk = keys.public_key();
    Keypair {
        secret_key: keys.secret_key().clone(),
        pubkey_hex: pk.to_hex(),
        npub: pk.to_bech32().expect("public key always bech32-encodes"),
    }
}

/// Fresh identity.
pub fn generate_keypair() -> Keypair {
    from_keys(Keys::generate())
}

/// Rehydrate from a stored 32-byte secret.
pub fn keypair_from_secret(secret_key: &[u8]) -> Result<Keypair, CryptoError> {
    let sk = SecretKey::from_slice(secret_key).map_err(|_| CryptoError::InvalidKey)?;
    Ok(from_keys(Keys::new(sk)))
}

/// Rehydrate from a stored hex secret (hosts persist the nsec as hex).
pub fn keypair_from_secret_hex(secret_hex: &str) -> Result<Keypair, CryptoError> {
    let sk = SecretKey::from_hex(secret_hex).map_err(|_| CryptoError::InvalidKey)?;
    Ok(from_keys(Keys::new(sk)))
}

/// npub for a hex pubkey (e.g. a paired peer's npub from the event author).
pub fn npub_from_hex(pubkey_hex: &str) -> Result<String, CryptoError> {
    PublicKey::from_hex(pubkey_hex)
        .map_err(|_| CryptoError::InvalidKey)?
        .to_bech32()
        .map_err(|_| CryptoError::InvalidKey)
}

/// hex pubkey for an `npub…` (pairing URL / manual-pair input). `Err` on a
/// non-`npub` bech32 (e.g. an `nsec`) or garbage — never a panic.
pub fn hex_from_npub(npub: &str) -> Result<String, CryptoError> {
    use nostr::nips::nip19::FromBech32;
    Ok(PublicKey::from_bech32(npub)
        .map_err(|_| CryptoError::InvalidKey)?
        .to_hex())
}

/// Hex → bytes, with the same strictness as the TS helper (even length, only
/// `0-9a-fA-F`).
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, CryptoError> {
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CryptoError::InvalidHex);
    }
    hex::decode(hex).map_err(|_| CryptoError::InvalidHex)
}

/// Bytes → lower-hex.
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// NIP-44 v2 encrypt `plaintext` from `secret_key`'s owner to `peer_pubkey_hex`.
pub fn encrypt_to(
    secret_key: &SecretKey,
    peer_pubkey_hex: &str,
    plaintext: &str,
) -> Result<String, CryptoError> {
    let pk = PublicKey::from_hex(peer_pubkey_hex).map_err(|_| CryptoError::InvalidKey)?;
    nip44::encrypt(secret_key, &pk, plaintext, Version::V2)
        .map_err(|e| CryptoError::Nip44(e.to_string()))
}

/// NIP-44 v2 decrypt a ciphertext sent by `peer_pubkey_hex` to `secret_key`'s
/// owner. `Err` (never panic) on garbage / tampered / not-for-us input.
pub fn decrypt_from(
    secret_key: &SecretKey,
    peer_pubkey_hex: &str,
    ciphertext: &str,
) -> Result<String, CryptoError> {
    let pk = PublicKey::from_hex(peer_pubkey_hex).map_err(|_| CryptoError::InvalidKey)?;
    nip44::decrypt(secret_key, &pk, ciphertext).map_err(|e| CryptoError::Nip44(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // NIP-44 spec test keys (nips/44.md vectors): sec = 0x…01 and 0x…02.
    const SEC1: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const SEC2: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    #[test]
    fn keypair_shapes() {
        let kp = generate_keypair();
        assert_eq!(kp.pubkey_hex.len(), 64);
        assert!(kp.npub.starts_with("npub1"));
        // round-trips through the stored hex secret
        let re = keypair_from_secret_hex(&kp.secret_hex()).unwrap();
        assert_eq!(re.pubkey_hex, kp.pubkey_hex);
        assert_eq!(re.npub, kp.npub);
    }

    #[test]
    fn npub_from_hex_matches_keypair() {
        let kp = generate_keypair();
        assert_eq!(npub_from_hex(&kp.pubkey_hex).unwrap(), kp.npub);
        assert_eq!(npub_from_hex("nothex"), Err(CryptoError::InvalidKey));
    }

    #[test]
    fn hex_from_npub_round_trips_and_rejects_non_npub() {
        let kp = generate_keypair();
        assert_eq!(hex_from_npub(&kp.npub).unwrap(), kp.pubkey_hex);
        assert_eq!(hex_from_npub("npub1garbage"), Err(CryptoError::InvalidKey));
        // an nsec is valid bech32 but not a public key
        assert_eq!(
            hex_from_npub("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"),
            Err(CryptoError::InvalidKey)
        );
    }

    #[test]
    fn hex_helpers_match_ts_strictness() {
        assert_eq!(hex_to_bytes("deadbeef").unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(bytes_to_hex(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
        assert_eq!(hex_to_bytes("abc"), Err(CryptoError::InvalidHex)); // odd length
        assert_eq!(hex_to_bytes("zz"), Err(CryptoError::InvalidHex)); // non-hex
        assert_eq!(hex_to_bytes(""), Ok(vec![]));
    }

    #[test]
    fn nip44_v2_cross_key_round_trip_with_spec_keys() {
        let a = keypair_from_secret_hex(SEC1).unwrap();
        let b = keypair_from_secret_hex(SEC2).unwrap();

        let ct = encrypt_to(&a.secret_key, &b.pubkey_hex, "a").unwrap();
        // shared conversation key => b decrypts what a sent, and vice versa
        assert_eq!(decrypt_from(&b.secret_key, &a.pubkey_hex, &ct).unwrap(), "a");

        let ct2 = encrypt_to(&b.secret_key, &a.pubkey_hex, "hola \u{2708} mundo").unwrap();
        assert_eq!(
            decrypt_from(&a.secret_key, &b.pubkey_hex, &ct2).unwrap(),
            "hola \u{2708} mundo"
        );
    }

    #[test]
    fn decrypt_is_total_on_garbage() {
        let a = generate_keypair();
        let b = generate_keypair();
        assert!(decrypt_from(&a.secret_key, &b.pubkey_hex, "not base64 !!!").is_err());
        assert!(decrypt_from(&a.secret_key, &b.pubkey_hex, "").is_err());
        // a valid payload for a DIFFERENT recipient must not decrypt for us
        let c = generate_keypair();
        let ct = encrypt_to(&b.secret_key, &c.pubkey_hex, "secret").unwrap();
        assert!(decrypt_from(&a.secret_key, &b.pubkey_hex, &ct).is_err());
    }
}
