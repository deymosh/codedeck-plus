//! Real persistence for the Android `Core` — before this, `Core::new` used
//! `CorePorts::default()`'s in-memory `Kv`/`TranscriptStore`, losing every
//! store (machines, pairing, outbox, settings, identity) on every process
//! restart. Same schema and `rusqlite` shape as `apps/mobile/src-tauri/src/
//! native_ports.rs`'s `KvSqlite`/`TranscriptStoreSqlite` (itself schema-
//! compatible with `apps/mobile/src/platform/sqlite.ts`) — kept a direct port
//! rather than a shared crate because the two hosts' `Connection` lifetimes
//! differ enough (Tauri's `AppHandle`-scoped path vs. Android's own data dir)
//! that a shared abstraction would just be an extra layer over one `execute`
//! call each.
//!
//! One `rusqlite::Connection`, `Rc`-shared between the two port impls: never
//! sent across threads, opened fresh on the dedicated core thread `Core::new`
//! spins up, matching every other `client_runtime` port on that thread.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use client_runtime::client_core::stores::settings::hydrate_settings;
use client_runtime::ports::{LocalBoxFuture, TranscriptRow};
use client_runtime::stores::SETTINGS_KEY;
use client_runtime::{Kv, TranscriptStore};
use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS transcript (
        machine_pubkey TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (machine_pubkey, session_id, seq)
    )",
    "CREATE INDEX IF NOT EXISTS idx_transcript_session_created
        ON transcript (machine_pubkey, session_id, created_at)",
];

/// Open (creating the file and directory if needed) and migrate the app
/// database. Idempotent — safe to call every `Core::new`.
pub fn open_native_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create db dir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("set busy_timeout: {e}"))?;
    // WAL + synchronous=NORMAL, the pairing Android's own SQLiteDatabase
    // uses: a commit appends to the log instead of rewriting and fsyncing
    // the main file, and readers never block the writer. Only a power loss
    // (never an app crash) can drop the newest commits, and everything this
    // file holds is either re-synced from the bridge (transcript rows) or
    // re-written on the next change (kv). Best-effort: a filesystem without
    // shared-memory support keeps the default journal and still works.
    let _ = conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0));
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    for stmt in MIGRATIONS {
        conn.execute(stmt, []).map_err(|e| format!("migration failed: {e}"))?;
    }
    Ok(conn)
}

fn settings_from_kv(conn: &Connection) -> client_runtime::client_core::stores::settings::SettingsData {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE key = ?", [SETTINGS_KEY], |row| row.get(0))
        .ok();
    hydrate_settings(raw.as_deref())
}

/// The relay list `Core::new` will hydrate from this SAME db file once it
/// opens it — read standalone, before any `Core` exists, so the Android host
/// can pass a real persisted (or default, on a fresh install) relay list into
/// `Core::new`'s `relays` constructor argument. Mirrors `apps/mobile`'s own
/// `createPhoneCoreNative.ts`, which reads `loadPersistedSettings` from its
/// KV before calling `core.init` for the exact same reason: `Core::spawn`
/// dials `WsConfig.relays` from the constructor argument, not from whatever
/// `hydrate()` separately reads once the core is already running, so nothing
/// short of the caller pre-reading this row would put a persisted relay list
/// on the wire at boot.
pub fn relays_from_kv(conn: &Connection) -> Vec<String> {
    settings_from_kv(conn).relays
}

/// Same rationale as [`relays_from_kv`], for the OTHER boot-time value
/// `Core::new`'s `tor` argument needs: whether the user had Orbot routing on
/// last time settings were saved. `Core::spawn`'s own `config.tor` check
/// (which primes the HTTP port's proxy before the first request) only helps
/// if the caller actually passes `true` here when that's what was persisted.
pub fn tor_proxy_enabled_from_kv(conn: &Connection) -> bool {
    settings_from_kv(conn).tor_proxy_enabled
}

/// The `OutputEntry` discriminator, extracted defensively (the port keeps the
/// entry opaque; `kind` is denormalized for ad-hoc queries/debugging only).
fn kind_of(entry: &serde_json::Value) -> String {
    entry
        .get("entryType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub struct KvSqlite {
    conn: Rc<RefCell<Connection>>,
}

impl KvSqlite {
    pub fn new(conn: Rc<RefCell<Connection>>) -> Self {
        Self { conn }
    }
}

impl Kv for KvSqlite {
    fn get(&self, key: &str) -> LocalBoxFuture<'_, Option<String>> {
        let result = self
            .conn
            .borrow()
            .query_row("SELECT value FROM kv WHERE key = ?", [key], |row| row.get(0))
            .ok();
        Box::pin(async move { result })
    }

    // The port has no error channel, but a failed write (full disk, locked
    // file) must not vanish without a trace: settings, pairing and identity
    // all persist through here. The key is logged, never the value.
    fn set(&self, key: &str, value: &str) -> LocalBoxFuture<'_, ()> {
        if let Err(e) = self.conn.borrow().execute(
            "INSERT INTO kv (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        ) {
            log::error!("kv set {key} failed: {e}");
        }
        Box::pin(async {})
    }

    fn delete(&self, key: &str) -> LocalBoxFuture<'_, ()> {
        if let Err(e) = self.conn.borrow().execute("DELETE FROM kv WHERE key = ?", [key]) {
            log::error!("kv delete {key} failed: {e}");
        }
        Box::pin(async {})
    }
}

pub struct TranscriptStoreSqlite {
    conn: Rc<RefCell<Connection>>,
}

impl TranscriptStoreSqlite {
    pub fn new(conn: Rc<RefCell<Connection>>) -> Self {
        Self { conn }
    }
}

impl TranscriptStore for TranscriptStoreSqlite {
    fn insert_ignore(
        &self,
        machine: &str,
        session: &str,
        rows: &[TranscriptRow],
    ) -> LocalBoxFuture<'_, Vec<u64>> {
        let inserted = insert_rows(&self.conn.borrow(), machine, session, rows);
        Box::pin(async move { inserted })
    }

    fn seqs(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, Vec<u64>> {
        let seqs = self.query_seqs(machine, session);
        Box::pin(async move { seqs })
    }

    fn read_range(
        &self,
        machine: &str,
        session: &str,
        from: u64,
        to: u64,
    ) -> LocalBoxFuture<'_, Vec<TranscriptRow>> {
        let rows = self.query_range(machine, session, from, to);
        Box::pin(async move { rows })
    }

    fn remove(&self, machine: &str, session: &str) -> LocalBoxFuture<'_, ()> {
        let _ = self.conn.borrow().execute(
            "DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ?",
            [machine, session],
        );
        Box::pin(async {})
    }
}

/// Inserts one sync batch in a single transaction and returns the seqs that
/// were new. Per-row autocommit would make every row its own commit (and
/// its own disk sync) on the core's event-loop thread — a gap refill of a
/// few hundred rows stalled the loop for as many syncs. A batch that fails
/// to commit is rolled back and reported as inserting nothing, so the
/// caller never counts rows that did not land.
fn insert_rows(conn: &Connection, machine: &str, session: &str, rows: &[TranscriptRow]) -> Vec<u64> {
    let Ok(tx) = conn.unchecked_transaction() else {
        return Vec::new();
    };
    let mut inserted = Vec::new();
    {
        let Ok(mut stmt) = tx.prepare_cached(
            "INSERT OR IGNORE INTO transcript
                (machine_pubkey, session_id, seq, kind, json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        ) else {
            return Vec::new();
        };
        let created_at = now_ms();
        for row in rows {
            let changed = stmt
                .execute(rusqlite::params![
                    machine,
                    session,
                    row.seq,
                    kind_of(&row.entry),
                    row.entry.to_string(),
                    created_at,
                ])
                .unwrap_or(0);
            if changed > 0 {
                inserted.push(row.seq);
            }
        }
    }
    if tx.commit().is_err() {
        return Vec::new();
    }
    inserted
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TranscriptStoreSqlite {
    fn query_seqs(&self, machine: &str, session: &str) -> Vec<u64> {
        let conn = self.conn.borrow();
        let mut stmt = match conn.prepare_cached(
            "SELECT seq FROM transcript WHERE machine_pubkey = ? AND session_id = ? ORDER BY seq ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([machine, session], |row| row.get::<_, i64>(0));
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).map(|s| s as u64).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// A row whose `json` fails to parse is unreadable, not fatal — it is
    /// dropped from the result AND deleted, same as the TS adapter: sync
    /// re-fetches the gap because `haveRanges` is computed from `seqs`.
    fn query_range(&self, machine: &str, session: &str, from: u64, to: u64) -> Vec<TranscriptRow> {
        let conn = self.conn.borrow();
        let mut out = Vec::new();
        let mut corrupt = Vec::new();
        {
            let mut stmt = match conn.prepare_cached(
                "SELECT seq, json FROM transcript
                 WHERE machine_pubkey = ? AND session_id = ? AND seq >= ? AND seq <= ?
                 ORDER BY seq ASC",
            ) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            let raw = stmt.query_map(rusqlite::params![machine, session, from, to], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            });
            if let Ok(raw) = raw {
                for (seq, json) in raw.filter_map(Result::ok) {
                    match serde_json::from_str(&json) {
                        Ok(entry) => out.push(TranscriptRow { seq: seq as u64, entry }),
                        Err(_) => corrupt.push(seq),
                    }
                }
            }
            // `stmt` (and the borrow of `conn` it holds) is dropped here, at
            // the end of this block — before the delete pass below borrows
            // `conn` again.
        }
        for seq in corrupt {
            let _ = conn.execute(
                "DELETE FROM transcript WHERE machine_pubkey = ? AND session_id = ? AND seq = ?",
                rusqlite::params![machine, session, seq],
            );
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_temp() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_native_db(&dir.path().join("codedeck.db")).unwrap();
        (dir, conn)
    }

    #[test]
    fn opens_in_wal_mode() {
        let (_dir, conn) = open_temp();
        let mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).unwrap();
        assert_eq!(mode.to_ascii_lowercase(), "wal");
    }

    #[tokio::test]
    async fn kv_round_trips_and_upserts() {
        let (_dir, conn) = open_temp();
        let kv = KvSqlite::new(Rc::new(RefCell::new(conn)));
        assert_eq!(kv.get("k").await, None);
        kv.set("k", "v1").await;
        assert_eq!(kv.get("k").await, Some("v1".to_string()));
        kv.set("k", "v2").await; // upsert, not a duplicate row
        assert_eq!(kv.get("k").await, Some("v2".to_string()));
        kv.delete("k").await;
        assert_eq!(kv.get("k").await, None);
    }

    #[tokio::test]
    async fn transcript_insert_ignore_is_structural_dedup() {
        let (_dir, conn) = open_temp();
        let conn = Rc::new(RefCell::new(conn));
        let store = TranscriptStoreSqlite::new(conn);

        let row = |seq: u64, text: &str| TranscriptRow {
            seq,
            entry: serde_json::json!({ "entryType": "system", "text": text }),
        };
        let inserted = store.insert_ignore("m1", "s1", &[row(1, "a"), row(2, "b")]).await;
        assert_eq!(inserted, vec![1, 2]);

        let reinserted = store
            .insert_ignore("m1", "s1", &[row(1, "different"), row(3, "c")])
            .await;
        assert_eq!(reinserted, vec![3]);

        assert_eq!(store.seqs("m1", "s1").await, vec![1, 2, 3]);
        let range = store.read_range("m1", "s1", 1, 2).await;
        assert_eq!(range.len(), 2);
        assert_eq!(range[0].entry["text"], "a"); // NOT "different"
    }

    #[tokio::test]
    async fn transcript_remove_drops_only_that_session() {
        let (_dir, conn) = open_temp();
        let conn = Rc::new(RefCell::new(conn));
        let store = TranscriptStoreSqlite::new(conn);
        let row = TranscriptRow { seq: 1, entry: serde_json::json!({}) };
        store.insert_ignore("m1", "s1", std::slice::from_ref(&row)).await;
        store.insert_ignore("m1", "s2", &[row]).await;

        store.remove("m1", "s1").await;
        assert_eq!(store.seqs("m1", "s1").await, Vec::<u64>::new());
        assert_eq!(store.seqs("m1", "s2").await, vec![1]);
    }

    #[tokio::test]
    async fn a_corrupt_row_is_dropped_from_the_read_and_deleted() {
        let (_dir, conn) = open_temp();
        conn.execute(
            "INSERT INTO transcript (machine_pubkey, session_id, seq, kind, json, created_at)
             VALUES ('m1', 's1', 1, '', 'not json', 0)",
            [],
        )
        .unwrap();
        let conn = Rc::new(RefCell::new(conn));
        let store = TranscriptStoreSqlite::new(conn.clone());

        assert_eq!(store.read_range("m1", "s1", 1, 1).await, Vec::new());
        let remaining: i64 = conn
            .borrow()
            .query_row("SELECT COUNT(*) FROM transcript", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn relays_from_kv_falls_back_to_defaults_on_a_fresh_db() {
        let (_dir, conn) = open_temp();
        let defaults = hydrate_settings(None).relays;
        assert!(!defaults.is_empty());
        assert_eq!(relays_from_kv(&conn), defaults);
    }

    #[test]
    fn relays_from_kv_reads_a_persisted_settings_row() {
        let (_dir, conn) = open_temp();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?)",
            rusqlite::params![
                SETTINGS_KEY,
                serde_json::json!({ "relays": ["wss://custom.example"] }).to_string(),
            ],
        )
        .unwrap();
        assert_eq!(relays_from_kv(&conn), vec!["wss://custom.example".to_string()]);
    }

    #[test]
    fn tor_proxy_enabled_from_kv_defaults_to_off() {
        let (_dir, conn) = open_temp();
        assert!(!tor_proxy_enabled_from_kv(&conn));
    }

    #[test]
    fn tor_proxy_enabled_from_kv_reads_a_persisted_settings_row() {
        let (_dir, conn) = open_temp();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?)",
            rusqlite::params![
                SETTINGS_KEY,
                serde_json::json!({ "torProxyEnabled": true }).to_string(),
            ],
        )
        .unwrap();
        assert!(tor_proxy_enabled_from_kv(&conn));
    }

    /// An existing install's `codedeck.db` (the WebView's own schema, CDX-012)
    /// opens straight through — no migration surprises for a user switching
    /// from the Tauri app to this native one.
    #[test]
    fn matches_the_shared_schema_verbatim() {
        let (_dir, conn) = open_temp();
        conn.execute(
            "INSERT INTO kv (key, value) VALUES ('k', 'v')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO transcript (machine_pubkey, session_id, seq, kind, json, created_at)
             VALUES ('m', 's', 1, 'system', '{}', 0)",
            [],
        )
        .unwrap();
    }
}
