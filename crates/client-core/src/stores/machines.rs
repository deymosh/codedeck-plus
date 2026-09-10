//! `machines` store — the bug-B session-loss killer. Port of the PURE half of
//! `apps/mobile/src/core/stores/machines.ts`: `mergeSessionList` and the title
//! helpers. The store actions (`applySessionList`, `applyModels`, …), the
//! `MachineView`, and serialize/hydrate land in a follow-up.
//!
//! Contract, verbatim from the TS:
//! - sessions in the incoming list are upserted (`Live`, or `Offline` on a
//!   `machineOffline` shutdown publish);
//! - **absence NEVER deletes** — a known session missing from the list is kept
//!   and marked `Stale` (or held past a grace window);
//! - removal is ONLY via explicit `removedSessions` tombstones;
//! - the merge is pure — `prev` is never mutated.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::wire::capabilities::BridgeHostKind;
use crate::wire::common::{GsdState, ProviderProfileInfo, RemoteSessionInfo, UsageData};
use crate::wire::events::{ModelEntry, ModelsMsg, ProviderProfilesMsg, SessionListMsg};

/// A user-dismissed session id keeps suppressing incoming lists for this long
/// (then the bridge is trusted again — it has had ample time to process the
/// close-session).
pub const DISMISSED_TTL_MS: u64 = 60 * 60 * 1000;

/// The three honest presence states for a listed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListingPresence {
    Live,
    Stale,
    Offline,
}

/// One session as the machines store holds it. The per-session extras (`usage`,
/// `gsd`) survive every heartbeat — the merge spreads the previous view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub info: RemoteSessionInfo,
    pub presence: ListingPresence,
    /// ms timestamp this session was last present in an incoming list.
    pub last_listed_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gsd: Option<GsdState>,
}

impl SessionView {
    /// A freshly-listed session with no prior extras.
    pub fn listed(info: RemoteSessionInfo, presence: ListingPresence, now: u64) -> Self {
        Self {
            info,
            presence,
            last_listed_at: now,
            usage: None,
            gsd: None,
        }
    }
}

/// `mergeSessionList` options.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergeOptions {
    /// A session absent from an incoming list keeps its previous presence while
    /// it was listed within this window (rapid partial lists during session
    /// creation must not flicker everything stale). `0` = stale at once.
    pub stale_grace_ms: u64,
}

/// Phase 6 title-merge guard: a `null` incoming title must not wipe a title we
/// already hold (the client-side first-message stopgap), but a non-null
/// incoming title always wins. TS: `incoming.title ?? prev.title`.
fn with_guarded_title(incoming: &RemoteSessionInfo, prev: Option<&SessionView>) -> RemoteSessionInfo {
    let held = prev.and_then(|p| p.info.title.clone());
    if incoming.title.is_some() || held.is_none() {
        return incoming.clone();
    }
    RemoteSessionInfo {
        title: held,
        ..incoming.clone()
    }
}

/// Pure session-list merge. Returns a NEW map; `prev` is untouched.
pub fn merge_session_list(
    prev: &BTreeMap<String, SessionView>,
    incoming: &SessionListMsg,
    now: u64,
    opts: MergeOptions,
) -> BTreeMap<String, SessionView> {
    let machine_offline = incoming.machine_offline.unwrap_or(false);
    let presence = if machine_offline {
        ListingPresence::Offline
    } else {
        ListingPresence::Live
    };

    let mut next: BTreeMap<String, SessionView> = BTreeMap::new();
    let mut listed: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();

    for info in &incoming.sessions {
        listed.insert(info.id.as_str());
        let prior = prev.get(&info.id);
        next.insert(
            info.id.clone(),
            SessionView {
                info: with_guarded_title(info, prior),
                presence,
                last_listed_at: now,
                // per-session extras survive every heartbeat
                usage: prior.and_then(|p| p.usage.clone()),
                gsd: prior.and_then(|p| p.gsd.clone()),
            },
        );
    }

    for (id, view) in prev {
        if listed.contains(id.as_str()) {
            continue;
        }
        // Absence NEVER deletes.
        let kept = if machine_offline {
            SessionView {
                presence: ListingPresence::Offline,
                ..view.clone()
            }
        } else if now.saturating_sub(view.last_listed_at) <= opts.stale_grace_ms {
            view.clone()
        } else {
            SessionView {
                presence: ListingPresence::Stale,
                ..view.clone()
            }
        };
        next.insert(id.clone(), kept);
    }

    // Tombstones are the ONLY bridge-driven removal path.
    for id in incoming.removed_sessions.iter().flatten() {
        next.remove(id);
    }

    next
}

/// Old-app first-message title: newlines → spaces, trim; `> 80` chars →
/// `slice(0, 77) + "..."`. Empty input yields `""` (the caller skips it).
pub fn title_from_first_message(text: &str) -> String {
    let title: String = text.replace('\n', " ");
    let title = title.trim();
    if title.chars().count() > 80 {
        let head: String = title.chars().take(77).collect();
        format!("{head}...")
    } else {
        title.to_string()
    }
}

/// Drop dismissed-session ids older than [`DISMISSED_TTL_MS`].
///
/// The TS returns the same object identity when nothing expired (a cheap
/// no-change signal for `zustand.set`); the Rust caller compares values, so
/// this just returns the pruned map.
pub fn prune_dismissed(dismissed: &BTreeMap<String, u64>, now: u64) -> BTreeMap<String, u64> {
    dismissed
        .iter()
        .filter(|(_, &at)| now.saturating_sub(at) < DISMISSED_TTL_MS)
        .map(|(id, &at)| (id.clone(), at))
        .collect()
}

// --- MachineView + the store's pure transforms --------------------------------

/// A paired bridge and its session list. `provider_profiles` is
/// bridge-authoritative and in-memory only — it never serializes (a fresh boot
/// re-requests the live list, CDX-062).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineView {
    pub pubkey_hex: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<BridgeHostKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub protocol_version: Option<u32>,
    #[serde(default)]
    pub machine_offline: bool,
    #[serde(default)]
    pub last_heartbeat_at: Option<u64>,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_error: Option<String>,
    /// Never persisted (CDX-062) and never hydrated.
    #[serde(skip)]
    pub provider_profiles: Option<Vec<ProviderProfileInfo>>,
}

impl MachineView {
    fn new(pubkey_hex: String, name: String) -> Self {
        Self {
            pubkey_hex,
            name,
            host: None,
            label: None,
            capabilities: Vec::new(),
            folders: Vec::new(),
            roots: Vec::new(),
            protocol_version: None,
            machine_offline: false,
            last_heartbeat_at: None,
            sessions: BTreeMap::new(),
            models: None,
            default_model: None,
            models_error: None,
            provider_profiles: None,
        }
    }
}

/// `serializeMachines`: a JSON array of the machines, `providerProfiles`
/// stripped. Round-tripping through this can never truncate — it holds the FULL
/// map, unlike the old app's merged-short list.
pub fn serialize_machines(machines: &BTreeMap<String, MachineView>) -> String {
    serde_json::to_string(&machines.values().collect::<Vec<_>>())
        .expect("MachineView always serializes")
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

/// The machines store as a pure state machine (plan F2a). Every method mutates
/// only `self`; the runtime persists `serialize_machines(&self.machines)` after
/// anything that changes `machines`. `dismissed_sessions` is in-memory only.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MachinesState {
    pub machines: BTreeMap<String, MachineView>,
    pub dismissed_sessions: BTreeMap<String, u64>,
    pub merge_options: MergeOptions,
}

impl MachinesState {
    pub fn new(machines: BTreeMap<String, MachineView>, merge_options: MergeOptions) -> Self {
        Self {
            machines,
            dismissed_sessions: BTreeMap::new(),
            merge_options,
        }
    }

    pub fn machine(&self, pubkey_hex: &str) -> Option<&MachineView> {
        self.machines.get(pubkey_hex)
    }
    pub fn session(&self, machine_pubkey: &str, session_id: &str) -> Option<&SessionView> {
        self.machines.get(machine_pubkey)?.sessions.get(session_id)
    }
    pub fn machine_pubkeys(&self) -> Vec<String> {
        self.machines.keys().cloned().collect()
    }

    /// Upsert a machine record (pair-ack). An existing record keeps its fields;
    /// only `name` (and `label` / `host` when given) update.
    pub fn register_machine(
        &mut self,
        pubkey_hex: &str,
        name: &str,
        label: Option<String>,
        host: Option<BridgeHostKind>,
    ) {
        let entry = self
            .machines
            .entry(pubkey_hex.to_string())
            .or_insert_with(|| MachineView::new(pubkey_hex.to_string(), name.to_string()));
        entry.name = name.to_string();
        if let Some(l) = label {
            entry.label = Some(l);
        }
        if let Some(h) = host {
            entry.host = Some(h);
        }
    }

    pub fn remove_machine(&mut self, pubkey_hex: &str) -> bool {
        self.machines.remove(pubkey_hex).is_some()
    }

    /// The heartbeat path. CDX-022: the record is SPREAD from the existing one,
    /// never rebuilt — a field the wire omits (`models`, `host`, …) keeps its
    /// stored value; a field the wire carries always wins. The resurrection
    /// shield filters non-expired user-dismissed session ids out of `msg`
    /// BEFORE the merge.
    pub fn apply_session_list(&mut self, machine_pubkey: &str, msg: &SessionListMsg, at: u64) {
        self.dismissed_sessions = prune_dismissed(&self.dismissed_sessions, at);
        let dismissed = &self.dismissed_sessions;

        let prev_sessions = self
            .machines
            .get(machine_pubkey)
            .map(|m| m.sessions.clone())
            .unwrap_or_default();

        // Filtered copy of the incoming list (resurrection shield).
        let mut shielded = msg.clone();
        shielded
            .sessions
            .retain(|s| !dismissed.contains_key(&s.id));

        let sessions = merge_session_list(&prev_sessions, &shielded, at, self.merge_options);

        let entry = self
            .machines
            .entry(machine_pubkey.to_string())
            .or_insert_with(|| MachineView::new(machine_pubkey.to_string(), msg.machine.clone()));
        entry.pubkey_hex = machine_pubkey.to_string();
        entry.name = msg.machine.clone();
        if let Some(h) = msg.host {
            entry.host = Some(h);
        }
        if let Some(caps) = &msg.capabilities {
            entry.capabilities = caps.clone();
        }
        if let Some(f) = &msg.folders {
            entry.folders = f.clone();
        }
        if let Some(r) = &msg.roots {
            entry.roots = r.clone();
        }
        entry.protocol_version = Some(msg.protocol_version);
        entry.machine_offline = msg.machine_offline.unwrap_or(false);
        entry.last_heartbeat_at = Some(at);
        entry.sessions = sessions;
    }

    fn with_machine<F: FnOnce(&mut MachineView)>(&mut self, machine_pubkey: &str, f: F) -> bool {
        match self.machines.get_mut(machine_pubkey) {
            Some(m) => {
                f(m);
                true
            }
            None => false,
        }
    }

    pub fn apply_session_upsert(&mut self, machine_pubkey: &str, info: &RemoteSessionInfo, at: u64) {
        self.with_machine(machine_pubkey, |m| {
            let prior = m.sessions.get(&info.id);
            let view = SessionView {
                info: with_guarded_title(info, prior),
                presence: ListingPresence::Live,
                last_listed_at: at,
                usage: prior.and_then(|p| p.usage.clone()),
                gsd: prior.and_then(|p| p.gsd.clone()),
            };
            m.sessions.insert(info.id.clone(), view);
        });
    }

    pub fn apply_session_replaced(
        &mut self,
        machine_pubkey: &str,
        old_session_id: &str,
        info: &RemoteSessionInfo,
        at: u64,
    ) {
        self.with_machine(machine_pubkey, |m| {
            // The predecessor carries the conversation — its stopgap title
            // survives a titleless replacement announcement.
            let prev = m
                .sessions
                .get(old_session_id)
                .or_else(|| m.sessions.get(&info.id))
                .cloned();
            m.sessions.remove(old_session_id);
            m.sessions.insert(
                info.id.clone(),
                SessionView {
                    info: with_guarded_title(info, prev.as_ref()),
                    presence: ListingPresence::Live,
                    last_listed_at: at,
                    usage: prev.as_ref().and_then(|p| p.usage.clone()),
                    gsd: prev.and_then(|p| p.gsd),
                },
            );
        });
    }

    /// Patch a session's `info` in place (e.g. mode / effort / model confirmed).
    pub fn update_session_info<F: FnOnce(&mut RemoteSessionInfo)>(
        &mut self,
        machine_pubkey: &str,
        session_id: &str,
        patch: F,
    ) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                patch(&mut s.info);
            }
        });
    }

    /// The FIRST user message titles an untitled session. No-op when the session
    /// is unknown, already titled, or the text is whitespace-only.
    pub fn note_first_user_message(&mut self, machine_pubkey: &str, session_id: &str, text: &str) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(session_id) else {
                return;
            };
            if s.info.title.is_some() {
                return;
            }
            let title = title_from_first_message(text);
            if title.is_empty() {
                return;
            }
            s.info.title = Some(title);
        });
    }

    /// Explicit user delete — one of exactly two removal paths.
    pub fn user_remove_session(&mut self, machine_pubkey: &str, session_id: &str) {
        self.with_machine(machine_pubkey, |m| {
            m.sessions.remove(session_id);
        });
    }

    /// Shield a user-deleted session from resurrection by stale heartbeats.
    pub fn dismiss_session(&mut self, session_id: &str, at: u64) {
        self.dismissed_sessions = prune_dismissed(&self.dismissed_sessions, at);
        self.dismissed_sessions.insert(session_id.to_string(), at);
    }

    /// Undo a delete: un-dismiss and re-insert the exact snapshotted view.
    pub fn restore_session(&mut self, machine_pubkey: &str, view: SessionView) {
        self.dismissed_sessions.remove(&view.info.id);
        self.with_machine(machine_pubkey, |m| {
            m.sessions.insert(view.info.id.clone(), view);
        });
    }

    pub fn apply_usage(&mut self, machine_pubkey: &str, session_id: &str, usage: UsageData) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                s.usage = Some(usage);
            }
        });
    }

    pub fn apply_gsd(&mut self, machine_pubkey: &str, session_id: &str, gsd: GsdState) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                s.gsd = Some(gsd);
            }
        });
    }

    /// CDX-035: an EMPTY `models` is a "could not answer" report (it carries a
    /// reason) — it must never overwrite a good list. A non-empty answer is
    /// always authoritative and clears any stored reason.
    pub fn apply_models(&mut self, machine_pubkey: &str, msg: &ModelsMsg) {
        // Machines the phone hasn't paired can still receive a models answer
        // (3c routing) — create the record if needed, matching the TS
        // `withMachine` that would drop it. Actually the TS drops it; mirror
        // that: only touch a known machine.
        self.with_machine(machine_pubkey, |m| {
            if msg.models.is_empty() {
                m.models_error = msg.error.clone();
                return;
            }
            m.models = Some(msg.models.clone());
            if let Some(dm) = &msg.default_model {
                m.default_model = Some(dm.clone());
            }
            m.models_error = None;
        });
    }

    /// CDX-062: plain replace (unlike `apply_models`) — the bridge always
    /// answers straight from storage, so an empty list truly means zero
    /// profiles.
    pub fn apply_provider_profiles(&mut self, machine_pubkey: &str, msg: &ProviderProfilesMsg) {
        self.with_machine(machine_pubkey, |m| {
            m.provider_profiles = Some(msg.profiles.clone());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::codec::decode_bridge_to_phone;
    use crate::wire::events::BridgeToPhone;
    use serde_json::json;

    fn info(id: &str) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: id.into(),
            slug: format!("slug-{id}"),
            cwd: "/work".into(),
            last_activity: "1970-01-01T00:00:00.000Z".into(),
            line_count: 0,
            title: None,
            project: "proj".into(),
            permission_mode: None,
            effort_level: None,
            model: None,
            context_window: None,
            context_percentage: None,
            committed: None,
            state: None,
            seq_high: None,
            provider_id: None,
            provider_label: None,
        }
    }

    fn titled(id: &str, title: &str) -> RemoteSessionInfo {
        RemoteSessionInfo {
            title: Some(title.into()),
            ..info(id)
        }
    }

    /// Build a `sessions` message by round-tripping through the real decoder —
    /// keeps the test honest against the wire schema.
    fn list(sessions: &[RemoteSessionInfo], extra: serde_json::Value) -> SessionListMsg {
        let mut obj = json!({
            "type": "sessions",
            "machine": "m1",
            "sessions": sessions,
            "protocolVersion": crate::wire::capabilities::PROTOCOL_VERSION,
        });
        if let (Some(o), Some(e)) = (obj.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        match decode_bridge_to_phone(&obj.to_string()).unwrap() {
            BridgeToPhone::Sessions(m) => m,
            other => panic!("not a sessions message: {other:?}"),
        }
    }

    fn view(id: &str, presence: ListingPresence, last_listed_at: u64) -> SessionView {
        SessionView {
            info: info(id),
            presence,
            last_listed_at,
            usage: None,
            gsd: None,
        }
    }

    fn map(views: Vec<SessionView>) -> BTreeMap<String, SessionView> {
        views.into_iter().map(|v| (v.info.id.clone(), v)).collect()
    }

    const NONE: fn() -> serde_json::Value = || json!({});

    #[test]
    fn upserts_listed_sessions_as_live() {
        let next = merge_session_list(
            &BTreeMap::new(),
            &list(&[info("a"), info("b")], NONE()),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(next["a"].presence, ListingPresence::Live);
        assert_eq!(next["a"].last_listed_at, 100);
    }

    #[test]
    fn absence_never_deletes_a_missing_session_goes_stale() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(&prev, &list(&[info("a")], NONE()), 100, MergeOptions::default());
        assert_eq!(next["b"].presence, ListingPresence::Stale);
        assert_eq!(next["a"].presence, ListingPresence::Live);
    }

    #[test]
    fn an_empty_incoming_list_deletes_nothing() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
            view("c", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions::default());
        assert_eq!(next.len(), 3);
        assert!(next.values().all(|v| v.presence == ListingPresence::Stale));
    }

    #[test]
    fn tombstones_are_the_only_bridge_removal_and_only_hit_their_target() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(
            &prev,
            &list(&[info("a")], json!({ "removedSessions": ["b"] })),
            100,
            MergeOptions::default(),
        );
        assert!(!next.contains_key("b"));
        assert!(next.contains_key("a"));
    }

    #[test]
    fn a_tombstone_for_an_unknown_session_is_harmless() {
        let next = merge_session_list(
            &map(vec![view("a", ListingPresence::Live, 0)]),
            &list(&[info("a")], json!({ "removedSessions": ["ghost"] })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn machine_offline_keeps_every_session_marked_offline() {
        let prev = map(vec![
            view("a", ListingPresence::Live, 0),
            view("b", ListingPresence::Live, 0),
        ]);
        let next = merge_session_list(
            &prev,
            &list(&[info("a")], json!({ "machineOffline": true })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(next.len(), 2);
        assert_eq!(next["a"].presence, ListingPresence::Offline);
        assert_eq!(next["b"].presence, ListingPresence::Offline);
    }

    #[test]
    fn grace_period_holds_a_recent_absentee_and_stales_an_old_one() {
        let prev = map(vec![
            view("fresh", ListingPresence::Live, 95),
            view("old", ListingPresence::Live, 10),
        ]);
        let next = merge_session_list(&prev, &list(&[], NONE()), 100, MergeOptions { stale_grace_ms: 10 });
        assert_eq!(next["fresh"].presence, ListingPresence::Live);
        assert_eq!(next["old"].presence, ListingPresence::Stale);
    }

    #[test]
    fn merge_does_not_mutate_prev() {
        let prev = map(vec![view("a", ListingPresence::Live, 0)]);
        let snapshot = prev.clone();
        let _ = merge_session_list(
            &prev,
            &list(&[], json!({ "removedSessions": ["a"] })),
            100,
            MergeOptions::default(),
        );
        assert_eq!(prev, snapshot);
    }

    // --- title merge guard ---

    #[test]
    fn a_titleless_incoming_session_keeps_the_held_title() {
        let prev = map(vec![SessionView {
            info: titled("s1", "client stopgap"),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 1, MergeOptions::default());
        assert_eq!(next["s1"].info.title.as_deref(), Some("client stopgap"));
    }

    #[test]
    fn a_non_null_incoming_title_always_wins() {
        let prev = map(vec![SessionView {
            info: titled("s1", "client stopgap"),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(
            &prev,
            &list(&[titled("s1", "bridge topical")], NONE()),
            1,
            MergeOptions::default(),
        );
        assert_eq!(next["s1"].info.title.as_deref(), Some("bridge topical"));
    }

    #[test]
    fn no_previous_title_incoming_null_stays_null() {
        let next = merge_session_list(
            &map(vec![view("s1", ListingPresence::Live, 0)]),
            &list(&[info("s1")], NONE()),
            1,
            MergeOptions::default(),
        );
        assert_eq!(next["s1"].info.title, None);
    }

    #[test]
    fn per_session_usage_and_gsd_survive_a_heartbeat() {
        let usage: UsageData = serde_json::from_value(json!({
            "available": true,
            "subscriptionType": null,
            "fiveHour": { "utilization": 0.2, "resetsAt": null },
            "fetchedAt": "1970-01-01T00:00:00.000Z"
        }))
        .unwrap();
        let prev = map(vec![SessionView {
            usage: Some(usage.clone()),
            ..view("s1", ListingPresence::Live, 0)
        }]);
        let next = merge_session_list(&prev, &list(&[info("s1")], NONE()), 5, MergeOptions::default());
        assert_eq!(next["s1"].usage, Some(usage));
    }

    // --- title_from_first_message ---

    #[test]
    fn title_from_first_message_truncation_is_exact() {
        let eighty = "a".repeat(80);
        assert_eq!(title_from_first_message(&eighty), eighty);
        let eighty_one = "b".repeat(81);
        assert_eq!(title_from_first_message(&eighty_one), format!("{}...", "b".repeat(77)));
        assert_eq!(title_from_first_message(&eighty_one).chars().count(), 80);
        assert_eq!(title_from_first_message("line1\nline2\n line3 "), "line1 line2  line3");
        assert_eq!(title_from_first_message("  \n \n "), "");
    }

    // --- prune_dismissed ---

    #[test]
    fn prune_dismissed_drops_only_expired_entries() {
        let d: BTreeMap<String, u64> = [("old".to_string(), 0u64), ("fresh".to_string(), 1_000_000)]
            .into_iter()
            .collect();
        let pruned = prune_dismissed(&d, DISMISSED_TTL_MS + 500);
        assert_eq!(pruned.keys().cloned().collect::<Vec<_>>(), vec!["fresh"]);
        // exactly at the TTL boundary the entry is dropped (`>=`)
        assert!(!prune_dismissed(&d, DISMISSED_TTL_MS).contains_key("old"));
    }

    // --- property: sessions are lost ONLY to tombstones ---

    fn prng(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(s) / f64::from(u32::MAX)
        }
    }

    // --- MachinesState (store transforms) ---

    fn models_msg(ids: &[&str], default: Option<&str>) -> ModelsMsg {
        ModelsMsg {
            models: ids
                .iter()
                .map(|id| ModelEntry {
                    id: (*id).to_string(),
                    label: Some(id.to_uppercase()),
                })
                .collect(),
            default_model: default.map(str::to_string),
            error: None,
        }
    }

    #[test]
    fn apply_session_list_creates_the_machine_and_keeps_it_across_heartbeats() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 10);
        st.apply_models("pk", &models_msg(&["opus", "sonnet"], Some("opus")));
        assert_eq!(st.machine("pk").unwrap().models.as_ref().unwrap().len(), 2);

        // CDX-022: the refresh-sessions heartbeat that used to wipe the picker.
        for at in [20, 30, 40, 50, 60] {
            st.apply_session_list("pk", &list(&[info("s1")], NONE()), at);
        }
        assert_eq!(
            st.machine("pk")
                .unwrap()
                .models
                .as_ref()
                .unwrap()
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["opus", "sonnet"]
        );
        assert_eq!(st.machine("pk").unwrap().default_model.as_deref(), Some("opus"));
    }

    #[test]
    fn an_empty_models_response_never_wipes_a_good_list_and_carries_the_reason() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 10);
        st.apply_models("pk", &models_msg(&["opus"], None));
        st.apply_models(
            "pk",
            &ModelsMsg { models: vec![], default_model: None, error: Some("no live SDK".into()) },
        );
        assert_eq!(
            st.machine("pk").unwrap().models.as_ref().unwrap()[0].id,
            "opus"
        );
        assert_eq!(st.machine("pk").unwrap().models_error.as_deref(), Some("no live SDK"));
        // a later good answer clears the error
        st.apply_models("pk", &models_msg(&["opus", "sonnet"], None));
        assert_eq!(st.machine("pk").unwrap().models_error, None);
    }

    #[test]
    fn a_field_less_heartbeat_keeps_the_host_badge_but_a_new_host_wins() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], json!({ "host": "vscode" })), 10);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Vscode));
        st.apply_session_list("pk", &list(&[], NONE()), 20);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Vscode));
        st.apply_session_list("pk", &list(&[], json!({ "host": "cli" })), 30);
        assert_eq!(st.machine("pk").unwrap().host, Some(BridgeHostKind::Cli));
    }

    #[test]
    fn two_pubkeys_with_the_same_name_stay_two_machines() {
        let mut st = MachinesState::default();
        st.apply_session_list("pkA", &list(&[], json!({ "machine": "box", "host": "cli" })), 1);
        st.apply_session_list("pkB", &list(&[], json!({ "machine": "box", "host": "vscode" })), 1);
        assert_eq!(st.machine_pubkeys(), vec!["pkA", "pkB"]);
        assert_eq!(st.machine("pkA").unwrap().host, Some(BridgeHostKind::Cli));
        assert_eq!(st.machine("pkB").unwrap().host, Some(BridgeHostKind::Vscode));
    }

    #[test]
    fn user_remove_session_is_a_local_removal_path() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
        st.user_remove_session("pk", "a");
        assert!(st.session("pk", "a").is_none());
        assert!(st.session("pk", "b").is_some());
    }

    #[test]
    fn the_resurrection_shield_keeps_a_deleted_session_out_of_a_stale_heartbeat() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 1);
        // deleteController does both: remove now + shield against resurrection.
        st.user_remove_session("pk", "a");
        st.dismiss_session("a", 2);
        // a stale heartbeat still lists `a` — the shield filters it BEFORE the
        // merge, so it does not come back.
        st.apply_session_list("pk", &list(&[info("a"), info("b")], NONE()), 3);
        assert!(st.session("pk", "a").is_none());
        assert!(st.session("pk", "b").is_some());
        // past the TTL the bridge is trusted again.
        st.apply_session_list("pk", &list(&[info("a")], NONE()), DISMISSED_TTL_MS + 4);
        assert!(st.session("pk", "a").is_some());
    }

    #[test]
    fn title_guard_covers_upsert_and_replaced() {
        let mut st = MachinesState::default();
        st.register_machine("m1", "m1", None, None);
        st.apply_session_upsert("m1", &info("s1"), 0);
        st.note_first_user_message("m1", "s1", "stopgap");

        st.apply_session_upsert("m1", &info("s1"), 1); // titleless upsert
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("stopgap"));

        st.apply_session_replaced("m1", "s1", &info("s2"), 2); // titleless replace inherits
        assert_eq!(st.session("m1", "s2").unwrap().info.title.as_deref(), Some("stopgap"));

        st.apply_session_replaced("m1", "s2", &titled("s3", "bridge"), 3); // titled wins
        assert_eq!(st.session("m1", "s3").unwrap().info.title.as_deref(), Some("bridge"));
    }

    #[test]
    fn note_first_user_message_only_titles_an_untitled_known_session_once() {
        let mut st = MachinesState::default();
        st.register_machine("m1", "m1", None, None);
        st.apply_session_upsert("m1", &info("s1"), 0);

        st.note_first_user_message("m1", "UNKNOWN", "hi");
        assert!(st.session("m1", "UNKNOWN").is_none());

        st.note_first_user_message("m1", "s1", "first\nmessage  ");
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));
        st.note_first_user_message("m1", "s1", "second");
        assert_eq!(st.session("m1", "s1").unwrap().info.title.as_deref(), Some("first message"));

        st.apply_session_upsert("m1", &info("s2"), 1);
        st.note_first_user_message("m1", "s2", "  \n \n ");
        assert_eq!(st.session("m1", "s2").unwrap().info.title, None);
    }

    #[test]
    fn update_session_info_patches_in_place() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[info("s1")], NONE()), 1);
        st.update_session_info("pk", "s1", |i| i.model = Some("opus".into()));
        assert_eq!(st.session("pk", "s1").unwrap().info.model.as_deref(), Some("opus"));
        // unknown session is a no-op, not a panic
        st.update_session_info("pk", "ghost", |i| i.model = Some("x".into()));
    }

    #[test]
    fn serialize_then_hydrate_never_truncates() {
        let mut st = MachinesState::default();
        st.register_machine("pk1", "M1", Some("Laptop".into()), None);
        st.apply_session_list("pk1", &list(&[info("a"), info("b")], NONE()), 50);
        st.apply_session_list("pk1", &list(&[info("a")], NONE()), 60); // b -> stale
        st.register_machine("pk2", "M2", None, None);
        st.apply_models("pk1", &models_msg(&["opus", "fable"], Some("opus")));

        let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert_eq!(hydrated.keys().cloned().collect::<Vec<_>>(), vec!["pk1", "pk2"]);
        assert_eq!(
            hydrated["pk1"].sessions.keys().cloned().collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(hydrated["pk1"].sessions["b"].presence, ListingPresence::Offline);
        assert_eq!(hydrated["pk1"].label.as_deref(), Some("Laptop"));
        assert!(hydrated["pk1"].machine_offline); // honest until a live heartbeat
        assert_eq!(
            hydrated["pk1"].models.as_ref().unwrap()[0].id,
            "opus"
        );
    }

    #[test]
    fn hydrate_tolerates_garbage_without_panicking() {
        assert!(hydrate_machines(None).is_empty());
        assert!(hydrate_machines(Some("not json")).is_empty());
        assert!(hydrate_machines(Some(r#"{"a":1}"#)).is_empty());
        assert!(hydrate_machines(Some(r#"[{"nope":true}]"#)).is_empty());
    }

    #[test]
    fn provider_profiles_never_serialize() {
        let mut st = MachinesState::default();
        st.apply_session_list("pk", &list(&[], NONE()), 1);
        st.apply_provider_profiles(
            "pk",
            &ProviderProfilesMsg { machine: "pk".into(), profiles: vec![] },
        );
        assert!(st.machine("pk").unwrap().provider_profiles.is_some());
        let hydrated = hydrate_machines(Some(&serialize_machines(&st.machines)));
        assert!(hydrated["pk"].provider_profiles.is_none());
    }

    #[test]
    fn property_sessions_survive_everything_but_a_tombstone() {
        let universe: Vec<String> = (0..8).map(|i| format!("s{i}")).collect();
        for seed in 1..=200u32 {
            let mut rnd = prng(seed);
            let mut state: BTreeMap<String, SessionView> = BTreeMap::new();
            let mut ever_known: std::collections::BTreeSet<String> = Default::default();
            let mut tombstoned: std::collections::BTreeSet<String> = Default::default();
            let mut now = 0u64;

            for step in 0..30 {
                now += (rnd() * 1000.0) as u64;
                let listed: Vec<RemoteSessionInfo> = universe
                    .iter()
                    .filter(|_| rnd() < 0.4)
                    .map(|id| info(id))
                    .collect();
                let removed: Vec<String> =
                    universe.iter().filter(|_| rnd() < 0.1).cloned().collect();
                let machine_offline = rnd() < 0.15;

                let mut extra = serde_json::Map::new();
                if !removed.is_empty() {
                    extra.insert("removedSessions".into(), json!(removed));
                }
                if machine_offline {
                    extra.insert("machineOffline".into(), json!(true));
                }
                let msg = list(&listed, serde_json::Value::Object(extra));

                for s in &listed {
                    ever_known.insert(s.id.clone());
                    tombstoned.remove(&s.id); // re-listing resurrects
                }
                for id in &removed {
                    tombstoned.insert(id.clone());
                }

                state = merge_session_list(&state, &msg, now, MergeOptions::default());

                for id in &ever_known {
                    if tombstoned.contains(id) {
                        assert!(
                            !state.contains_key(id),
                            "seed {seed} step {step}: tombstoned {id} survived"
                        );
                    } else {
                        assert!(
                            state.contains_key(id),
                            "seed {seed} step {step}: lost session {id}"
                        );
                    }
                }
            }
        }
    }
}
