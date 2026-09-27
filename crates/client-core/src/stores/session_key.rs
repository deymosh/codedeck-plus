//! `session_key` — the phone's local session keys and the policy for granting
//! them to each bridge.
//!
//! The phone's identity key may live in an external signer (NIP-55), too
//! slow and too interactive to encrypt and decrypt every message. So each
//! install also holds a local session keypair and grants it to every bridge
//! that honours session keys (`session-key`, or `sessionKey` on the
//! `pair-request`). The session key never signs — every event stays signed
//! by the identity — it only keys NIP-44 payloads: once a bridge confirms a
//! grant, command payloads to it are encrypted with the session key and its
//! messages come encrypted to it. For a bridge without a live grant, the
//! identity's signer encrypts and decrypts too.
//!
//! A grant is confirmed by the first message the bridge encrypts to the
//! granted key after it was sent; a message the bridge encrypts to the
//! identity after the grant took means the bridge no longer holds the key,
//! and it is granted again.
//!
//! **Rotation.** A key lives [`GRANT_LIFETIME_SECS`], and every grant of it
//! runs until the key's own expiry. Once less than [`RENEW_BEFORE_SECS`] is
//! left, a fresh key replaces it ([`SessionKeyRing::rotate_if_due`]) and is
//! granted to every bridge in turn; renewal never re-grants an old key. The
//! previous key is kept, for decrypting and for the bridges still on it,
//! until every bridge has confirmed the new one or its grants lapse. The
//! host keeps both keys (the ring, [`SessionKeyRing::encode`]) wherever it
//! keeps secrets.

use protocol::capabilities::SESSION_KEYS;
use protocol::commands::SESSION_KEY_MAX_LIFETIME_SECS;
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
use serde::{Deserialize, Serialize};

use super::machines::MachinesState;

/// How long a key, and so every grant of it, runs: the protocol maximum,
/// less an hour of headroom for a phone clock running ahead of the bridge's.
pub const GRANT_LIFETIME_SECS: u64 = SESSION_KEY_MAX_LIFETIME_SECS - 3600;
/// A key is replaced by a fresh one once less than this is left of it.
pub const RENEW_BEFORE_SECS: u64 = 30 * 24 * 3600;
/// A grant this close to lapsing is no longer used: commands go through the
/// identity rather than risk arriving after the bridge dropped the key.
const USE_MARGIN_SECS: u64 = 600;
/// The least time between two grants to one bridge, so a bridge that never
/// confirms costs the identity's signer one request per window, not one per
/// message.
pub const REGRANT_EVERY_MS: u64 = 10 * 60 * 1000;

/// One session key the phone holds, and when it (and every grant of it)
/// lapses, in seconds.
#[derive(Clone)]
pub struct SessionKey {
    pub keypair: Keypair,
    pub expires_at: u64,
}

impl std::fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionKey")
            .field("pubkey_hex", &self.keypair.pubkey_hex)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl SessionKey {
    fn fresh(now_ms: u64) -> Self {
        Self { keypair: generate_keypair(), expires_at: now_ms / 1000 + GRANT_LIFETIME_SECS }
    }

    pub fn pubkey_hex(&self) -> &str {
        &self.keypair.pubkey_hex
    }

    fn live(&self, now_secs: u64) -> bool {
        self.expires_at > now_secs
    }
}

/// The phone's session keys: the one it grants, and the one before it while
/// some bridge may still use it.
#[derive(Debug, Clone)]
pub struct SessionKeyRing {
    pub current: SessionKey,
    pub previous: Option<SessionKey>,
}

/// The ring as the host stores it. Holds secrets.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRing {
    current: StoredKey,
    #[serde(default)]
    previous: Option<StoredKey>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredKey {
    secret_hex: String,
    expires_at: u64,
}

impl StoredKey {
    fn of(key: &SessionKey) -> Self {
        Self { secret_hex: key.keypair.secret_hex(), expires_at: key.expires_at }
    }

    fn key(&self) -> Option<SessionKey> {
        let keypair = keypair_from_secret_hex(&self.secret_hex).ok()?;
        Some(SessionKey { keypair, expires_at: self.expires_at })
    }
}

impl SessionKeyRing {
    /// The ring the host stored, or a fresh one when there is none or it is
    /// unreadable (every bridge is then simply granted the new key). The
    /// flag says whether the ring changed and must be stored. The ring is
    /// rotated if due.
    pub fn load(stored: Option<&str>, now_ms: u64) -> (Self, bool) {
        let parsed = stored.and_then(|s| serde_json::from_str::<StoredRing>(s).ok()).and_then(|r| {
            let current = r.current.key()?;
            Some(Self { current, previous: r.previous.and_then(|p| p.key()) })
        });
        match parsed {
            Some(mut ring) => {
                let rotated = ring.rotate_if_due(now_ms);
                (ring, rotated)
            }
            None => (Self { current: SessionKey::fresh(now_ms), previous: None }, true),
        }
    }

    /// The ring as the host stores it. Holds the secrets: keep it wherever
    /// the host keeps secrets, never in a log.
    pub fn encode(&self) -> String {
        let ring = StoredRing { current: StoredKey::of(&self.current), previous: self.previous.as_ref().map(StoredKey::of) };
        serde_json::to_string(&ring).expect("ring serializes")
    }

    /// Replace the current key with a fresh one once less than
    /// [`RENEW_BEFORE_SECS`] is left of it; it becomes the previous key.
    /// Returns whether the ring changed.
    pub fn rotate_if_due(&mut self, now_ms: u64) -> bool {
        let now = now_ms / 1000;
        if self.current.expires_at >= now + RENEW_BEFORE_SECS {
            return false;
        }
        let old = std::mem::replace(&mut self.current, SessionKey::fresh(now_ms));
        self.previous = old.live(now).then_some(old);
        true
    }

    /// Forget the previous key once no bridge's live grant names it.
    /// Returns whether the ring changed.
    pub fn drop_unused_previous(&mut self, machines: &MachinesState, now_ms: u64) -> bool {
        let now = now_ms / 1000;
        let Some(previous) = &self.previous else { return false };
        let used = previous.live(now)
            && machines.machines.values().any(|m| {
                m.session_grant.as_ref().is_some_and(|g| g.pubkey_hex == previous.keypair.pubkey_hex && g.expires_at > now)
            });
        if used {
            return false;
        }
        self.previous = None;
        true
    }

    /// The live key with this public half, if the ring holds one.
    pub fn key(&self, pubkey_hex: &str, now_ms: u64) -> Option<&SessionKey> {
        self.keys(now_ms).find(|k| k.keypair.pubkey_hex == pubkey_hex)
    }

    /// The live keys, current first: what a bridge's message may be
    /// encrypted to besides the identity.
    pub fn keys(&self, now_ms: u64) -> impl Iterator<Item = &SessionKey> {
        let now = now_ms / 1000;
        std::iter::once(&self.current).chain(self.previous.as_ref()).filter(move |k| k.live(now))
    }
}

/// A grant of one session key to one bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionGrant {
    /// The granted key's public half.
    pub pubkey_hex: String,
    /// When the grant lapses (seconds): the key's own expiry.
    #[specta(type = specta_typescript::Number)]
    pub expires_at: u64,
    /// When it was sent (seconds).
    #[specta(type = specta_typescript::Number)]
    pub sent_at: u64,
}

/// Which of the phone's keys a bridge message was encrypted to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recipient {
    /// The session key with this public half.
    SessionKey(String),
    Identity,
}

impl MachinesState {
    /// The session key commands to `machine` go out under: the one it
    /// confirmed, unless that grant is about to lapse.
    pub fn session_key_of(&self, machine: &str, now_ms: u64) -> Option<&str> {
        self.machine(machine)
            .and_then(|m| m.session_grant.as_ref())
            .filter(|g| g.expires_at > now_ms / 1000 + USE_MARGIN_SECS)
            .map(|g| g.pubkey_hex.as_str())
    }

    /// Whether `machine` should be granted `current` (again): it honours
    /// session keys and has not confirmed a grant of `current` with more
    /// than [`RENEW_BEFORE_SECS`] left. Throttling repeats is the caller's.
    pub fn wants_session_grant(&self, machine: &str, current: &SessionKey, now_ms: u64) -> bool {
        let Some(m) = self.machine(machine) else { return false };
        m.capabilities.iter().any(|c| c == SESSION_KEYS)
            && !m.session_grant.as_ref().is_some_and(|g| {
                g.pubkey_hex == current.keypair.pubkey_hex && g.expires_at >= now_ms / 1000 + RENEW_BEFORE_SECS
            })
    }

    /// `grant` was sent to `machine`; it counts once the bridge confirms it.
    /// Returns whether the store changed.
    pub fn note_session_grant_sent(&mut self, machine: &str, grant: SessionGrant) -> bool {
        let Some(m) = self.machines.get_mut(machine) else { return false };
        m.session_grant_sent = Some(grant);
        true
    }

    /// `machine` sent a message created at `created_at` (seconds) encrypted
    /// to `recipient`. To the key of the grant last sent, that confirms it;
    /// to the identity after a grant took, it means the bridge no longer
    /// holds the key. Returns whether the store changed.
    pub fn note_heard_via(&mut self, machine: &str, recipient: &Recipient, created_at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine) else { return false };
        match recipient {
            Recipient::SessionKey(key) => {
                if m.session_grant_sent.as_ref().is_none_or(|g| g.pubkey_hex != *key) {
                    return false;
                }
                m.session_grant = m.session_grant_sent.take();
                true
            }
            // Only a message written after the grant was sent says
            // anything: a relay replaying an older one is not news.
            Recipient::Identity => match &m.session_grant {
                Some(g) if created_at > g.sent_at => {
                    m.session_grant = None;
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

    const DAY_MS: u64 = 24 * 3600 * 1000;
    const NOW: u64 = 1_000 * DAY_MS;

    #[test]
    fn a_stored_ring_is_reused_and_a_missing_or_corrupt_one_is_replaced() {
        let (ring, changed) = SessionKeyRing::load(None, NOW);
        assert!(changed);
        assert_eq!(ring.current.expires_at, NOW / 1000 + GRANT_LIFETIME_SECS);
        let (again, changed) = SessionKeyRing::load(Some(&ring.encode()), NOW + DAY_MS);
        assert!(!changed);
        assert_eq!(again.current.keypair.secret_hex(), ring.current.keypair.secret_hex());
        let (fresh, changed) = SessionKeyRing::load(Some("not json"), NOW);
        assert!(changed);
        assert_ne!(fresh.current.pubkey_hex(), ring.current.pubkey_hex());
    }

    #[test]
    fn the_debug_form_holds_no_secret() {
        let (ring, _) = SessionKeyRing::load(None, NOW);
        assert!(!format!("{ring:?}").contains(&ring.current.keypair.secret_hex()));
    }

    #[test]
    fn a_key_is_replaced_a_month_before_it_lapses_and_kept_as_the_previous() {
        let (mut ring, _) = SessionKeyRing::load(None, NOW);
        let first = ring.current.pubkey_hex().to_string();
        let lifetime_ms = GRANT_LIFETIME_SECS * 1000;
        assert!(!ring.rotate_if_due(NOW + lifetime_ms - 31 * DAY_MS));
        let later = NOW + lifetime_ms - 29 * DAY_MS;
        assert!(ring.rotate_if_due(later));
        assert_ne!(ring.current.pubkey_hex(), first);
        assert_eq!(ring.previous.as_ref().unwrap().pubkey_hex(), first);
        assert_eq!(ring.keys(later).count(), 2);
        // Both survive a reload.
        let (again, _) = SessionKeyRing::load(Some(&ring.encode()), later);
        assert_eq!(again.previous.unwrap().pubkey_hex(), first);
        // A lapsed key is not kept at all.
        let (mut stale, _) = SessionKeyRing::load(None, NOW);
        assert!(stale.rotate_if_due(NOW + lifetime_ms + DAY_MS));
        assert!(stale.previous.is_none());
    }

    fn store(caps: &[&str]) -> MachinesState {
        let mut s = MachinesState::new(Default::default(), MergeOptions::default());
        for m in ["m", "n"] {
            s.register_machine(m, "laptop", None, None);
            s.machines.get_mut(m).unwrap().capabilities = caps.iter().map(|c| c.to_string()).collect();
        }
        s
    }

    fn grant_of(key: &SessionKey, now_ms: u64) -> SessionGrant {
        SessionGrant { pubkey_hex: key.pubkey_hex().to_string(), expires_at: key.expires_at, sent_at: now_ms / 1000 }
    }

    fn via(key: &SessionKey) -> Recipient {
        Recipient::SessionKey(key.pubkey_hex().to_string())
    }

    #[test]
    fn a_grant_counts_only_once_the_bridge_confirms_it() {
        let (ring, _) = SessionKeyRing::load(None, NOW);
        let mut s = store(&[SESSION_KEYS]);
        assert!(s.wants_session_grant("m", &ring.current, NOW));
        assert!(s.note_session_grant_sent("m", grant_of(&ring.current, NOW)));
        assert_eq!(s.session_key_of("m", NOW), None, "sent, not confirmed");
        // A message to the identity before the grant took changes nothing.
        assert!(!s.note_heard_via("m", &Recipient::Identity, NOW / 1000));
        assert!(s.note_heard_via("m", &via(&ring.current), NOW / 1000 + 1));
        assert_eq!(s.session_key_of("m", NOW), Some(ring.current.pubkey_hex()));
        assert!(!s.wants_session_grant("m", &ring.current, NOW));
        // Further session-key messages are nothing new.
        assert!(!s.note_heard_via("m", &via(&ring.current), NOW / 1000 + 2));
    }

    #[test]
    fn a_rotation_regrants_every_bridge_and_keeps_the_old_key_until_all_confirm() {
        let (mut ring, _) = SessionKeyRing::load(None, NOW);
        let mut s = store(&[SESSION_KEYS]);
        for m in ["m", "n"] {
            s.note_session_grant_sent(m, grant_of(&ring.current, NOW));
            s.note_heard_via(m, &via(&ring.current), NOW / 1000);
        }
        let old = ring.current.clone();
        let later = NOW + (GRANT_LIFETIME_SECS - RENEW_BEFORE_SECS) * 1000 + DAY_MS;
        assert!(ring.rotate_if_due(later));
        assert!(!ring.drop_unused_previous(&s, later), "both bridges are on it");
        for m in ["m", "n"] {
            assert!(s.wants_session_grant(m, &ring.current, later));
            // Until a bridge confirms the new key, it keeps the old one.
            assert_eq!(s.session_key_of(m, later), Some(old.pubkey_hex()));
            s.note_session_grant_sent(m, grant_of(&ring.current, later));
            assert!(!s.note_heard_via(m, &via(&old), later / 1000 + 1), "the old key confirms nothing");
        }
        assert!(s.note_heard_via("m", &via(&ring.current), later / 1000 + 2));
        assert_eq!(s.session_key_of("m", later), Some(ring.current.pubkey_hex()));
        assert!(!ring.drop_unused_previous(&s, later), "n is still on it");
        assert!(ring.key(old.pubkey_hex(), later).is_some());
        assert!(s.note_heard_via("n", &via(&ring.current), later / 1000 + 3));
        assert!(ring.drop_unused_previous(&s, later));
        assert!(ring.key(old.pubkey_hex(), later).is_none());
    }

    #[test]
    fn the_previous_key_goes_once_its_grants_lapse() {
        let (mut ring, _) = SessionKeyRing::load(None, NOW);
        let mut s = store(&[SESSION_KEYS]);
        s.note_session_grant_sent("m", grant_of(&ring.current, NOW));
        s.note_heard_via("m", &via(&ring.current), NOW / 1000);
        let lifetime_ms = GRANT_LIFETIME_SECS * 1000;
        ring.rotate_if_due(NOW + lifetime_ms - DAY_MS);
        assert!(!ring.drop_unused_previous(&s, NOW + lifetime_ms - DAY_MS));
        // m never came back: its grant ran out, and with it the key.
        assert_eq!(s.session_key_of("m", NOW + lifetime_ms - 60_000), None);
        assert!(ring.drop_unused_previous(&s, NOW + lifetime_ms + 1000));
    }

    #[test]
    fn a_message_to_the_identity_after_the_grant_took_drops_it() {
        let (ring, _) = SessionKeyRing::load(None, NOW);
        let mut s = store(&[SESSION_KEYS]);
        s.note_session_grant_sent("m", grant_of(&ring.current, NOW));
        s.note_heard_via("m", &via(&ring.current), NOW / 1000);
        // A replay of something older than the grant is not news.
        assert!(!s.note_heard_via("m", &Recipient::Identity, NOW / 1000 - 30));
        assert!(s.session_key_of("m", NOW).is_some());
        assert!(s.note_heard_via("m", &Recipient::Identity, NOW / 1000 + 60));
        assert_eq!(s.session_key_of("m", NOW), None);
        assert!(s.wants_session_grant("m", &ring.current, NOW));
    }

    #[test]
    fn a_bridge_without_session_keys_is_never_granted() {
        let (ring, _) = SessionKeyRing::load(None, NOW);
        let s = store(&["images"]);
        assert!(!s.wants_session_grant("m", &ring.current, NOW));
        assert!(!s.wants_session_grant("unknown", &ring.current, NOW));
        assert_eq!(s.session_key_of("unknown", NOW), None);
    }
}
