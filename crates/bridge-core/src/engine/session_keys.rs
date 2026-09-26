//! Session keys: a key a paired phone's identity lets act for it here.
//!
//! A phone whose identity key lives in an external signer grants the bridge a
//! local key once (`session-key`, or with its `pair-request`); from then on
//! it signs and encrypts every command with that key, and the bridge
//! encrypts to it. Everything past ingest still works in identities: an
//! event from a session key is handed on as its identity's, and a publish
//! addressed to an identity is re-addressed to the identity's current key
//! on its way out ([`Engine::address_publishes`]). An identity without a
//! live key is addressed directly, as before.
//!
//! Rules:
//! - only the identity itself grants (a session key cannot extend itself);
//! - a grant lapses at its `expiresAt`, at most
//!   [`SESSION_KEY_MAX_LIFETIME_SECS`] ahead;
//! - each identity keeps its [`KEY_RING`] newest keys, so commands the phone
//!   sent from the previous key while rotating are still heard;
//! - a key the bridge already knows for anyone (a paired identity, another
//!   phone's key, the bridge's own) is refused, so a grant cannot capture
//!   another phone's traffic.

use protocol::commands::{SessionKeyGrant, SESSION_KEY_MAX_LIFETIME_SECS};
use protocol::crypto::npub_from_hex;

use super::Engine;
use crate::io::{store_keys, Effect, PairedPhone};

/// Keys kept per identity.
pub const KEY_RING: usize = 2;

/// Clock skew allowed on a grant's `expiresAt`.
const SKEW_SECS: u64 = 300;

/// Who wrote a command event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    /// The paired identity the event counts as.
    pub identity: String,
    /// Written with a session key rather than the identity key.
    pub by_session_key: bool,
}

/// The paired identity `pubkey` is, or holds a live session key for.
pub fn resolve_author(paired: &[PairedPhone], pubkey: &str, now_secs: u64) -> Option<Author> {
    if let Some(p) = paired.iter().find(|p| p.pubkey_hex == pubkey) {
        return Some(Author { identity: p.pubkey_hex.clone(), by_session_key: false });
    }
    paired
        .iter()
        .find(|p| p.session_keys.iter().any(|k| k.pubkey_hex == pubkey && k.expires_at > now_secs))
        .map(|p| Author { identity: p.pubkey_hex.clone(), by_session_key: true })
}

/// Every live session key of every paired phone.
pub fn live_keys(paired: &[PairedPhone], now_secs: u64) -> impl Iterator<Item = &str> {
    paired
        .iter()
        .flat_map(|p| p.session_keys.iter())
        .filter(move |k| k.expires_at > now_secs)
        .map(|k| k.pubkey_hex.as_str())
}

impl Engine {
    fn now_secs(&self) -> u64 {
        self.now() / 1000
    }

    /// Accept `grant` for the paired `identity`. Returns whether it took.
    pub(super) fn grant_session_key(&mut self, identity: &str, grant: SessionKeyGrant) -> bool {
        let short = grant.pubkey_hex.get(..8).unwrap_or(&grant.pubkey_hex).to_string();
        let now = self.now_secs();
        let refusal = if npub_from_hex(&grant.pubkey_hex).is_err() {
            Some("not a valid public key")
        } else if grant.expires_at <= now {
            Some("already expired")
        } else if grant.expires_at > now + SESSION_KEY_MAX_LIFETIME_SECS + SKEW_SECS {
            Some("expires too far ahead")
        } else if grant.pubkey_hex == self.config.keys.pubkey_hex || self.key_taken(identity, &grant.pubkey_hex) {
            Some("key already in use")
        } else {
            None
        };
        if let Some(why) = refusal {
            log::warn!("[Engine] Refusing session key {short}...: {why}");
            return false;
        }
        let Some(phone) = self.paired.iter_mut().find(|p| p.pubkey_hex == identity) else { return false };
        phone.session_keys.retain(|k| k.pubkey_hex != grant.pubkey_hex && k.expires_at > now);
        phone.session_keys.push(grant.clone());
        let excess = phone.session_keys.len().saturating_sub(KEY_RING);
        phone.session_keys.drain(..excess);
        let label = format!("{} (session key)", phone.label);
        log::info!("[Engine] Session key {short}... granted for {}...", identity.get(..8).unwrap_or(identity));
        self.store_paired();
        // Heard from now on, registered where writes are gated on pubkey,
        // and told at once: the heartbeat that follows is addressed to it.
        self.out.push(Effect::Resubscribe);
        self.out.push(Effect::RegisterPhone { pubkey_hex: grant.pubkey_hex, label });
        self.list_dirty = true;
        true
    }

    /// Whether `key` already stands for someone other than `identity`'s own
    /// ring: any paired identity, or another phone's session key.
    fn key_taken(&self, identity: &str, key: &str) -> bool {
        self.paired.iter().any(|p| {
            p.pubkey_hex == key || (p.pubkey_hex != identity && p.session_keys.iter().any(|k| k.pubkey_hex == key))
        })
    }

    /// Drop lapsed keys; they would be refused anyway, this keeps the
    /// command subscription and the stored list tidy.
    pub(super) fn prune_session_keys(&mut self) {
        let now = self.now_secs();
        let mut changed = false;
        for phone in &mut self.paired {
            let before = phone.session_keys.len();
            phone.session_keys.retain(|k| k.expires_at > now);
            changed |= phone.session_keys.len() != before;
        }
        if changed {
            self.store_paired();
            self.out.push(Effect::Resubscribe);
        }
    }

    pub(super) fn store_paired(&mut self) {
        let json = serde_json::to_string(&self.paired).expect("phones serialize");
        if let Err(err) = self.store.set(store_keys::PAIRED_PHONES, &json) {
            log::error!("[Engine] Could not store the paired phones: {err}");
        }
    }

    /// Where a message for `identity` goes: its newest live session key,
    /// else the identity itself.
    fn recipient(&self, identity: &str, now_secs: u64) -> String {
        self.paired
            .iter()
            .find(|p| p.pubkey_hex == identity)
            .and_then(|p| p.session_keys.iter().rev().find(|k| k.expires_at > now_secs))
            .map_or_else(|| identity.to_string(), |k| k.pubkey_hex.clone())
    }

    /// Re-address every publish in `effects` from identities to their
    /// current session keys.
    pub(super) fn address_publishes(&self, effects: &mut [Effect]) {
        let now = self.now_secs();
        for effect in effects {
            if let Effect::Publish { to, .. } = effect {
                for phone in to.iter_mut() {
                    *phone = self.recipient(phone, now);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(pk: &str, keys: &[(&str, u64)]) -> PairedPhone {
        PairedPhone {
            npub: String::new(),
            pubkey_hex: pk.to_string(),
            label: "p".into(),
            paired_at: String::new(),
            session_keys: keys
                .iter()
                .map(|(k, exp)| SessionKeyGrant { pubkey_hex: k.to_string(), expires_at: *exp })
                .collect(),
        }
    }

    #[test]
    fn an_author_resolves_to_its_identity_by_identity_or_live_key() {
        let paired = [phone("a", &[("ka", 200), ("old", 50)]), phone("b", &[])];
        assert_eq!(resolve_author(&paired, "a", 100), Some(Author { identity: "a".into(), by_session_key: false }));
        assert_eq!(resolve_author(&paired, "ka", 100), Some(Author { identity: "a".into(), by_session_key: true }));
        assert_eq!(resolve_author(&paired, "old", 100), None, "lapsed");
        assert_eq!(resolve_author(&paired, "stranger", 100), None);
        assert_eq!(live_keys(&paired, 100).collect::<Vec<_>>(), vec!["ka"]);
    }
}
