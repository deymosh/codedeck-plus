//! The phone's two keys and what each is for.
//!
//! * The **identity** is the phone's Nostr identity — the key a bridge pairs
//!   with, and the ONLY key that signs: every command, grant, relay NIP-42
//!   AUTH and Blossom upload auth, so relays and image servers with an
//!   allowlist only ever see this one pubkey. It may live outside this
//!   process (a NIP-55 signer app), so it is reached through the
//!   [`IdentitySigner`] port.
//! * The **session key** is a local keypair (see
//!   `client_core::stores::session_key`) the identity grants to each bridge,
//!   replaced by a fresh one a month before it lapses. It never signs; it
//!   only keys the NIP-44 payloads between the phone and a bridge that
//!   confirmed the grant, so the signer is not asked to encrypt and decrypt
//!   every message.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use client_core::bridge_api::{command_event, command_plaintext, EgressError};
use client_core::stores::session_key::{SessionGrant, SessionKey};
use nostr::{Event, EventBuilder, JsonUtil, PublicKey, RelayUrl, Timestamp, UnsignedEvent};
use nostr_transport::AuthSigner;
use protocol::commands::{PhoneToBridge, SessionKeyGrant};
use protocol::crypto::{decrypt_from, encrypt_to, CryptoError, Keypair};
use protocol::nostr_event::SignedEvent;

use crate::ports::LocalBoxFuture;

/// Why the identity's signer did not do what was asked: it refused, or it
/// could not be reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerError(pub String);

impl std::fmt::Display for SignerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The phone identity's key, wherever it lives. Every call may take a while
/// (another app, perhaps a prompt to the user) and may fail.
pub trait IdentitySigner {
    /// The identity's public key, lowercase hex. Known up front, never a
    /// round trip to the signer.
    fn pubkey_hex(&self) -> String;
    /// Sign `event`, whose `pubkey` is this identity and whose id is set.
    /// [`sign`] checks what comes back.
    fn sign_event(&self, event: UnsignedEvent) -> LocalBoxFuture<'_, Result<Event, SignerError>>;
    /// NIP-44 encrypt `plaintext` from the identity to `peer_pubkey_hex`.
    fn nip44_encrypt(&self, peer_pubkey_hex: &str, plaintext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>>;
    /// NIP-44 decrypt `ciphertext` that `peer_pubkey_hex` sent the identity.
    fn nip44_decrypt(&self, peer_pubkey_hex: &str, ciphertext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>>;
}

/// An identity whose secret key is in this process.
pub struct LocalSigner(pub Keypair);

impl IdentitySigner for LocalSigner {
    fn pubkey_hex(&self) -> String {
        self.0.pubkey_hex.clone()
    }

    fn sign_event(&self, event: UnsignedEvent) -> LocalBoxFuture<'_, Result<Event, SignerError>> {
        let signed = event
            .sign_with_keys(&nostr::Keys::new(self.0.secret_key.clone()))
            .map_err(|e| SignerError(e.to_string()));
        Box::pin(async move { signed })
    }

    fn nip44_encrypt(&self, peer_pubkey_hex: &str, plaintext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
        let out = encrypt_to(&self.0.secret_key, peer_pubkey_hex, plaintext).map_err(|e| SignerError(e.to_string()));
        Box::pin(async move { out })
    }

    fn nip44_decrypt(&self, peer_pubkey_hex: &str, ciphertext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
        let out = decrypt_from(&self.0.secret_key, peer_pubkey_hex, ciphertext).map_err(|e| SignerError(e.to_string()));
        Box::pin(async move { out })
    }
}

/// The public halves of the phone's keys — what the wire needs to name them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneKeys {
    pub identity_pubkey_hex: String,
    pub identity_npub: String,
    /// The current session key: the one granted.
    pub session_pubkey_hex: String,
    /// When it, and every grant of it, lapses (seconds).
    pub session_expires_at: u64,
}

impl PhoneKeys {
    pub fn new(identity_pubkey_hex: &str, session: &SessionKey) -> Self {
        Self {
            identity_pubkey_hex: identity_pubkey_hex.to_string(),
            identity_npub: protocol::crypto::npub_from_hex(identity_pubkey_hex).unwrap_or_default(),
            session_pubkey_hex: session.pubkey_hex().to_string(),
            session_expires_at: session.expires_at,
        }
    }

    /// A grant of the current session key to `bridge`, for the wire.
    pub fn grant_for(&self, bridge: &str) -> SessionKeyGrant {
        SessionKeyGrant {
            pubkey_hex: self.session_pubkey_hex.clone(),
            bridge_pubkey_hex: bridge.to_string(),
            expires_at: self.session_expires_at,
        }
    }

    /// The record of a grant of the current session key sent at `now_ms`.
    pub fn grant_sent(&self, now_ms: u64) -> SessionGrant {
        SessionGrant {
            pubkey_hex: self.session_pubkey_hex.clone(),
            expires_at: self.session_expires_at,
            sent_at: now_ms / 1000,
        }
    }
}

/// Have the identity sign `event` (its `pubkey` must be the identity's). A
/// signer's answer is only taken if it is a valid signature over exactly
/// this event by this identity.
pub async fn sign(signer: &dyn IdentitySigner, mut event: UnsignedEvent) -> Result<Event, SignerError> {
    let id = event.id();
    let pubkey = event.pubkey;
    let signed = signer.sign_event(event).await?;
    if signed.id != id || signed.pubkey != pubkey || signed.verify().is_err() {
        return Err(SignerError("the signer returned a different or invalid event".into()));
    }
    Ok(signed)
}

/// What a command's payload is encrypted with.
#[derive(Clone)]
pub enum Cipher {
    /// The session key: the bridge confirmed it holds it.
    SessionKey(Keypair),
    /// The identity, through its signer.
    Identity,
}

/// One command event for `machine`, signed by the identity, its payload
/// encrypted with `cipher`. The caller re-publishes it verbatim on retry.
pub async fn build_command(
    signer: &dyn IdentitySigner,
    cipher: &Cipher,
    machine: &str,
    msg: &PhoneToBridge,
    now_ms: u64,
) -> Result<SignedEvent, EgressError> {
    let plaintext = command_plaintext(msg)?;
    PublicKey::from_hex(machine).map_err(|_| CryptoError::InvalidKey)?;
    let content = match cipher {
        Cipher::SessionKey(key) => encrypt_to(&key.secret_key, machine, &plaintext)?,
        Cipher::Identity => signer
            .nip44_encrypt(machine, &plaintext)
            .await
            .map_err(|e| EgressError::Sign(e.0))?,
    };
    let event = command_event(&signer.pubkey_hex(), machine, msg, content, now_ms)?;
    let signed = sign(signer, event).await.map_err(|e| EgressError::Sign(e.0))?;
    Ok(SignedEvent::from_nostr(&signed))
}

/// Relay NIP-42 AUTH answered by the identity.
pub struct IdentityAuth(pub Rc<dyn IdentitySigner>);

impl AuthSigner for IdentityAuth {
    fn sign_auth(
        &self,
        relay: &str,
        challenge: &str,
        now_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<SignedEvent, String>> + '_>> {
        let unsigned = PublicKey::from_hex(&self.0.pubkey_hex())
            .map_err(|e| e.to_string())
            .and_then(|pk| {
                let relay = RelayUrl::parse(relay).map_err(|e| format!("bad relay url {relay:?}: {e}"))?;
                Ok(EventBuilder::auth(challenge, relay)
                    .custom_created_at(Timestamp::from(now_ms / 1000))
                    .build(pk))
            });
        Box::pin(async move {
            let signed = sign(self.0.as_ref(), unsigned?).await.map_err(|e| e.0)?;
            Ok(SignedEvent::from_nostr(&signed))
        })
    }
}

/// An unsigned event as the JSON a signer app takes (NIP-55 `SIGN_EVENT`):
/// the canonical event object with its `id` and without a `sig`.
pub fn unsigned_event_json(event: &UnsignedEvent) -> String {
    event.as_json()
}

/// Parse the signed event JSON a signer app returned.
pub fn signed_event_from_json(json: &str) -> Result<Event, SignerError> {
    Event::from_json(json).map_err(|e| SignerError(format!("the signer returned no event: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::commands::BareMsg;
    use protocol::crypto::generate_keypair;

    fn refresh() -> PhoneToBridge {
        PhoneToBridge::RefreshSessions(BareMsg {})
    }

    #[tokio::test]
    async fn a_command_is_signed_by_the_identity_whichever_key_encrypts_it() {
        let (id, session, machine) = (generate_keypair(), generate_keypair(), generate_keypair());
        let signer = LocalSigner(id.clone());
        for (cipher, key) in [(Cipher::Identity, &id), (Cipher::SessionKey(session.clone()), &session)] {
            let ev = build_command(&signer, &cipher, &machine.pubkey_hex, &refresh(), 5_000).await.unwrap();
            assert_eq!(ev.pubkey, id.pubkey_hex);
            assert_eq!(ev.created_at, 5);
            assert!(ev.tags.iter().any(|t| t[0] == "p" && t[1] == machine.pubkey_hex));
            let plaintext = decrypt_from(&machine.secret_key, &key.pubkey_hex, &ev.content).unwrap();
            assert_eq!(plaintext, command_plaintext(&refresh()).unwrap());
        }
    }

    /// A signer that signs whatever it likes with a key of its own.
    struct Impostor(Keypair);
    impl IdentitySigner for Impostor {
        fn pubkey_hex(&self) -> String {
            // Claims to be someone else.
            generate_keypair().pubkey_hex
        }
        fn sign_event(&self, event: UnsignedEvent) -> LocalBoxFuture<'_, Result<Event, SignerError>> {
            let mut other = event;
            other.pubkey = nostr::Keys::new(self.0.secret_key.clone()).public_key();
            other.id = None;
            let signed = other.sign_with_keys(&nostr::Keys::new(self.0.secret_key.clone())).unwrap();
            Box::pin(async move { Ok(signed) })
        }
        fn nip44_encrypt(&self, peer: &str, plaintext: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
            let out = encrypt_to(&self.0.secret_key, peer, plaintext).unwrap();
            Box::pin(async move { Ok(out) })
        }
        fn nip44_decrypt(&self, _peer: &str, _ct: &str) -> LocalBoxFuture<'_, Result<String, SignerError>> {
            Box::pin(async { Err(SignerError("no".into())) })
        }
    }

    #[tokio::test]
    async fn a_signature_over_anything_else_is_refused() {
        let machine = generate_keypair();
        let err = build_command(&Impostor(generate_keypair()), &Cipher::Identity, &machine.pubkey_hex, &refresh(), 5_000)
            .await
            .unwrap_err();
        assert!(matches!(err, EgressError::Sign(_)), "{err:?}");
    }

    #[tokio::test]
    async fn relay_auth_is_signed_by_the_identity() {
        let id = generate_keypair();
        let auth = IdentityAuth(Rc::new(LocalSigner(id.clone())));
        let ev = auth.sign_auth("wss://relay.example", "chal", 1_000).await.unwrap();
        assert_eq!((ev.kind, ev.pubkey.as_str()), (22242, id.pubkey_hex.as_str()));
        assert!(ev.tags.iter().any(|t| t[0] == "challenge" && t[1] == "chal"));
    }

    #[test]
    fn signed_event_json_round_trips() {
        let k = generate_keypair();
        let mut ev = nostr::EventBuilder::text_note("hi").build(nostr::Keys::new(k.secret_key.clone()).public_key());
        ev.ensure_id();
        assert!(unsigned_event_json(&ev).contains("\"id\""));
        let signed = ev.sign_with_keys(&nostr::Keys::new(k.secret_key.clone())).unwrap();
        assert_eq!(signed_event_from_json(&signed.as_json()).unwrap(), signed);
        assert!(signed_event_from_json("{}").is_err());
    }
}
