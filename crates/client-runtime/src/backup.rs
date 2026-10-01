//! The config backup's events: sealing the phone's configuration into one
//! (NIP-44 encrypted to the identity itself, then signed), opening one, and
//! the deletion that withdraws it. What goes in the backup, and merging it
//! back, is `client_core::stores::backup`; when to save and fetch is the
//! runtime loop's.
//!
//! Only the identity can read a backup: its content is NIP-44 encrypted from
//! the identity to the identity, through the identity's signer (so a key held
//! by a NIP-55 signer app works the same way). The relay sees the pubkey,
//! the kind, when it was saved and an opaque `d` tag — nothing of what is in
//! it.

use client_core::stores::backup::{
    backup_address, backup_d_tag, decode_backup, encode_backup, ConfigBackup, BACKUP_KIND, DELETION_KIND,
};
use nostr::{EventBuilder, Kind, PublicKey, Tag, TagKind, Timestamp, UnsignedEvent};
use nostr_transport::NostrEvent;
use protocol::nostr_event::SignedEvent;

use crate::signer::{sign, IdentitySigner};

/// Where a backup operation stands, as the settings page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum BackupStatus {
    /// Nothing going on (backup off, or on and up to date).
    #[default]
    Idle,
    /// Looking on the relay for a backup.
    Checking,
    /// A backup is on the relay: import it, or keep this phone's.
    Found {
        #[specta(type = specta_typescript::Number)]
        saved_at: u64,
        machines: u32,
    },
    Saving,
    Importing,
    /// The last operation failed; `reason` says why, for the user.
    Failed { reason: String },
}

fn unsigned(signer: &dyn IdentitySigner, kind: u16, content: String, tags: Vec<Tag>, created_at: u64) -> Result<UnsignedEvent, String> {
    let author = PublicKey::from_hex(&signer.pubkey_hex()).map_err(|e| e.to_string())?;
    let mut event = EventBuilder::new(Kind::Custom(kind), content)
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .build(author);
    event.ensure_id();
    Ok(event)
}

/// `backup` as a signed event, dated `created_at` (seconds): its content
/// encrypted to the identity itself.
pub async fn seal_backup(signer: &dyn IdentitySigner, backup: &ConfigBackup, created_at: u64) -> Result<SignedEvent, String> {
    let me = signer.pubkey_hex();
    let content = signer
        .nip44_encrypt(&me, &encode_backup(backup))
        .await
        .map_err(|e| format!("The backup could not be encrypted: {e}"))?;
    let tags = vec![Tag::identifier(backup_d_tag(&me))];
    let event = unsigned(signer, BACKUP_KIND, content, tags, created_at)?;
    let signed = sign(signer, event).await.map_err(|e| format!("The backup could not be signed: {e}"))?;
    Ok(SignedEvent::from_nostr(&signed))
}

/// The backup `event` holds. Only one the identity wrote to itself opens.
pub async fn open_backup(signer: &dyn IdentitySigner, event: &NostrEvent) -> Result<ConfigBackup, String> {
    let me = signer.pubkey_hex();
    if event.kind != BACKUP_KIND || !event.pubkey.eq_ignore_ascii_case(&me) {
        return Err("The backup could not be read.".into());
    }
    let plaintext = signer
        .nip44_decrypt(&me, &event.content)
        .await
        .map_err(|_| "The backup could not be decrypted with this key.".to_string())?;
    decode_backup(&plaintext)
}

/// The newest of `events` that could be the identity's backup.
pub fn newest_backup<'a>(events: &'a [NostrEvent], me: &str) -> Option<&'a NostrEvent> {
    events
        .iter()
        .filter(|e| e.kind == BACKUP_KIND && e.pubkey.eq_ignore_ascii_case(me))
        .max_by_key(|e| e.created_at)
}

/// A NIP-09 deletion of the identity's backup, dated `created_at`.
pub async fn seal_deletion(signer: &dyn IdentitySigner, created_at: u64) -> Result<SignedEvent, String> {
    let me = signer.pubkey_hex();
    let tags = vec![
        Tag::custom(TagKind::a(), [backup_address(&me)]),
        Tag::custom(TagKind::k(), [BACKUP_KIND.to_string()]),
    ];
    let event = unsigned(signer, DELETION_KIND, String::new(), tags, created_at)?;
    let signed = sign(signer, event).await.map_err(|e| e.to_string())?;
    Ok(SignedEvent::from_nostr(&signed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::LocalSigner;
    use client_core::stores::machines::{MachinesState, MergeOptions};
    use client_core::stores::quick_prompts::QuickPrompt;
    use client_core::stores::settings::default_settings;
    use protocol::crypto::generate_keypair;
    use std::collections::BTreeMap;

    const MACHINE: &str = "4f3c2b1a09f8e7d6c5b4a3928170615f4e3d2c1b0a9f8e7d6c5b4a3928170615";
    const SESSION_SECRET: &str = "7e57000000000000000000000000000000000000000000000000000000000001";

    fn backup() -> ConfigBackup {
        let mut machines = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        machines.register_machine(MACHINE, "my laptop", Some("Secret lab".into()), None, &["wss://private.relay".to_string()]);
        let prompts = [QuickPrompt { id: "q".into(), label: "Deploy".into(), text: "ship it".into() }];
        let stored = format!(r#"{{"current":{{"secretHex":"{SESSION_SECRET}","expiresAt":99999999999}}}}"#);
        let ring = client_core::stores::session_key::SessionKeyRing::load(Some(&stored), 1_000).0;
        client_core::stores::backup::build_backup(&machines, &default_settings(), &prompts, &ring, 42)
    }

    fn as_received(e: &SignedEvent) -> NostrEvent {
        NostrEvent { id: e.id.clone(), kind: e.kind, created_at: e.created_at as i64, pubkey: e.pubkey.clone(), content: e.content.clone() }
    }

    #[tokio::test]
    async fn a_sealed_backup_shows_nothing_of_what_is_in_it_and_only_its_identity_opens_it() {
        let me = LocalSigner(generate_keypair());
        let event = seal_backup(&me, &backup(), 1_000).await.unwrap();
        assert_eq!(event.kind, BACKUP_KIND);
        assert_eq!(event.created_at, 1_000);
        // The only tag is the opaque d tag.
        assert_eq!(event.tags, vec![vec!["d".to_string(), backup_d_tag(&me.pubkey_hex())]]);
        let wire = serde_json::to_string(&event).unwrap();
        // Each has a space or a dot, or is long: none can turn up by chance in
        // base64 ciphertext or a hex id.
        for secret in ["Secret lab", "private.relay", "my laptop", "ship it", MACHINE, SESSION_SECRET] {
            assert!(!wire.contains(secret), "{secret} is readable in {wire}");
        }
        assert_eq!(open_backup(&me, &as_received(&event)).await.unwrap(), backup());

        // Another identity cannot read it, even handed the event as its own.
        let other = LocalSigner(generate_keypair());
        let mut stolen = as_received(&event);
        assert!(open_backup(&other, &stolen).await.is_err());
        stolen.pubkey = other.pubkey_hex();
        assert!(open_backup(&other, &stolen).await.is_err());
    }

    #[tokio::test]
    async fn the_newest_backup_is_the_one_taken() {
        let me = LocalSigner(generate_keypair());
        let old = as_received(&seal_backup(&me, &backup(), 1).await.unwrap());
        let new = as_received(&seal_backup(&me, &backup(), 2).await.unwrap());
        let events = [old, new.clone()];
        assert_eq!(newest_backup(&events, &me.pubkey_hex()), Some(&new));
        assert_eq!(newest_backup(&events, "someone-else"), None);
    }

    #[tokio::test]
    async fn a_deletion_names_the_backup_by_its_address() {
        let me = LocalSigner(generate_keypair());
        let event = seal_deletion(&me, 5).await.unwrap();
        assert_eq!(event.kind, DELETION_KIND);
        assert!(event.tags.contains(&vec!["a".to_string(), backup_address(&me.pubkey_hex())]));
        assert!(event.tags.contains(&vec!["k".to_string(), "30078".to_string()]));
    }
}
