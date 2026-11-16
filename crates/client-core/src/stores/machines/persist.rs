//! The machines and the dismissed sessions as the key-value store holds them:
//! what is stripped before writing, and the tolerant parse at boot.

use std::collections::BTreeMap;

use super::{Dismissed, ListingPresence, MachineView};

/// `serializeMachines`: a JSON array of the machines, `providerProfiles`,
/// `plugins` and every session's `commands` stripped. Round-tripping through this can never truncate — it holds the FULL
/// map, unlike the old app's merged-short list.
///
/// The strip happens HERE, not via a `#[serde(skip)]` on the field itself —
/// `MachineView` also serializes into the live `MachinesView` that crosses the
/// IPC boundary to the UI, and that path must carry `provider_profiles`.
pub fn serialize_machines(machines: &BTreeMap<String, MachineView>) -> String {
    let stripped: Vec<MachineView> = machines
        .values()
        .cloned()
        .map(|mut m| {
            m.provider_profiles = None;
            m.plugins.clear();
            m.mcp.clear();
            m.personas.clear();
            m.permission_rules.clear();
            m.accounts.clear();
            m.agent_actions.clear();
            m.incompatible = None;
            for s in m.sessions.values_mut() {
                s.commands = None;
                s.mcp = None;
                s.personas = None;
            }
            m
        })
        .collect();
    serde_json::to_string(&stripped).expect("MachineView always serializes")
}

/// `hydrateMachines`: tolerant parse. Every presence comes back `Offline` and
/// `machine_offline` is forced true — honest until the first live heartbeat.
/// Garbage / unknown input yields an empty map (never a panic at boot).
pub fn hydrate_machines(raw: Option<&str>) -> BTreeMap<String, MachineView> {
    let Some(raw) = raw else {
        return BTreeMap::new();
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    for item in items {
        let Ok(mut m) = serde_json::from_value::<MachineView>(item) else {
            continue;
        };
        if m.pubkey_hex.is_empty() {
            continue;
        }
        if m.name.is_empty() {
            m.name = m.pubkey_hex.chars().take(8).collect();
        }
        m.machine_offline = true;
        m.provider_profiles = None;
        for view in m.sessions.values_mut() {
            view.presence = ListingPresence::Offline;
        }
        out.insert(m.pubkey_hex.clone(), m);
    }
    out
}

/// `dismissed_sessions` for the KV. Kept apart from the machines so a
/// deleted session stays shielded across an app restart.
pub fn serialize_dismissed(dismissed: &BTreeMap<String, Dismissed>) -> String {
    serde_json::to_string(dismissed).expect("dismissed sessions serialize")
}

/// Tolerant parse of [`serialize_dismissed`]: garbage yields an empty map,
/// an unreadable entry is skipped.
pub fn hydrate_dismissed(raw: Option<&str>) -> BTreeMap<String, Dismissed> {
    let Some(map) = raw.and_then(|r| serde_json::from_str::<BTreeMap<String, serde_json::Value>>(r).ok()) else {
        return BTreeMap::new();
    };
    map.into_iter().filter_map(|(id, v)| Some((id, serde_json::from_value(v).ok()?))).collect()
}
