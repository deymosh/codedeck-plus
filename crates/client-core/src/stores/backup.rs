//! `backup` — the phone's configuration as one encrypted Nostr event on a
//! relay the user picks, so a new phone (or a reinstalled one) with the same
//! identity picks up where the old one left off.
//!
//! A bridge knows a phone by its identity pubkey, so what a restored phone
//! needs is only what the phone alone knows: each paired machine's relays,
//! label, direct endpoints and new-session defaults, the settings and the
//! quick prompts. Everything a bridge re-sends in its heartbeat (sessions,
//! agents, credentials, models, folders) is left out, as is anything about
//! one device.
//!
//! The session keys go in too, with each machine's confirmed grant: a
//! restored phone then reads what its bridges encrypt to those keys at once,
//! instead of asking the identity's signer to grant every bridge again. A
//! session key never signs, so whoever reads it can read payloads but never
//! command a bridge; and the backup is readable only with the identity,
//! which reads every payload anyway. The phone adopts the backup's keys only
//! while it has granted none of its own ([`merge_backup`]).
//!
//! The event is NIP-78 application data: kind [`BACKUP_KIND`], addressable,
//! so a relay keeps only the latest one per `d` tag. The `d` tag
//! ([`backup_d_tag`]) is a hash of the identity and a context only this app
//! uses: it names no app to someone browsing the relay, and no other app's
//! data can share it. The content is the [`ConfigBackup`] JSON, NIP-44
//! encrypted to the identity itself. What stays public is what any event
//! shows: the pubkey, the kind and when it was saved.
//!
//! Pure: building, decoding and merging a backup. Encrypting, signing and
//! the relay are the runtime's.

use nostr::hashes::{sha256, Hash};
use serde::{Deserialize, Serialize};

use super::machines::{AgentDefaults, MachinesState};
use super::pairing::is_relay_url;
use super::quick_prompts::{QuickPrompt, QuickPromptsState};
use super::session_key::{SessionGrant, SessionKeyRing, StoredRing};
use super::settings::{clamp_ui_scale, SettingsData, SettingsState};

use std::collections::BTreeMap;

/// NIP-78 application-specific data (addressable).
pub const BACKUP_KIND: u16 = 30078;
/// NIP-09 deletion.
pub const DELETION_KIND: u16 = 5;
/// The payload version this build writes and reads.
pub const BACKUP_VERSION: u32 = 1;
/// Hashed with the identity into the `d` tag; changing it moves every
/// backup to a new address.
const D_TAG_CONTEXT: &str = "codedeck-plus/config-backup/v1";
/// Where the backup relay is kept on the phone (never in the backup).
pub const BACKUP_STORAGE_KEY: &str = "backup";

/// The backup's `d` tag for identity `pubkey_hex`: hex sha256 of the
/// context, a colon and the pubkey (lowercase). Deterministic, so a new phone
/// finds it with the identity alone.
pub fn backup_d_tag(pubkey_hex: &str) -> String {
    let input = format!("{D_TAG_CONTEXT}:{}", pubkey_hex.to_ascii_lowercase());
    sha256::Hash::hash(input.as_bytes()).to_string()
}

/// The `a` address a NIP-09 deletion of the backup names.
pub fn backup_address(pubkey_hex: &str) -> String {
    format!("{BACKUP_KIND}:{}:{}", pubkey_hex.to_ascii_lowercase(), backup_d_tag(pubkey_hex))
}

/// One paired machine, as only the phone knows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMachine {
    pub pubkey_hex: String,
    /// What the bridge last called itself: shown until its next heartbeat.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub relays: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub direct_endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_defaults: BTreeMap<String, AgentDefaults>,
    /// The session-key grant this bridge confirmed, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_grant: Option<SessionGrant>,
}

/// The backup's plaintext.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackup {
    pub v: u32,
    /// When it was made, in ms since the epoch.
    pub saved_at: u64,
    pub machines: Vec<BackupMachine>,
    pub settings: SettingsData,
    pub quick_prompts: Vec<QuickPrompt>,
    /// The phone's session keys, with their secrets and expiries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_keys: Option<StoredRing>,
}

/// The backup of the current state.
pub fn build_backup(
    machines: &MachinesState,
    settings: &SettingsData,
    prompts: &[QuickPrompt],
    ring: &SessionKeyRing,
    saved_at: u64,
) -> ConfigBackup {
    ConfigBackup {
        v: BACKUP_VERSION,
        saved_at,
        session_keys: Some(ring.stored()),
        machines: machines
            .machines
            .values()
            .map(|m| BackupMachine {
                pubkey_hex: m.pubkey_hex.clone(),
                name: m.name.clone(),
                label: m.label.clone(),
                relays: m.relays.clone(),
                direct_endpoints: m.direct_endpoints.clone(),
                default_agent: m.default_agent.clone(),
                agent_defaults: m.agent_defaults.clone(),
                session_grant: m.session_grant.clone(),
            })
            .collect(),
        settings: settings.clone(),
        quick_prompts: prompts.to_vec(),
    }
}

pub fn encode_backup(backup: &ConfigBackup) -> String {
    serde_json::to_string(backup).expect("ConfigBackup serializes")
}

/// What the backup holds, whenever it was made: two backups with the same
/// fingerprint need not both be saved.
pub fn backup_fingerprint(backup: &ConfigBackup) -> String {
    let content = ConfigBackup { saved_at: 0, ..backup.clone() };
    sha256::Hash::hash(encode_backup(&content).as_bytes()).to_string()
}

/// Decode a backup's plaintext. Total: bad JSON, another version, or a
/// machine with no relay the phone may dial is an error to show, never a
/// panic. A machine's relays the phone may not dial are dropped.
pub fn decode_backup(json: &str) -> Result<ConfigBackup, String> {
    let raw: serde_json::Value = serde_json::from_str(json).map_err(|_| "The backup could not be read.".to_string())?;
    match raw.get("v").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(BACKUP_VERSION) => {}
        Some(v) if v > u64::from(BACKUP_VERSION) => {
            return Err("The backup was made by a newer version of the app. Update it and try again.".into())
        }
        _ => return Err("The backup could not be read.".into()),
    }
    let mut backup: ConfigBackup =
        serde_json::from_value(raw).map_err(|_| "The backup could not be read.".to_string())?;
    backup.settings.ui_scale = clamp_ui_scale(backup.settings.ui_scale);
    for m in &mut backup.machines {
        m.relays.retain(|r| is_relay_url(r));
    }
    backup.machines.retain(|m| !m.pubkey_hex.is_empty() && !m.relays.is_empty());
    Ok(backup)
}

/// What an import did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportSummary {
    /// Machines the phone did not have.
    pub added: usize,
    /// Machines it had, left as they were.
    pub kept: usize,
    /// Whether the phone took the backup's session keys (the host must
    /// store the ring again and encrypt under it).
    pub adopted_keys: bool,
}

/// Merge `backup` into the phone: the machines it does not have are added
/// (as they were, offline until each bridge is heard from), the ones it has
/// keep their own configuration, and the settings and quick prompts become
/// the backup's.
///
/// The backup's session keys replace `ring` only while no bridge holds or
/// awaits a grant of the phone's own (a phone that has granted its keys
/// would otherwise strand those bridges on a key it no longer has), and
/// only if they are still live. A machine then gets back the grant it had
/// confirmed, if it names a live key of the ring the phone ends up with;
/// any other is granted afresh when next heard from.
pub fn merge_backup(
    backup: &ConfigBackup,
    machines: &mut MachinesState,
    settings: &mut SettingsState,
    prompts: &mut QuickPromptsState,
    ring: &mut SessionKeyRing,
    now_ms: u64,
) -> ImportSummary {
    let mut summary = ImportSummary::default();
    let granted = machines.machines.values().any(|m| m.session_grant.is_some() || m.session_grant_sent.is_some());
    if !granted {
        if let Some(theirs) = backup.session_keys.as_ref().and_then(|s| SessionKeyRing::from_stored(s, now_ms)) {
            *ring = theirs;
            summary.adopted_keys = true;
        }
    }
    for m in &backup.machines {
        if machines.machine(&m.pubkey_hex).is_some() {
            summary.kept += 1;
        } else {
            machines.register_machine(&m.pubkey_hex, &m.name, m.label.clone(), None, &m.relays);
            machines.set_direct_endpoints(&m.pubkey_hex, m.direct_endpoints.clone());
            machines.set_default_agent(&m.pubkey_hex, m.default_agent.clone());
            for (agent, defaults) in &m.agent_defaults {
                machines.set_agent_defaults(&m.pubkey_hex, agent, defaults.clone());
            }
            summary.added += 1;
        }
        let grant = m.session_grant.as_ref().filter(|g| g.expires_at > now_ms / 1000 && ring.key(&g.pubkey_hex, now_ms).is_some());
        if let (Some(grant), Some(here)) = (grant, machines.machines.get_mut(&m.pubkey_hex)) {
            if here.session_grant.is_none() && here.session_grant_sent.is_none() {
                here.session_grant = Some(grant.clone());
            }
        }
    }
    settings.data = backup.settings.clone();
    prompts.prompts = backup.quick_prompts.clone();
    summary
}

/// The backup relay, kept on the phone apart from the backup.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    /// `None`: backup is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// When a backup last reached the relay, in ms since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<u64>,
    /// The fingerprint of what was last saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// Tolerant hydrate: anything unreadable is backup off.
pub fn hydrate_backup_config(raw: Option<&str>) -> BackupConfig {
    let config: BackupConfig = raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or_default();
    match &config.relay {
        Some(relay) if !is_relay_url(relay) => BackupConfig::default(),
        _ => config,
    }
}

pub fn serialize_backup_config(config: &BackupConfig) -> String {
    serde_json::to_string(config).expect("BackupConfig serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::machines::MergeOptions;
    use crate::stores::settings::default_settings;

    const ID: &str = "AB12cd";
    const NOW: u64 = 1_700_000_000_000;

    fn ring() -> SessionKeyRing {
        SessionKeyRing::load(None, NOW).0
    }

    fn phone() -> (MachinesState, SettingsState, QuickPromptsState) {
        let mut machines = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        machines.register_machine("m1", "laptop", Some("Work".into()), None, &["wss://relay.one".to_string()]);
        machines.set_direct_endpoints("m1", vec!["wss://laptop.tailnet:7447".into()]);
        machines.set_default_agent("m1", Some("opencode".into()));
        machines.set_agent_defaults("m1", "claude", AgentDefaults { mode: "plan".into(), effort: String::new(), model: String::new() });
        let mut settings = SettingsState::default();
        settings.set_tor_proxy_enabled(true);
        let prompts = QuickPromptsState::from_hydrated(vec![QuickPrompt { id: "q".into(), label: "Go".into(), text: "Continue".into() }]);
        (machines, settings, prompts)
    }

    #[test]
    fn the_d_tag_is_a_hash_of_the_identity_and_names_no_app() {
        let tag = backup_d_tag(ID);
        assert_eq!(tag.len(), 64);
        assert!(tag.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!tag.contains("codedeck"));
        // The same for the same identity, whatever its case; another for another.
        assert_eq!(tag, backup_d_tag(&ID.to_ascii_lowercase()));
        assert_ne!(tag, backup_d_tag("ab12ce"));
        assert_eq!(backup_address(ID), format!("30078:ab12cd:{tag}"));
    }

    #[test]
    fn a_backup_holds_only_what_the_phone_alone_knows_and_round_trips() {
        let (mut machines, settings, prompts) = phone();
        // A heartbeat's worth of data the bridge would send again.
        machines.machines.get_mut("m1").unwrap().folders = vec!["repo".into()];
        let backup = build_backup(&machines, &settings.data, &prompts.prompts, &ring(), 7);
        let json = encode_backup(&backup);
        assert!(!json.contains("repo") && !json.contains("sessions"));
        assert_eq!(decode_backup(&json).unwrap(), backup);
    }

    #[test]
    fn the_fingerprint_ignores_when_it_was_made() {
        let (machines, settings, prompts) = phone();
        let keys = ring();
        let a = build_backup(&machines, &settings.data, &prompts.prompts, &keys, 1);
        let b = build_backup(&machines, &settings.data, &prompts.prompts, &keys, 2);
        assert_eq!(backup_fingerprint(&a), backup_fingerprint(&b));
        let mut c = b.clone();
        c.quick_prompts.clear();
        assert_ne!(backup_fingerprint(&a), backup_fingerprint(&c));
    }

    #[test]
    fn importing_adds_the_missing_machines_and_keeps_the_ones_the_phone_has() {
        let (machines, settings, prompts) = phone();
        let mut backup = build_backup(&machines, &settings.data, &prompts.prompts, &ring(), 1);
        backup.machines.push(BackupMachine {
            pubkey_hex: "m2".into(),
            name: "vps".into(),
            label: None,
            relays: vec!["wss://relay.two".into()],
            direct_endpoints: vec![],
            default_agent: None,
            agent_defaults: BTreeMap::new(),
            session_grant: None,
        });

        // A phone that already has m1, labelled its own way.
        let mut here = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        here.register_machine("m1", "laptop", Some("Mine".into()), None, &["wss://relay.local".to_string()]);
        let mut here_settings = SettingsState::new(default_settings());
        let mut here_prompts = QuickPromptsState::default();

        let summary = merge_backup(&backup, &mut here, &mut here_settings, &mut here_prompts, &mut ring(), NOW);
        assert_eq!(summary, ImportSummary { added: 1, kept: 1, adopted_keys: true });
        assert_eq!(here.machine("m1").unwrap().label.as_deref(), Some("Mine"));
        assert_eq!(here.machine("m2").unwrap().relays, ["wss://relay.two"]);
        assert!(here_settings.data.tor_proxy_enabled);
        assert_eq!(here_prompts.prompts.len(), 1);

        // Everything a fresh phone gets back.
        let mut fresh = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        merge_backup(&backup, &mut fresh, &mut SettingsState::default(), &mut QuickPromptsState::default(), &mut ring(), NOW);
        let m1 = fresh.machine("m1").unwrap();
        assert_eq!((m1.label.as_deref(), m1.default_agent.as_deref()), (Some("Work"), Some("opencode")));
        assert_eq!(m1.direct_endpoints, ["wss://laptop.tailnet:7447"]);
        assert_eq!(m1.agent_defaults["claude"].mode, "plan");
    }

    #[test]
    fn a_bad_or_newer_backup_is_an_error_not_a_panic() {
        assert!(decode_backup("not json").is_err());
        assert!(decode_backup(r#"{"v":1}"#).is_err());
        assert!(decode_backup(r#"{"v":99}"#).unwrap_err().contains("newer version"));
        // A machine with no relay the phone may dial is dropped.
        let (machines, settings, prompts) = phone();
        let mut backup = build_backup(&machines, &settings.data, &prompts.prompts, &ring(), 1);
        backup.machines[0].relays = vec!["http://plain.example".into()];
        assert!(decode_backup(&encode_backup(&backup)).unwrap().machines.is_empty());
    }

    fn grant(key: &SessionKeyRing) -> SessionGrant {
        SessionGrant { pubkey_hex: key.current.pubkey_hex().to_string(), expires_at: key.current.expires_at, sent_at: NOW / 1000 }
    }

    #[test]
    fn a_fresh_phone_takes_the_session_keys_and_the_confirmed_grants() {
        let (mut machines, settings, prompts) = phone();
        let theirs = ring();
        machines.machines.get_mut("m1").unwrap().session_grant = Some(grant(&theirs));
        let backup = build_backup(&machines, &settings.data, &prompts.prompts, &theirs, 1);
        // The secrets travel only inside the encrypted content, and no Debug shows them.
        let secret = theirs.current.keypair.secret_hex();
        assert!(encode_backup(&backup).contains(&secret));
        assert!(!format!("{backup:?}").contains(&secret));
        let backup = decode_backup(&encode_backup(&backup)).unwrap();

        let mut fresh = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        let mut mine = ring();
        let summary = merge_backup(&backup, &mut fresh, &mut SettingsState::default(), &mut QuickPromptsState::default(), &mut mine, NOW);
        assert!(summary.adopted_keys);
        assert_eq!(mine.current.keypair.secret_hex(), secret);
        assert_eq!(fresh.session_key_of("m1", NOW), Some(theirs.current.pubkey_hex()));
    }

    #[test]
    fn a_phone_that_granted_its_own_keys_keeps_them() {
        let (mut machines, settings, prompts) = phone();
        let theirs = ring();
        machines.machines.get_mut("m1").unwrap().session_grant = Some(grant(&theirs));
        let backup = build_backup(&machines, &settings.data, &prompts.prompts, &theirs, 1);

        let mut here = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        here.register_machine("m0", "desk", None, None, &["wss://relay.local".to_string()]);
        let mut mine = ring();
        here.machines.get_mut("m0").unwrap().session_grant_sent = Some(grant(&mine));
        let own = mine.current.pubkey_hex().to_string();
        let summary = merge_backup(&backup, &mut here, &mut SettingsState::default(), &mut QuickPromptsState::default(), &mut mine, NOW);
        assert!(!summary.adopted_keys);
        assert_eq!(mine.current.pubkey_hex(), own);
        // m1's grant names a key this phone does not hold: it is granted afresh.
        assert!(here.machine("m1").unwrap().session_grant.is_none());
    }

    #[test]
    fn lapsed_session_keys_are_not_taken() {
        let (machines, settings, prompts) = phone();
        let theirs = ring();
        let backup = build_backup(&machines, &settings.data, &prompts.prompts, &theirs, 1);
        let later = (theirs.current.expires_at + 1) * 1000;
        let mut fresh = MachinesState::new(BTreeMap::new(), MergeOptions::default());
        let mut mine = SessionKeyRing::load(None, later).0;
        let summary = merge_backup(&backup, &mut fresh, &mut SettingsState::default(), &mut QuickPromptsState::default(), &mut mine, later);
        assert!(!summary.adopted_keys);
        assert_ne!(mine.current.pubkey_hex(), theirs.current.pubkey_hex());
    }

    #[test]
    fn the_backup_relay_hydrates_tolerantly() {
        assert_eq!(hydrate_backup_config(None), BackupConfig::default());
        assert_eq!(hydrate_backup_config(Some("garbage")), BackupConfig::default());
        assert_eq!(hydrate_backup_config(Some(r#"{"relay":"http://x"}"#)), BackupConfig::default());
        let config = BackupConfig { relay: Some("wss://r".into()), saved_at: Some(5), fingerprint: None };
        assert_eq!(hydrate_backup_config(Some(&serialize_backup_config(&config))), config);
    }
}
