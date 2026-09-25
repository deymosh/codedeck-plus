//! The bridge side of transcript sync.
//!
//! For a `sync-request { sessionId, haveRanges }` from one phone:
//! 1. `missing` = the seqs in `1..=seqHigh` the phone does not have;
//! 2. `sync-begin { syncId, seqHigh, ranges: missing }`;
//! 3. one `sync-chunk` per [`SyncConfig::chunk_size`] seqs of `missing`;
//! 4. the phone acks each chunk; chunks still unacked after
//!    [`SyncConfig::ack_timeout_ms`] are resent, up to
//!    [`SyncConfig::max_retries`] times with the wait doubling each pass;
//! 5. `sync-end { deliveredRanges }` names ONLY the acked chunks — the phone
//!    asks again for whatever is still missing on its next connect.
//!
//! One sync per (session, phone): a newer request replaces the older one,
//! which ends without a `sync-end`. A sync with no activity for
//! [`SyncConfig::idle_timeout_ms`] is closed.

use std::collections::BTreeMap;
use std::num::NonZeroU64;

use protocol::events::{BridgeToPhone, SyncBeginMsg, SyncChunkMsg, SyncEndMsg};
use protocol::ranges::{chunk_ranges, missing_ranges, union_ranges, SeqRange};

use crate::out::{Out, TimerKind};
use crate::ports::Transcripts;

#[derive(Debug, Clone, Copy)]
pub struct SyncConfig {
    pub chunk_size: NonZeroU64,
    pub ack_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub max_retries: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            chunk_size: NonZeroU64::new(50).expect("nonzero"),
            ack_timeout_ms: 10_000,
            idle_timeout_ms: 60_000,
            max_retries: 2,
        }
    }
}

struct Chunk {
    range: SeqRange,
    acked: bool,
}

struct Sync {
    session_id: String,
    phone: String,
    chunks: Vec<Chunk>,
    /// 0 = the first send; 1..=max_retries = resend passes.
    pass: u32,
    ack_timer: Option<crate::io::TimerId>,
    idle_timer: Option<crate::io::TimerId>,
}

#[derive(Default)]
pub struct SyncServer {
    config: SyncConfig,
    by_id: BTreeMap<String, Sync>,
    by_key: BTreeMap<(String, String), String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SyncTimer {
    Ack,
    Idle,
}

impl SyncServer {
    pub fn new(config: SyncConfig) -> Self {
        Self { config, ..Default::default() }
    }

    /// In-flight syncs.
    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.by_id.len()
    }

    /// Start a sync for `phone`, superseding its previous one for this session.
    #[allow(clippy::too_many_arguments)]
    pub fn request(
        &mut self,
        out: &mut Out,
        transcripts: &dyn Transcripts,
        sync_id: String,
        session_id: &str,
        phone: &str,
        have: &[SeqRange],
        seq_high: u64,
    ) {
        let key = (session_id.to_string(), phone.to_string());
        if let Some(old) = self.by_key.get(&key).cloned() {
            log::info!("[Sync] {old}: superseded by a new sync-request for {session_id}");
            self.abort(out, &old);
        }
        let missing = missing_ranges(have, 1, seq_high);
        let chunks = chunk_ranges(&missing, self.config.chunk_size)
            .into_iter()
            .map(|range| Chunk { range, acked: false })
            .collect();
        self.by_key.insert(key, sync_id.clone());
        self.by_id.insert(
            sync_id.clone(),
            Sync {
                session_id: session_id.to_string(),
                phone: phone.to_string(),
                chunks,
                pass: 0,
                ack_timer: None,
                idle_timer: None,
            },
        );
        out.publish(
            vec![phone.to_string()],
            BridgeToPhone::SyncBegin(SyncBeginMsg {
                session_id: session_id.to_string(),
                sync_id: sync_id.clone(),
                seq_high,
                ranges: missing,
            }),
        );
        self.send_pass(out, transcripts, &sync_id);
    }

    /// A phone acked one chunk.
    pub fn ack(&mut self, out: &mut Out, sync_id: &str, range: SeqRange) {
        let Some(sync) = self.by_id.get_mut(sync_id) else { return };
        let Some(chunk) = sync.chunks.iter_mut().find(|c| c.range == range) else {
            log::info!("[Sync] {sync_id}: ack for unknown range [{},{}]", range.0, range.1);
            return;
        };
        chunk.acked = true;
        if sync.chunks.iter().all(|c| c.acked) {
            self.finish(out, sync_id, "complete");
        } else {
            self.touch(out, sync_id);
        }
    }

    pub fn timer_fired(&mut self, out: &mut Out, transcripts: &dyn Transcripts, sync_id: &str, timer: SyncTimer) {
        let Some(sync) = self.by_id.get_mut(sync_id) else { return };
        match timer {
            SyncTimer::Idle => {
                sync.idle_timer = None;
                log::info!("[Sync] {sync_id}: idle for {}ms — closing", self.config.idle_timeout_ms);
                self.finish(out, sync_id, "idle-timeout");
            }
            SyncTimer::Ack => {
                sync.ack_timer = None;
                let unacked = sync.chunks.iter().filter(|c| !c.acked).count();
                if unacked == 0 {
                    self.finish(out, sync_id, "complete");
                } else if sync.pass >= self.config.max_retries {
                    log::info!(
                        "[Sync] {sync_id}: {unacked} chunk(s) unacked after {} retries — reporting partial delivery",
                        sync.pass
                    );
                    self.finish(out, sync_id, "retries-exhausted");
                } else {
                    sync.pass += 1;
                    log::info!("[Sync] {sync_id}: retry pass {} for {unacked} chunk(s)", sync.pass);
                    self.send_pass(out, transcripts, sync_id);
                }
            }
        }
    }

    /// Abort every sync without a `sync-end` (shutdown).
    pub fn close(&mut self, out: &mut Out) {
        let ids: Vec<String> = self.by_id.keys().cloned().collect();
        for id in ids {
            self.abort(out, &id);
        }
    }

    /// Send every unacked chunk, then wait for acks.
    fn send_pass(&mut self, out: &mut Out, transcripts: &dyn Transcripts, sync_id: &str) {
        let Some(sync) = self.by_id.get(sync_id) else { return };
        let (session_id, phone) = (sync.session_id.clone(), sync.phone.clone());
        let ranges: Vec<SeqRange> = sync.chunks.iter().filter(|c| !c.acked).map(|c| c.range).collect();
        if ranges.is_empty() {
            self.finish(out, sync_id, "complete");
            return;
        }
        for range in ranges {
            let entries = match transcripts.read(&session_id, range) {
                Ok(entries) => entries,
                Err(err) => {
                    log::warn!("[Sync] {sync_id}: reading [{},{}] failed: {err}", range.0, range.1);
                    self.finish(out, sync_id, "error");
                    return;
                }
            };
            out.publish(
                vec![phone.clone()],
                BridgeToPhone::SyncChunk(SyncChunkMsg {
                    session_id: session_id.clone(),
                    sync_id: sync_id.to_string(),
                    range,
                    entries,
                }),
            );
        }
        self.touch(out, sync_id);
        let pass = self.by_id.get(sync_id).map_or(0, |s| s.pass);
        let delay = self.config.ack_timeout_ms.saturating_mul(1 << pass.min(16));
        let timer = out.set_timer(delay, TimerKind::SyncAck(sync_id.to_string()));
        if let Some(sync) = self.by_id.get_mut(sync_id) {
            sync.ack_timer = Some(timer);
        }
    }

    /// Restart the idle clock.
    fn touch(&mut self, out: &mut Out, sync_id: &str) {
        let Some(old) = self.by_id.get_mut(sync_id).map(|s| s.idle_timer.take()) else { return };
        if let Some(old) = old {
            out.cancel_timer(old);
        }
        let timer = out.set_timer(self.config.idle_timeout_ms, TimerKind::SyncIdle(sync_id.to_string()));
        if let Some(sync) = self.by_id.get_mut(sync_id) {
            sync.idle_timer = Some(timer);
        }
    }

    /// Close with a `sync-end` that reports only what was acked.
    fn finish(&mut self, out: &mut Out, sync_id: &str, reason: &str) {
        let Some(sync) = self.remove(out, sync_id) else { return };
        let acked: Vec<SeqRange> = sync.chunks.iter().filter(|c| c.acked).map(|c| c.range).collect();
        log::info!("[Sync] {sync_id}: done ({reason})");
        out.publish(
            vec![sync.phone.clone()],
            BridgeToPhone::SyncEnd(SyncEndMsg {
                session_id: sync.session_id,
                sync_id: sync_id.to_string(),
                delivered_ranges: union_ranges(&acked, &[]),
            }),
        );
    }

    fn abort(&mut self, out: &mut Out, sync_id: &str) {
        self.remove(out, sync_id);
    }

    fn remove(&mut self, out: &mut Out, sync_id: &str) -> Option<Sync> {
        let sync = self.by_id.remove(sync_id)?;
        let key = (sync.session_id.clone(), sync.phone.clone());
        if self.by_key.get(&key).is_some_and(|id| id == sync_id) {
            self.by_key.remove(&key);
        }
        for timer in [sync.ack_timer, sync.idle_timer].into_iter().flatten() {
            out.cancel_timer(timer);
        }
        Some(sync)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::Effect;
    use crate::ports::memory::MemoryTranscripts;
    use protocol::common::{EntryBody, OutputEntry};

    struct T {
        out: Out,
        server: SyncServer,
        transcripts: MemoryTranscripts,
        n: u32,
    }

    impl T {
        fn with_entries(count: u64) -> Self {
            let mut transcripts = MemoryTranscripts::default();
            for seq in 1..=count {
                let entry = OutputEntry::new("t", EntryBody::Status { text: format!("e{seq}") });
                transcripts.append("s", seq, &entry).unwrap();
            }
            Self { out: Out::default(), server: SyncServer::new(SyncConfig::default()), transcripts, n: 0 }
        }

        fn request(&mut self, phone: &str, have: &[SeqRange], seq_high: u64) -> String {
            self.n += 1;
            let id = format!("sync{}", self.n);
            self.server.request(&mut self.out, &self.transcripts, id.clone(), "s", phone, have, seq_high);
            id
        }

        fn messages(&mut self) -> Vec<BridgeToPhone> {
            std::mem::take(&mut self.out.effects)
                .into_iter()
                .filter_map(|e| match e {
                    Effect::Publish { message, .. } => Some(message),
                    _ => None,
                })
                .collect()
        }

        /// Fire the pending timer of `kind` for `id`.
        fn fire(&mut self, id: &str, which: SyncTimer) {
            let timer = *self
                .out
                .timers
                .iter()
                .find(|(_, k)| match (k, which) {
                    (TimerKind::SyncAck(s), SyncTimer::Ack) | (TimerKind::SyncIdle(s), SyncTimer::Idle) => s == id,
                    _ => false,
                })
                .expect("timer armed")
                .0;
            self.out.take_timer(timer);
            self.server.timer_fired(&mut self.out, &self.transcripts, id, which);
        }

        fn ack_delay(&self, id: &str) -> u64 {
            self.out
                .timers
                .iter()
                .find(|(_, k)| matches!(k, TimerKind::SyncAck(s) if s == id))
                .map(|(t, _)| self.out.delay_of(*t))
                .expect("ack timer armed")
        }
    }

    fn end_ranges(m: &BridgeToPhone) -> Vec<SeqRange> {
        match m {
            BridgeToPhone::SyncEnd(e) => e.delivered_ranges.clone(),
            other => panic!("expected sync-end, got {other:?}"),
        }
    }

    fn chunk_ranges_of(msgs: &[BridgeToPhone]) -> Vec<SeqRange> {
        msgs.iter()
            .filter_map(|m| match m {
                BridgeToPhone::SyncChunk(c) => Some(c.range),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn full_sync_sends_50_entry_chunks_and_ends_once_all_are_acked() {
        let mut t = T::with_entries(120);
        let id = t.request("phone", &[], 120);
        let msgs = t.messages();
        match &msgs[0] {
            BridgeToPhone::SyncBegin(b) => assert_eq!((b.seq_high, b.ranges.clone()), (120, vec![(1, 120)])),
            other => panic!("{other:?}"),
        }
        assert_eq!(chunk_ranges_of(&msgs), [(1, 50), (51, 100), (101, 120)]);
        match &msgs[1] {
            BridgeToPhone::SyncChunk(c) => {
                assert_eq!(c.entries.len(), 50);
                assert_eq!(c.entries[0].seq, 1);
            }
            other => panic!("{other:?}"),
        }
        for r in [(1, 50), (51, 100), (101, 120)] {
            t.server.ack(&mut t.out, &id, r);
        }
        let msgs = t.messages();
        assert_eq!(end_ranges(&msgs[0]), [(1, 120)]);
        assert_eq!(t.server.active(), 0);
        assert!(t.out.timers.is_empty(), "every timer cancelled");
    }

    #[test]
    fn a_gap_fill_sends_only_the_missing_ranges() {
        let mut t = T::with_entries(120);
        t.request("phone", &[(1, 80)], 120);
        assert_eq!(chunk_ranges_of(&t.messages()), [(81, 120)]);
    }

    #[test]
    fn nothing_missing_begins_and_ends_at_once() {
        let mut t = T::with_entries(10);
        t.request("phone", &[(1, 10)], 10);
        let msgs = t.messages();
        assert!(matches!(&msgs[0], BridgeToPhone::SyncBegin(b) if b.ranges.is_empty()));
        assert!(end_ranges(&msgs[1]).is_empty());
        assert_eq!(t.server.active(), 0);
    }

    #[test]
    fn unacked_chunks_are_resent_with_backoff_then_reported_honestly() {
        let mut t = T::with_entries(100);
        let id = t.request("phone", &[], 100);
        t.messages();
        t.server.ack(&mut t.out, &id, (1, 50));
        assert_eq!(t.ack_delay(&id), 10_000);
        t.fire(&id, SyncTimer::Ack);
        assert_eq!(chunk_ranges_of(&t.messages()), [(51, 100)], "only the unacked chunk is resent");
        assert_eq!(t.ack_delay(&id), 20_000);
        t.fire(&id, SyncTimer::Ack);
        assert_eq!(chunk_ranges_of(&t.messages()), [(51, 100)]);
        assert_eq!(t.ack_delay(&id), 40_000);
        t.fire(&id, SyncTimer::Ack);
        let msgs = t.messages();
        assert_eq!(end_ranges(&msgs[0]), [(1, 50)], "only what was acked");
    }

    #[test]
    fn an_ack_during_the_retries_completes_the_sync() {
        let mut t = T::with_entries(100);
        let id = t.request("phone", &[], 100);
        t.server.ack(&mut t.out, &id, (1, 50));
        t.fire(&id, SyncTimer::Ack);
        t.messages();
        t.server.ack(&mut t.out, &id, (51, 100));
        assert_eq!(end_ranges(&t.messages()[0]), [(1, 100)]);
    }

    #[test]
    fn a_new_request_supersedes_the_old_one_without_a_sync_end() {
        let mut t = T::with_entries(60);
        let old = t.request("phone", &[], 60);
        t.messages();
        let new = t.request("phone", &[(1, 50)], 60);
        let msgs = t.messages();
        assert!(!msgs.iter().any(|m| matches!(m, BridgeToPhone::SyncEnd(_))));
        assert_eq!(t.server.active(), 1);
        t.server.ack(&mut t.out, &old, (1, 50));
        assert!(t.messages().is_empty(), "acks for the superseded sync are ignored");
        t.server.ack(&mut t.out, &new, (51, 60));
        assert_eq!(end_ranges(&t.messages()[0]), [(51, 60)]);
    }

    #[test]
    fn different_phones_sync_the_same_session_independently() {
        let mut t = T::with_entries(10);
        t.request("a", &[], 10);
        t.request("b", &[], 10);
        assert_eq!(t.server.active(), 2);
    }

    #[test]
    fn an_idle_sync_closes_with_what_was_acked() {
        let mut t = T::with_entries(100);
        let id = t.request("phone", &[], 100);
        t.server.ack(&mut t.out, &id, (1, 50));
        t.messages();
        t.fire(&id, SyncTimer::Idle);
        assert_eq!(end_ranges(&t.messages()[0]), [(1, 50)]);
    }

    #[test]
    fn bogus_acks_are_absorbed() {
        let mut t = T::with_entries(10);
        let id = t.request("phone", &[], 10);
        t.messages();
        t.server.ack(&mut t.out, "nope", (1, 10));
        t.server.ack(&mut t.out, &id, (3, 4));
        assert!(t.messages().is_empty());
        assert_eq!(t.server.active(), 1);
    }

    #[test]
    fn close_aborts_every_sync_without_a_sync_end() {
        let mut t = T::with_entries(10);
        t.request("a", &[], 10);
        t.request("b", &[], 10);
        t.messages();
        t.server.close(&mut t.out);
        assert!(t.messages().is_empty());
        assert_eq!(t.server.active(), 0);
        assert!(t.out.timers.is_empty());
    }

    #[test]
    fn after_a_restart_the_phone_gap_fills_exactly_what_it_missed() {
        // 80 entries delivered live, the bridge restarts, 40 more arrive while
        // the phone is away: seqs continue from the store, so the phone asks
        // for exactly [81, 120].
        let mut t = T::with_entries(120);
        let mut restarted = t.transcripts.clone();
        let highs = restarted.load().unwrap();
        assert_eq!(highs["s"], 120);
        let id = t.request("phone", &[(1, 80)], highs["s"]);
        let msgs = t.messages();
        assert_eq!(chunk_ranges_of(&msgs), [(81, 120)]);
        t.server.ack(&mut t.out, &id, (81, 120));
        assert_eq!(end_ranges(&t.messages()[0]), [(81, 120)]);
    }
}
