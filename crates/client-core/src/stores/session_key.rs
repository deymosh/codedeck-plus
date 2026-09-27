//! `session_key` — the phone's local session key and the policy for granting
//! it to each bridge.
//!
//! The phone's identity key may live in an external signer (NIP-55), too
//! slow and too interactive to encrypt and decrypt every message. So each
//! install also holds ONE local session keypair, created on first boot and
//! persisted (hex secret) through the KV port, and grants it to every bridge
//! that honours session keys (`session-key`, or `sessionKey` on the
//! `pair-request`). The session key never signs — every event stays signed
//! by the identity — it only keys NIP-44 payloads: once a bridge confirms a
//! grant, command payloads to it are encrypted with the session key and its
//! messages come encrypted to it. For a bridge without a live grant, the
//! identity's signer encrypts and decrypts too.
//!
//! A grant is confirmed by the first message the bridge encrypts to the
//! session key after it was sent; a message the bridge encrypts to the
//! identity after the grant took means the bridge no longer holds the key,
//! and it is granted again.

use protocol::capabilities::SESSION_KEYS;
use protocol::commands::SESSION_KEY_MAX_LIFETIME_SECS;
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};

use super::machines::MachinesState;

pub const SESSION_KEY_STORAGE_KEY: &str = "session.secretKey";

/// How long a grant runs: the protocol maximum, less an hour of headroom for
/// a phone clock running ahead of the bridge's.
pub const GRANT_LIFETIME_SECS: u64 = SESSION_KEY_MAX_LIFETIME_SECS - 3600;
/// A grant is renewed once less than this is left of it.
pub const RENEW_BEFORE_SECS: u64 = 30 * 24 * 3600;
/// A grant this close to lapsing is no longer used: commands go through the
/// identity rather than risk arriving after the bridge dropped the key.
const USE_MARGIN_SECS: u64 = 600;
/// The least time between two grants to one bridge, so a bridge that never
/// confirms costs the identity's signer one request per window, not one per
/// message.
pub const REGRANT_EVERY_MS: u64 = 10 * 60 * 1000;

pub struct LoadedSessionKey {
    pub keypair: Keypair,
    /// The stored secret was absent or corrupt — the runtime must persist
    /// `keypair.secret_hex()` under [`SESSION_KEY_STORAGE_KEY`].
    pub needs_persist: bool,
}

/// Parse the persisted hex secret into a keypair, or generate a fresh one. A
/// fresh key is harmless: every bridge is simply granted it again.
pub fn load_or_create_session_key(stored: Option<&str>) -> LoadedSessionKey {
    if let Some(keypair) = stored.and_then(|hex| keypair_from_secret_hex(hex).ok()) {
        return LoadedSessionKey { keypair, needs_persist: false };
    }
    LoadedSessionKey { keypair: generate_keypair(), needs_persist: true }
}

/// When a grant made at `now_ms` lapses, in seconds.
pub fn grant_expiry(now_ms: u64) -> u64 {
    now_ms / 1000 + GRANT_LIFETIME_SECS
}

/// Which of the phone's keys a bridge message was encrypted to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recipient {
    SessionKey,
    Identity,
}

impl MachinesState {
    /// Whether commands to `machine` go out under the session key: the
    /// bridge confirmed a grant that is not about to lapse.
    pub fn uses_session_key(&self, machine: &str, now_ms: u64) -> bool {
        self.machine(machine)
            .and_then(|m| m.session_granted_until)
            .is_some_and(|until| until > now_ms / 1000 + USE_MARGIN_SECS)
    }

    /// Whether `machine` should be granted the session key (again): it
    /// honours session keys and holds no grant with more than
    /// [`RENEW_BEFORE_SECS`] left. Throttling repeats is the caller's.
    pub fn wants_session_grant(&self, machine: &str, now_ms: u64) -> bool {
        let Some(m) = self.machine(machine) else { return false };
        m.capabilities.iter().any(|c| c == SESSION_KEYS)
            && m.session_granted_until.is_none_or(|until| until < now_ms / 1000 + RENEW_BEFORE_SECS)
    }

    /// A grant running until `expires_at` was sent to `machine`; it counts
    /// once the bridge confirms it. Returns whether the store changed.
    pub fn note_session_grant_sent(&mut self, machine: &str, expires_at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine) else { return false };
        m.session_grant_pending = Some(expires_at);
        true
    }

    /// `machine` sent a message created at `created_at` (seconds) encrypted
    /// to `recipient`. To the session key, that confirms a pending grant; to
    /// the identity after a grant took, it means the bridge no longer holds
    /// the key. Returns whether the store changed.
    pub fn note_heard_via(&mut self, machine: &str, recipient: Recipient, created_at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine) else { return false };
        match recipient {
            Recipient::SessionKey => match m.session_grant_pending.take() {
                Some(pending) => {
                    m.session_granted_until = Some(m.session_granted_until.map_or(pending, |g| g.max(pending)));
                    true
                }
                None => false,
            },
            Recipient::Identity => match m.session_granted_until {
                // Only a message written after the grant was sent says
                // anything: a relay replaying an older one is not news.
                Some(until) if created_at > until.saturating_sub(GRANT_LIFETIME_SECS) => {
                    m.session_granted_until = None;
                    true
                }
                _ => false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::machines::MergeOptions;

    #[test]
    fn a_valid_stored_secret_is_reused_without_a_persist() {
        let original = generate_keypair();
        let loaded = load_or_create_session_key(Some(&original.secret_hex()));
        assert!(!loaded.needs_persist);
        assert_eq!(loaded.keypair.secret_hex(), original.secret_hex());
    }

    #[test]
    fn an_absent_or_corrupt_secret_generates_a_fresh_keypair_that_needs_persisting() {
        let fresh = load_or_create_session_key(None);
        assert!(fresh.needs_persist);
        assert_eq!(fresh.keypair.pubkey_hex.len(), 64);
        let corrupt = load_or_create_session_key(Some("not-hex"));
        assert!(corrupt.needs_persist);
        assert_ne!(corrupt.keypair.pubkey_hex, fresh.keypair.pubkey_hex);
    }

    const DAY_MS: u64 = 24 * 3600 * 1000;

    fn store(caps: &[&str]) -> MachinesState {
        let mut s = MachinesState::new(Default::default(), MergeOptions::default());
        s.register_machine("m", "laptop", None, None);
        s.machines.get_mut("m").unwrap().capabilities = caps.iter().map(|c| c.to_string()).collect();
        s
    }

    #[test]
    fn a_grant_counts_only_once_the_bridge_confirms_it() {
        let now = 1_000 * DAY_MS;
        let mut s = store(&[SESSION_KEYS]);
        assert!(s.wants_session_grant("m", now));
        assert!(s.note_session_grant_sent("m", grant_expiry(now)));
        assert!(!s.uses_session_key("m", now), "sent, not confirmed");
        // A message to the identity before the grant took changes nothing.
        assert!(!s.note_heard_via("m", Recipient::Identity, now / 1000));
        assert!(s.note_heard_via("m", Recipient::SessionKey, now / 1000 + 1));
        assert!(s.uses_session_key("m", now));
        assert!(!s.wants_session_grant("m", now));
        // Further session-key messages are nothing new.
        assert!(!s.note_heard_via("m", Recipient::SessionKey, now / 1000 + 2));
    }

    #[test]
    fn a_grant_is_renewed_a_month_ahead_and_dropped_near_its_end() {
        let now = 1_000 * DAY_MS;
        let mut s = store(&[SESSION_KEYS]);
        s.note_session_grant_sent("m", grant_expiry(now));
        s.note_heard_via("m", Recipient::SessionKey, now / 1000);
        let lifetime_ms = GRANT_LIFETIME_SECS * 1000;
        assert!(!s.wants_session_grant("m", now + lifetime_ms - 31 * DAY_MS));
        assert!(s.wants_session_grant("m", now + lifetime_ms - 29 * DAY_MS));
        assert!(s.uses_session_key("m", now + lifetime_ms - DAY_MS));
        assert!(!s.uses_session_key("m", now + lifetime_ms - 60_000));
        // The renewal, once confirmed, extends the grant.
        let later = now + lifetime_ms - 29 * DAY_MS;
        s.note_session_grant_sent("m", grant_expiry(later));
        s.note_heard_via("m", Recipient::SessionKey, later / 1000);
        assert_eq!(s.machine("m").unwrap().session_granted_until, Some(grant_expiry(later)));
    }

    #[test]
    fn a_message_to_the_identity_after_the_grant_took_drops_it() {
        let now = 1_000 * DAY_MS;
        let mut s = store(&[SESSION_KEYS]);
        s.note_session_grant_sent("m", grant_expiry(now));
        s.note_heard_via("m", Recipient::SessionKey, now / 1000);
        // A replay of something older than the grant is not news.
        assert!(!s.note_heard_via("m", Recipient::Identity, now / 1000 - 30));
        assert!(s.uses_session_key("m", now));
        assert!(s.note_heard_via("m", Recipient::Identity, now / 1000 + 60));
        assert!(!s.uses_session_key("m", now));
        assert!(s.wants_session_grant("m", now));
    }

    #[test]
    fn a_bridge_without_session_keys_is_never_granted() {
        let s = store(&["images"]);
        assert!(!s.wants_session_grant("m", 0));
        assert!(!s.wants_session_grant("unknown", 0));
        assert!(!s.uses_session_key("unknown", 0));
    }
}
