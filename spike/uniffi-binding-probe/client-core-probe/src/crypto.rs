//! NIP-44 v2 helpers, a faithful shape-match of `apps/mobile/src/core/crypto.ts`
//! (`generateKeypair` / `keypairFromSecret` / `encryptTo` / `decryptFrom`).
//! Backed by the `nostr` crate's vetted implementation for this spike; the real
//! `client-core` decides hand-roll vs `nostr` in F1 (plan risk #13).

use nostr::key::{Keys, PublicKey, SecretKey};
use nostr::nips::nip44::{self, Version};
use serde::{Deserialize, Serialize};

// NOTE (spike finding): a fielded uniffi error variant must NOT name a field
// `message` — it collides with Kotlin's `Throwable.message` and the 0.28
// codegen does not emit `override`. Convention for the real client-core:
// error fields are `detail` / `reason` / domain-specific names, never `message`.
#[derive(Debug, thiserror::Error, uniffi::Error, Serialize)]
pub enum CryptoError {
    #[error("invalid key: {detail}")]
    BadKey { detail: String },
    #[error("nip44 failure: {detail}")]
    Nip44 { detail: String },
}

/// Hex-encoded keypair — the wire/storage form the phone core already uses.
#[derive(Debug, Clone, uniffi::Record, Serialize, Deserialize)]
pub struct Keypair {
    pub secret_hex: String,
    pub public_hex: String,
}

fn keypair_of(keys: &Keys) -> Keypair {
    Keypair {
        secret_hex: keys.secret_key().to_secret_hex(),
        public_hex: keys.public_key().to_hex(),
    }
}

#[uniffi::export]
pub fn generate_keypair() -> Keypair {
    keypair_of(&Keys::generate())
}

#[uniffi::export]
pub fn keypair_from_secret(secret_hex: String) -> Result<Keypair, CryptoError> {
    let sk = SecretKey::from_hex(&secret_hex).map_err(|e| CryptoError::BadKey { detail: e.to_string() })?;
    Ok(keypair_of(&Keys::new(sk)))
}

#[uniffi::export]
pub fn encrypt_to(
    sender_secret_hex: String,
    recipient_public_hex: String,
    plaintext: String,
) -> Result<String, CryptoError> {
    let sk = SecretKey::from_hex(&sender_secret_hex).map_err(|e| CryptoError::BadKey { detail: e.to_string() })?;
    let pk =
        PublicKey::from_hex(&recipient_public_hex).map_err(|e| CryptoError::BadKey { detail: e.to_string() })?;
    nip44::encrypt(&sk, &pk, plaintext, Version::V2).map_err(|e| CryptoError::Nip44 { detail: e.to_string() })
}

#[uniffi::export]
pub fn decrypt_from(
    recipient_secret_hex: String,
    sender_public_hex: String,
    ciphertext: String,
) -> Result<String, CryptoError> {
    let sk =
        SecretKey::from_hex(&recipient_secret_hex).map_err(|e| CryptoError::BadKey { detail: e.to_string() })?;
    let pk = PublicKey::from_hex(&sender_public_hex).map_err(|e| CryptoError::BadKey { detail: e.to_string() })?;
    nip44::decrypt(&sk, &pk, &ciphertext).map_err(|e| CryptoError::Nip44 { detail: e.to_string() })
}
