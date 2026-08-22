//! In-crate SQLite command layer — replaces `tauri-plugin-sql` (CDX-012).
//!
//! Why: MDK's `mdk-sqlite-storage` hard-pins `rusqlite 0.37` (libsqlite3-sys
//! 0.35) while `tauri-plugin-sql`'s sqlx pins libsqlite3-sys 0.28 — both
//! `links = "sqlite3"`, and cargo forbids two linked copies of the same native
//! library in one binary. The plugin's entire used surface was the tiny
//! `SqlExecutor` seam (single statements, `?` positional params), so the same
//! contract is served here over the SAME rusqlite build MDK uses.
//!
//! Path compatibility: `tauri-plugin-sql` resolved `sqlite:codedeck.db`
//! against the app CONFIG dir — this module opens exactly
//! `app_config_dir()/codedeck.db`, so existing installs keep their data. The
//! bundled SQLCipher build reads plain (unencrypted) SQLite files fine when no
//! key is applied; the app DB stays plain, only MDK's own store is encrypted.
use std::sync::Mutex;

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Number, Value as JsonValue};

pub const DB_FILE: &str = "codedeck.db";

#[derive(Default)]
pub struct SqlState(Mutex<Option<Connection>>);

fn json_to_sql(v: &JsonValue) -> Result<SqlValue, String> {
    Ok(match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(i64::from(*b)),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("unbindable number: {n}"));
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        other => return Err(format!("unbindable parameter type: {other}")),
    })
}

fn sql_to_json(v: rusqlite::types::ValueRef<'_>) -> JsonValue {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(JsonValue::Number).unwrap_or(JsonValue::Null),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        // The app schema stores no blobs; degrade defensively instead of panicking.
        ValueRef::Blob(_) => JsonValue::Null,
    }
}

pub fn execute_on(conn: &Connection, sql: &str, params: &[JsonValue]) -> Result<(), String> {
    let bound: Vec<SqlValue> = params.iter().map(json_to_sql).collect::<Result<_, _>>()?;
    conn.execute(sql, rusqlite::params_from_iter(bound))
        .map(|_| ())
        .map_err(|e| format!("sql execute: {e}"))
}

pub fn select_on(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<Vec<Map<String, JsonValue>>, String> {
    let bound: Vec<SqlValue> = params.iter().map(json_to_sql).collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(sql).map_err(|e| format!("sql prepare: {e}"))?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(bound))
        .map_err(|e| format!("sql query: {e}"))?;
    let mut out = Vec::new();
    loop {
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(e) => return Err(format!("sql row: {e}")),
        };
        let mut obj = Map::with_capacity(columns.len());
        for (i, name) in columns.iter().enumerate() {
            let value = row
                .get_ref(i)
                .map(sql_to_json)
                .map_err(|e| format!("sql column {name}: {e}"))?;
            obj.insert(name.clone(), value);
        }
        out.push(obj);
    }
    Ok(out)
}

impl SqlState {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let guard = self.0.lock().map_err(|_| "sql lock poisoned".to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "sql store not opened (call sql_open first)".to_string())?;
        f(conn)
    }
}

/// Open (creating if needed) the app database. Idempotent.
#[tauri::command]
pub async fn sql_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SqlState>,
) -> Result<(), String> {
    use tauri::Manager;
    let mut guard = state.0.lock().map_err(|_| "sql lock poisoned".to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app config dir: {e}"))?;
    let conn =
        Connection::open(dir.join(DB_FILE)).map_err(|e| format!("open {DB_FILE}: {e}"))?;
    *guard = Some(conn);
    Ok(())
}

/// Execute a single statement with `?` positional parameters.
#[tauri::command]
pub async fn sql_execute(
    state: tauri::State<'_, SqlState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<(), String> {
    state.with(|conn| execute_on(conn, &sql, &params))
}

/// Run a single SELECT; rows come back as column-name → JSON value objects.
#[tauri::command]
pub async fn sql_select(
    state: tauri::State<'_, SqlState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    state.with(|conn| select_on(conn, &sql, &params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    /// The exact statements platform/sqlite.ts issues (migrations, upsert,
    /// select) work through the JSON binding layer.
    #[test]
    fn app_schema_round_trip() {
        let c = conn();
        execute_on(
            &c,
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            &[],
        )
        .unwrap();
        execute_on(
            &c,
            "INSERT INTO kv (key, value) VALUES (?, ?)\n     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            &[json!("schema.version"), json!("1")],
        )
        .unwrap();
        execute_on(
            &c,
            "INSERT INTO kv (key, value) VALUES (?, ?)\n     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            &[json!("schema.version"), json!("2")],
        )
        .unwrap();
        let rows = select_on(&c, "SELECT value FROM kv WHERE key = ?", &[json!("schema.version")])
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["value"], json!("2"));
    }

    /// Numbers keep their integer-ness (transcript seq/created_at are read
    /// back as JS numbers, not strings), and NULL/bool bind sanely.
    #[test]
    fn type_fidelity() {
        let c = conn();
        execute_on(&c, "CREATE TABLE t (i INTEGER, f REAL, s TEXT, n TEXT)", &[]).unwrap();
        execute_on(
            &c,
            "INSERT INTO t (i, f, s, n) VALUES (?, ?, ?, ?)",
            &[json!(42), json!(1.5), json!("x"), JsonValue::Null],
        )
        .unwrap();
        let rows = select_on(&c, "SELECT i, f, s, n FROM t", &[]).unwrap();
        assert_eq!(rows[0]["i"], json!(42));
        assert_eq!(rows[0]["f"], json!(1.5));
        assert_eq!(rows[0]["s"], json!("x"));
        assert_eq!(rows[0]["n"], JsonValue::Null);
    }
}
