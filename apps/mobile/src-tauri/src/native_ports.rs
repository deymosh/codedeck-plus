//! F2b: real persistence for the in-process `client_runtime::Core` (F1's
//! transitional `CorePorts::default()` used in-memory ports, losing every
//! store — machines, pairing, outbox, settings, identity — on every app
//! restart). Behind `native-core`, same as `corebridge.rs`.
//!
//! Schema compatibility is deliberate: this opens the SAME `codedeck.db` file
//! and issues the SAME `CREATE TABLE`/`CREATE INDEX` statements as
//! `apps/mobile/src/platform/sqlite.ts`'s `MIGRATION_STATEMENTS` (`kv(key,
//! value)`; `transcript(machine_pubkey, session_id, seq, kind, json,
//! created_at)`, PK `(machine_pubkey, session_id, seq)`) — an existing install
//! upgrading onto the native path keeps its pairing, sessions, and transcript
//! history rather than starting cold. The two paths are not meant to write
//! concurrently in the shipped app (the WebView's SQL commands stop once
//! `apps/mobile` is re-pointed at this `Core`), but a generous `busy_timeout`
//! is set anyway so the F1 dual-path test build's occasional overlap fails
//! closed (retried) rather than with an immediate "database is locked".
//!
//! One `rusqlite::Connection`, `Rc`-shared between the two port impls (same
//! shape as the TS `db` object backing both `sqliteKv` and
//! `sqliteTranscriptStorage`) — never sent across threads: this lives on the
//! `Core`'s own dedicated thread, opened fresh there (`Connection` is `Send`
//! but the ports hold it behind `Rc`, matching every other `client_runtime`
//! port).

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use client_runtime::ports::{LocalBoxFuture, TranscriptRow};
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

/// Open (creating the file and directory if needed) and migrate the shared
/// app database. Idempotent — safe to call every `core_init`.
pub fn open_native_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create db dir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("set busy_timeout: {e}"))?;
    for stmt in MIGRATIONS {
        conn.execute(stmt, []).map_err(|e| format!("migration failed: {e}"))?;
    }
    Ok(conn)
}

/// The `OutputEntry` discriminator, extracted defensively (the port keeps the
/// entry opaque; `kind` is denormalized for ad-hoc queries/debugging only) —
/// same field and fallback as the TS `kindOf`.
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

    fn set(&self, key: &str, value: &str) -> LocalBoxFuture<'_, ()> {
        let _ = self.conn.borrow().execute(
            "INSERT INTO kv (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        );
        Box::pin(async {})
    }

    fn delete(&self, key: &str) -> LocalBoxFuture<'_, ()> {
        let _ = self.conn.borrow().execute("DELETE FROM kv WHERE key = ?", [key]);
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
        let conn = self.conn.borrow();
        let mut inserted = Vec::new();
        for row in rows {
            let changed = conn
                .execute(
                    "INSERT OR IGNORE INTO transcript
                        (machine_pubkey, session_id, seq, kind, json, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        machine,
                        session,
                        row.seq,
                        kind_of(&row.entry),
                        row.entry.to_string(),
                        now_ms(),
                    ],
                )
                .unwrap_or(0);
            if changed > 0 {
                inserted.push(row.seq);
            }
        }
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TranscriptStoreSqlite {
    fn query_seqs(&self, machine: &str, session: &str) -> Vec<u64> {
        let conn = self.conn.borrow();
        let mut stmt = match conn.prepare(
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
            let mut stmt = match conn.prepare(
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

        // Re-inserting seq 1 with DIFFERENT content is ignored (dedup is by
        // (machine, session, seq), not content) — mirrors PK semantics.
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

    /// An existing install's `codedeck.db` (the WebView's own schema, CDX-012)
    /// opens straight through — no migration surprises for an upgrading user.
    #[test]
    fn matches_the_ts_adapter_schema_verbatim() {
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
