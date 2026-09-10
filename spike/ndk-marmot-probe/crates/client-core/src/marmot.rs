//! A minimal, faithful slice of `apps/mobile/src-tauri/src/marmot.rs`: open a
//! SQLCipher-encrypted MDK store (key = domain-separated SHA-256 of the identity
//! secret) and run the MLS key-package + group-creation path. Enough to prove
//! the stack builds and executes after the workspace re-layout.

use std::path::Path;

use mdk_core::prelude::*;
use mdk_sqlite_storage::{EncryptionConfig, MdkSqliteStorage};
use nostr::prelude::*;
use sha2::{Digest, Sha256};

pub const KIND_KEY_PACKAGE: u16 = 30443;

pub struct MarmotService {
    mdk: MDK<MdkSqliteStorage>,
    keys: Keys,
}

impl MarmotService {
    pub fn open(db_path: &Path, identity_secret_hex: &str) -> Result<Self, String> {
        let keys = Keys::parse(identity_secret_hex).map_err(|_| "invalid identity secret".to_string())?;
        let mut hasher = Sha256::new();
        hasher.update(b"codedeck-marmot-db-v1");
        hasher.update(keys.secret_key().as_secret_bytes());
        let db_key: [u8; 32] = hasher.finalize().into();
        let storage = MdkSqliteStorage::new_with_key(db_path, EncryptionConfig::new(db_key))
            .map_err(|e| format!("open marmot storage: {e}"))?;
        Ok(Self { mdk: MDK::new(storage), keys })
    }

    pub fn key_package_event(&self, relays: &[String]) -> Result<Event, String> {
        let relay_urls: Vec<RelayUrl> = relays.iter().filter_map(|r| RelayUrl::parse(r).ok()).collect();
        let data = self
            .mdk
            .create_key_package_for_event(&self.keys.public_key(), relay_urls)
            .map_err(|e| format!("create key package: {e}"))?;
        EventBuilder::new(Kind::Custom(KIND_KEY_PACKAGE), data.content)
            .tags(data.tags_30443)
            .sign_with_keys(&self.keys)
            .map_err(|e| format!("sign key package: {e}"))
    }

    /// Create a 1:1 group inviting `peer` via their kind-30443 event. Returns
    /// the MLS group id (hex) and the number of welcome rumors produced.
    pub fn create_group(
        &self,
        peer: &PublicKey,
        peer_kp_event: Event,
        relays: &[String],
    ) -> Result<(String, usize, usize), String> {
        let relay_urls: Vec<RelayUrl> = relays.iter().filter_map(|r| RelayUrl::parse(r).ok()).collect();
        let config = NostrGroupConfigData::new(
            "CodeDeck DM".to_string(),
            "probe".to_string(),
            None,
            None,
            None,
            relay_urls,
            vec![self.keys.public_key(), *peer],
        );
        let res = self
            .mdk
            .create_group(&self.keys.public_key(), vec![peer_kp_event], config)
            .map_err(|e| format!("create group: {e}"))?;
        let members = self
            .mdk
            .get_members(&res.group.mls_group_id)
            .map(|m| m.len())
            .unwrap_or(0);
        let gid = hex::encode(res.group.mls_group_id.as_slice());
        Ok((gid, res.welcome_rumors.len(), members))
    }
}

/// Two fresh identities, two encrypted stores, one group. Returns a summary.
pub fn loopback(dir: &Path) -> Result<String, String> {
    let a_keys = Keys::generate();
    let b_keys = Keys::generate();
    let a = MarmotService::open(&dir.join("a.db"), &a_keys.secret_key().to_secret_hex())?;
    let b = MarmotService::open(&dir.join("b.db"), &b_keys.secret_key().to_secret_hex())?;

    let relays = vec!["wss://relay.example".to_string()];
    let kp_a = a.key_package_event(&relays)?;
    if kp_a.kind.as_u16() != KIND_KEY_PACKAGE {
        return Err("key package has wrong kind".to_string());
    }
    kp_a.verify().map_err(|e| format!("kp signature: {e}"))?;

    let (gid, welcomes, members) = b.create_group(&a_keys.public_key(), kp_a, &relays)?;
    if welcomes == 0 {
        return Err("create_group produced no welcome rumor".to_string());
    }
    if members != 2 {
        return Err(format!("expected 2 members, got {members}"));
    }
    Ok(format!("ok group={} welcomes={} members={}", &gid[..16.min(gid.len())], welcomes, members))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlcipher_open_and_mls_group_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let summary = loopback(dir.path()).expect("loopback");
        assert!(summary.starts_with("ok group="), "{summary}");
    }

    #[test]
    fn store_is_actually_encrypted() {
        // A SQLCipher db has no readable "SQLite format 3" header.
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();
        let path = dir.path().join("enc.db");
        let _ = MarmotService::open(&path, &keys.secret_key().to_secret_hex()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() > 16);
        assert_ne!(&bytes[0..16], b"SQLite format 3\0", "db should be SQLCipher-encrypted");
    }
}
