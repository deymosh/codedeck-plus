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

use crate::wire::common::{GsdState, RemoteSessionInfo, UsageData};
use crate::wire::events::SessionListMsg;

/// A user-dismissed session id keeps suppressing incoming lists for this long
/// (then the bridge is trusted again — it has had ample time to process the
/// close-session).
pub const DISMISSED_TTL_MS: u64 = 60 * 60 * 1000;

/// The three honest presence states for a listed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingPresence {
    Live,
    Stale,
    Offline,
}

/// One session as the machines store holds it. The per-session extras (`usage`,
/// `gsd`) survive every heartbeat — the merge spreads the previous view.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionView {
    pub info: RemoteSessionInfo,
    pub presence: ListingPresence,
    /// ms timestamp this session was last present in an incoming list.
    pub last_listed_at: u64,
    pub usage: Option<UsageData>,
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
#[derive(Debug, Clone, Copy, Default)]
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
