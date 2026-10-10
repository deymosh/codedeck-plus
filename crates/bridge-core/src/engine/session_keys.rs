//! Session keys: keys a paired identity's clients encrypt their traffic with.
//!
//! A client whose identity key lives in an external signer should not ask it
//! to decrypt every message. It grants the bridge a local key
//! (`session-key`, or with its `pair-request`), and from then on the NIP-44
//! payload of every message between them is encrypted with that key. The
//! events themselves never change hands: the client signs every command with
//! the identity, and the bridge `p`-tags every message to the identity. A
//! session key can only read and write payloads inside events the identity
//! signed, so it can never act as the identity on its own.
//!
//! An identity may have any number of clients — phones, desktops — and each
//! holds its own key, so a client is known by its key. Every message goes
//! to each client: one copy per client, encrypted to its newest key (to the
//! identity itself when no client has granted one), each with its own
//! recipient tag (`protocol::recipients`).
//!
//! Rules:
//! - a grant arrives in a command, which only the paired identity can sign;
//! - a grant names the one bridge it is for; one naming another is refused,
//!   so a grant seen by one bridge cannot be replayed to another;
//! - a grant lapses at its `expiresAt`, at most
//!   [`SESSION_KEY_MAX_LIFETIME_SECS`] ahead, and its client with it;
//! - a grant naming the key it `replaces` moves that client to the new key;
//!   the old one is still read (commands the client sent while rotating)
//!   until it lapses, but no longer written to. Any other grant of a new
//!   key adds a client, up to [`MAX_CLIENTS`]: past that, the client whose
//!   key lapses soonest is dropped;
//! - a key the bridge already knows for anyone (a paired identity, another
//!   identity's client, the bridge's own) or that a client already rotated
//!   away from is refused: a session key belongs to one client.

use protocol::commands::{SessionKeyGrant, SESSION_KEY_MAX_LIFETIME_SECS};
use protocol::crypto::npub_from_hex;

use super::Engine;
use crate::io::{store_keys, Addressee, Effect, PhoneClient};

/// The most clients an identity keeps. Each costs a copy of every message,
/// so a client that keeps granting fresh keys cannot grow that without end.
pub const MAX_CLIENTS: usize = 16;

/// Clock skew allowed on a grant's `expiresAt`.
const SKEW_SECS: u64 = 300;

fn short(key: &str) -> &str {
    key.get(..8).unwrap_or(key)
}

impl Engine {
    fn now_secs(&self) -> u64 {
        self.now() / 1000
    }

    /// Accept `grant` for the paired `identity`. Returns whether it took.
    pub(super) fn grant_session_key(&mut self, identity: &str, grant: SessionKeyGrant) -> bool {
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
        let key = short(&grant.pubkey_hex).to_string();
        if let Some(why) = refusal {
            log::warn!("[Engine] Refusing session key {key}...: {why}");
            return false;
        }
        let Some(phone) = self.paired.iter_mut().find(|p| p.pubkey_hex == identity) else { return false };
        phone.clients.retain(|c| c.key.expires_at > now);
        let renewed = phone.clients.iter().position(|c| c.key.pubkey_hex == grant.pubkey_hex);
        let rotated = grant
            .replaces
            .as_deref()
            .and_then(|old| phone.clients.iter().position(|c| c.key.pubkey_hex == old));
        if let Some(i) = renewed {
            phone.clients[i].key = grant;
            log::info!("[Engine] Session key {key}... renewed for {}...", short(identity));
        } else if let Some(i) = rotated {
            let client = &mut phone.clients[i];
            client.previous = Some(std::mem::replace(&mut client.key, grant));
            log::info!("[Engine] A client of {}... rotated to session key {key}...", short(identity));
        } else {
            if phone.clients.len() >= MAX_CLIENTS {
                let soonest = phone
                    .clients
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, c)| c.key.expires_at)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                let dropped = phone.clients.remove(soonest);
                log::info!("[Engine] {}... has too many clients; dropping {}...", short(identity), short(&dropped.key.pubkey_hex));
            }
            phone.clients.push(PhoneClient { key: grant, previous: None });
            log::info!("[Engine] Session key {key}... granted for a new client of {}...", short(identity));
        }
        self.store_paired();
        // The heartbeat that follows is encrypted to the key: the client's
        // confirmation.
        self.list_dirty = true;
        true
    }

    /// Whether `key` already stands for someone other than a client of
    /// `identity` granting it again: any paired identity, another
    /// identity's client, or a key one of `identity`'s clients rotated away
    /// from.
    fn key_taken(&self, identity: &str, key: &str) -> bool {
        self.paired.iter().any(|p| {
            p.pubkey_hex == key
                || p.clients.iter().any(|c| {
                    let previous = c.previous.as_ref().is_some_and(|k| k.pubkey_hex == key);
                    previous || (p.pubkey_hex != identity && c.key.pubkey_hex == key)
                })
        })
    }

    /// Drop lapsed keys, and the clients whose newest key lapsed; they would
    /// be skipped anyway, this keeps the stored list tidy.
    pub(super) fn prune_session_keys(&mut self) {
        let now = self.now_secs();
        let mut changed = false;
        for phone in &mut self.paired {
            let before = phone.clients.len();
            phone.clients.retain(|c| c.key.expires_at > now);
            changed |= phone.clients.len() != before;
            for client in &mut phone.clients {
                if client.previous.as_ref().is_some_and(|k| k.expires_at <= now) {
                    client.previous = None;
                    changed = true;
                }
            }
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

    /// Every live session key of `identity`'s clients, newest keys first:
    /// what its command payloads may be encrypted with, besides the identity
    /// itself.
    pub(super) fn payload_keys(&self, identity: &str, now_secs: u64) -> Vec<String> {
        let Some(phone) = self.paired.iter().find(|p| p.pubkey_hex == identity) else { return Vec::new() };
        let newest = phone.clients.iter().map(|c| &c.key);
        let previous = phone.clients.iter().filter_map(|c| c.previous.as_ref());
        newest.chain(previous).filter(|k| k.expires_at > now_secs).map(|k| k.pubkey_hex.clone()).collect()
    }

    /// The keys a message to `identity` is encrypted to, a copy each: its
    /// clients' newest live keys, or the identity itself when it has none.
    fn copy_keys(&self, identity: &str, now_secs: u64) -> Vec<String> {
        let keys: Vec<String> = self
            .paired
            .iter()
            .find(|p| p.pubkey_hex == identity)
            .map(|p| p.clients.iter().filter(|c| c.key.expires_at > now_secs).map(|c| c.key.pubkey_hex.clone()).collect())
            .unwrap_or_default();
        if keys.is_empty() {
            vec![identity.to_string()]
        } else {
            keys
        }
    }

    /// Turn every publish in `effects` into a copy for each client of each
    /// identity it goes to.
    pub(super) fn address_publishes(&self, effects: &mut [Effect]) {
        let now = self.now_secs();
        for effect in effects {
            if let Effect::Publish { to, .. } = effect {
                *to = to
                    .iter()
                    .flat_map(|a| {
                        self.copy_keys(&a.phone, now).into_iter().map(|key| Addressee { phone: a.phone.clone(), key })
                    })
                    .collect();
            }
        }
    }
}
