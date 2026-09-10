//! `Router` — decoded `BridgeToPhone` → the `CoreStores` state machines. The
//! Rust mirror of the `handlers` table in `apps/mobile/src/core/createPhoneCore.ts`.
//!
//! `route` applies a message to the stores and returns a [`RouteResult`]: the
//! stores the runtime must re-serialize to the `Kv`, and any phone→bridge
//! commands the message provoked (a `sync-ack` after a durable chunk write, a
//! `sync-request` when `sync-end` left a gap). The event loop turns the sends
//! into signed commands and persists the named stores.
//!
//! Built in slices by message family; unhandled variants are a no-op until
//! their slice lands.

use std::collections::{HashMap, HashSet};

use client_core::stores::transcript::SyncEffect;
use client_core::wire::commands::{PhoneToBridge, SyncAckMsg, SyncRequestMsg, VersionFields};
use client_core::wire::events::BridgeToPhone;

use crate::ports::{TranscriptRow, TranscriptStore};
use crate::stores::CoreStores;

/// A `client_core` store the runtime must re-serialize to the `Kv` after a
/// route mutated it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreId {
    Machines,
    Outbox,
    Dm,
    Marmot,
    Settings,
    QuickPrompts,
}

/// What a routed message asks the event loop to do beyond the in-memory store
/// mutation `route` already applied.
#[derive(Debug, Default, PartialEq)]
pub struct RouteResult {
    /// Stores to re-serialize to the `Kv`.
    pub persist: Vec<StoreId>,
    /// Commands to build + publish to the routed machine.
    pub sends: Vec<PhoneToBridge>,
}

impl RouteResult {
    fn persist(&mut self, id: StoreId) {
        if !self.persist.contains(&id) {
            self.persist.push(id);
        }
    }
}

pub struct Router<'a> {
    pub stores: &'a mut CoreStores,
    pub transcript_store: &'a dyn TranscriptStore,
    /// Phone pubkey (self-copy / viewing checks in later slices).
    pub me: &'a str,
    pub now: u64,
}

impl<'a> Router<'a> {
    pub fn new(
        stores: &'a mut CoreStores,
        transcript_store: &'a dyn TranscriptStore,
        me: &'a str,
        now: u64,
    ) -> Self {
        Self {
            stores,
            transcript_store,
            me,
            now,
        }
    }

    pub async fn route(&mut self, machine: &str, msg: &BridgeToPhone) -> RouteResult {
        let mut r = RouteResult::default();
        match msg {
            BridgeToPhone::Output(m) => {
                let entry = to_value(&m.entry);
                self.apply_rows(machine, &m.session_id, vec![(m.seq, entry)])
                    .await;
            }
            BridgeToPhone::SyncBegin(m) => {
                self.stores.transcript.apply_sync_begin(
                    machine,
                    &m.session_id,
                    &m.sync_id,
                    m.seq_high,
                );
            }
            BridgeToPhone::SyncChunk(m) => {
                let rows = m
                    .entries
                    .iter()
                    .map(|e| (e.seq, to_value(&e.entry)))
                    .collect();
                self.apply_rows(machine, &m.session_id, rows).await;
                // Ack AFTER the entries are durably stored — an ack must never
                // claim data we could still lose.
                r.sends.push(PhoneToBridge::SyncAck(SyncAckMsg {
                    version: VersionFields::default(),
                    sync_id: m.sync_id.clone(),
                    range: m.range,
                }));
            }
            BridgeToPhone::SyncEnd(m) => {
                let effects = self
                    .stores
                    .transcript
                    .apply_sync_end(machine, &m.session_id, self.now);
                r.sends.extend(effects.into_iter().map(sync_effect_to_cmd));
            }
            BridgeToPhone::InputAck(m) => {
                self.stores.outbox.confirm(&m.input_id, self.now);
                r.persist(StoreId::Outbox);
            }
            BridgeToPhone::InputFailed(m) => {
                if let Some(id) = &m.input_id {
                    let reason = to_value(&m.reason)
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_default();
                    self.stores.outbox.fail(id, reason, self.now);
                    r.persist(StoreId::Outbox);
                }
            }
            // Remaining families land in later slices.
            _ => {}
        }
        r
    }

    /// Insert rows through the [`TranscriptStore`] port, then fold the inserted
    /// seqs (and any content conflicts on already-stored seqs) into the pure
    /// [`client_core::stores::transcript::TranscriptState`].
    async fn apply_rows(
        &mut self,
        machine: &str,
        session: &str,
        rows: Vec<(u64, serde_json::Value)>,
    ) {
        if rows.is_empty() {
            return;
        }
        let store_rows: Vec<TranscriptRow> = rows
            .iter()
            .map(|(seq, entry)| TranscriptRow {
                seq: *seq,
                entry: entry.clone(),
            })
            .collect();
        let inserted = self
            .transcript_store
            .insert_ignore(machine, session, &store_rows)
            .await;
        let inserted_set: HashSet<u64> = inserted.iter().copied().collect();

        // Already stored: same seq must mean same content — anything else is
        // renumbering, which we record and refuse to apply.
        let mut conflicts = Vec::new();
        let non_inserted: Vec<u64> = rows
            .iter()
            .map(|(seq, _)| *seq)
            .filter(|seq| !inserted_set.contains(seq))
            .collect();
        if !non_inserted.is_empty() {
            let lo = non_inserted.iter().copied().min().unwrap();
            let hi = non_inserted.iter().copied().max().unwrap();
            let stored: HashMap<u64, serde_json::Value> = self
                .transcript_store
                .read_range(machine, session, lo, hi)
                .await
                .into_iter()
                .map(|row| (row.seq, row.entry))
                .collect();
            for (seq, entry) in &rows {
                if inserted_set.contains(seq) {
                    continue;
                }
                if let Some(existing) = stored.get(seq) {
                    if existing != entry {
                        conflicts.push(*seq);
                    }
                }
            }
        }

        self.stores
            .transcript
            .integrate_rows(machine, session, &inserted, &conflicts);
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn sync_effect_to_cmd(effect: SyncEffect) -> PhoneToBridge {
    match effect {
        SyncEffect::SendSyncRequest {
            session_id,
            have_ranges,
        } => PhoneToBridge::SyncRequest(SyncRequestMsg {
            version: VersionFields::default(),
            session_id,
            have_ranges,
        }),
        SyncEffect::SendSyncAck { sync_id, range } => PhoneToBridge::SyncAck(SyncAckMsg {
            version: VersionFields::default(),
            sync_id,
            range,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::MemoryTranscriptStore;
    use crate::stores::{hydrate, StoresConfig};
    use crate::ports::MemoryKv;
    use client_core::stores::outbox::{OutboxItemState, OutboxState};
    use client_core::wire::events::{
        InputAckMsg, InputFailedMsg, OutputMsg, SyncChunkMsg, SyncEndMsg,
    };
    use client_core::wire::common::{OutputEntry, OutputEntryType};
    use serde_json::json;

    const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const MACHINE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    async fn stores() -> (CoreStores, MemoryTranscriptStore) {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        (h.stores, ts)
    }

    fn text_entry(content: &str) -> OutputEntry {
        OutputEntry {
            entry_type: OutputEntryType::Text,
            content: content.to_string(),
            timestamp: "t".to_string(),
            metadata: None,
            diff: None,
        }
    }

    #[tokio::test]
    async fn output_stores_the_row_and_advances_coverage() {
        let (mut s, ts) = stores().await;
        let mut r = Router::new(&mut s, &ts, ME, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("hello"),
                }),
            )
            .await;
        assert_eq!(out, RouteResult::default());
        assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1]);
        assert!(s.transcript.has_contiguous(MACHINE, "s1", Some(1)));
    }

    #[tokio::test]
    async fn a_re_delivered_seq_with_different_content_is_a_recorded_conflict() {
        let (mut s, ts) = stores().await;
        {
            let mut r = Router::new(&mut s, &ts, ME, 1_000);
            r.route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("first"),
                }),
            )
            .await;
        }
        {
            let mut r = Router::new(&mut s, &ts, ME, 2_000);
            r.route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("REWRITTEN"),
                }),
            )
            .await;
        }
        assert_eq!(s.transcript.seq_conflicts.len(), 1);
        assert_eq!(s.transcript.seq_conflicts[0].seq, 1);
        // the stored row is untouched — the first content wins
        let rows = ts.read_range(MACHINE, "s1", 1, 1).await;
        assert_eq!(rows[0].entry, json!({ "entryType": "text", "content": "first", "timestamp": "t" }));
    }

    #[tokio::test]
    async fn sync_chunk_stores_then_acks_after_the_write() {
        let (mut s, ts) = stores().await;
        let mut r = Router::new(&mut s, &ts, ME, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SyncChunk(SyncChunkMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    range: (1, 2),
                    entries: vec![
                        client_core::wire::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        client_core::wire::events::SyncEntry { seq: 2, entry: text_entry("b") },
                    ],
                }),
            )
            .await;
        assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1, 2]);
        assert_eq!(
            out.sends,
            vec![PhoneToBridge::SyncAck(SyncAckMsg {
                version: VersionFields::default(),
                sync_id: "sy1".into(),
                range: (1, 2),
            })]
        );
    }

    #[tokio::test]
    async fn sync_end_with_a_gap_re_requests() {
        let (mut s, ts) = stores().await;
        // seq 5 is advertised but only 1..=2 are covered
        s.transcript.apply_sync_begin(MACHINE, "s1", "sy1", 5);
        {
            let mut r = Router::new(&mut s, &ts, ME, 1_000);
            r.route(
                MACHINE,
                &BridgeToPhone::SyncChunk(SyncChunkMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    range: (1, 2),
                    entries: vec![
                        client_core::wire::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        client_core::wire::events::SyncEntry { seq: 2, entry: text_entry("b") },
                    ],
                }),
            )
            .await;
        }
        let mut r = Router::new(&mut s, &ts, ME, 2_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SyncEnd(SyncEndMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    delivered_ranges: vec![(1, 2)],
                }),
            )
            .await;
        assert!(matches!(
            out.sends.as_slice(),
            [PhoneToBridge::SyncRequest(m)] if m.session_id == "s1"
        ));
    }

    #[tokio::test]
    async fn input_ack_confirms_the_outbox_item_and_asks_for_a_persist() {
        let (mut s, ts) = stores().await;
        let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
        s.outbox.begin_publish(item);
        s.outbox.settle_publish("in-1", true, None, 600);

        let mut r = Router::new(&mut s, &ts, ME, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::InputAck(InputAckMsg {
                    session_id: "s1".into(),
                    input_id: "in-1".into(),
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Outbox]);
        assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Confirmed);
    }

    #[tokio::test]
    async fn input_failed_marks_the_item_failed_with_the_wire_reason() {
        let (mut s, ts) = stores().await;
        let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
        s.outbox.begin_publish(item);
        s.outbox.settle_publish("in-1", true, None, 600);

        let mut r = Router::new(&mut s, &ts, ME, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::InputFailed(InputFailedMsg {
                    session_id: "s1".into(),
                    reason: client_core::wire::events::InputFailedReason::Busy,
                    input_id: Some("in-1".into()),
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Outbox]);
        assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Failed);
        assert_eq!(s.outbox.items["in-1"].error.as_deref(), Some("busy"));
    }
}
