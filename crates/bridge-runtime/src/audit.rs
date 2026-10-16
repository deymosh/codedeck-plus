//! The terminal audit: `<home>/audit/terminal.jsonl`, a hash-chained log of
//! what every terminal did, and the retention of the asciicast recordings
//! beside it.
//!
//! The engine decides and records; this owns the file. Every
//! [`TerminalAuditRecord`] the engine emits becomes one JSON line, and each
//! line carries `prev`: the SHA-256, in hex, of the line before it (the first
//! line's `prev` is 64 zeros). An edited or deleted line breaks the chain at
//! the next line, which `codedeck-bridge audit verify` finds. The honest
//! limit, the same one [`docs/TERMINAL.md`](../../../docs/TERMINAL.md) states:
//! anyone running as the bridge's user can rewrite the whole file, chain and
//! all; the chain catches tampering that is not that thorough, and
//! `audit.syslog: true` also copies each line to the system log, which
//! survives even that.
//!
//! Nothing here runs on the bridge's one runtime thread. Writes go to a thread
//! of their own, fed by a channel and writing lines in order, so an audit
//! never blocks a relay, a session or a terminal. That thread also runs
//! retention: the oldest whole `term-*.cast` recordings are removed when they
//! are older than `audit.maxDays` or while the directory is larger than
//! `audit.maxBytes` (`terminal.jsonl` itself is kept — it is small and is the
//! record of who opened what).

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use bridge_core::TerminalAuditRecord;
use sha2::{Digest, Sha256};

/// The directory the audit lives in, under the bridge home (`0700`).
pub const AUDIT_DIR: &str = "audit";
/// The chained log of terminal events (`0600`).
pub const LOG_FILE: &str = "terminal.jsonl";
/// `prev` of the first line: a 32-byte SHA-256 in hex, all zeros, so every
/// line carries one and `verify` needs no special case for the first.
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The prefix and suffix a recording file has (`term-<id>.cast`).
const CAST_PREFIX: &str = "term-";
const CAST_SUFFIX: &str = ".cast";
/// How often the writer thread runs retention.
const RETENTION_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// How the audit is kept. 0 for `max_days` / `max_bytes` means no limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    pub max_days: u64,
    pub max_bytes: u64,
}

/// The audit's writer thread and the channel that feeds it. Dropping this
/// closes the channel and joins the thread, so everything already recorded is
/// on disk before the process ends.
pub struct Audit {
    tx: Option<Sender<TerminalAuditRecord>>,
    thread: Option<JoinHandle<()>>,
}

impl Audit {
    /// Start the audit under `home`, continuing the chain from the last line
    /// already on disk (a blocking read before the runtime serves anything is
    /// fine), and running retention once at once and then daily. A failure to
    /// open the log or start the thread is logged and leaves the audit off:
    /// the bridge keeps running, and `record` warns that a line was lost.
    pub fn open(home: &Path, syslog: bool, retention: Retention) -> Audit {
        let dir = home.join(AUDIT_DIR);
        if let Err(e) = fs::create_dir_all(&dir) {
            log::error!("[Terminal] cannot create the audit directory {}: {e}", dir.display());
            return Audit { tx: None, thread: None };
        }
        crate::state::restrict(&dir, 0o700);
        let log = dir.join(LOG_FILE);
        let prev = match last_line_hash(&log) {
            Ok(prev) => prev,
            Err(err) => {
                log::error!("[Terminal] cannot continue the terminal audit: {err}");
                return Audit { tx: None, thread: None };
            }
        };
        let (tx, rx) = mpsc::channel::<TerminalAuditRecord>();
        let thread = std::thread::Builder::new()
            .name("terminal-audit".into())
            .spawn(move || writer_loop(dir, log, rx, syslog, retention, prev))
            .map_err(|e| log::error!("[Terminal] cannot start the terminal audit thread: {e}"))
            .ok();
        Audit { tx: Some(tx), thread }
    }

    /// Record one line. Sent to the writer thread, never written here.
    pub fn record(&self, record: TerminalAuditRecord) {
        match &self.tx {
            Some(tx) => {
                if tx.send(record).is_err() {
                    log::warn!("[Terminal] the audit writer thread is gone; a line was lost");
                }
            }
            None => log::warn!("[Terminal] the audit is not running; a line was lost"),
        }
    }
}

impl Drop for Audit {
    fn drop(&mut self) {
        // Closing the channel ends the writer loop once it has drained.
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn writer_loop(
    dir: PathBuf,
    log: PathBuf,
    rx: Receiver<TerminalAuditRecord>,
    syslog: bool,
    retention: Retention,
    mut prev: String,
) {
    let file = match OpenOptions::new().create(true).append(true).open(&log) {
        Ok(file) => file,
        Err(e) => {
            log::error!("[Terminal] cannot open the audit log {}: {e}", log.display());
            return;
        }
    };
    crate::state::restrict(&log, 0o600);
    let mut out = BufWriter::new(file);

    run_retention(&dir, retention);
    let mut next_retention = Instant::now() + RETENTION_INTERVAL;
    loop {
        let wait = next_retention.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
            Ok(record) => match write_line(&mut out, &record, &prev) {
                Ok(line) => {
                    prev = hash_hex(line.as_bytes());
                    if syslog {
                        // The audit's log target. There is no syslog client
                        // here: `audit.syslog` routes each line to the `audit`
                        // target, so a log handler that forwards to the system
                        // log (journald, rsyslog) keeps a copy that survives
                        // the file being rewritten.
                        log::info!(target: "audit", "{line}");
                    }
                }
                Err(e) => log::error!("[Terminal] cannot write the audit log: {e}"),
            },
            Err(RecvTimeoutError::Timeout) => {
                run_retention(&dir, retention);
                next_retention = Instant::now() + RETENTION_INTERVAL;
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = out.flush();
                return;
            }
        }
    }
}

/// Serialize one record as a JSON line with `prev`, write it, and fsync. The
/// returned string is the line without its newline — what the next line's
/// `prev` hashes.
fn write_line(out: &mut BufWriter<File>, record: &TerminalAuditRecord, prev: &str) -> std::io::Result<String> {
    let mut value = serde_json::to_value(record).expect("a terminal audit record serializes");
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("prev".to_string(), serde_json::Value::String(prev.to_string()));
    }
    let line = serde_json::to_string(&value).expect("a JSON object serializes");
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    // Durability matters for a security log, and this is off the runtime
    // thread: pay the fsync here rather than risk losing the tail.
    out.get_ref().sync_all()?;
    Ok(line)
}

fn hash_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The chain head to continue from: the hash of the file's last line, or
/// [`GENESIS`] when there is no file or it has no lines.
fn last_line_hash(log: &Path) -> Result<String, String> {
    let file = match File::open(log) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(GENESIS.to_string()),
        Err(e) => return Err(format!("cannot read {}: {e}", log.display())),
    };
    let mut prev = GENESIS.to_string();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("cannot read {}: {e}", log.display()))?;
        if line.is_empty() {
            continue;
        }
        prev = hash_hex(line.as_bytes());
    }
    Ok(prev)
}

/// Walk the log and recompute the chain. `Ok(n)` is the number of lines;
/// `Err` names the first line whose `prev` does not match the line before it
/// (1-based) — the line after an edited or deleted one, which is where the
/// break shows.
pub fn verify(log: &Path) -> Result<u64, String> {
    let file = match File::open(log) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("cannot read {}: {e}", log.display())),
    };
    let mut prev = GENESIS.to_string();
    let mut n = 0u64;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("cannot read {}: {e}", log.display()))?;
        n += 1;
        if line.is_empty() {
            return Err(format!("line {n}: the line is empty"));
        }
        let value: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| format!("line {n}: not valid JSON ({e})"))?;
        let got = value.get("prev").and_then(|v| v.as_str()).unwrap_or("");
        if got != prev {
            let found = if got.is_empty() { "(missing)".to_string() } else { got.to_string() };
            return Err(format!("line {n}: prev is {found}, but the line before it hashes to {prev}"));
        }
        prev = hash_hex(line.as_bytes());
    }
    Ok(n)
}

/// Remove the oldest whole recordings under `dir` that are older than
/// `max_days`, or while the directory is larger than `max_bytes`. Oldest
/// first; `terminal.jsonl` is never removed.
fn run_retention(dir: &Path, retention: Retention) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("[Terminal] cannot read the audit directory {} for retention: {e}", dir.display());
            return;
        }
    };
    let mut casts: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(CAST_PREFIX) || !name.ends_with(CAST_SUFFIX) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        casts.push((entry.path(), mtime, meta.len()));
    }
    casts.sort_by_key(|(_, mtime, _)| *mtime);

    let cutoff = (retention.max_days > 0)
        .then(|| SystemTime::now().checked_sub(Duration::from_secs(retention.max_days * 86_400)).unwrap_or(SystemTime::UNIX_EPOCH));
    let mut total: u64 = casts.iter().map(|(_, _, len)| len).sum();
    for (path, mtime, len) in casts {
        let too_old = cutoff.is_some_and(|cutoff| mtime < cutoff);
        let too_big = retention.max_bytes > 0 && total > retention.max_bytes;
        if !too_old && !too_big {
            // Sorted oldest first: nothing later is older or a better
            // candidate for the size limit.
            break;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                total = total.saturating_sub(len);
                log::info!("[Terminal] audit retention removed {}", path.display());
            }
            Err(e) => log::warn!("[Terminal] cannot remove {}: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_core::TerminalAuditWhat;

    fn record(at_ms: u64, term: &str) -> TerminalAuditRecord {
        TerminalAuditRecord {
            at_ms,
            term: term.to_string(),
            what: TerminalAuditWhat::Opened,
            identity: "npub1example".to_string(),
            device: Some("a1b2".to_string()),
            label: Some("Pixel 8".to_string()),
            via: Some(protocol::common::TerminalVia::Direct),
            cwd: Some("/home/me".to_string()),
            shell: Some("/bin/bash".to_string()),
            cols: Some(80),
            rows: Some(24),
            reason: None,
            code: None,
            duration_ms: None,
            why: None,
        }
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path).unwrap().lines().map(str::to_string).collect()
    }

    #[test]
    fn three_lines_verify_and_the_chain_links_them() {
        let dir = tempfile::tempdir().unwrap();
        let audit = Audit::open(dir.path(), false, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(1, "t1"));
        audit.record(record(2, "t2"));
        audit.record(record(3, "t3"));
        drop(audit); // joins the writer thread, so the file is complete

        let log = dir.path().join(AUDIT_DIR).join(LOG_FILE);
        assert_eq!(verify(&log), Ok(3));
        let lines = lines(&log);
        // Each line's prev is the hash of the one before it; the first is GENESIS.
        let value: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(value["prev"], GENESIS);
        assert_eq!(value["what"], "opened");
        assert_eq!(value["atMs"], 1);
        let value2: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(value2["prev"], hash_hex(lines[0].as_bytes()));
    }

    #[test]
    fn the_chain_continues_across_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(AUDIT_DIR).join(LOG_FILE);

        let audit = Audit::open(dir.path(), false, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(1, "t1"));
        audit.record(record(2, "t2"));
        drop(audit);

        let audit = Audit::open(dir.path(), false, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(3, "t3"));
        drop(audit);

        // If the second run had started from GENESIS instead of the last
        // line's hash, line 3's prev would not match and this would fail.
        assert_eq!(verify(&log), Ok(3));
    }

    #[test]
    fn an_edited_line_breaks_the_chain_at_the_next_line() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(AUDIT_DIR).join(LOG_FILE);
        let audit = Audit::open(dir.path(), false, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(1, "t1"));
        audit.record(record(2, "t2"));
        audit.record(record(3, "t3"));
        drop(audit);

        let mut lines = lines(&log);
        // Edit the middle line: line 3's prev no longer matches line 2.
        lines[1] = lines[1].replace("\"t2\"", "\"tX\"");
        fs::write(&log, lines.join("\n") + "\n").unwrap();

        let err = verify(&log).unwrap_err();
        assert!(err.contains("line 3"), "{err}");
    }

    #[test]
    fn a_deleted_line_breaks_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(AUDIT_DIR).join(LOG_FILE);
        let audit = Audit::open(dir.path(), false, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(1, "t1"));
        audit.record(record(2, "t2"));
        audit.record(record(3, "t3"));
        drop(audit);

        let lines = lines(&log);
        fs::write(&log, format!("{}\n{}\n", lines[0], lines[2])).unwrap();

        let err = verify(&log).unwrap_err();
        assert!(err.contains("line 2"), "{err}");
    }

    #[test]
    fn an_empty_or_missing_log_verifies_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(verify(&dir.path().join("nope.jsonl")), Ok(0));
        fs::write(dir.path().join("empty.jsonl"), "").unwrap();
        assert_eq!(verify(&dir.path().join("empty.jsonl")), Ok(0));
    }

    #[test]
    fn syslog_lines_go_to_the_audit_target() {
        // The line is emitted to the `audit` log target; a test just proves it
        // does not panic and the file is written either way.
        let dir = tempfile::tempdir().unwrap();
        let audit = Audit::open(dir.path(), true, Retention { max_days: 90, max_bytes: 1 << 30 });
        audit.record(record(1, "t1"));
        drop(audit);
        assert_eq!(verify(&dir.path().join(AUDIT_DIR).join(LOG_FILE)), Ok(1));
    }

    fn cast(dir: &Path, name: &str, bytes: usize, age_days: u64) {
        let path = dir.join(name);
        fs::write(&path, vec![b'x'; bytes]).unwrap();
        let when = SystemTime::now() - Duration::from_secs(age_days * 86_400);
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(when).unwrap();
    }

    #[test]
    fn retention_removes_the_oldest_by_age() {
        let dir = tempfile::tempdir().unwrap();
        cast(dir.path(), "term-a.cast", 10, 3);
        cast(dir.path(), "term-b.cast", 10, 1);
        cast(dir.path(), "term-c.cast", 10, 0);
        fs::write(dir.path().join(LOG_FILE), "kept\n").unwrap();

        run_retention(dir.path(), Retention { max_days: 2, max_bytes: 0 });

        assert!(!dir.path().join("term-a.cast").exists(), "the oldest, over the age limit, is gone");
        assert!(dir.path().join("term-b.cast").exists());
        assert!(dir.path().join("term-c.cast").exists());
        assert!(dir.path().join(LOG_FILE).exists(), "the event log is never removed");
    }

    #[test]
    fn retention_removes_the_oldest_while_over_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        cast(dir.path(), "term-a.cast", 100, 2);
        cast(dir.path(), "term-b.cast", 100, 1);
        cast(dir.path(), "term-c.cast", 100, 0);

        // Room for two of the three: the oldest goes.
        run_retention(dir.path(), Retention { max_days: 0, max_bytes: 200 });

        assert!(!dir.path().join("term-a.cast").exists());
        assert!(dir.path().join("term-b.cast").exists());
        assert!(dir.path().join("term-c.cast").exists());
    }

    #[test]
    fn retention_leaves_other_files_and_the_log_alone() {
        let dir = tempfile::tempdir().unwrap();
        cast(dir.path(), "term-a.cast", 10, 30);
        fs::write(dir.path().join("notes.txt"), "keep me").unwrap();
        run_retention(dir.path(), Retention { max_days: 1, max_bytes: 0 });
        assert!(!dir.path().join("term-a.cast").exists());
        assert!(dir.path().join("notes.txt").exists());
    }
}
