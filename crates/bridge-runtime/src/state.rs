//! `$CODEDECK_HOME/state.json` — the bridge's secret key and the engine's
//! key/value store (paired phones, credentials, provider profiles, the
//! session registry, the ingest cursor) — and `bridge.lock`, which keeps two
//! bridges from ever running on one identity.
//!
//! The file holds secrets, so it is owner-only (0600) and the home directory
//! 0700, and it is rewritten atomically (temporary file, then rename) so a
//! crash never leaves half a file.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use bridge_core::ports::Store;
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
use serde::{Deserialize, Serialize};

/// Best-effort permission tightening (a no-op off Unix).
pub fn restrict(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// Write `content` to `path` atomically, owner-only.
pub fn write_private(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut f = File::create(&tmp)?;
        restrict(&tmp, 0o600);
        f.write_all(content)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateDoc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret_key_hex: Option<String>,
    #[serde(default)]
    kv: BTreeMap<String, String>,
}

/// One snapshot handed to the state writer. `ack`, when set, is answered once
/// this snapshot — or a newer one that supersedes it — is on disk.
struct Job {
    doc: StateDoc,
    ack: Option<Sender<Result<(), String>>>,
}

/// Writes `state.json` on a thread of its own. The bridge runs on one thread,
/// and every write ends in an fsync that a slow disk (or a Docker Desktop
/// volume) can hold for tens of milliseconds — time every relay and phone
/// link would otherwise wait, on every session-list revision, heartbeat
/// cursor and registry change. Snapshots queue up and coalesce: the thread
/// writes the newest one it has, and a write of the newest makes every older
/// one it supersedes unnecessary, so an acknowledgement taken for an older
/// snapshot is answered by that write.
struct Writer {
    tx: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Writer {
    fn spawn(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let thread = std::thread::Builder::new()
            .name("codedeck-state-writer".into())
            .spawn(move || writer_loop(&path, rx))
            .map_err(|e| log::error!("[State] cannot start the state writer thread: {e}"))
            .ok();
        Self { tx: Some(tx), thread }
    }

    /// Queue a snapshot. Never touches the file and never blocks the caller on
    /// it; only the newest snapshot waiting matters.
    fn queue(&self, doc: StateDoc) -> Result<(), String> {
        match &self.tx {
            Some(tx) => tx.send(Job { doc, ack: None }).map_err(|_| "the state writer thread is gone".to_string()),
            None => Err("the state writer thread is not running".into()),
        }
    }

    /// Queue a snapshot and wait until it, or a newer one, is on disk.
    fn write_now(&self, doc: StateDoc) -> Result<(), String> {
        let (done, wait) = mpsc::channel();
        let Some(tx) = &self.tx else { return Err("the state writer thread is not running".into()) };
        tx.send(Job { doc, ack: Some(done) }).map_err(|_| "the state writer thread is gone".to_string())?;
        wait.recv().map_err(|_| "the state writer thread is gone".to_string())?
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Closing the channel ends the writer thread once it has drained and
        // written what was still queued; joining makes the last snapshot
        // durable before the process exits.
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn write_doc(path: &Path, doc: &StateDoc) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(doc).expect("state serializes");
    write_private(path, &json).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// How long the writer waits before retrying a failed snapshot. After these
/// attempts it waits for the next snapshot: if the disk is still failing,
/// retrying the same bytes adds nothing, and the newest snapshot is tried as
/// a fresh one with its own budget. A transient failure is therefore not
/// left as a silently stale `state.json`.
#[cfg(not(test))]
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(5)];
#[cfg(test)]
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(20), Duration::from_millis(50)];

fn writer_loop(path: &Path, rx: Receiver<Job>) {
    loop {
        let (mut doc, mut acks): (StateDoc, Vec<Sender<Result<(), String>>>) = match rx.recv() {
            Ok(Job { doc, ack }) => (doc, ack.into_iter().collect()),
            Err(_) => break,
        };
        doc = coalesce(doc, &mut acks, &rx);
        let mut delays = RETRY_DELAYS.into_iter();
        let result = loop {
            match write_doc(path, &doc) {
                Ok(()) => break Ok(()),
                Err(e) => {
                    log::warn!("[State] {e}");
                    let Some(delay) = delays.next() else { break Err(e) };
                    // Wait out the delay, but a newer snapshot supersedes the
                    // one that failed.
                    match rx.recv_timeout(delay) {
                        Ok(Job { doc: newer, ack }) => {
                            doc = newer;
                            acks.extend(ack);
                            doc = coalesce(doc, &mut acks, &rx);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break Err(e),
                    }
                }
            }
        };
        for ack in acks {
            let _ = ack.send(result.clone());
        }
    }
}

/// The newest snapshot queued behind `doc`, folding the acknowledgements of
/// every snapshot it supersedes into `acks`.
fn coalesce(mut doc: StateDoc, acks: &mut Vec<Sender<Result<(), String>>>, rx: &Receiver<Job>) -> StateDoc {
    while let Ok(Job { doc: newer, ack }) = rx.try_recv() {
        doc = newer;
        acks.extend(ack);
    }
    doc
}

/// The state file. Clones share one in-memory copy and one writer.
#[derive(Clone)]
pub struct StateFile {
    doc: Arc<Mutex<StateDoc>>,
    writer: Arc<Writer>,
}

impl StateFile {
    pub fn open(home: &Path) -> Result<Self, String> {
        fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
        restrict(home, 0o700);
        let path = home.join("state.json");
        let doc = match fs::read_to_string(&path) {
            Ok(raw) => {
                restrict(&path, 0o600);
                serde_json::from_str(&raw).map_err(|e| {
                    format!(
                        "corrupt state file {}: {e}. Move it aside to start fresh (this loses the bridge identity and pairings).",
                        path.display()
                    )
                })?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => StateDoc::default(),
            Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
        };
        let writer = Arc::new(Writer::spawn(path));
        Ok(Self { doc: Arc::new(Mutex::new(doc)), writer })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StateDoc> {
        self.doc.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Wait until everything set so far is on disk. The runtime never needs
    /// this — its writer flushes on drop — but it makes a reopen deterministic.
    pub fn flush(&self) -> Result<(), String> {
        self.writer.write_now(self.lock().clone())
    }

    pub fn has_identity(&self) -> bool {
        self.lock().secret_key_hex.is_some()
    }

    /// The bridge identity, created and stored on first use. Persisted before
    /// it is returned: the identity is the bridge, and a pairing made with a
    /// key that never reached the disk would be lost.
    pub fn identity(&self) -> Result<Keypair, String> {
        let mut doc = self.lock();
        if let Some(hex) = &doc.secret_key_hex {
            return keypair_from_secret_hex(hex).map_err(|e| format!("stored bridge key is invalid: {e}"));
        }
        let keys = generate_keypair();
        doc.secret_key_hex = Some(keys.secret_hex());
        self.writer.write_now(doc.clone())?;
        Ok(keys)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.lock().kv.get(key).cloned()
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut doc = self.lock();
        if doc.kv.get(key).map(String::as_str) == Some(value) {
            return Ok(());
        }
        doc.kv.insert(key.to_string(), value.to_string());
        self.writer.queue(doc.clone())
    }
}

impl Store for StateFile {
    fn get(&self, key: &str) -> Option<String> {
        StateFile::get(self, key)
    }
    fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        StateFile::set(self, key, value)
    }
}

/// `bridge.lock`: an exclusive OS lock held for the life of the process. The
/// OS drops it when the process dies, however it dies, so a stale lock can
/// never block a restart. The holder's pid goes in `bridge.pid` beside it,
/// for messages only: Windows locks are mandatory, so another process cannot
/// read a locked file, and whether a bridge runs is the lock's answer alone.
pub struct Lock {
    _file: File,
}

/// A running bridge found holding the lock; its pid when `bridge.pid` could
/// be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Holder {
    pub pid: Option<u32>,
}

impl Holder {
    /// ` (pid N)`, or nothing when the pid is unknown.
    pub fn pid_suffix(&self) -> String {
        self.pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
    }
}

pub fn acquire_lock(home: &Path) -> Result<Lock, String> {
    // First run: the home directory may not exist yet.
    fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let path = home.join("bridge.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            let holder = lock_holder(home).map(|h| h.pid_suffix()).unwrap_or_default();
            return Err(format!(
                "a bridge is already running on {}{holder}. Stop it first, or use a different --home.",
                home.display()
            ));
        }
        Err(fs::TryLockError::Error(e)) => return Err(format!("cannot lock {}: {e}", path.display())),
    }
    let pid_file = home.join("bridge.pid");
    fs::write(&pid_file, std::process::id().to_string()).map_err(|e| format!("cannot write {}: {e}", pid_file.display()))?;
    Ok(Lock { _file: file })
}

/// The running bridge on `home`, if one holds the lock.
pub fn lock_holder(home: &Path) -> Option<Holder> {
    let file = OpenOptions::new().read(true).write(true).open(home.join("bridge.lock")).ok()?;
    match file.try_lock() {
        Ok(()) => None,
        Err(_) => Some(Holder { pid: fs::read_to_string(home.join("bridge.pid")).ok().and_then(|s| s.trim().parse().ok()) }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identity_and_values_survive_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateFile::open(dir.path()).unwrap();
        assert!(!state.has_identity());
        let keys = state.identity().unwrap();
        state.set("pairedPhones", "[]").unwrap();
        state.flush().unwrap();
        let again = StateFile::open(dir.path()).unwrap();
        assert_eq!(again.identity().unwrap().pubkey_hex, keys.pubkey_hex);
        assert_eq!(again.get("pairedPhones").as_deref(), Some("[]"));
    }

    #[test]
    fn a_burst_of_sets_leaves_the_last_value_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateFile::open(dir.path()).unwrap();
        state.identity().unwrap();
        for i in 0..100 {
            state.set("cursor", &i.to_string()).unwrap();
        }
        state.flush().unwrap();
        let again = StateFile::open(dir.path()).unwrap();
        assert_eq!(again.get("cursor").as_deref(), Some("99"));
    }

    #[test]
    fn dropping_the_state_file_flushes_what_was_set() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateFile::open(dir.path()).unwrap();
        let keys = state.identity().unwrap();
        state.set("pairedPhones", "[1]").unwrap();
        drop(state);
        let again = StateFile::open(dir.path()).unwrap();
        assert_eq!(again.identity().unwrap().pubkey_hex, keys.pubkey_hex);
        assert_eq!(again.get("pairedPhones").as_deref(), Some("[1]"));
    }

    #[test]
    fn a_failed_write_is_retried_before_it_is_given_up_and_the_next_snapshot_lands() {
        let dir = tempfile::tempdir().unwrap();
        // The parent directory does not exist yet: every attempt fails.
        let path = dir.path().join("sub").join("state.json");
        let writer = Writer::spawn(path.clone());
        let mut doc = StateDoc::default();
        doc.kv.insert("k".into(), "v".into());
        let started = std::time::Instant::now();
        assert!(writer.write_now(doc.clone()).is_err());
        assert!(
            started.elapsed() >= Duration::from_millis(60),
            "the failed write waited for its retries before giving up"
        );
        // The disk recovers; the next snapshot is a fresh write, not a
        // permanently stale file.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        writer.write_now(doc).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"v\""));
    }

    #[test]
    fn queued_snapshots_coalesce_to_the_newest_and_answer_every_wait() {
        let (tx, rx) = mpsc::channel::<Job>();
        let mut acks = Vec::new();
        let mut waits = Vec::new();
        for value in ["a", "b", "c"] {
            let mut doc = StateDoc::default();
            doc.kv.insert("k".into(), value.into());
            let (ack, wait) = mpsc::channel();
            tx.send(Job { doc, ack: Some(ack) }).unwrap();
            waits.push(wait);
        }
        let Job { doc, ack } = rx.recv().unwrap();
        acks.extend(ack);
        let doc = coalesce(doc, &mut acks, &rx);
        // The newest snapshot supersedes the two before it, and one write
        // answers all three waiters.
        assert_eq!(doc.kv["k"], "c");
        assert_eq!(acks.len(), 3);
        assert!(waits.iter().all(|wait| matches!(wait.try_recv(), Err(mpsc::TryRecvError::Empty))));
    }

    #[cfg(unix)]
    #[test]
    fn the_state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        StateFile::open(dir.path()).unwrap().identity().unwrap();
        let mode = fs::metadata(dir.path().join("state.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_not_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("state.json"), "{torn").unwrap();
        assert!(StateFile::open(dir.path()).err().unwrap().contains("corrupt state file"));
    }

    #[test]
    fn the_first_run_creates_its_home_directory() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("deep").join("codedeck");
        let lock = acquire_lock(&home).unwrap();
        assert!(home.join("bridge.lock").exists());
        drop(lock);
        // Released within a short while, not at once: see the test below.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while lock_holder(&home).is_some() {
            assert!(std::time::Instant::now() < deadline, "the lock was not released after the drop");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        acquire_lock(&home).unwrap();
    }

    #[test]
    fn a_second_lock_is_refused_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = acquire_lock(dir.path()).unwrap();
        assert_eq!(lock_holder(dir.path()), Some(Holder { pid: Some(std::process::id()) }));
        assert!(acquire_lock(dir.path()).err().unwrap().contains("already running"));
        drop(lock);
        // A flock belongs to the open file, which a child process that another
        // test forks at that moment shares until it execs; the lock is only
        // free once it has. Released means released within a short while.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while lock_holder(dir.path()).is_some() {
            assert!(std::time::Instant::now() < deadline, "the lock was not released after the drop");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        acquire_lock(dir.path()).unwrap();
    }
}
