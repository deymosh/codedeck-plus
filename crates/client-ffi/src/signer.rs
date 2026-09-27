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
