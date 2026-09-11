//! `transcript` — the per-session sync client. Port of the pure half of
//! `apps/mobile/src/core/stores/transcript.ts` (the storage port + the single
//! write queue are the runtime's).
//!
//! Kills bug B by design:
//! - `have_ranges` is computed from what is actually stored — a `sync-request`
//!   carries the truth, so exactly the gaps get re-delivered.
//! - Per-session bounded attempts + exponential retry backoff REPLACE the old
//!   never-reset `autoHistoryRequested` set: a failed sync retries after a
//!   backoff, and [`TranscriptState::on_reconnect`] resets every cycle so a
//!   fresh connection always gets a fresh chance.
//! - A seq re-arriving with different content is a recorded `seq_conflict`
//!   (forbidden bridge-side renumbering) and NOT applied — the runtime computes
//!   that from the storage rows and passes it in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use protocol::ranges::{missing_ranges, normalize_ranges, union_ranges, SeqRange};

pub const SYNC_MAX_ATTEMPTS: u32 = 3;
pub const SYNC_RETRY_BASE_MS: u64 = 5_000;
pub const SYNC_RETRY_MAX_MS: u64 = 300_000;

/// Retry backoff after a failed sync cycle: 5s → 5min cap, exponential.
pub fn sync_retry_delay_ms(attempts: u32) -> u64 {
    let exp = attempts.saturating_sub(1).min(20);
    SYNC_RETRY_BASE_MS
        .saturating_mul(1u64 << exp)
        .min(SYNC_RETRY_MAX_MS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Idle,
    Requested,
    Syncing,
    Complete,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSyncStatus {
    pub state: SyncState,
    /// sync-requests sent in the current cycle (reset on success / reconnect).
    pub attempts: u32,
    /// When `state == Failed`: earliest ms a retry may fire.
    pub next_retry_at: Option<u64>,
    pub active_sync_id: Option<String>,
    /// seqHigh we are trying to cover.
    pub target: u64,
}

impl Default for SessionSyncStatus {
    fn default() -> Self {
        Self {
            state: SyncState::Idle,
            attempts: 0,
            next_retry_at: None,
            active_sync_id: None,
            target: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTranscript {
    pub machine: String,
    pub session_id: String,
    pub have_ranges: Vec<SeqRange>,
    /// Highest locally-stored seq (0 = empty).
    pub local_high: u64,
    pub sync: SessionSyncStatus,
}

impl SessionTranscript {
    fn fresh(machine: &str, session_id: &str) -> Self {
        Self {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
            have_ranges: Vec::new(),
            local_high: 0,
            sync: SessionSyncStatus::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeqConflict {
    pub machine: String,
    pub session_id: String,
    pub seq: u64,
}

/// What the runtime must send after a state transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncEffect {
    /// `sync-request` carrying the real `have_ranges`.
    SendSyncRequest {
        session_id: String,
        have_ranges: Vec<SeqRange>,
    },
    /// `sync-ack` — sent ONLY after the chunk's rows are durably stored.
    SendSyncAck {
        sync_id: String,
        range: SeqRange,
    },
}

/// The transcript sync client as a pure state machine. The runtime owns the
/// `TranscriptStore` port: it calls `storage.insert_ignore` / `seqs` /
/// `read_range` / `remove` and feeds the results in here.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptState {
    sessions: BTreeMap<(String, String), SessionTranscript>,
    pub seq_conflicts: Vec<SeqConflict>,
    pub max_attempts: u32,
}

impl TranscriptState {
    pub fn new(max_attempts: u32) -> Self {
        Self {
            sessions: BTreeMap::new(),
            seq_conflicts: Vec::new(),
            max_attempts: if max_attempts == 0 {
                SYNC_MAX_ATTEMPTS
            } else {
                max_attempts
            },
        }
    }

    fn key(machine: &str, session_id: &str) -> (String, String) {
        (machine.to_string(), session_id.to_string())
    }

    fn get_or_create(&mut self, machine: &str, session_id: &str) -> &mut SessionTranscript {
        self.sessions
            .entry(Self::key(machine, session_id))
            .or_insert_with(|| SessionTranscript::fresh(machine, session_id))
    }

    pub fn session(&self, machine: &str, session_id: &str) -> Option<&SessionTranscript> {
        self.sessions.get(&Self::key(machine, session_id))
    }

    pub fn have_ranges_of(&self, machine: &str, session_id: &str) -> Vec<SeqRange> {
        self.session(machine, session_id)
            .map(|s| s.have_ranges.clone())
            .unwrap_or_default()
    }

    /// True iff the session's coverage is a single range starting at 1 (and
    /// reaching `expected_high` when given). An empty transcript is contiguous
    /// only against `None` / `Some(0)`.
    pub fn has_contiguous(&self, machine: &str, session_id: &str, expected_high: Option<u64>) -> bool {
        let ranges = self.have_ranges_of(machine, session_id);
        if ranges.is_empty() {
            return matches!(expected_high, None | Some(0));
        }
        if ranges.len() != 1 || ranges[0].0 != 1 {
            return false;
        }
        expected_high.is_none_or(|h| ranges[0].1 == h)
    }

    /// Boot path: the runtime read `storage.seqs`; normalize them to coverage.
    pub fn hydrate_from_seqs(&mut self, machine: &str, session_id: &str, seqs: &[u64]) {
        let ranges = normalize_ranges(&seqs.iter().map(|&s| (s, s)).collect::<Vec<_>>());
        let local_high = ranges.last().map(|r| r.1).unwrap_or(0);
        let s = self.get_or_create(machine, session_id);
        s.have_ranges = ranges;
        s.local_high = local_high;
    }

    /// After the runtime's `storage.insert_ignore` (→ `inserted` seqs) and its
    /// content comparison of the rest (→ `conflicts`): fold coverage forward
    /// and record any renumbering.
    pub fn integrate_rows(
        &mut self,
        machine: &str,
        session_id: &str,
        inserted: &[u64],
        conflicts: &[u64],
    ) {
        {
            let s = self.get_or_create(machine, session_id);
            if !inserted.is_empty() {
                let ins: Vec<SeqRange> = inserted.iter().map(|&seq| (seq, seq)).collect();
                s.have_ranges = union_ranges(&s.have_ranges, &ins);
                s.local_high = s.have_ranges.last().map(|r| r.1).unwrap_or(0);
            }
        }
        for &seq in conflicts {
            self.seq_conflicts.push(SeqConflict {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
                seq,
            });
        }
    }

    /// Explicit removal (tombstone / user delete). The runtime also calls
    /// `storage.remove`.
    pub fn remove_session(&mut self, machine: &str, session_id: &str) {
        self.sessions.remove(&Self::key(machine, session_id));
    }

    fn start_cycle(
        &mut self,
        machine: &str,
        session_id: &str,
        target: u64,
    ) -> Vec<SyncEffect> {
        let s = self.get_or_create(machine, session_id);
        s.sync.state = SyncState::Requested;
        s.sync.attempts += 1;
        s.sync.next_retry_at = None;
        s.sync.active_sync_id = None;
        s.sync.target = target.max(s.sync.target);
        vec![SyncEffect::SendSyncRequest {
            session_id: session_id.to_string(),
            have_ranges: s.have_ranges.clone(),
        }]
    }

    /// `sync-begin`: the bridge is about to stream. → `Syncing`.
    pub fn apply_sync_begin(
        &mut self,
        machine: &str,
        session_id: &str,
        sync_id: &str,
        seq_high: u64,
    ) {
        let s = self.get_or_create(machine, session_id);
        s.sync.state = SyncState::Syncing;
        s.sync.active_sync_id = Some(sync_id.to_string());
        s.sync.target = s.sync.target.max(seq_high);
    }

    /// `sync-chunk`: emit the ack. The runtime calls this ONLY after
    /// [`Self::integrate_rows`] has durably stored the chunk's entries.
    pub fn ack_sync_chunk(&self, sync_id: &str, range: SeqRange) -> SyncEffect {
        SyncEffect::SendSyncAck {
            sync_id: sync_id.to_string(),
            range,
        }
    }

    /// `sync-end`: reconcile. Covered → `Complete`; a gap with attempts left →
    /// re-request now; attempts exhausted → `Failed` with a retry timestamp
    /// (NEVER permanent — `on_reconnect` clears it).
    pub fn apply_sync_end(&mut self, machine: &str, session_id: &str, now: u64) -> Vec<SyncEffect> {
        let Some(s) = self.sessions.get(&Self::key(machine, session_id)) else {
            return vec![];
        };
        let target = s.sync.target.max(s.local_high);
        let missing = if target > 0 {
            missing_ranges(&s.have_ranges, 1, target)
        } else {
            vec![]
        };
        let attempts = s.sync.attempts;

        if missing.is_empty() {
            let s = self.get_or_create(machine, session_id);
            s.sync.state = SyncState::Complete;
            s.sync.attempts = 0;
            s.sync.next_retry_at = None;
            s.sync.active_sync_id = None;
            return vec![];
        }
        if attempts < self.max_attempts {
            return self.start_cycle(machine, session_id, target);
        }
        let delay = sync_retry_delay_ms(attempts);
        let s = self.get_or_create(machine, session_id);
        s.sync.state = SyncState::Failed;
        s.sync.next_retry_at = Some(now + delay);
        s.sync.active_sync_id = None;
        vec![]
    }

    /// Reconcile toward `target_seq_high` (from the session list). Sends a
    /// `sync-request` iff there are gaps and no cycle is in flight (and any
    /// failure backoff has elapsed).
    pub fn ensure_synced(
        &mut self,
        machine: &str,
        session_id: &str,
        target_seq_high: u64,
        now: u64,
    ) -> Vec<SyncEffect> {
        if target_seq_high == 0 {
            return vec![];
        }
        let s = self.get_or_create(machine, session_id);
        let missing = missing_ranges(&s.have_ranges, 1, target_seq_high);
        if missing.is_empty() {
            if s.sync.state != SyncState::Complete {
                s.sync.state = SyncState::Complete;
                s.sync.attempts = 0;
                s.sync.next_retry_at = None;
                s.sync.active_sync_id = None;
            }
            return vec![];
        }
        match s.sync.state {
            SyncState::Requested | SyncState::Syncing => {
                // In flight — just raise the target; sync-end reconciles.
                s.sync.target = s.sync.target.max(target_seq_high);
                vec![]
            }
            SyncState::Failed
                if s.sync.next_retry_at.is_some_and(|at| now < at) =>
            {
                vec![] // backoff still running
            }
            _ => self.start_cycle(machine, session_id, target_seq_high),
        }
    }

    /// Every reconnect: failed AND stuck-in-flight cycles → `Idle`, attempts 0.
    /// A new connection is a new world.
    pub fn on_reconnect(&mut self, machine: Option<&str>) {
        for s in self.sessions.values_mut() {
            if machine.is_some_and(|m| s.machine != m) {
                continue;
            }
            if matches!(s.sync.state, SyncState::Idle | SyncState::Complete) {
                continue;
            }
            s.sync.state = SyncState::Idle;
            s.sync.attempts = 0;
            s.sync.next_retry_at = None;
            s.sync.active_sync_id = None;
        }
    }

    /// Fire retries whose backoff has elapsed.
    pub fn retry_sweep(&mut self, now: u64) -> Vec<SyncEffect> {
        let due: Vec<(String, String, u64)> = self
            .sessions
            .values()
            .filter(|s| s.sync.state == SyncState::Failed)
            .filter(|s| s.sync.next_retry_at.is_none_or(|at| now >= at))
            .filter(|s| s.sync.target > 0)
            .map(|s| (s.machine.clone(), s.session_id.clone(), s.sync.target))
            .collect();
        let mut effects = Vec::new();
        for (machine, session_id, target) in due {
            effects.extend(self.start_cycle(&machine, &session_id, target));
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st() -> TranscriptState {
        TranscriptState::new(SYNC_MAX_ATTEMPTS)
    }

    fn sync(t: &TranscriptState) -> &SessionSyncStatus {
        &t.session("m", "s").unwrap().sync
    }

    fn requests(effects: &[SyncEffect]) -> Vec<&Vec<SeqRange>> {
        effects
            .iter()
            .filter_map(|e| match e {
                SyncEffect::SendSyncRequest { have_ranges, .. } => Some(have_ranges),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn integrate_rows_builds_coverage_and_records_conflicts() {
        let mut t = st();
        t.integrate_rows("m", "s", &[1, 2, 5], &[]);
        t.integrate_rows("m", "s", &[], &[]); // dup of 2 — no-op
        assert_eq!(t.have_ranges_of("m", "s"), vec![(1, 2), (5, 5)]);
        assert_eq!(t.session("m", "s").unwrap().local_high, 5);
        assert!(t.seq_conflicts.is_empty());
        assert!(!t.has_contiguous("m", "s", None));

        t.integrate_rows("m", "s", &[], &[3]); // seq 3 re-arrived with different content
        assert_eq!(
            t.seq_conflicts,
            vec![SeqConflict { machine: "m".into(), session_id: "s".into(), seq: 3 }]
        );
    }

    #[test]
    fn coverage_never_regresses_over_random_insert_order() {
        let mut t = st();
        let mut sizes = Vec::new();
        for seq in [7, 1, 3, 2, 9, 8, 4, 6, 5, 10] {
            t.integrate_rows("m", "s", &[seq], &[]);
            sizes.push(protocol::ranges::range_size(&t.have_ranges_of("m", "s")));
        }
        assert_eq!(t.have_ranges_of("m", "s"), vec![(1, 10)]);
        let mut sorted = sizes.clone();
        sorted.sort_unstable();
        assert_eq!(sizes, sorted);
    }

    #[test]
    fn hydrate_from_seqs_restores_coverage() {
        let mut t = st();
        t.hydrate_from_seqs("m", "s", &[1, 2, 4]);
        assert_eq!(t.have_ranges_of("m", "s"), vec![(1, 2), (4, 4)]);
        assert_eq!(t.session("m", "s").unwrap().local_high, 4);
    }

    #[test]
    fn ensure_synced_sends_a_request_with_the_real_have_ranges() {
        let mut t = st();
        t.integrate_rows("m", "s", &[1, 2], &[]);
        let eff = t.ensure_synced("m", "s", 10, 0);
        assert_eq!(requests(&eff), vec![&vec![(1u64, 2u64)]]);
        assert_eq!(sync(&t).state, SyncState::Requested);
        assert_eq!(sync(&t).attempts, 1);
    }

    #[test]
    fn ensure_synced_is_idempotent_while_in_flight_but_raises_the_target() {
        let mut t = st();
        let e1 = t.ensure_synced("m", "s", 10, 0);
        let e2 = t.ensure_synced("m", "s", 12, 0);
        let e3 = t.ensure_synced("m", "s", 12, 0);
        assert_eq!(requests(&e1).len(), 1);
        assert!(requests(&e2).is_empty());
        assert!(requests(&e3).is_empty());
        assert_eq!(sync(&t).target, 12);
    }

    #[test]
    fn already_covered_completes_without_a_request() {
        let mut t = st();
        t.integrate_rows("m", "s", &[1, 2], &[]);
        let eff = t.ensure_synced("m", "s", 2, 0);
        assert!(requests(&eff).is_empty());
        assert_eq!(sync(&t).state, SyncState::Complete);
    }

    #[test]
    fn sync_chunk_ack_then_sync_end_completes_when_covered() {
        let mut t = st();
        t.ensure_synced("m", "s", 3, 0);
        t.apply_sync_begin("m", "s", "sy1", 3);
        assert_eq!(sync(&t).state, SyncState::Syncing);
        t.integrate_rows("m", "s", &[1, 2, 3], &[]);
        let ack = t.ack_sync_chunk("sy1", (1, 3));
        assert_eq!(ack, SyncEffect::SendSyncAck { sync_id: "sy1".into(), range: (1, 3) });
        let eff = t.apply_sync_end("m", "s", 0);
        assert!(requests(&eff).is_empty());
        assert_eq!(sync(&t).state, SyncState::Complete);
        assert_eq!(sync(&t).attempts, 0);
        assert!(t.has_contiguous("m", "s", Some(3)));
    }

    #[test]
    fn an_incomplete_sync_end_re_requests_while_attempts_remain() {
        let mut t = st();
        t.ensure_synced("m", "s", 4, 0);
        t.apply_sync_begin("m", "s", "sy1", 4);
        t.integrate_rows("m", "s", &[3, 4], &[]); // [1,2] lost
        let eff = t.apply_sync_end("m", "s", 0);
        assert_eq!(requests(&eff), vec![&vec![(3u64, 4u64)]]);
        assert_eq!(sync(&t).state, SyncState::Requested);
        assert_eq!(sync(&t).attempts, 2);
    }

    #[test]
    fn attempts_exhausted_fails_with_a_retry_timestamp_then_retry_sweep_fires() {
        let mut t = st();
        let mut requests_sent = 0;
        for i in 0..SYNC_MAX_ATTEMPTS {
            if i == 0 {
                requests_sent += requests(&t.ensure_synced("m", "s", 5, 0)).len();
            }
            requests_sent += requests(&t.apply_sync_end("m", "s", 100)).len();
        }
        assert_eq!(requests_sent, SYNC_MAX_ATTEMPTS as usize);
        assert_eq!(sync(&t).state, SyncState::Failed);
        let retry_at = sync(&t).next_retry_at.unwrap();
        assert!(retry_at > 100);

        // backoff not elapsed
        assert!(requests(&t.ensure_synced("m", "s", 5, retry_at - 1)).is_empty());
        assert!(requests(&t.retry_sweep(retry_at - 1)).is_empty());
        // elapsed
        assert_eq!(requests(&t.retry_sweep(retry_at)).len(), 1);
    }

    #[test]
    fn on_reconnect_resets_failed_and_stuck_in_flight_cycles() {
        let mut t = TranscriptState::new(1);
        t.ensure_synced("m", "a", 3, 0);
        t.apply_sync_end("m", "a", 0); // 1 attempt, exhausted -> failed
        t.ensure_synced("m", "b", 3, 0); // stuck Requested
        assert_eq!(t.session("m", "a").unwrap().sync.state, SyncState::Failed);
        assert_eq!(t.session("m", "b").unwrap().sync.state, SyncState::Requested);

        t.on_reconnect(None);
        for s in ["a", "b"] {
            let sy = &t.session("m", s).unwrap().sync;
            assert_eq!(sy.state, SyncState::Idle);
            assert_eq!(sy.attempts, 0);
            assert_eq!(sy.next_retry_at, None);
        }
        // and the next ensure_synced fires immediately
        assert_eq!(requests(&t.ensure_synced("m", "a", 3, 0)).len(), 1);
    }

    #[test]
    fn on_reconnect_can_scope_to_one_machine() {
        let mut t = TranscriptState::new(1);
        t.ensure_synced("m1", "a", 3, 0);
        t.ensure_synced("m2", "b", 3, 0);
        t.on_reconnect(Some("m1"));
        assert_eq!(t.session("m1", "a").unwrap().sync.state, SyncState::Idle);
        assert_eq!(t.session("m2", "b").unwrap().sync.state, SyncState::Requested);
    }

    #[test]
    fn sync_retry_delay_backs_off_to_the_cap() {
        assert_eq!(sync_retry_delay_ms(1), SYNC_RETRY_BASE_MS);
        assert_eq!(sync_retry_delay_ms(2), SYNC_RETRY_BASE_MS * 2);
        assert_eq!(sync_retry_delay_ms(3), SYNC_RETRY_BASE_MS * 4);
        assert_eq!(sync_retry_delay_ms(30), SYNC_RETRY_MAX_MS);
    }

    #[test]
    fn live_output_during_a_sync_raises_coverage_without_conflicts() {
        let mut t = st();
        t.ensure_synced("m", "s", 3, 0);
        t.integrate_rows("m", "s", &[4], &[]); // concurrent live tail
        t.apply_sync_begin("m", "s", "sy", 3);
        t.integrate_rows("m", "s", &[1, 2, 3], &[]);
        let eff = t.apply_sync_end("m", "s", 0);
        assert!(requests(&eff).is_empty());
        assert!(t.has_contiguous("m", "s", Some(4)));
        assert!(t.seq_conflicts.is_empty());
        assert_eq!(sync(&t).state, SyncState::Complete);
    }

    #[test]
    fn remove_session_drops_it() {
        let mut t = st();
        t.integrate_rows("m", "s", &[1], &[]);
        t.remove_session("m", "s");
        assert!(t.session("m", "s").is_none());
    }
}
