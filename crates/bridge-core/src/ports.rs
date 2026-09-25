//! The local, synchronous seams the engine reads and writes through: the
//! clock and randomness, key/value storage, transcript files and the
//! workspace directories.
//!
//! These are quick local operations the engine needs an answer to before it
//! can go on (a new session's working directory, the entries of a sync
//! chunk), so they are plain calls rather than effects. Anything slow or
//! remote — relays, the agent host, HTTP, git, adb — is an
//! [`Effect`](crate::Effect) instead, with its result coming back as an
//! [`Input`](crate::Input).
//!
//! [`memory`] has in-memory implementations for tests; `bridge-runtime`
//! implements them over the filesystem.

use std::collections::BTreeMap;

use protocol::common::OutputEntry;
use protocol::events::SyncEntry;
use protocol::ranges::SeqRange;

/// Clock, identifiers and the process environment.
pub trait System: Send {
    /// Wall clock, milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;
    /// A fresh unique id (session ids, sync ids).
    fn new_id(&mut self) -> String;
    /// A fresh unguessable token (pairing windows).
    fn new_token(&mut self) -> String;
    /// Whether the bridge's environment sets `name` to a non-empty value.
    /// Only presence is ever asked: an operator-set credential wins over a
    /// stored one, and the phone may not clear it.
    fn env_is_set(&self, name: &str) -> bool;
}

/// Key/value storage for the engine's small documents (paired phones,
/// credentials, provider profiles, the session registry, the ingest
/// cursor). Values are JSON text. [`SECRET_KEYS`](crate::store_keys::SECRET_KEYS)
/// hold secrets; an implementation must keep them owner-readable only.
pub trait Store: Send {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&mut self, key: &str, value: &str) -> Result<(), String>;
}

/// Append-only session transcripts. The engine assigns seqs (starting at 1,
/// never renumbered); a store keeps what it is given and answers ranges.
pub trait Transcripts: Send {
    /// Every session that has a transcript, with its highest seq — read
    /// once at start so seqs continue across restarts.
    fn load(&mut self) -> Result<BTreeMap<String, u64>, String>;
    fn append(&mut self, session_id: &str, seq: u64, entry: &OutputEntry) -> Result<(), String>;
    /// The entries with `from <= seq <= to`, in seq order. Seqs the store no
    /// longer has (pruned) are simply absent.
    fn read(&self, session_id: &str, range: SeqRange) -> Result<Vec<SyncEntry>, String>;
    /// Keep only the last `keep_last` entries, without renumbering.
    fn prune(&mut self, session_id: &str, keep_last: usize) -> Result<(), String>;
    fn remove(&mut self, session_id: &str) -> Result<(), String>;
}

/// The directories sessions run in. Every path the phone sends is untrusted
/// and must stay inside a root.
pub trait Workspace: Send {
    /// The workspace roots, absolute, in configured order. Never empty.
    fn roots(&self) -> Vec<String>;
    /// Project folders under the roots, relative to their root — each one a
    /// valid `create-session.cwd`.
    fn folders(&mut self) -> Vec<String>;
    /// The working directory for a new session: `requested` (relative to a
    /// root) when it is an existing directory inside a root — created when
    /// `create` is set — else the first root.
    fn resolve_cwd(&mut self, requested: Option<&str>, create: bool) -> String;
    /// Create a project folder under `root` (one of [`Workspace::roots`]; the
    /// first when absent). Returns the path relative to the root, or why not.
    fn create_folder(&mut self, root: Option<&str>, path: &str) -> Result<String, String>;
}

/// The engine's four ports.
pub struct Ports {
    pub system: Box<dyn System>,
    pub store: Box<dyn Store>,
    pub transcripts: Box<dyn Transcripts>,
    pub workspace: Box<dyn Workspace>,
}

/// In-memory ports. Each is a cheap handle over shared state, so a test can
/// keep a clone to inspect what the engine wrote, or hand the same state to
/// a second engine to simulate a restart.
pub mod memory {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::{Arc, Mutex, MutexGuard};

    use protocol::common::OutputEntry;
    use protocol::events::SyncEntry;
    use protocol::ranges::SeqRange;

    use super::{Store, System, Transcripts, Workspace};

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A manual clock with deterministic ids.
    #[derive(Clone, Default)]
    pub struct TestSystem {
        inner: Arc<Mutex<SystemState>>,
    }

    #[derive(Default)]
    struct SystemState {
        now_ms: u64,
        next_id: u64,
        env: BTreeSet<String>,
    }

    impl TestSystem {
        pub fn at(now_ms: u64) -> Self {
            let s = Self::default();
            s.set_now(now_ms);
            s
        }
        pub fn set_now(&self, now_ms: u64) {
            lock(&self.inner).now_ms = now_ms;
        }
        pub fn advance(&self, ms: u64) {
            lock(&self.inner).now_ms += ms;
        }
        pub fn set_env(&self, name: &str) {
            lock(&self.inner).env.insert(name.to_string());
        }
    }

    impl System for TestSystem {
        fn now_ms(&self) -> u64 {
            lock(&self.inner).now_ms
        }
        fn new_id(&mut self) -> String {
            let mut s = lock(&self.inner);
            s.next_id += 1;
            format!("id-{}", s.next_id)
        }
        fn new_token(&mut self) -> String {
            let mut s = lock(&self.inner);
            s.next_id += 1;
            format!("token-{}", s.next_id)
        }
        fn env_is_set(&self, name: &str) -> bool {
            lock(&self.inner).env.contains(name)
        }
    }

    #[derive(Clone, Default)]
    pub struct MemoryStore {
        map: Arc<Mutex<BTreeMap<String, String>>>,
    }

    impl MemoryStore {
        pub fn snapshot(&self) -> BTreeMap<String, String> {
            lock(&self.map).clone()
        }
        pub fn put(&self, key: &str, value: &str) {
            lock(&self.map).insert(key.to_string(), value.to_string());
        }
    }

    impl Store for MemoryStore {
        fn get(&self, key: &str) -> Option<String> {
            lock(&self.map).get(key).cloned()
        }
        fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
            self.put(key, value);
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    pub struct MemoryTranscripts {
        files: Arc<Mutex<BTreeMap<String, Vec<SyncEntry>>>>,
        failing: Arc<Mutex<bool>>,
    }

    impl MemoryTranscripts {
        /// Every entry of a session, in seq order.
        pub fn entries(&self, session_id: &str) -> Vec<SyncEntry> {
            lock(&self.files).get(session_id).cloned().unwrap_or_default()
        }
        pub fn sessions(&self) -> Vec<String> {
            lock(&self.files).keys().cloned().collect()
        }
        /// Make every write fail (a vanished state directory).
        pub fn fail_writes(&self, failing: bool) {
            *lock(&self.failing) = failing;
        }
    }

    impl Transcripts for MemoryTranscripts {
        fn load(&mut self) -> Result<BTreeMap<String, u64>, String> {
            Ok(lock(&self.files)
                .iter()
                .map(|(id, entries)| (id.clone(), entries.last().map_or(0, |e| e.seq)))
                .collect())
        }
        fn append(&mut self, session_id: &str, seq: u64, entry: &OutputEntry) -> Result<(), String> {
            if *lock(&self.failing) {
                return Err("transcript store unavailable".into());
            }
            lock(&self.files)
                .entry(session_id.to_string())
                .or_default()
                .push(SyncEntry { seq, entry: entry.clone() });
            Ok(())
        }
        fn read(&self, session_id: &str, (from, to): SeqRange) -> Result<Vec<SyncEntry>, String> {
            Ok(self
                .entries(session_id)
                .into_iter()
                .filter(|e| e.seq >= from && e.seq <= to)
                .collect())
        }
        fn prune(&mut self, session_id: &str, keep_last: usize) -> Result<(), String> {
            if let Some(entries) = lock(&self.files).get_mut(session_id) {
                let drop = entries.len().saturating_sub(keep_last);
                entries.drain(..drop);
            }
            Ok(())
        }
        fn remove(&mut self, session_id: &str) -> Result<(), String> {
            lock(&self.files).remove(session_id);
            Ok(())
        }
    }

    /// A workspace of fixed roots whose folders exist only in memory.
    #[derive(Clone)]
    pub struct MemoryWorkspace {
        inner: Arc<Mutex<WorkspaceState>>,
    }

    struct WorkspaceState {
        roots: Vec<String>,
        folders: BTreeSet<String>,
    }

    impl MemoryWorkspace {
        pub fn new(roots: &[&str], folders: &[&str]) -> Self {
            Self {
                inner: Arc::new(Mutex::new(WorkspaceState {
                    roots: roots.iter().map(|r| r.to_string()).collect(),
                    folders: folders.iter().map(|f| f.to_string()).collect(),
                })),
            }
        }
    }

    /// `path` normalized relative to a root, or None when it escapes.
    fn confined(path: &str) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        for part in path.split(['/', '\\']) {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop()?;
                }
                p => parts.push(p),
            }
        }
        (!parts.is_empty() && !path.starts_with('/')).then(|| parts.join("/"))
    }

    impl Workspace for MemoryWorkspace {
        fn roots(&self) -> Vec<String> {
            lock(&self.inner).roots.clone()
        }
        fn folders(&mut self) -> Vec<String> {
            lock(&self.inner).folders.iter().cloned().collect()
        }
        fn resolve_cwd(&mut self, requested: Option<&str>, create: bool) -> String {
            let mut s = lock(&self.inner);
            let root = s.roots[0].clone();
            let Some(rel) = requested.and_then(confined) else { return root };
            if s.folders.contains(&rel) {
                return format!("{root}/{rel}");
            }
            if create {
                s.folders.insert(rel.clone());
                return format!("{root}/{rel}");
            }
            root
        }
        fn create_folder(&mut self, root: Option<&str>, path: &str) -> Result<String, String> {
            let mut s = lock(&self.inner);
            if root.is_some_and(|r| !s.roots.iter().any(|x| x == r)) {
                return Err("unknown workspace root".into());
            }
            let rel = confined(path.trim()).ok_or("folder path escapes the workspace root")?;
            s.folders.insert(rel.clone());
            Ok(rel)
        }
    }
}
