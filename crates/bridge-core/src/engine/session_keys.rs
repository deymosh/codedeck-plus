//! Session keys: keys a paired phone's identity lets encrypt its traffic.
//!
//! A phone whose identity key lives in an external signer should not ask it
//! to decrypt every message. It grants the bridge a local key
//! (`session-key`, or with its `pair-request`), and from then on the NIP-44
//! payload of every message between them is encrypted with that key. The
//! events themselves never change hands: the phone signs every command with
//! its identity, and the bridge `p`-tags every message to the identity. A
//! session key can only read and write payloads inside events the identity
//! signed, so it can never act as the phone on its own.
//!
//! Rules:
//! - a grant arrives in a command, which only the paired identity can sign;
//! - a grant names the one bridge it is for; one naming another is refused,
//!   so a grant seen by one bridge cannot be replayed to another;
//! - a grant lapses at its `expiresAt`, at most
//!   [`SESSION_KEY_MAX_LIFETIME_SECS`] ahead;
//! - each identity keeps its [`KEY_RING`] newest keys; commands encrypted
//!   with either are read, so commands the phone sent while rotating still
//!   land, and messages are encrypted to the newest;
//! - a key the bridge already knows for anyone (a paired identity, another
//!   phone's key, the bridge's own) is refused: a session key belongs to
//!   one phone.

use protocol::commands::{SessionKeyGrant, SESSION_KEY_MAX_LIFETIME_SECS};
use protocol::crypto::npub_from_hex;

use super::Engine;
use crate::io::{store_keys, Effect};

/// Keys kept per identity.
pub const KEY_RING: usize = 2;

/// Clock skew allowed on a grant's `expiresAt`.
const SKEW_SECS: u64 = 300;

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
        } else if grant.bridge_pubkey_hex != self.config.keys.pubkey_hex {
            Some("granted to another bridge")
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
        phone.session_keys.push(grant);
        let excess = phone.session_keys.len().saturating_sub(KEY_RING);
        phone.session_keys.drain(..excess);
        log::info!("[Engine] Session key {short}... granted for {}...", identity.get(..8).unwrap_or(identity));
        self.store_paired();
        // The heartbeat that follows is encrypted to the key: the phone's
        // confirmation.
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

    /// Drop lapsed keys; they would be skipped anyway, this keeps the
    /// stored list tidy.
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
        }
    }

    pub(super) fn store_paired(&mut self) {
        let json = serde_json::to_string(&self.paired).expect("phones serialize");
        if let Err(err) = self.store.set(store_keys::PAIRED_PHONES, &json) {
            log::error!("[Engine] Could not store the paired phones: {err}");
        }
    }

    /// `identity`'s live session keys, newest first: what its command
    /// payloads may be encrypted with, besides the identity itself.
    pub(super) fn payload_keys(&self, identity: &str, now_secs: u64) -> Vec<String> {
        self.paired
            .iter()
            .find(|p| p.pubkey_hex == identity)
            .map(|p| {
                p.session_keys
                    .iter()
                    .rev()
                    .filter(|k| k.expires_at > now_secs)
                    .map(|k| k.pubkey_hex.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Encrypt every publish in `effects` to its phone's newest live
    /// session key, where it has one.
    pub(super) fn address_publishes(&self, effects: &mut [Effect]) {
        let now = self.now_secs();
        for effect in effects {
            if let Effect::Publish { to, .. } = effect {
                for addressee in to.iter_mut() {
                    if let Some(key) = self.payload_keys(&addressee.phone, now).into_iter().next() {
                        addressee.key = key;
                    }
                }
            }
        }
    }
}
