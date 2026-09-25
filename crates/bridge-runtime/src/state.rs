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
use std::sync::{Arc, Mutex};

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

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateDoc {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret_key_hex: Option<String>,
    #[serde(default)]
    kv: BTreeMap<String, String>,
}

/// The state file. Clones share one in-memory copy.
#[derive(Clone)]
pub struct StateFile {
    path: PathBuf,
    doc: Arc<Mutex<StateDoc>>,
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
        Ok(Self { path, doc: Arc::new(Mutex::new(doc)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StateDoc> {
        self.doc.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn persist(&self, doc: &StateDoc) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(doc).expect("state serializes");
        write_private(&self.path, &json).map_err(|e| format!("cannot write {}: {e}", self.path.display()))
    }

    pub fn has_identity(&self) -> bool {
        self.lock().secret_key_hex.is_some()
    }

    /// The bridge identity, created and stored on first use.
    pub fn identity(&self) -> Result<Keypair, String> {
        let mut doc = self.lock();
        if let Some(hex) = &doc.secret_key_hex {
            return keypair_from_secret_hex(hex).map_err(|e| format!("stored bridge key is invalid: {e}"));
        }
        let keys = generate_keypair();
        doc.secret_key_hex = Some(keys.secret_hex());
        self.persist(&doc)?;
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
        self.persist(&doc)
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
        let again = StateFile::open(dir.path()).unwrap();
        assert_eq!(again.identity().unwrap().pubkey_hex, keys.pubkey_hex);
        assert_eq!(again.get("pairedPhones").as_deref(), Some("[]"));
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
