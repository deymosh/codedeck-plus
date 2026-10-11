//! `backup` — what an identity's clients share, as one encrypted Nostr event
//! on a relay the user picks: every device with the same identity (a phone,
//! a desktop, a reinstall) keeps it in step and restores from it.
//!
//! A bridge knows an identity, not a device: a machine paired from one
//! device takes commands from any device of the identity. So what the
//! backup holds is what the devices need to reach their machines — each
//! paired machine's relays, label, direct endpoints and new-session
//! defaults — and the quick prompts. Everything a bridge re-sends in its
//! heartbeat (sessions, agents, credentials, models, folders) is left out;
//! so is everything about one device: its settings (scale, notifications,
//! Tor, the image server) and its session keys. A restored or added device
//! makes keys of its own and is its own client of each bridge.
//!
//! **Several writers.** Every device reads the backup, merges it with what
//! it has, and writes the result when it holds anything newer, so no device
//! overwrites another's change. Each machine carries when its shared fields
//! last changed, and a removed machine leaves a tombstone with when it was
//! removed: per machine, the newest of an entry and a tombstone wins, so a
//! machine removed on one device is removed on every device, and pairing it
//! again later brings it back. The quick prompts go as one list, the newest
//! wins. On a tie the backup's side wins, in every comparison, so two
//! devices never each keep their own. Tombstones are kept
//! [`TOMBSTONE_KEEP_MS`].
//!
//! A device learns of its own edits by comparing what it has with what it
//! last agreed with the backup ([`SyncRecord`], kept on the device, never in
//! the backup): a machine whose shared fields changed was edited now, one
//! gone was removed now. What a device had before it first took part
//! counts as older than anything in the backup, so turning backup on never
//! overrides another device's newer edits with stale ones.
//!
//! **Clocks.** Stamps come from each device's wall clock, which may be off.
//! So an edit is stamped no earlier than just after the newest stamp the
//! device has seen ([`SyncRecord::latest`]): an edit made after seeing
//! another device's change always wins over it, however far ahead that
//! device's clock ran. A clock running ahead only moves every device's
//! stamps forward with it; it never makes a later edit lose.
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

use super::machines::{AgentDefaults, MachineView, MachinesState};
use super::pairing::is_relay_url;
use super::quick_prompts::{QuickPrompt, QuickPromptsState};

use std::collections::BTreeMap;

/// NIP-78 application-specific data (addressable).
pub const BACKUP_KIND: u16 = 30078;
/// NIP-09 deletion.
pub const DELETION_KIND: u16 = 5;
/// The payload version this build writes and reads.
pub const BACKUP_VERSION: u32 = 2;
/// Hashed with the identity into the `d` tag; changing it moves every
/// backup to a new address.
const D_TAG_CONTEXT: &str = "codedeck-plus/config-backup/v2";
/// Where the backup relay is kept on the phone (never in the backup).
pub const BACKUP_STORAGE_KEY: &str = "backup";
/// How long a removed machine's tombstone is kept: long enough for every
/// device of the identity in use to have been opened since. A device left
/// unopened for longer can bring a machine removed meanwhile back; removing
/// it again removes it everywhere.
pub const TOMBSTONE_KEEP_MS: u64 = 30 * 24 * 3600 * 1000;

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

/// One paired machine, as the identity's devices share it.
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
    /// When its shared fields last changed, in ms since the epoch.
    pub changed_at: u64,
}

/// The backup's plaintext.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBackup {
    pub v: u32,
    /// When it was made, in ms since the epoch.
    pub saved_at: u64,
    pub machines: Vec<BackupMachine>,
    /// Machines removed, by pubkey: when (ms).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub removed_machines: BTreeMap<String, u64>,
    pub quick_prompts: Vec<QuickPrompt>,
    /// When the quick prompts last changed (ms).
    pub prompts_changed_at: u64,
}

/// What a device last agreed with the backup about one thing: the
/// fingerprint of what it held, and when that last changed (ms).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub fingerprint: String,
    pub changed_at: u64,
}

/// What this device last agreed with the backup: kept on the device, so it
/// can tell its own edits and removals from what the backup brought.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    /// When this device first took part (ms); `None` until it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub machines: BTreeMap<String, Stamp>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub removed_machines: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Stamp>,
    /// The newest stamp this device has made or seen (ms): its next edit
    /// is stamped after it.
    #[serde(default)]
    pub latest: u64,
}

/// The fields of `m` the identity's devices share, as a fingerprint.
fn machine_fingerprint(m: &MachineView) -> String {
    shared_fingerprint(&m.label, &m.relays, &m.direct_endpoints, &m.default_agent, &m.agent_defaults)
}

fn backup_machine_fingerprint(m: &BackupMachine) -> String {
    shared_fingerprint(&m.label, &m.relays, &m.direct_endpoints, &m.default_agent, &m.agent_defaults)
}

fn shared_fingerprint(
    label: &Option<String>,
    relays: &[String],
    direct_endpoints: &[String],
    default_agent: &Option<String>,
    agent_defaults: &BTreeMap<String, AgentDefaults>,
) -> String {
    let shared = serde_json::json!([label, relays, direct_endpoints, default_agent, agent_defaults]);
    sha256::Hash::hash(shared.to_string().as_bytes()).to_string()
}

fn prompts_fingerprint(prompts: &[QuickPrompt]) -> String {
    sha256::Hash::hash(serde_json::to_string(prompts).expect("prompts serialize").as_bytes()).to_string()
}

impl SyncRecord {
    /// Stamp what changed on this device since it last agreed with the
    /// backup: an edited or new machine changed now, one gone was removed
    /// now, likewise the quick prompts. On a device's first time, what it
    /// has counts as older than anything the backup holds. Returns whether
    /// anything was stamped.
    pub fn note_local_changes(&mut self, machines: &MachinesState, prompts: &[QuickPrompt], now_ms: u64) -> bool {
        let first = self.since.is_none();
        let edit_at = now_ms.max(self.latest + 1);
        let stamp_at = if first { 0 } else { edit_at };
        self.since.get_or_insert(now_ms);
        let mut changed = first;
        for (pubkey, m) in &machines.machines {
            let fingerprint = machine_fingerprint(m);
            if self.machines.get(pubkey).is_none_or(|s| s.fingerprint != fingerprint) {
                self.machines.insert(pubkey.clone(), Stamp { fingerprint, changed_at: stamp_at });
                self.removed_machines.remove(pubkey);
                changed = true;
            }
        }
        let gone: Vec<String> = self.machines.keys().filter(|p| !machines.machines.contains_key(*p)).cloned().collect();
        for pubkey in gone {
            self.machines.remove(&pubkey);
            self.removed_machines.insert(pubkey, edit_at);
            changed = true;
        }
        let fingerprint = prompts_fingerprint(prompts);
        if self.prompts.as_ref().is_none_or(|s| s.fingerprint != fingerprint) {
            self.prompts = Some(Stamp { fingerprint, changed_at: stamp_at });
            changed = true;
        }
        if changed && !first {
            self.latest = edit_at;
        }
        changed
    }

    /// Note a stamp seen in the backup.
    fn saw(&mut self, stamp: u64) {
        self.latest = self.latest.max(stamp);
    }

    /// Forget tombstones older than [`TOMBSTONE_KEEP_MS`].
    fn prune(&mut self, now_ms: u64) {
        self.removed_machines.retain(|_, at| now_ms.saturating_sub(*at) < TOMBSTONE_KEEP_MS);
    }
}

/// The backup of what this device has, stamped as `sync` records it (call
/// [`SyncRecord::note_local_changes`] first).
pub fn build_backup(machines: &MachinesState, prompts: &[QuickPrompt], sync: &SyncRecord, saved_at: u64) -> ConfigBackup {
    ConfigBackup {
        v: BACKUP_VERSION,
        saved_at,
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
                changed_at: sync.machines.get(&m.pubkey_hex).map_or(0, |s| s.changed_at),
            })
            .collect(),
        removed_machines: sync
            .removed_machines
            .iter()
            .filter(|(_, at)| saved_at.saturating_sub(**at) < TOMBSTONE_KEEP_MS)
            .map(|(p, at)| (p.clone(), *at))
            .collect(),
        quick_prompts: prompts.to_vec(),
        prompts_changed_at: sync.prompts.as_ref().map_or(0, |s| s.changed_at),
    }
}

pub fn encode_backup(backup: &ConfigBackup) -> String {
    serde_json::to_string(backup).expect("ConfigBackup serializes")
}

/// What the backup holds, whenever it was made and whatever each device
/// last heard its machines call themselves: two backups with the same
/// fingerprint need not both be saved. A machine's name is not merged (its
/// heartbeat says it again), so two devices may hold different ones; were it
/// counted, each would save over the other's for ever.
pub fn backup_fingerprint(backup: &ConfigBackup) -> String {
    let mut content = ConfigBackup { saved_at: 0, ..backup.clone() };
    for m in &mut content.machines {
        m.name.clear();
    }
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
    for m in &mut backup.machines {
        m.relays.retain(|r| is_relay_url(r));
    }
    backup.machines.retain(|m| !m.pubkey_hex.is_empty() && !m.relays.is_empty());
    Ok(backup)
}

/// What a merge did to this device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeOutcome {
    /// Machines it did not have.
    pub added: usize,
    /// Machines whose shared fields another device changed later.
    pub updated: usize,
    /// Machines another device removed later than this one last changed
    /// them: the caller removes them, with everything kept about them.
    pub removed: Vec<String>,
    /// Whether the quick prompts became the backup's.
    pub prompts_changed: bool,
}

/// Merge `backup` into this device: per machine, whichever of the device's
/// entry or tombstone, the backup's entry and the backup's tombstone changed
/// last wins; the quick prompts likewise as one list. On a tie the backup's
/// wins, every time: so a device joining with what it had before (stamped
/// as older than anything) takes what the others share, and two devices
/// whose sides tie end up with the same one, never each with its own.
/// `sync` is brought up to date. Afterwards, [`build_backup`] gives what to
/// save if it differs from `backup`.
pub fn merge_backup(
    backup: &ConfigBackup,
    machines: &mut MachinesState,
    prompts: &mut QuickPromptsState,
    sync: &mut SyncRecord,
    now_ms: u64,
) -> MergeOutcome {
    sync.note_local_changes(machines, &prompts.prompts, now_ms);
    let stamps = backup.machines.iter().map(|m| m.changed_at).chain(backup.removed_machines.values().copied());
    for stamp in stamps.chain([backup.prompts_changed_at]) {
        sync.saw(stamp);
    }
    let mut outcome = MergeOutcome::default();
    for theirs in &backup.machines {
        let pubkey = &theirs.pubkey_hex;
        let removed_here = sync.removed_machines.get(pubkey).is_some_and(|at| *at > theirs.changed_at);
        let newer_here = machines.machine(pubkey).is_some()
            && sync.machines.get(pubkey).is_some_and(|s| {
                s.changed_at > theirs.changed_at
                    || (s.changed_at == theirs.changed_at && s.fingerprint == backup_machine_fingerprint(theirs))
            });
        if removed_here || newer_here {
            continue;
        }
        if machines.machine(pubkey).is_some() {
            outcome.updated += 1;
        } else {
            machines.register_machine(pubkey, &theirs.name, None, None, &[]);
            outcome.added += 1;
        }
        machines.set_label(pubkey, theirs.label.clone());
        machines.set_relays(pubkey, theirs.relays.clone());
        machines.set_direct_endpoints(pubkey, theirs.direct_endpoints.clone());
        machines.set_default_agent(pubkey, theirs.default_agent.clone());
        machines.replace_agent_defaults(pubkey, theirs.agent_defaults.clone());
        if let Some(m) = machines.machine(pubkey) {
            sync.machines.insert(pubkey.clone(), Stamp { fingerprint: machine_fingerprint(m), changed_at: theirs.changed_at });
        }
        sync.removed_machines.remove(pubkey);
    }
    for (pubkey, removed_at) in &backup.removed_machines {
        let here = sync.machines.get(pubkey).map(|s| s.changed_at);
        match here {
            Some(changed_at) if changed_at > *removed_at => continue,
            Some(_) if machines.machine(pubkey).is_some() => outcome.removed.push(pubkey.clone()),
            _ => {}
        }
        sync.machines.remove(pubkey);
        let at = sync.removed_machines.entry(pubkey.clone()).or_default();
        *at = (*at).max(*removed_at);
    }
    let theirs = prompts_fingerprint(&backup.quick_prompts);
    let older_here = sync.prompts.as_ref().is_none_or(|s| {
        s.changed_at < backup.prompts_changed_at || (s.changed_at == backup.prompts_changed_at && s.fingerprint != theirs)
    });
    if older_here {
        prompts.prompts = backup.quick_prompts.clone();
        sync.prompts = Some(Stamp { fingerprint: prompts_fingerprint(&prompts.prompts), changed_at: backup.prompts_changed_at });
        outcome.prompts_changed = true;
    }
    sync.prune(now_ms);
    outcome
}

/// The backup relay and this device's part in the backup, kept on the
/// device apart from the backup.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    /// `None`: backup is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<String>,
    /// When a backup last reached the relay, in ms since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<u64>,
    /// The fingerprint of the backup on the relay as this device last saw
    /// or saved it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// How many machines that backup held.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines: Option<u32>,
    #[serde(default)]
    pub sync: SyncRecord,
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

    const ID: &str = "AB12cd";
    const NOW: u64 = 1_700_000_000_000;
    const MIN: u64 = 60_000;

    /// One device of the identity: its machines, prompts and sync record.
    struct Device {
        machines: MachinesState,
        prompts: QuickPromptsState,
        sync: SyncRecord,
    }

    impl Device {
        fn new() -> Self {
            Self {
                machines: MachinesState::new(BTreeMap::new(), MergeOptions::default()),
                prompts: QuickPromptsState::default(),
                sync: SyncRecord::default(),
            }
        }

        fn pair(&mut self, pubkey: &str, label: &str) {
            self.machines.register_machine(pubkey, "bridge", Some(label.into()), None, &["wss://relay.one".to_string()]);
        }

        /// Merge `backup` (if any) and return what this device then saves.
        fn sync(&mut self, backup: Option<&ConfigBackup>, now: u64) -> (MergeOutcome, ConfigBackup) {
            let outcome = match backup {
                Some(b) => merge_backup(b, &mut self.machines, &mut self.prompts, &mut self.sync, now),
                None => {
                    self.sync.note_local_changes(&self.machines, &self.prompts.prompts, now);
                    MergeOutcome::default()
                }
            };
            // The caller removes what the merge says another device removed.
            for pubkey in &outcome.removed {
                self.machines.remove_machine(pubkey);
            }
            (outcome, build_backup(&self.machines, &self.prompts.prompts, &self.sync, now))
        }

        fn label(&self, pubkey: &str) -> Option<&str> {
            self.machines.machine(pubkey).and_then(|m| m.label.as_deref())
        }
    }

    #[test]
    fn the_d_tag_is_a_hash_of_the_identity_and_names_no_app() {
        let tag = backup_d_tag(ID);
        assert_eq!(tag.len(), 64);
        assert!(tag.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!tag.contains("codedeck"));
        assert_eq!(tag, backup_d_tag(&ID.to_ascii_lowercase()));
        assert_ne!(tag, backup_d_tag("ab12ce"));
        assert_eq!(backup_address(ID), format!("30078:ab12cd:{tag}"));
    }

    #[test]
    fn a_backup_holds_what_the_devices_share_and_round_trips() {
        let mut a = Device::new();
        a.pair("m1", "Work");
        a.machines.set_direct_endpoints("m1", vec!["wss://laptop.tailnet:7447".into()]);
        a.machines.set_default_agent("m1", Some("opencode".into()));
        a.machines.set_agent_defaults("m1", "claude", AgentDefaults { mode: "plan".into(), effort: String::new(), model: String::new() });
        // A heartbeat's worth of data the bridge would send again.
        a.machines.machines.get_mut("m1").unwrap().folders = vec!["repo".into()];
        a.prompts.prompts = vec![QuickPrompt { id: "q".into(), label: "Go".into(), text: "Continue".into() }];
        let (_, backup) = a.sync(None, NOW);
        let json = encode_backup(&backup);
        assert!(!json.contains("repo") && !json.contains("sessions"));
        // Nothing about one device: no settings, no keys.
        assert!(!json.contains("uiScale") && !json.contains("torProxy") && !json.contains("secret") && !json.contains("Grant"));
        assert_eq!(decode_backup(&json).unwrap(), backup);

        // A fresh device gets everything back.
        let mut b = Device::new();
        let (outcome, _) = b.sync(Some(&backup), NOW + MIN);
        assert_eq!((outcome.added, outcome.prompts_changed), (1, true));
        let m1 = b.machines.machine("m1").unwrap();
        assert_eq!((m1.label.as_deref(), m1.default_agent.as_deref()), (Some("Work"), Some("opencode")));
        assert_eq!(m1.direct_endpoints, ["wss://laptop.tailnet:7447"]);
        assert_eq!(m1.agent_defaults["claude"].mode, "plan");
        assert_eq!(b.prompts.prompts.len(), 1);
    }

    #[test]
    fn devices_pairing_different_machines_end_up_with_all_of_them() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.pair("m2", "Server");
        let (outcome, saved) = desk.sync(Some(&saved), NOW + MIN);
        assert_eq!(outcome.added, 1);
        assert_eq!(saved.machines.len(), 2, "the desktop writes both, not just its own");
        let (outcome, _) = phone.sync(Some(&saved), NOW + 2 * MIN);
        assert_eq!(outcome.added, 1);
        assert!(phone.machines.machine("m2").is_some());
    }

    #[test]
    fn the_newest_edit_wins_and_an_older_one_does_not_come_back() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        // The desktop renames it; the phone hears of it.
        desk.machines.set_label("m1", Some("Work laptop".into()));
        let (_, saved) = desk.sync(Some(&saved), NOW + 2 * MIN);
        let (outcome, mine) = phone.sync(Some(&saved), NOW + 3 * MIN);
        assert_eq!((outcome.updated, phone.label("m1")), (1, Some("Work laptop")));
        assert_eq!(backup_fingerprint(&mine), backup_fingerprint(&saved), "nothing newer to write");
        // A stale backup (the one before the rename) changes nothing.
        let (_, old) = Device::new().sync(None, NOW);
        let (outcome, _) = phone.sync(Some(&old), NOW + 4 * MIN);
        assert_eq!((outcome.updated, phone.label("m1")), (0, Some("Work laptop")));
    }

    #[test]
    fn a_device_joining_late_does_not_override_newer_edits_with_what_it_had() {
        let mut desk = Device::new();
        desk.pair("m1", "Old name");
        let mut phone = Device::new();
        phone.pair("m1", "Old name");
        // The desktop keeps the backup, renames the machine later.
        desk.sync(None, NOW);
        desk.machines.set_label("m1", Some("New name".into()));
        let (_, saved) = desk.sync(None, NOW + MIN);
        // The phone turns backup on afterwards, with its stale label.
        let (_, mine) = phone.sync(Some(&saved), NOW + 2 * MIN);
        assert_eq!(phone.label("m1"), Some("New name"));
        assert_eq!(mine.machines[0].label.as_deref(), Some("New name"));
    }

    #[test]
    fn a_removal_reaches_every_device_and_pairing_again_brings_it_back() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        phone.pair("m2", "Server");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        // Removed on the desktop: the phone removes it too.
        desk.machines.remove_machine("m1");
        let (_, saved) = desk.sync(Some(&saved), NOW + 2 * MIN);
        assert!(saved.machines.iter().all(|m| m.pubkey_hex != "m1"));
        assert_eq!(saved.removed_machines.get("m1"), Some(&(NOW + 2 * MIN)));
        let (outcome, saved) = phone.sync(Some(&saved), NOW + 3 * MIN);
        assert_eq!(outcome.removed, ["m1"]);
        assert!(phone.machines.machine("m1").is_none() && phone.machines.machine("m2").is_some());
        // Paired again on the phone later: it comes back on the desktop.
        phone.pair("m1", "Laptop again");
        let (_, saved) = phone.sync(Some(&saved), NOW + 4 * MIN);
        let (outcome, _) = desk.sync(Some(&saved), NOW + 5 * MIN);
        assert_eq!((outcome.added, desk.label("m1")), (1, Some("Laptop again")));
    }

    #[test]
    fn an_edit_after_a_removal_elsewhere_keeps_the_machine() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        desk.machines.remove_machine("m1");
        let (_, removal) = desk.sync(None, NOW + 2 * MIN);
        // The phone renamed it after the desktop removed it.
        phone.machines.set_label("m1", Some("Still mine".into()));
        let (outcome, saved) = phone.sync(Some(&removal), NOW + 3 * MIN);
        assert!(outcome.removed.is_empty());
        assert!(saved.machines.iter().any(|m| m.pubkey_hex == "m1"));
    }

    #[test]
    fn devices_that_heard_different_names_have_nothing_to_save() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        // Each heard the bridge call itself something else since.
        phone.machines.machines.get_mut("m1").unwrap().name = "laptop-old".into();
        desk.machines.machines.get_mut("m1").unwrap().name = "laptop-new".into();
        let (_, phones) = phone.sync(Some(&saved), NOW + 2 * MIN);
        let (_, desks) = desk.sync(Some(&phones), NOW + 3 * MIN);
        assert_ne!(phones.machines[0].name, desks.machines[0].name);
        assert_eq!(backup_fingerprint(&phones), backup_fingerprint(&desks), "neither saves over the other");
    }

    #[test]
    fn a_removal_and_an_edit_at_the_same_moment_settle_on_one() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        // At the same millisecond: the phone renames it, the desktop removes it.
        phone.machines.set_label("m1", Some("Renamed".into()));
        let (_, edit) = phone.sync(None, NOW + 2 * MIN);
        desk.machines.remove_machine("m1");
        let (_, removal) = desk.sync(None, NOW + 2 * MIN);
        assert_eq!(edit.machines[0].changed_at, removal.removed_machines["m1"]);
        // Each takes the other's side: whichever the relay keeps, the device
        // that reads it agrees with it and has nothing to save.
        let (_, phones) = phone.sync(Some(&removal), NOW + 3 * MIN);
        assert!(phone.machines.machine("m1").is_none());
        assert_eq!(backup_fingerprint(&phones), backup_fingerprint(&removal));
        let (_, desks) = desk.sync(Some(&edit), NOW + 3 * MIN);
        assert_eq!(desk.label("m1"), Some("Renamed"));
        assert_eq!(backup_fingerprint(&desks), backup_fingerprint(&edit));
    }

    #[test]
    fn an_edit_after_seeing_a_change_wins_however_far_ahead_its_clock_ran() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.pair("m1", "Laptop");
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        // The desktop's clock runs a day ahead.
        let ahead = NOW + 24 * 60 * MIN;
        desk.machines.set_label("m1", Some("From the desk".into()));
        let (_, saved) = desk.sync(Some(&saved), ahead);
        // The phone takes it, and renames it a minute later by its own clock.
        phone.sync(Some(&saved), NOW + 2 * MIN);
        phone.machines.set_label("m1", Some("From the phone".into()));
        let (_, saved) = phone.sync(Some(&saved), NOW + 3 * MIN);
        assert!(saved.machines[0].changed_at > ahead);
        let (outcome, _) = desk.sync(Some(&saved), ahead + MIN);
        assert_eq!((outcome.updated, desk.label("m1")), (1, Some("From the phone")));
    }

    #[test]
    fn the_quick_prompts_go_as_one_list_the_newest_wins() {
        let (mut phone, mut desk) = (Device::new(), Device::new());
        phone.prompts.prompts = vec![QuickPrompt { id: "a".into(), label: "A".into(), text: "a".into() }];
        let (_, saved) = phone.sync(None, NOW);
        desk.sync(Some(&saved), NOW + MIN);
        desk.prompts.prompts.push(QuickPrompt { id: "b".into(), label: "B".into(), text: "b".into() });
        let (_, saved) = desk.sync(Some(&saved), NOW + 2 * MIN);
        let (outcome, _) = phone.sync(Some(&saved), NOW + 3 * MIN);
        assert!(outcome.prompts_changed);
        assert_eq!(phone.prompts.prompts.len(), 2);
    }

    #[test]
    fn tombstones_are_forgotten_after_a_while() {
        let mut phone = Device::new();
        phone.pair("m1", "Laptop");
        phone.sync(None, NOW);
        phone.machines.remove_machine("m1");
        let (_, saved) = phone.sync(None, NOW + MIN);
        assert!(saved.removed_machines.contains_key("m1"));
        let (_, later) = phone.sync(Some(&saved), NOW + MIN + TOMBSTONE_KEEP_MS);
        assert!(later.removed_machines.is_empty());
    }

    #[test]
    fn the_fingerprint_ignores_when_it_was_made() {
        let mut phone = Device::new();
        phone.pair("m1", "Laptop");
        let (_, a) = phone.sync(None, NOW);
        let b = ConfigBackup { saved_at: NOW + 1, ..a.clone() };
        assert_eq!(backup_fingerprint(&a), backup_fingerprint(&b));
        let c = ConfigBackup { quick_prompts: vec![QuickPrompt { id: "x".into(), label: "X".into(), text: "x".into() }], ..b };
        assert_ne!(backup_fingerprint(&a), backup_fingerprint(&c));
    }

    #[test]
    fn a_bad_or_other_version_backup_is_an_error_not_a_panic() {
        assert!(decode_backup("not json").is_err());
        assert!(decode_backup(r#"{"v":2}"#).is_err());
        assert!(decode_backup(r#"{"v":1,"savedAt":1,"machines":[],"settings":{},"quickPrompts":[]}"#).is_err());
        assert!(decode_backup(r#"{"v":99}"#).unwrap_err().contains("newer version"));
        // A machine with no relay the phone may dial is dropped.
        let mut phone = Device::new();
        phone.pair("m1", "Laptop");
        let (_, mut backup) = phone.sync(None, NOW);
        backup.machines[0].relays = vec!["http://plain.example".into()];
        assert!(decode_backup(&encode_backup(&backup)).unwrap().machines.is_empty());
    }

    #[test]
    fn the_backup_relay_hydrates_tolerantly() {
        assert_eq!(hydrate_backup_config(None), BackupConfig::default());
        assert_eq!(hydrate_backup_config(Some("garbage")), BackupConfig::default());
        assert_eq!(hydrate_backup_config(Some(r#"{"relay":"http://x"}"#)), BackupConfig::default());
        let config = BackupConfig { relay: Some("wss://r".into()), saved_at: Some(5), ..Default::default() };
        assert_eq!(hydrate_backup_config(Some(&serialize_backup_config(&config))), config);
    }
}
