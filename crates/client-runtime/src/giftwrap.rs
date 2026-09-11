//! NIP-59 gift-wrap for the NIP-17 DM path. `client-core` stays crypto-pure for
//! the codec; the wrap uses the `nostr` crate's `nip59` builder (async only
//! because its signer trait is — no I/O, every `.await` resolves inline on a
//! local `Keys`), and the unwrap is a hand-rolled NIP-44 double-decrypt so it
//! runs off the transport's `NostrEvent` (`pubkey` + `content`), sync.
//!
//! Send: build the kind-14 rumor ONCE (its id is the stable message id across
//! every copy), then wrap it for the recipient AND for ourselves (the self-copy
//! is what makes our own sends survive a reinstall via relay catch-up).

use protocol::crypto::{decrypt_from, Keypair};
use protocol::nostr_event::SignedEvent;
use client_core::stores::dm::{DmRumor, DM_RUMOR_KIND};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag, UnsignedEvent};

#[derive(Debug)]
pub enum GiftwrapError {
    /// A pubkey / key was malformed.
    BadKey,
    /// The gift wrap could not be unwrapped for this identity.
    Unwrap(String),
    /// The nostr crate failed to build / sign an event.
    Build(String),
}

impl std::fmt::Display for GiftwrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GiftwrapError::BadKey => write!(f, "bad key"),
            GiftwrapError::Unwrap(m) => write!(f, "gift-wrap unwrap failed: {m}"),
            GiftwrapError::Build(m) => write!(f, "gift-wrap build failed: {m}"),
        }
    }
}
impl std::error::Error for GiftwrapError {}

/// The two gift wraps to publish for one outgoing DM, plus the shared rumor id.
#[derive(Debug, Clone)]
pub struct WrappedDm {
    /// The kind-14 rumor id — the message id both ends dedup on.
    pub rumor_id: String,
    /// Rumor `created_at`, unix seconds.
    pub created_at: u64,
    /// Wrap addressed to the peer.
    pub for_recipient: SignedEvent,
    /// Wrap addressed to ourselves (restart-survival copy).
    pub for_self: SignedEvent,
}

fn keys_of(identity: &Keypair) -> Keys {
    Keys::new(identity.secret_key.clone())
}

/// A replaceable relay-list event (NIP-17 kind-10050 / MIP-00 kind-10051): one
/// `relay` tag per URL, identity-signed, empty content.
pub fn relay_list_event(
    identity: &Keypair,
    kind: u16,
    relays: &[String],
    created_at_secs: u64,
) -> Result<SignedEvent, GiftwrapError> {
    let me = keys_of(identity);
    let tags: Vec<Tag> = relays
        .iter()
        .map(|url| Tag::parse(["relay".to_string(), url.clone()]))
        .collect::<Result<_, _>>()
        .map_err(|e| GiftwrapError::Build(e.to_string()))?;
    let event = EventBuilder::new(Kind::Custom(kind), "")
        .tags(tags)
        .custom_created_at(nostr::Timestamp::from_secs(created_at_secs))
        .sign_with_keys(&me)
        .map_err(|e| GiftwrapError::Build(e.to_string()))?;
    Ok(SignedEvent::from_nostr(&event))
}

/// Build the rumor once and wrap it for the peer and for ourselves.
pub async fn wrap_dm(
    identity: &Keypair,
    peer_pubkey_hex: &str,
    content: &str,
) -> Result<WrappedDm, GiftwrapError> {
    let me = keys_of(identity);
    let peer = PublicKey::from_hex(peer_pubkey_hex).map_err(|_| GiftwrapError::BadKey)?;

    // The rumor: an unsigned kind-14 event with a `p` tag to the peer. Its id is
    // deterministic and shared by every copy.
    let rumor: UnsignedEvent = EventBuilder::new(Kind::Custom(DM_RUMOR_KIND as u16), content)
        .tags([Tag::public_key(peer)])
        .build(me.public_key());
    let rumor_id = rumor.id.ok_or_else(|| GiftwrapError::Build("rumor has no id".into()))?;
    let created_at = rumor.created_at.as_secs();

    let for_recipient = EventBuilder::gift_wrap(&me, &peer, rumor.clone(), [])
        .await
        .map_err(|e| GiftwrapError::Build(e.to_string()))?;
    let for_self = EventBuilder::gift_wrap(&me, &me.public_key(), rumor, [])
        .await
        .map_err(|e| GiftwrapError::Build(e.to_string()))?;

    Ok(WrappedDm {
        rumor_id: rumor_id.to_hex(),
        created_at,
        for_recipient: SignedEvent::from_nostr(&for_recipient),
        for_self: SignedEvent::from_nostr(&for_self),
    })
}

/// Unwrap a kind-1059 gift wrap from its `(pubkey, content)` — the two fields
/// the transport's `NostrEvent` carries. Sync: NIP-44 decrypt twice (wrap →
/// seal → rumor), verify the seal's signature, check the rumor author matches
/// the seal. On success returns the inner rumor (ANY kind — the caller decides
/// DM vs the Marmot-welcome route).
pub fn unwrap_gift_parts(
    identity: &Keypair,
    wrap_pubkey_hex: &str,
    wrap_content: &str,
) -> Result<DmRumor, GiftwrapError> {
    let sk = &identity.secret_key;

    let seal_json = decrypt_from(sk, wrap_pubkey_hex, wrap_content)
        .map_err(|e| GiftwrapError::Unwrap(e.to_string()))?;
    let seal: Event = Event::from_json(&seal_json)
        .map_err(|e| GiftwrapError::Unwrap(format!("seal parse: {e}")))?;
    seal.verify()
        .map_err(|e| GiftwrapError::Unwrap(format!("seal verify: {e}")))?;

    let rumor_json = decrypt_from(sk, &seal.pubkey.to_hex(), &seal.content)
        .map_err(|e| GiftwrapError::Unwrap(e.to_string()))?;
    let rumor: UnsignedEvent = UnsignedEvent::from_json(&rumor_json)
        .map_err(|e| GiftwrapError::Unwrap(format!("rumor parse: {e}")))?;
    if rumor.pubkey != seal.pubkey {
        return Err(GiftwrapError::Unwrap("rumor author != seal author".into()));
    }

    Ok(DmRumor {
        id: rumor
            .id
            .map(|id| id.to_hex())
            .ok_or_else(|| GiftwrapError::Unwrap("rumor has no id".into()))?,
        pubkey: rumor.pubkey.to_hex(),
        kind: i64::from(rumor.kind.as_u16()),
        content: rumor.content.clone(),
        created_at: rumor.created_at.as_secs(),
        tags: rumor.tags.iter().map(|t| t.as_slice().to_vec()).collect(),
    })
}

/// Unwrap from a full relay event JSON (test / non-transport callers).
pub fn unwrap_gift(identity: &Keypair, raw: &str) -> Result<DmRumor, GiftwrapError> {
    let event = Event::from_json(raw).map_err(|e| GiftwrapError::Unwrap(e.to_string()))?;
    if event.kind != Kind::GiftWrap {
        return Err(GiftwrapError::Unwrap("not a kind-1059 gift wrap".into()));
    }
    unwrap_gift_parts(identity, &event.pubkey.to_hex(), &event.content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::generate_keypair;

    #[tokio::test]
    async fn a_dm_round_trips_peer_to_peer_and_the_self_copy_shares_the_rumor_id() {
        let a = generate_keypair();
        let b = generate_keypair();

        let w = wrap_dm(&a, &b.pubkey_hex, "hi over nostr").await.unwrap();
        assert_eq!(w.for_recipient.kind, 1059);
        assert_eq!(w.for_self.kind, 1059);
        // ephemeral wrap keys — neither wrap is signed by our identity
        assert_ne!(w.for_recipient.pubkey, a.pubkey_hex);
        assert_ne!(w.for_self.pubkey, a.pubkey_hex);

        // B unwraps the recipient copy
        let recipient_json = serde_json::to_string(&w.for_recipient).unwrap();
        let seen_by_b = unwrap_gift(&b, &recipient_json).unwrap();
        assert_eq!(seen_by_b.id, w.rumor_id);
        assert_eq!(seen_by_b.kind, 14);
        assert_eq!(seen_by_b.content, "hi over nostr");
        assert_eq!(seen_by_b.pubkey, a.pubkey_hex);
        assert!(seen_by_b
            .tags
            .iter()
            .any(|t| t.first().map(String::as_str) == Some("p") && t.get(1) == Some(&b.pubkey_hex)));

        // A unwraps its own self-copy — same rumor id
        let self_json = serde_json::to_string(&w.for_self).unwrap();
        let seen_by_a = unwrap_gift(&a, &self_json).unwrap();
        assert_eq!(seen_by_a.id, w.rumor_id);
        assert_eq!(seen_by_a.pubkey, a.pubkey_hex);
    }

    #[tokio::test]
    async fn a_wrap_for_someone_else_fails_to_unwrap() {
        let a = generate_keypair();
        let b = generate_keypair();
        let c = generate_keypair();
        let w = wrap_dm(&a, &b.pubkey_hex, "not for C").await.unwrap();
        let json = serde_json::to_string(&w.for_recipient).unwrap();
        assert!(unwrap_gift(&c, &json).is_err());
    }

    #[tokio::test]
    async fn garbage_is_an_error_not_a_panic() {
        let a = generate_keypair();
        assert!(unwrap_gift(&a, "not json").is_err());
        assert!(unwrap_gift(&a, r#"{"kind":1,"content":"x"}"#).is_err());
    }
}
