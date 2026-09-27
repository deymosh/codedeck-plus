//! The phone identity's signer across the FFI.
//!
//! [`UniffiIdentitySigner`] is what the core asks to sign every event and to
//! encrypt / decrypt payloads for bridges holding no session key. Kotlin
//! implements it for a NIP-55 signer app; [`local_identity_signer`] gives a
//! Rust-backed one for a key the app holds itself.
//!
//! Every call is blocking from Rust's point of view and runs on a worker
//! thread ([`SignerAdapter`] hops to `spawn_blocking` first): an
//! implementation may take as long as it needs, e.g. waiting for the user to
//! approve a request in the signer app, and must not touch main-thread
//! state.

use std::sync::Arc;

use client_runtime::ports::LocalBoxFuture;
use client_runtime::signer::{signed_event_from_json, unsigned_event_json, IdentitySigner, SignerError};
use client_runtime::SessionKeyStore;
use client_runtime::nostr;
use protocol::crypto::{decrypt_from, encrypt_to, keypair_from_secret_hex, Keypair};

use crate::CoreInitError;

/// Why the signer did not answer: it refused, or it could not be reached.
/// The field is `detail`, not `message`: see `UniffiHttpError`.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UniffiSignerError {
    #[error("{detail}")]
    Failed { detail: String },
}

/// The phone's identity key, wherever it lives.
#[uniffi::export(with_foreign)]
pub trait UniffiIdentitySigner: Send + Sync {
    /// The identity's public key, lowercase hex. Called once, up front: the
    /// implementation knows it without asking the signer again.
    fn pubkey_hex(&self) -> String;
    /// Sign the unsigned event JSON (the canonical event object with `id`
    /// and `pubkey`, no `sig`); return the signed event JSON. The core
    /// checks the answer is a valid signature over exactly that event.
    fn sign_event(&self, unsigned_event_json: String) -> Result<String, UniffiSignerError>;
    fn nip44_encrypt(&self, peer_pubkey_hex: String, plaintext: String) -> Result<String, UniffiSignerError>;
    fn nip44_decrypt(&self, peer_pubkey_hex: String, ciphertext: String) -> Result<String, UniffiSignerError>;
}

/// A signer for an identity whose secret the app holds itself (unwrapped
/// from the platform keystore by the caller).
#[uniffi::export]
pub fn local_identity_signer(secret_hex: String) -> Result<Arc<dyn UniffiIdentitySigner>, CoreInitError> {
    let keypair = keypair_from_secret_hex(&secret_hex).map_err(|e| CoreInitError::BadIdentity { detail: e.to_string() })?;
    Ok(Arc::new(LocalIdentity(keypair)))
}

/// The hex secret key in `input`: an `nsec1…`, or 64 hex characters.
/// `None` when it is neither — for validating an imported key.
#[uniffi::export]
pub fn secret_hex_of(input: String) -> Option<String> {
    let input = input.trim();
    let key = if input.starts_with("nsec1") {
        <nostr::SecretKey as nostr::nips::nip19::FromBech32>::from_bech32(input).ok()?
    } else {
        nostr::SecretKey::from_hex(input).ok()?
    };
    Some(key.to_secret_hex())
}

/// The hex public key in `input`: an `npub1…`, or 64 hex characters (what
/// a signer app may answer `get_public_key` with). `None` when it is
/// neither.
#[uniffi::export]
pub fn pubkey_hex_of(input: String) -> Option<String> {
    let input = input.trim();
    let key = if input.starts_with("npub1") {
        <nostr::PublicKey as nostr::nips::nip19::FromBech32>::from_bech32(input).ok()?
    } else {
        nostr::PublicKey::from_hex(input).ok()?
    };
    Some(key.to_hex())
}

/// The `npub1…` form of a hex public key, for display.
#[uniffi::export]
pub fn npub_of(pubkey_hex: String) -> Option<String> {
    protocol::crypto::npub_from_hex(&pubkey_hex).ok()
}

struct LocalIdentity(Keypair);

impl UniffiIdentitySigner for LocalIdentity {
    fn pubkey_hex(&self) -> String {
        self.0.pubkey_hex.clone()
    }

    fn sign_event(&self, unsigned_event_json: String) -> Result<String, UniffiSignerError> {
        let failed = |detail: String| UniffiSignerError::Failed { detail };
        let event = <nostr::UnsignedEvent as nostr::JsonUtil>::from_json(&unsigned_event_json).map_err(|e| failed(e.to_string()))?;
        let signed = event
            .sign_with_keys(&nostr::Keys::new(self.0.secret_key.clone()))
            .map_err(|e| failed(e.to_string()))?;
        Ok(nostr::JsonUtil::as_json(&signed))
    }

    fn nip44_encrypt(&self, peer_pubkey_hex: String, plaintext: String) -> Result<String, UniffiSignerError> {
        encrypt_to(&self.0.secret_key, &peer_pubkey_hex, &plaintext)
            .map_err(|e| UniffiSignerError::Failed { detail: e.to_string() })
    }

    fn nip44_decrypt(&self, peer_pubkey_hex: String, ciphertext: String) -> Result<String, UniffiSignerError> {
        decrypt_from(&self.0.secret_key, &peer_pubkey_hex, &ciphertext)
            .map_err(|e| UniffiSignerError::Failed { detail: e.to_string() })
    }
}

/// The runtime's [`IdentitySigner`] over a foreign one. The public key is
/// read once, at construction.
pub(crate) struct SignerAdapter {
    inner: Arc<dyn UniffiIdentitySigner>,
    pubkey_hex: String,
}

impl SignerAdapter {
    pub(crate) fn new(inner: Arc<dyn UniffiIdentitySigner>, pubkey_hex: String) -> Self {
        Self { inner, pubkey_hex }
    }

    fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn UniffiIdentitySigner) -> Result<T, UniffiSignerError> + Send + 'static,
    ) -> LocalBoxFuture<'_, Result<T, SignerError>> {
        let inner = Arc::clone(&self.inner);
        let join = tokio::task::spawn_blocking(move || f(inner.as_ref()));
        Box::pin(async move {
            match join.await {
                Ok(Ok(v)) => Ok(v),
                Ok(Err(UniffiSignerError::Failed { detail })) => Err(SignerError(detail)),
                Err(join) => Err(SignerError(format!("signer callback failed: {join}"))),
            }
        })
    }
}

impl IdentitySigner for SignerAdapter {
    fn pubkey_hex(&self) -> String {
        self.pubkey_hex.clone()
    }

    fn sign_event(&self, event: nostr::UnsignedEvent) -> LocalBoxFuture<'_, Result<nostr::Event, SignerError>> {
        let json = unsigned_event_json(&event);
        let call = self.call(move |s| s.sign_event(json));
        Box::pin(async move { signed_event_from_json(&call.await?) })
    }

    fn nip44_encrypt(&self, peer_pubkey_hex: &str, plaintext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
        let (peer, plaintext) = (peer_pubkey_hex.to_string(), plaintext.to_string());
        self.call(move |s| s.nip44_encrypt(peer, plaintext))
    }

    fn nip44_decrypt(&self, peer_pubkey_hex: &str, ciphertext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
        let (peer, ciphertext) = (peer_pubkey_hex.to_string(), ciphertext.to_string());
        self.call(move |s| s.nip44_decrypt(peer, ciphertext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use client_runtime::signer::{build_command, Cipher};
    use protocol::commands::{BareMsg, PhoneToBridge};
    use protocol::crypto::generate_keypair;

    #[test]
    fn keys_parse_from_bech32_or_hex() {
        let k = generate_keypair();
        let nsec = nostr::nips::nip19::ToBech32::to_bech32(&k.secret_key).unwrap();
        assert_eq!(secret_hex_of(nsec), Some(k.secret_hex()));
        assert_eq!(secret_hex_of(format!(" {} ", k.secret_hex())), Some(k.secret_hex()));
        assert_eq!(secret_hex_of("nsec1nope".into()), None);
        assert_eq!(pubkey_hex_of(k.npub.clone()), Some(k.pubkey_hex.clone()));
        assert_eq!(pubkey_hex_of(k.pubkey_hex.clone()), Some(k.pubkey_hex.clone()));
        assert_eq!(pubkey_hex_of("zz".into()), None);
        assert_eq!(npub_of(k.pubkey_hex.clone()), Some(k.npub));
    }

    #[tokio::test]
    async fn a_command_signs_through_the_foreign_trait_shape() {
        let id = generate_keypair();
        let machine = generate_keypair();
        let foreign = local_identity_signer(id.secret_hex()).unwrap();
        let adapter = SignerAdapter::new(foreign, id.pubkey_hex.clone());
        let msg = PhoneToBridge::RefreshSessions(BareMsg { version: Default::default() });
        let ev = build_command(&adapter, &Cipher::Identity, &machine.pubkey_hex, &msg, 1_000).await.unwrap();
        assert_eq!(ev.pubkey, id.pubkey_hex);
        assert!(decrypt_from(&machine.secret_key, &id.pubkey_hex, &ev.content).is_ok());
    }
}

/// Where the app keeps the phone's session keys: an opaque blob that holds
/// their secrets, so the app stores it encrypted under the platform
/// keystore and never logs it. Called on the core's own thread: keep it
/// quick.
#[uniffi::export(with_foreign)]
pub trait UniffiSessionKeyStore: Send + Sync {
    /// The blob last saved, or `None` (nothing saved, or unreadable: the
    /// core then makes fresh keys).
    fn load(&self) -> Option<String>;
    fn save(&self, ring: String);
}

pub struct SessionKeyStoreAdapter(pub Arc<dyn UniffiSessionKeyStore>);

impl SessionKeyStore for SessionKeyStoreAdapter {
    fn load(&self) -> LocalBoxFuture<'_, Option<String>> {
        let ring = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.0.load())).unwrap_or_else(|_| {
            log::error!("foreign callback session-key load failed; starting with fresh keys");
            None
        });
        Box::pin(async move { ring })
    }

    fn save(&self, ring: &str) -> LocalBoxFuture<'_, ()> {
        crate::observer::foreign_call("session-key save", || self.0.save(ring.to_string()));
        Box::pin(async {})
    }
}
