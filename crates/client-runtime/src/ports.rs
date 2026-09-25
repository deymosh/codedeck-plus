//! Platform seams the runtime needs (migration plan §2.4). `client-core` stays
//! effect-based and never calls these — the runtime does the I/O on its behalf
//! after interpreting a store's returned effects/outcomes.
//!
//! Only three ports are genuinely needed: key/value persistence, transcript-row
//! storage, and OS-notification delivery. Timers are `tokio::time` directly;
//! the wall clock and jitter source are [`crate::Clock`] /
//! [`crate::Entropy`].
//!
//! Async trait methods return a boxed `!Send` future — the `Core` runs on a
//! current-thread `LocalSet`, so nothing here needs to cross threads.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

/// A `!Send` boxed future — the runtime is single-threaded.
pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

// --- Kv --------------------------------------------------------------------

/// Key/value persistence (NOT raw `localStorage`). SQLCipher /
/// `EncryptedSharedPreferences` on device; [`MemoryKv`] in tests. The runtime
/// hydrates every store from here on boot and re-serializes a store after any
/// mutation it made.
pub trait Kv {
    fn get(&self, key: &str) -> LocalBoxFuture<'_, Option<String>>;
    fn set(&self, key: &str, value: &str) -> LocalBoxFuture<'_, ()>;
    fn delete(&self, key: &str) -> LocalBoxFuture<'_, ()>;
}

/// In-memory [`Kv`] — tests, and a safe default before a real store is wired.
/// Cloning shares the backing map (an `Rc`), so a "rebooted" `Core` over the
/// same `MemoryKv` sees what the previous one persisted.
#[derive(Default, Clone)]
pub struct MemoryKv {
    map: Rc<RefCell<BTreeMap<String, String>>>,
}

impl MemoryKv {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed with initial entries (garbage values are fine — hydrators tolerate
    /// them).
    pub fn seeded<I, K, V>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let map = entries
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        Self {
            map: Rc::new(RefCell::new(map)),
        }
    }

    /// A snapshot of every stored pair (test assertions).
    pub fn dump(&self) -> BTreeMap<String, String> {
        self.map.borrow().clone()
    }
}

impl Kv for MemoryKv {
    fn get(&self, key: &str) -> LocalBoxFuture<'_, Option<String>> {
        let value = self.map.borrow().get(key).cloned();
        Box::pin(async move { value })
    }

    fn set(&self, key: &str, value: &str) -> LocalBoxFuture<'_, ()> {
        self.map.borrow_mut().insert(key.to_string(), value.to_string());
        Box::pin(async {})
    }

    fn delete(&self, key: &str) -> LocalBoxFuture<'_, ()> {
        self.map.borrow_mut().remove(key);
        Box::pin(async {})
    }
}

// --- TranscriptStore ----------------------------------------------------

/// One transcript row: a `seq` and its opaque `OutputEntry` JSON (kept opaque
/// so the port carries no protocol dependency).
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptRow {
    pub seq: u64,
    pub entry: serde_json::Value,
}

/// Per-`(machine, session)` transcript persistence with INSERT-OR-IGNORE
/// semantics on `(machine, session, seq)` — a SQLite PK on device, a map in
/// [`MemoryTranscriptStore`].
pub trait TranscriptStore {
    /// Insert rows, ignoring seqs already present. Returns the seqs actually
    /// inserted.
    fn insert_ignore(
        &self,
        machine: &str,
        session: &str,
        rows: &[TranscriptRow],
    ) -> LocalBoxFuture<'_, Vec<u64>>;
    /// All stored seqs for a session, ascending.
    fn seqs(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, Vec<u64>>;
    /// Rows with `from <= seq <= to`, ascending.
    fn read_range(
        &self,
        machine: &str,
        session: &str,
        from: u64,
        to: u64,
    ) -> LocalBoxFuture<'_, Vec<TranscriptRow>>;
    /// Drop a session's rows (explicit user / tombstone removal only).
    fn remove(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, ()>;
}

/// In-memory [`TranscriptStore`]. Cloning shares the backing map.
#[derive(Default, Clone)]
pub struct MemoryTranscriptStore {
    #[allow(clippy::type_complexity)]
    data: Rc<RefCell<BTreeMap<(String, String), BTreeMap<u64, serde_json::Value>>>>,
}

impl MemoryTranscriptStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TranscriptStore for MemoryTranscriptStore {
    fn insert_ignore(
        &self,
        machine: &str,
        session: &str,
        rows: &[TranscriptRow],
    ) -> LocalBoxFuture<'_, Vec<u64>> {
        let key = (machine.to_string(), session.to_string());
        let mut data = self.data.borrow_mut();
        let table = data.entry(key).or_default();
        let mut inserted = Vec::new();
        for row in rows {
            if table.contains_key(&row.seq) {
                continue;
            }
            table.insert(row.seq, row.entry.clone());
            inserted.push(row.seq);
        }
        Box::pin(async move { inserted })
    }

    fn seqs(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, Vec<u64>> {
        let key = (machine.to_string(), session.to_string());
        let seqs = self
            .data
            .borrow()
            .get(&key)
            .map(|t| t.keys().copied().collect())
            .unwrap_or_default();
        Box::pin(async move { seqs })
    }

    fn read_range(
        &self,
        machine: &str,
        session: &str,
        from: u64,
        to: u64,
    ) -> LocalBoxFuture<'_, Vec<TranscriptRow>> {
        let key = (machine.to_string(), session.to_string());
        let rows = self
            .data
            .borrow()
            .get(&key)
            .map(|t| {
                t.range(from..=to)
                    .map(|(seq, entry)| TranscriptRow {
                        seq: *seq,
                        entry: entry.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Box::pin(async move { rows })
    }

    fn remove(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, ()> {
        self.data
            .borrow_mut()
            .remove(&(machine.to_string(), session.to_string()));
        Box::pin(async {})
    }
}

/// A [`TranscriptStore`] that keeps the rows of the most recently read session
/// in memory. The transcript view re-reads a session's rows `1..=high` after
/// every append; with this in front, that costs a store read of only the rows
/// past the cached `high`, instead of the whole session each time (SQLite on
/// device, on the core's single event-loop thread).
///
/// The cache is exact, not a guess: it holds every stored row of its session
/// with `seq <= high`, because every write goes through this wrapper and is
/// mirrored (an insert below `high` — a gap refill — is added, a removal
/// drops the cache). Whenever an async completion finds that the cache moved
/// on underneath it, it drops the cache rather than reason about the
/// interleaving; the next read rebuilds it. It must therefore be the only
/// writer of the inner store.
pub struct CachedTranscriptStore {
    inner: Rc<dyn TranscriptStore>,
    cache: RefCell<Option<CachedSession>>,
    /// Bumped on every cache change, so a completion can tell whether the
    /// cache it started from is still the current one.
    generation: std::cell::Cell<u64>,
}

struct CachedSession {
    machine: String,
    session: String,
    high: u64,
    rows: BTreeMap<u64, serde_json::Value>,
}

impl CachedSession {
    fn is(&self, machine: &str, session: &str) -> bool {
        self.machine == machine && self.session == session
    }

    fn rows(&self, from: u64, to: u64) -> Vec<TranscriptRow> {
        self.rows
            .range(from..=to)
            .map(|(seq, entry)| TranscriptRow { seq: *seq, entry: entry.clone() })
            .collect()
    }
}

impl CachedTranscriptStore {
    pub fn new(inner: Rc<dyn TranscriptStore>) -> Self {
        Self { inner, cache: RefCell::new(None), generation: std::cell::Cell::new(0) }
    }

    fn set_cache(&self, cache: Option<CachedSession>) {
        *self.cache.borrow_mut() = cache;
        self.bump();
    }

    fn bump(&self) {
        self.generation.set(self.generation.get() + 1);
    }

    fn caches(&self, machine: &str, session: &str) -> bool {
        self.cache.borrow().as_ref().is_some_and(|c| c.is(machine, session))
    }
}

impl TranscriptStore for CachedTranscriptStore {
    fn insert_ignore(
        &self,
        machine: &str,
        session: &str,
        rows: &[TranscriptRow],
    ) -> LocalBoxFuture<'_, Vec<u64>> {
        let started = self.generation.get();
        let key = (machine.to_string(), session.to_string());
        // Only rows of the cached session can matter to the cache.
        let mirror: Option<Vec<TranscriptRow>> = self.caches(machine, session).then(|| rows.to_vec());
        let insert = self.inner.insert_ignore(machine, session, rows);
        Box::pin(async move {
            let inserted = insert.await;
            if !self.caches(&key.0, &key.1) {
                return inserted;
            }
            let Some(mirror) = mirror.filter(|_| self.generation.get() == started) else {
                // The cache covering this session was (re)built while this
                // insert was in flight: it may or may not hold the rows.
                self.set_cache(None);
                return inserted;
            };
            if let Some(cache) = self.cache.borrow_mut().as_mut() {
                for row in mirror {
                    if row.seq <= cache.high && inserted.contains(&row.seq) {
                        cache.rows.insert(row.seq, row.entry);
                    }
                }
            }
            self.bump();
            inserted
        })
    }

    fn seqs(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, Vec<u64>> {
        self.inner.seqs(machine, session)
    }

    fn read_range(
        &self,
        machine: &str,
        session: &str,
        from: u64,
        to: u64,
    ) -> LocalBoxFuture<'_, Vec<TranscriptRow>> {
        let (cached, high) = match self.cache.borrow().as_ref() {
            Some(c) if c.is(machine, session) => {
                if to <= c.high {
                    let rows = c.rows(from, to);
                    return Box::pin(async move { rows });
                }
                (Some(c.rows(from, c.high)), c.high)
            }
            _ => (None, 0),
        };
        // Only a read from the start can (re)build the cache: the cache must
        // hold every row up to its `high`.
        if cached.is_none() && from != 1 {
            return self.inner.read_range(machine, session, from, to);
        }
        let started = self.generation.get();
        let key = (machine.to_string(), session.to_string());
        let fetch_from = if cached.is_some() { high + 1 } else { 1 };
        let fetch = self.inner.read_range(machine, session, fetch_from.max(from), to);
        Box::pin(async move {
            let fetched = fetch.await;
            // `from > high + 1` skips rows the cache would need, so such a
            // read never extends it.
            let may_cache = self.generation.get() == started && from <= fetch_from;
            let mut rows = cached.unwrap_or_default();
            if may_cache {
                let mut slot = self.cache.borrow_mut();
                if !slot.as_ref().is_some_and(|c| c.is(&key.0, &key.1)) {
                    *slot = Some(CachedSession {
                        machine: key.0,
                        session: key.1,
                        high: 0,
                        rows: BTreeMap::new(),
                    });
                }
                let cache = slot.as_mut().expect("set just above");
                for row in &fetched {
                    cache.rows.insert(row.seq, row.entry.clone());
                }
                cache.high = to;
                drop(slot);
                self.bump();
            }
            rows.extend(fetched);
            rows
        })
    }

    fn remove(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, ()> {
        if self.caches(machine, session) {
            self.set_cache(None);
        }
        self.inner.remove(machine, session)
    }
}

// --- Notifier ---------------------------------------------------------------

/// OS-notification delivery. The core decides WHEN to notify
/// ([`client_core::notifications`]); this port only delivers. `tag` (CDX-026c)
/// groups deliveries so they can be cancelled when the user handles the
/// underlying thing in-app; platforms that cannot cancel ignore it.
pub trait Notifier {
    /// `kind` is `NotifyEvent::kind_str` — platforms route delivery on it
    /// (Android: which notification channel); headless seams ignore it.
    fn notify(&self, title: &str, body: &str, tag: Option<&str>, kind: &str);
    fn cancel(&self, _tag: &str) {}
}

/// A `Notifier` that drops everything — headless tests, or a platform without
/// notifications.
pub struct NullNotifier;
impl Notifier for NullNotifier {
    fn notify(&self, _title: &str, _body: &str, _tag: Option<&str>, _kind: &str) {}
}

/// A `Notifier` that records deliveries and cancels for assertions.
#[derive(Default, Clone)]
pub struct RecordingNotifier {
    inner: Rc<RefCell<RecordingNotifierInner>>,
}

#[derive(Default)]
struct RecordingNotifierInner {
    delivered: Vec<(String, String, Option<String>)>,
    cancelled: Vec<String>,
}

impl RecordingNotifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn delivered(&self) -> Vec<(String, String, Option<String>)> {
        self.inner.borrow().delivered.clone()
    }

    pub fn cancelled(&self) -> Vec<String> {
        self.inner.borrow().cancelled.clone()
    }
}

impl Notifier for RecordingNotifier {
    fn notify(&self, title: &str, body: &str, tag: Option<&str>, _kind: &str) {
        self.inner.borrow_mut().delivered.push((
            title.to_string(),
            body.to_string(),
            tag.map(str::to_string),
        ));
    }

    fn cancel(&self, tag: &str) {
        self.inner.borrow_mut().cancelled.push(tag.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn memory_kv_round_trips_and_sharing_survives_a_clone() {
        let kv = MemoryKv::seeded([("a", "1")]);
        assert_eq!(kv.get("a").await, Some("1".to_string()));
        assert_eq!(kv.get("missing").await, None);

        kv.set("b", "2").await;
        let reboot = kv.clone(); // a "second Core" over the same store
        assert_eq!(reboot.get("b").await, Some("2".to_string()));

        reboot.delete("a").await;
        assert_eq!(kv.get("a").await, None);
        assert_eq!(kv.dump(), BTreeMap::from([("b".to_string(), "2".to_string())]));
    }

    /// A [`MemoryTranscriptStore`] that logs every `read_range` it serves.
    #[derive(Default, Clone)]
    struct CountingStore {
        inner: MemoryTranscriptStore,
        reads: Rc<RefCell<Vec<(String, u64, u64)>>>,
    }

    impl TranscriptStore for CountingStore {
        fn insert_ignore(&self, m: &str, s: &str, rows: &[TranscriptRow]) -> LocalBoxFuture<'_, Vec<u64>> {
            self.inner.insert_ignore(m, s, rows)
        }
        fn seqs(&self, m: &str, s: &str) -> LocalBoxFuture<'_, Vec<u64>> {
            self.inner.seqs(m, s)
        }
        fn read_range(&self, m: &str, s: &str, from: u64, to: u64) -> LocalBoxFuture<'_, Vec<TranscriptRow>> {
            self.reads.borrow_mut().push((s.to_string(), from, to));
            self.inner.read_range(m, s, from, to)
        }
        fn remove(&self, m: &str, s: &str) -> LocalBoxFuture<'_, ()> {
            self.inner.remove(m, s)
        }
    }

    fn rows(seqs: &[u64]) -> Vec<TranscriptRow> {
        seqs.iter().map(|s| TranscriptRow { seq: *s, entry: json!({ "seq": s }) }).collect()
    }

    fn seqs_of(rows: &[TranscriptRow]) -> Vec<u64> {
        rows.iter().map(|r| r.seq).collect()
    }

    #[tokio::test]
    async fn the_cached_store_reads_only_new_rows_after_an_append() {
        let inner = CountingStore::default();
        let store = CachedTranscriptStore::new(Rc::new(inner.clone()));
        store.insert_ignore("m", "s", &rows(&[1, 2, 3])).await;
        assert_eq!(seqs_of(&store.read_range("m", "s", 1, 3).await), vec![1, 2, 3]);

        store.insert_ignore("m", "s", &rows(&[4])).await;
        assert_eq!(seqs_of(&store.read_range("m", "s", 1, 4).await), vec![1, 2, 3, 4]);
        // Unchanged: served from memory entirely.
        assert_eq!(seqs_of(&store.read_range("m", "s", 1, 4).await), vec![1, 2, 3, 4]);
        assert_eq!(seqs_of(&store.read_range("m", "s", 2, 3).await), vec![2, 3]);

        assert_eq!(*inner.reads.borrow(), vec![("s".into(), 1, 3), ("s".into(), 4, 4)]);
    }

    #[tokio::test]
    async fn the_cached_store_mirrors_gap_refills_and_removals() {
        let inner = CountingStore::default();
        let store = CachedTranscriptStore::new(Rc::new(inner.clone()));
        store.insert_ignore("m", "s", &rows(&[1, 3])).await;
        assert_eq!(seqs_of(&store.read_range("m", "s", 1, 3).await), vec![1, 3]);

        // A sync chunk fills the gap below the cached high.
        assert_eq!(store.insert_ignore("m", "s", &rows(&[2, 3])).await, vec![2]);
        assert_eq!(seqs_of(&store.read_range("m", "s", 1, 3).await), vec![1, 2, 3]);
        assert_eq!(inner.reads.borrow().len(), 1, "the refill was mirrored, not re-read");

        store.remove("m", "s").await;
        assert!(store.read_range("m", "s", 1, 3).await.is_empty());
    }

    #[tokio::test]
    async fn the_cached_store_answers_exactly_like_the_store_it_wraps() {
        let plain = MemoryTranscriptStore::new();
        let cached = CachedTranscriptStore::new(Rc::new(MemoryTranscriptStore::new()));
        // Two sessions interleaved, out-of-order arrivals, partial reads.
        let script: &[(&str, &[u64], u64, u64)] = &[
            ("a", &[1, 2], 1, 2),
            ("a", &[5], 1, 5),
            ("b", &[1], 1, 1),
            ("a", &[3, 4], 1, 5),
            ("a", &[6], 3, 6),
            ("b", &[2, 3], 2, 3),
            ("a", &[7], 1, 7),
            ("a", &[], 1, 9),
        ];
        for (session, seqs, from, to) in script {
            let r = rows(seqs);
            assert_eq!(plain.insert_ignore("m", session, &r).await, cached.insert_ignore("m", session, &r).await);
            assert_eq!(
                plain.read_range("m", session, *from, *to).await,
                cached.read_range("m", session, *from, *to).await,
                "{session} {from}..={to}"
            );
        }
    }

    #[tokio::test]
    async fn transcript_store_insert_ignore_dedups_by_seq() {
        let store = MemoryTranscriptStore::new();
        let rows = |seqs: &[u64]| {
            seqs.iter()
                .map(|s| TranscriptRow { seq: *s, entry: json!({ "seq": s }) })
                .collect::<Vec<_>>()
        };

        assert_eq!(store.insert_ignore("m", "s", &rows(&[1, 2, 3])).await, vec![1, 2, 3]);
        // 2 and 3 already present — only 4 is new
        assert_eq!(store.insert_ignore("m", "s", &rows(&[2, 3, 4])).await, vec![4]);
        assert_eq!(store.seqs("m", "s").await, vec![1, 2, 3, 4]);

        let range = store.read_range("m", "s", 2, 3).await;
        assert_eq!(range.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![2, 3]);

        store.remove("m", "s").await;
        assert!(store.seqs("m", "s").await.is_empty());
    }

    #[test]
    fn recording_notifier_captures_deliveries_and_cancels() {
        let n = RecordingNotifier::new();
        n.notify("Permission needed", "Bash", Some("session m s1"), "permission-request");
        n.cancel("session m s1");
        assert_eq!(
            n.delivered(),
            vec![(
                "Permission needed".to_string(),
                "Bash".to_string(),
                Some("session m s1".to_string())
            )]
        );
        assert_eq!(n.cancelled(), vec!["session m s1".to_string()]);
    }
}
