//! Platform seams the runtime needs (migration plan §2.4). `client-core` stays
//! effect-based and never calls these — the runtime does the I/O on its behalf
//! after interpreting a store's returned effects/outcomes.
//!
//! Only three ports are genuinely needed: key/value persistence, transcript-row
//! storage, and OS-notification delivery. Timers are `tokio::time` directly;
//! the wall clock and jitter source are [`crate::core::Clock`] /
//! [`crate::core::Entropy`].
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

// --- Notifier ---------------------------------------------------------------

/// OS-notification delivery. The core decides WHEN to notify
/// ([`client_core::notifications`]); this port only delivers. `tag` (CDX-026c)
/// groups deliveries so they can be cancelled when the user handles the
/// underlying thing in-app; platforms that cannot cancel ignore it.
pub trait Notifier {
    fn notify(&self, title: &str, body: &str, tag: Option<&str>);
    fn cancel(&self, _tag: &str) {}
}

/// A `Notifier` that drops everything — headless tests, or a platform without
/// notifications.
pub struct NullNotifier;
impl Notifier for NullNotifier {
    fn notify(&self, _title: &str, _body: &str, _tag: Option<&str>) {}
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
    fn notify(&self, title: &str, body: &str, tag: Option<&str>) {
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
        n.notify("Permission needed", "Bash", Some("session m s1"));
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
