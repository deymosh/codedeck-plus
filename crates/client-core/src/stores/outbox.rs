//! `outbox` store — nothing the user sends silently vanishes. Port of the pure
//! half of `apps/mobile/src/core/stores/outbox.ts`: the explicit lifecycle
//!
//!   Pending   — created; the relay publish not yet confirmed
//!   Published — at least one relay accepted the kind-4515 event
//!   Confirmed — the bridge echoed our `inputId` in an `input-ack`
//!   Failed    — publish failed / `input-failed` / no ack within the timeout
//!               (sweep) — visible in the UI with a retry action
//!
//! The `await transport.publish` itself is the runtime's; the state-machine
//! decisions here are pure. Every transition is a `put`, so the runtime
//! persists after each — an app kill mid-send leaves an honest
//! `Pending`/`Published` record the next boot's `sweep` surfaces as
//! failed-with-retry.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const OUTBOX_CONFIRM_TIMEOUT_MS: u64 = 30_000;

/// CDX-013 retention: resolved items (`Confirmed`/`Failed`) beyond this cap are
/// dropped oldest-first; unresolved items are NEVER dropped.
pub const MAX_OUTBOX_ITEMS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutboxItemState {
    Pending,
    Published,
    Confirmed,
    Failed,
}

impl OutboxItemState {
    fn is_resolved(self) -> bool {
        matches!(self, Self::Confirmed | Self::Failed)
    }
    fn is_unresolved(self) -> bool {
        matches!(self, Self::Pending | Self::Published)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    /// Also the wire `inputId` echoed back by `input-ack`.
    pub id: String,
    pub machine: String,
    pub session_id: String,
    pub text: String,
    pub state: OutboxItemState,
    pub created_at: u64,
    pub published_at: Option<u64>,
    pub confirmed_at: Option<u64>,
    pub failed_at: Option<u64>,
    pub error: Option<String>,
    pub attempts: u32,
}

/// A JSON array of the items. Hydrate is total on garbage.
pub fn serialize_outbox(items: &BTreeMap<String, OutboxItem>) -> String {
    serde_json::to_string(&items.values().collect::<Vec<_>>()).expect("OutboxItem serializes")
}

pub fn hydrate_outbox(raw: Option<&str>) -> BTreeMap<String, OutboxItem> {
    let Some(raw) = raw else {
        return BTreeMap::new();
    };
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(raw) else {
        return BTreeMap::new();
    };
    items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<OutboxItem>(v).ok())
        .filter(|i| !i.id.is_empty())
        .map(|i| (i.id.clone(), i))
        .collect()
}

/// The outbox as a pure state machine. The runtime owns the `await
/// transport.publish` between `begin_publish` and `settle_publish`, and
/// persists `serialize_outbox` after any change.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboxState {
    pub items: BTreeMap<String, OutboxItem>,
    pub confirm_timeout_ms: u64,
    pub max_items: usize,
}

impl Default for OutboxState {
    fn default() -> Self {
        Self {
            items: BTreeMap::new(),
            confirm_timeout_ms: OUTBOX_CONFIRM_TIMEOUT_MS,
            max_items: MAX_OUTBOX_ITEMS,
        }
    }
}

impl OutboxState {
    pub fn new(items: BTreeMap<String, OutboxItem>) -> Self {
        Self {
            items,
            ..Self::default()
        }
    }

    pub fn item(&self, id: &str) -> Option<&OutboxItem> {
        self.items.get(id)
    }

    /// Every item for one session, oldest first.
    pub fn items_for(&self, machine: &str, session_id: &str) -> Vec<&OutboxItem> {
        let mut out: Vec<&OutboxItem> = self
            .items
            .values()
            .filter(|i| i.machine == machine && i.session_id == session_id)
            .collect();
        out.sort_by_key(|i| i.created_at);
        out
    }

    /// Pending / Published items (nothing the user sent has landed yet).
    pub fn unresolved(&self) -> Vec<&OutboxItem> {
        self.items.values().filter(|i| i.state.is_unresolved()).collect()
    }

    /// A fresh input to send (`attempts` 0). Not stored yet — pass it to
    /// [`Self::begin_publish`].
    pub fn new_input(
        id: impl Into<String>,
        machine: impl Into<String>,
        session_id: impl Into<String>,
        text: impl Into<String>,
        now: u64,
    ) -> OutboxItem {
        OutboxItem {
            id: id.into(),
            machine: machine.into(),
            session_id: session_id.into(),
            text: text.into(),
            state: OutboxItemState::Pending,
            created_at: now,
            published_at: None,
            confirmed_at: None,
            failed_at: None,
            error: None,
            attempts: 0,
        }
    }

    /// Mark an item `Pending`, bump `attempts`, clear the previous error, and
    /// store it. The runtime then `await`s the publish and calls
    /// [`Self::settle_publish`].
    pub fn begin_publish(&mut self, mut item: OutboxItem) -> OutboxItem {
        item.state = OutboxItemState::Pending;
        item.attempts += 1;
        item.error = None;
        item.failed_at = None;
        self.put(item.clone());
        item
    }

    /// Fold the publish result in. A `Confirmed`/`Failed` verdict already
    /// recorded (an ack can beat the publish future) always wins.
    pub fn settle_publish(
        &mut self,
        id: &str,
        accepted: bool,
        error: Option<String>,
        now: u64,
    ) -> Option<OutboxItem> {
        let current = self.items.get(id)?.clone();
        if current.state.is_resolved() {
            return Some(current);
        }
        let next = if accepted {
            OutboxItem {
                state: OutboxItemState::Published,
                published_at: Some(now),
                ..current
            }
        } else {
            OutboxItem {
                state: OutboxItemState::Failed,
                failed_at: Some(now),
                error: Some(error.unwrap_or_else(|| "no relay accepted the event".to_string())),
                ..current
            }
        };
        self.put(next.clone());
        Some(next)
    }

    /// `input-ack` from the bridge.
    pub fn confirm(&mut self, id: &str, now: u64) {
        if let Some(item) = self.items.get(id) {
            if item.state != OutboxItemState::Confirmed {
                let next = OutboxItem {
                    state: OutboxItemState::Confirmed,
                    confirmed_at: Some(now),
                    error: None,
                    ..item.clone()
                };
                self.put(next);
            }
        }
    }

    /// `input-failed` from the bridge. A verdict never regresses.
    pub fn fail(&mut self, id: &str, reason: impl Into<String>, now: u64) {
        if let Some(item) = self.items.get(id) {
            if !item.state.is_resolved() {
                let next = OutboxItem {
                    state: OutboxItemState::Failed,
                    failed_at: Some(now),
                    error: Some(reason.into()),
                    ..item.clone()
                };
                self.put(next);
            }
        }
    }

    /// A user retry. `Some(item)` = re-publish this (already re-marked
    /// `Pending`, `attempts` bumped); `None` = the item is not failed, no-op.
    pub fn mark_retry(&mut self, id: &str) -> Option<OutboxItem> {
        let item = self.items.get(id)?.clone();
        if item.state != OutboxItemState::Failed {
            return None;
        }
        Some(self.begin_publish(item))
    }

    /// Time out unanswered sends: Pending/Published older than the timeout →
    /// Failed (visible + retryable).
    pub fn sweep(&mut self, now: u64) {
        let due: Vec<OutboxItem> = self
            .items
            .values()
            .filter(|i| i.state.is_unresolved())
            .filter(|i| {
                let started = i.published_at.unwrap_or(i.created_at);
                now.saturating_sub(started) >= self.confirm_timeout_ms
            })
            .cloned()
            .collect();
        for item in due {
            let error = if item.state == OutboxItemState::Published {
                "no ack from bridge"
            } else {
                "publish timed out"
            };
            self.put(OutboxItem {
                state: OutboxItemState::Failed,
                failed_at: Some(now),
                error: Some(error.to_string()),
                ..item
            });
        }
    }

    /// Insert + CDX-013 retention: past `max_items`, evict the OLDEST resolved
    /// items (never the one just written, never an unresolved one).
    fn put(&mut self, item: OutboxItem) {
        let just_written = item.id.clone();
        self.items.insert(item.id.clone(), item);
        if self.items.len() <= self.max_items {
            return;
        }
        let mut victims: Vec<(u64, String)> = self
            .items
            .values()
            .filter(|i| i.state.is_resolved() && i.id != just_written)
            .map(|i| (i.created_at, i.id.clone()))
            .collect();
        victims.sort();
        let mut excess = self.items.len() - self.max_items;
        for (_, id) in victims {
            if excess == 0 {
                break;
            }
            self.items.remove(&id);
            excess -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(now: u64) -> (OutboxState, OutboxItem) {
        let mut st = OutboxState::default();
        let item = st.begin_publish(OutboxState::new_input("in-1", "m1", "sess", "x", now));
        (st, item)
    }

    #[test]
    fn begin_then_settle_accepted_lands_published() {
        let (mut st, _) = seeded(1000);
        let settled = st.settle_publish("in-1", true, None, 1000).unwrap();
        assert_eq!(settled.state, OutboxItemState::Published);
        assert_eq!(settled.published_at, Some(1000));
        assert_eq!(settled.attempts, 1);
    }

    #[test]
    fn settle_rejected_lands_failed_with_a_visible_error() {
        let (mut st, _) = seeded(1000);
        let settled = st.settle_publish("in-1", false, None, 1000).unwrap();
        assert_eq!(settled.state, OutboxItemState::Failed);
        assert_eq!(settled.error.as_deref(), Some("no relay accepted the event"));
        let thrown = {
            let mut st = OutboxState::default();
            st.begin_publish(OutboxState::new_input("t", "m", "s", "x", 1));
            st.settle_publish("t", false, Some("socket dead".into()), 1).unwrap()
        };
        assert!(thrown.error.as_deref().unwrap().contains("socket dead"));
    }

    #[test]
    fn an_ack_racing_the_publish_result_wins() {
        let (mut st, _) = seeded(1000);
        st.confirm("in-1", 1001); // ack beats the publish future
        let settled = st.settle_publish("in-1", true, None, 1002).unwrap();
        assert_eq!(settled.state, OutboxItemState::Confirmed);
    }

    #[test]
    fn input_ack_flips_published_to_confirmed_and_clears_unresolved() {
        let (mut st, _) = seeded(1000);
        st.settle_publish("in-1", true, None, 1000);
        st.confirm("in-1", 1010);
        assert_eq!(st.item("in-1").unwrap().state, OutboxItemState::Confirmed);
        assert!(st.unresolved().is_empty());
    }

    #[test]
    fn input_failed_sets_the_reason_but_a_verdict_never_regresses() {
        let (mut st, _) = seeded(1000);
        st.settle_publish("in-1", true, None, 1000);
        st.fail("in-1", "no-session", 1010);
        assert_eq!(st.item("in-1").unwrap().error.as_deref(), Some("no-session"));

        st.begin_publish(OutboxState::new_input("in-2", "m1", "sess", "b", 1000));
        st.settle_publish("in-2", true, None, 1000);
        st.confirm("in-2", 1005);
        st.fail("in-2", "late-failure", 1006);
        assert_eq!(st.item("in-2").unwrap().state, OutboxItemState::Confirmed);
    }

    #[test]
    fn retry_republishes_a_failed_item_under_the_same_id_bumping_attempts() {
        let (mut st, _) = seeded(1000);
        st.settle_publish("in-1", false, None, 1000);
        let to_publish = st.mark_retry("in-1").unwrap();
        assert_eq!(to_publish.id, "in-1");
        assert_eq!(to_publish.state, OutboxItemState::Pending);
        assert_eq!(to_publish.attempts, 2);
        let settled = st.settle_publish("in-1", true, None, 1100).unwrap();
        assert_eq!(settled.state, OutboxItemState::Published);
        assert_eq!(settled.attempts, 2);
    }

    #[test]
    fn retry_on_a_non_failed_item_is_a_no_op() {
        let (mut st, _) = seeded(1000);
        st.settle_publish("in-1", true, None, 1000);
        assert!(st.mark_retry("in-1").is_none());
        assert!(st.mark_retry("ghost").is_none());
    }

    #[test]
    fn sweep_times_out_a_published_but_unacked_item() {
        let (mut st, _) = seeded(1000);
        st.settle_publish("in-1", true, None, 1000);
        st.sweep(1000 + OUTBOX_CONFIRM_TIMEOUT_MS - 1);
        assert_eq!(st.item("in-1").unwrap().state, OutboxItemState::Published);
        st.sweep(1000 + OUTBOX_CONFIRM_TIMEOUT_MS);
        assert_eq!(st.item("in-1").unwrap().state, OutboxItemState::Failed);
        assert_eq!(st.item("in-1").unwrap().error.as_deref(), Some("no ack from bridge"));
    }

    #[test]
    fn sweep_leaves_confirmed_and_already_failed_alone() {
        let mut st = OutboxState {
            confirm_timeout_ms: 10,
            ..OutboxState::default()
        };
        st.begin_publish(OutboxState::new_input("a", "m", "s", "a", 1000));
        st.confirm("a", 1000);
        st.sweep(999_999);
        assert_eq!(st.item("a").unwrap().state, OutboxItemState::Confirmed);
    }

    #[test]
    fn a_pending_item_from_a_previous_run_becomes_failed_on_the_next_sweep() {
        let (st, _) = seeded(1000); // stays Pending (no settle)
        let raw = serialize_outbox(&st.items);
        let mut booted = OutboxState::new(hydrate_outbox(Some(&raw)));
        booted.sweep(10_000_000);
        assert_eq!(booted.item("in-1").unwrap().state, OutboxItemState::Failed);
        assert_eq!(booted.item("in-1").unwrap().error.as_deref(), Some("publish timed out"));
    }

    // --- persistence ---

    #[test]
    fn round_trip_preserves_every_item_garbage_hydrates_empty() {
        let (mut st, _) = seeded(1);
        st.settle_publish("in-1", true, None, 2);
        let back = hydrate_outbox(Some(&serialize_outbox(&st.items)));
        assert_eq!(back, st.items);
        assert!(hydrate_outbox(None).is_empty());
        assert!(hydrate_outbox(Some("nope")).is_empty());
        assert!(hydrate_outbox(Some(r#"{"a":1}"#)).is_empty());
    }

    // --- retention cap (CDX-013) ---

    #[test]
    fn retention_evicts_the_oldest_resolved_items_beyond_the_cap() {
        let mut st = OutboxState {
            max_items: 5,
            ..OutboxState::default()
        };
        let mut ids = Vec::new();
        for i in 0..8 {
            let id = format!("in-{i}");
            st.begin_publish(OutboxState::new_input(&id, "m1", "sess", "x", 1000 + i));
            st.settle_publish(&id, true, None, 1000 + i);
            st.confirm(&id, 1000 + i);
            ids.push(id);
        }
        assert!(st.items.len() <= 5);
        assert!(st.items.contains_key(&ids[7]));
        assert!(!st.items.contains_key(&ids[0]));
    }

    #[test]
    fn retention_never_evicts_unresolved_items_even_over_the_cap() {
        let mut st = OutboxState {
            max_items: 3,
            ..OutboxState::default()
        };
        for i in 0..6 {
            let id = format!("in-{i}");
            st.begin_publish(OutboxState::new_input(&id, "m1", "sess", "x", 1000 + i));
            st.settle_publish(&id, true, None, 1000 + i); // Published, unresolved
        }
        assert_eq!(st.items.len(), 6);
        assert!(st.items.values().all(|i| i.state == OutboxItemState::Published));
    }
}
