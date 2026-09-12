//! `identity` store — the phone keypair. Port of the pure half of
//! `apps/mobile/src/core/stores/identity.ts`.
//!
//! One keypair per install, created on first boot and persisted (hex secret)
//! through the KV port. Everything that signs/encrypts gets the keypair from
//! here — no other store touches key material. The KV read/write is the
//! runtime's; this module only decides whether the stored secret is usable.

use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};

pub const IDENTITY_STORAGE_KEY: &str = "identity.secretKey";

pub struct LoadedIdentity {
    pub keypair: Keypair,
    /// The stored secret was absent or corrupt — the runtime must persist
    /// `keypair.secret_hex()` under [`IDENTITY_STORAGE_KEY`].
    pub needs_persist: bool,
}

/// Parse the persisted hex secret into a keypair, or generate a fresh one. A
/// corrupt stored secret is unrecoverable — regenerate rather than brick the
/// app (the user re-pairs); the runtime should log that loudly.
pub fn load_or_create_identity(stored: Option<&str>) -> LoadedIdentity {
    if let Some(hex) = stored {
        if let Ok(keypair) = keypair_from_secret_hex(hex) {
            return LoadedIdentity {
                keypair,
                needs_persist: false,
            };
        }
    }
    LoadedIdentity {
        keypair: generate_keypair(),
        needs_persist: true,
    }
}

/// The resolved identity, read-only for the rest of the core.
#[derive(Debug, Clone)]
pub struct IdentityState {
    pub keypair: Keypair,
    pub pubkey_hex: String,
    pub npub: String,
}

impl IdentityState {
    pub fn new(keypair: Keypair) -> Self {
        Self {
            pubkey_hex: keypair.pubkey_hex.clone(),
            npub: keypair.npub.clone(),
            keypair,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_valid_stored_secret_is_reused_without_a_persist() {
        let original = generate_keypair();
        let loaded = load_or_create_identity(Some(&original.secret_hex()));
        assert!(!loaded.needs_persist);
        assert_eq!(loaded.keypair.pubkey_hex, original.pubkey_hex);
        assert_eq!(loaded.keypair.secret_hex(), original.secret_hex());
    }

    #[test]
    fn an_absent_or_corrupt_secret_generates_a_fresh_keypair_that_needs_persisting() {
        let fresh = load_or_create_identity(None);
        assert!(fresh.needs_persist);
        assert_eq!(fresh.keypair.pubkey_hex.len(), 64);

        let corrupt = load_or_create_identity(Some("not-hex"));
        assert!(corrupt.needs_persist);
        // a distinct keypair, not a re-parse of the garbage
        assert_ne!(corrupt.keypair.pubkey_hex, fresh.keypair.pubkey_hex);
    }

    #[test]
    fn identity_state_mirrors_the_keypair_pubkey_and_npub() {
        let kp = generate_keypair();
        let state = IdentityState::new(kp.clone());
        assert_eq!(state.pubkey_hex, kp.pubkey_hex);
        assert_eq!(state.npub, kp.npub);
        assert!(state.npub.starts_with("npub1"));
    }
}
