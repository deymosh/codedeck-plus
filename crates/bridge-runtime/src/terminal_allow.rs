//! `<home>/terminal-allow.json` — the devices the machine's owner approved
//! for a terminal, and the ones that asked and were refused.
//!
//! Every client of a paired identity shares the identity key, so the key alone
//! cannot say which phone is asking; a device is named by the first session
//! key it granted this bridge (a name that survives rotation) and approved on
//! the machine. The file holds two lists — the approved device ids, and the
//! devices refused a terminal with the label and time the owner needs to
//! decide about them:
//!
//! ```json
//! { "devices": ["a1b2…"], "pending": [{ "device": "c3d4…", "label": "Pixel 8", "lastSeenMs": 1700000000000 }] }
//! ```
//!
//! It is owner-only (`0600`) and written atomically (a temporary file, then a
//! rename), so a crash never leaves half a file, and the CLI
//! (`codedeck-bridge terminal allow|disallow`) edits it while the bridge runs.
//! Every read-modify-write of it — the CLI's and the bridge's writer thread's —
//! takes a small lock file (`terminal-allow.json.lock`) so two of them cannot
//! lose each other's change. The bridge re-reads it, cached by a stamp of its
//! metadata, so a change takes effect without a restart: [`Cache::changed`] is
//! one `metadata` call, and the file is read only when that stamp moved.

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use bridge_core::{PendingDevice, TerminalAllowlist, TerminalDevices};

/// The file's name in the bridge home.
pub const ALLOWLIST_FILE: &str = "terminal-allow.json";

/// How long a read-modify-write waits for the lock before giving up. The
/// holder is the CLI or the bridge's writer thread, and neither holds it for
/// more than a read and a write.
const LOCK_WAIT: Duration = Duration::from_secs(2);
/// How often to retry while another holder has the lock.
const LOCK_RETRY: Duration = Duration::from_millis(20);
/// A lock file older than this belonged to a process that died holding it, so
/// it is removed and the lock taken. Well above the time a real holder needs.
const LOCK_STALE: Duration = Duration::from_secs(10);
/// What the lock file is called: the allowlist's name with this appended.
const LOCK_SUFFIX: &str = ".lock";

/// The allowlist file under `home`.
pub fn path_in(home: &Path) -> PathBuf {
    home.join(ALLOWLIST_FILE)
}

/// Read the file. Total: a missing or unreadable file is an empty list, and a
/// corrupt one is an empty list with a warning. An empty list refuses every
/// device — fail closed, the safe reading of a file the owner may have edited
/// by hand.
pub fn read(path: &Path) -> TerminalAllowlist {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            log::warn!("[Terminal] {} is not a valid allowlist ({e}); treating it as empty", path.display());
            TerminalAllowlist::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => TerminalAllowlist::default(),
        Err(e) => {
            log::warn!("[Terminal] cannot read {}: {e}; treating it as empty", path.display());
            TerminalAllowlist::default()
        }
    }
}

/// Write the list atomically and owner-only.
pub fn write(path: &Path, list: &TerminalAllowlist) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(list).expect("an allowlist serializes");
    crate::state::write_private(path, &json).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// What the cache compares to notice a change: the file's modification time,
/// its length, and (on unix) its inode. mtime alone is not enough — two writes
/// inside one mtime tick, or a filesystem with a coarse clock, report the same
/// mtime — so the length and inode are compared too. Every write here is an
/// atomic rename, so the inode is new on each one; the length also catches a
/// rewrite that kept the inode.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    mtime: Option<SystemTime>,
    len: u64,
    ino: u64,
}

impl Stamp {
    fn of(meta: &fs::Metadata) -> Stamp {
        #[cfg(unix)]
        let ino = {
            use std::os::unix::fs::MetadataExt;
            meta.ino()
        };
        #[cfg(not(unix))]
        let ino = 0;
        Stamp { mtime: meta.modified().ok(), len: meta.len(), ino }
    }
}

/// The allowlist file and the stamp last seen. The runtime shares one of
/// these between the command path and its periodic check, so a change is
/// noticed once and read once.
pub struct Cache {
    path: PathBuf,
    seen: Option<Stamp>,
    checked: bool,
}

impl Cache {
    pub fn new(home: &Path) -> Self {
        Self { path: path_in(home), seen: None, checked: false }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The list when the file changed since the last check, else `None`. The
    /// first call always returns the file's content, so it doubles as the
    /// start-up read.
    pub fn changed(&mut self) -> Option<TerminalAllowlist> {
        let seen = fs::metadata(&self.path).ok().map(|m| Stamp::of(&m));
        if self.checked && seen == self.seen {
            return None;
        }
        self.checked = true;
        self.seen = seen;
        Some(read(&self.path))
    }
}

/// The engine's refused-device list merged with the approved devices as they
/// are on disk now (the owner may have approved or withdrawn one in the CLI
/// while this bridge ran), less those no client is any more. Only the
/// allowlist's writer thread calls this, from its own thread: reading the
/// file is file work, and the bridge's runtime thread must not do it.
fn merge(path: &Path, devices: TerminalDevices) -> TerminalAllowlist {
    let mut list = read(path);
    list.pending = devices.pending;
    list.devices.retain(|d| devices.live.contains(d));
    list
}

/// Writes the allowlist on a thread of its own, so the bridge's single runtime
/// thread never touches the file (the same reason the audit has a writer
/// thread). It is fed the refused-device lists; each one is merged with the
/// approved devices as the file has them now and written whole, under the
/// allowlist lock. A burst of refused devices coalesces: the thread drains its
/// channel and writes only the newest list, so a device spamming
/// `terminal-open` costs the file one write, not one per message.
pub struct Writer {
    tx: Option<Sender<TerminalDevices>>,
    thread: Option<JoinHandle<()>>,
}

impl Writer {
    pub fn start(path: PathBuf) -> Writer {
        let (tx, rx) = mpsc::channel::<TerminalDevices>();
        let thread = std::thread::Builder::new()
            .name("terminal-allow".into())
            .spawn(move || writer_loop(path, rx))
            .map_err(|e| log::error!("[Terminal] cannot start the allowlist writer thread: {e}"))
            .ok();
        Writer { tx: Some(tx), thread }
    }

    /// Hand the devices over to be written. Never blocks the caller on the
    /// file, and only the newest list matters: a burst coalesces.
    pub fn set(&self, devices: TerminalDevices) {
        if let Some(tx) = &self.tx {
            if tx.send(devices).is_err() {
                log::warn!("[Terminal] the allowlist writer thread is gone; a change was lost");
            }
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Closing the channel ends the writer thread once it has drained.
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The writer thread: take the newest device lists, merge them with the file
/// as it is now, and write it — all under the lock, so the CLI editing the
/// file at the same moment cannot lose this write (nor this one the CLI's).
fn writer_loop(path: PathBuf, rx: Receiver<TerminalDevices>) {
    while let Ok(mut devices) = rx.recv() {
        // Everything that arrived while this one waited is superseded by the
        // newest: only the last list needs writing.
        while let Ok(newer) = rx.try_recv() {
            devices = newer;
        }
        let _lock = match Lock::acquire(&path) {
            Ok(lock) => lock,
            Err(err) => {
                log::warn!("[Terminal] cannot write the allowlist: {err}");
                continue;
            }
        };
        let list = merge(&path, devices);
        if let Err(err) = write(&path, &list) {
            log::warn!("[Terminal] cannot write the allowlist: {err}");
        }
    }
}

/// The lock that serializes the allowlist's read-modify-write. The CLI and the
/// bridge's writer thread each read the whole file and write it back, so
/// without this they can lose each other's change — `terminal allow` right
/// after a refusal, say. Taken by creating `<file>.lock` exclusively, which
/// works across processes; released by removing it. Only the CLI and the
/// writer thread ever take it: the bridge's runtime thread never does, so a
/// lock can never stall a relay, a session or a terminal.
struct Lock {
    path: PathBuf,
}

impl Lock {
    /// Take the lock for `file`, waiting up to [`LOCK_WAIT`] for a holder
    /// (retrying every [`LOCK_RETRY`]). A lock file older than [`LOCK_STALE`]
    /// belonged to a process that died holding it, so it is removed and the
    /// lock taken; anything else means a real holder, and the wait ends with
    /// an error rather than a lost write.
    fn acquire(file: &Path) -> Result<Lock, String> {
        let path = lock_path(file);
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Lock { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if stale(&path) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "timed out waiting for {} (another process is editing the allowlist)",
                            path.display()
                        ));
                    }
                    std::thread::sleep(LOCK_RETRY);
                }
                Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// `file`'s lock file: `<file>.lock` beside it.
fn lock_path(file: &Path) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(LOCK_SUFFIX);
    file.with_file_name(name)
}

/// Whether the lock file is old enough that its holder must have died. A file
/// that cannot be read is treated as held: the caller retries and, on the
/// deadline, reports it rather than stealing a live lock.
fn stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
        .is_some_and(|age| age >= LOCK_STALE)
}

/// The refused devices as lines for a person: id, label, when last seen.
pub fn pending_lines(list: &TerminalAllowlist) -> Vec<String> {
    list.pending
        .iter()
        .map(|p| {
            let label = p.label.as_deref().filter(|l| !l.is_empty()).unwrap_or("(no name)");
            format!("  {}  \"{}\"  last seen {}", p.device, label, when(p.last_seen_ms))
        })
        .collect()
}

/// A Unix-epoch millisecond timestamp as an ISO-8601 UTC instant.
fn when(ms: u64) -> String {
    bridge_core::time::iso(ms)
}

/// Approve a device: move it from the refused list to the approved one.
/// `target` is the id, or an unambiguous prefix of one. The whole
/// read-modify-write is under the allowlist lock, so it cannot race the
/// bridge's writer thread.
pub fn allow(path: &Path, target: &str) -> Result<String, String> {
    let _lock = Lock::acquire(path)?;
    let mut list = read(path);
    if resolve_device(&list.devices, target)?.is_some() {
        return Ok(format!("\"{target}\" is already approved."));
    }
    let Some(id) = resolve_pending(&list.pending, target)? else {
        return Err(format!(
            "no device waiting for approval matches \"{target}\". Run `codedeck-bridge terminal pending` to list them."
        ));
    };
    let label = list.pending.iter().find(|p| p.device == id).and_then(|p| p.label.clone());
    list.pending.retain(|p| p.device != id);
    list.devices.insert(id.clone());
    write(path, &list)?;
    Ok(format!("Approved {id}{}.", label.map(|l| format!(" \"{l}\"")).unwrap_or_default()))
}

/// Withdraw a device's approval: remove it from the approved list. A running
/// bridge closes that device's terminals the moment it next reads the file.
/// The whole read-modify-write is under the allowlist lock, so it cannot race
/// the bridge's writer thread.
pub fn disallow(path: &Path, target: &str) -> Result<String, String> {
    let _lock = Lock::acquire(path)?;
    let mut list = read(path);
    let Some(id) = resolve_device(&list.devices, target)? else {
        return Err(format!(
            "no approved device matches \"{target}\". Run `codedeck-bridge terminal pending`, or read {}, to see them.",
            path.display()
        ));
    };
    list.devices.remove(&id);
    write(path, &list)?;
    Ok(format!("Withdrew {id}. A running bridge closes its terminals at once."))
}

/// The approved device id `target` names: itself, or the single one it is a
/// prefix of. `Ok(None)` when nothing matches; an error when more than one
/// does, so an ambiguous prefix is never resolved by guessing.
fn resolve_device(devices: &BTreeSet<String>, target: &str) -> Result<Option<String>, String> {
    if target.is_empty() {
        return Ok(None);
    }
    if devices.contains(target) {
        return Ok(Some(target.to_string()));
    }
    let matches: Vec<&String> = devices.iter().filter(|d| d.starts_with(target)).collect();
    unique(target, matches)
}

/// The same for a device in the refused list, returning its id.
fn resolve_pending(pending: &[PendingDevice], target: &str) -> Result<Option<String>, String> {
    if target.is_empty() {
        return Ok(None);
    }
    if let Some(p) = pending.iter().find(|p| p.device == target) {
        return Ok(Some(p.device.clone()));
    }
    let matches: Vec<&String> = pending.iter().map(|p| &p.device).filter(|d| d.starts_with(target)).collect();
    unique(target, matches)
}

fn unique(target: &str, matches: Vec<&String>) -> Result<Option<String>, String> {
    match matches.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some((*one).clone())),
        many => Err(format!(
            "\"{target}\" matches more than one device: {}",
            many.iter().map(|d| d.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list_with(devices: &[&str], pending: &[(&str, &str)]) -> TerminalAllowlist {
        TerminalAllowlist { devices: devices.iter().map(|d| d.to_string()).collect(), pending: pending_of(pending) }
    }

    fn pending_of(pending: &[(&str, &str)]) -> Vec<PendingDevice> {
        pending
            .iter()
            .map(|(device, label)| PendingDevice {
                device: device.to_string(),
                label: Some(label.to_string()),
                last_seen_ms: 1_700_000_000_000,
            })
            .collect()
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        assert_eq!(read(&path), TerminalAllowlist::default());
        fs::write(&path, "{not json").unwrap();
        assert_eq!(read(&path), TerminalAllowlist::default());
    }

    #[test]
    fn the_list_round_trips_and_the_file_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let list = list_with(&["aaaa", "bbbb"], &[("cccc", "Pixel 8")]);
        write(&path, &list).unwrap();
        assert_eq!(read(&path), list);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn the_cache_re_reads_only_when_the_file_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let mut cache = Cache::new(dir.path());

        // The first check reads (an absent file reads as empty)...
        assert_eq!(cache.changed(), Some(TerminalAllowlist::default()));
        // ...and a second with nothing changed is one metadata call and None.
        assert_eq!(cache.changed(), None);

        // A write is noticed once (the file went from absent to present, so
        // its stamp moved), and not read again until it moves again.
        write(&path, &list_with(&["aaaa"], &[])).unwrap();
        let seen = cache.changed().expect("the changed file is read");
        assert!(seen.devices.contains("aaaa"));
        assert_eq!(cache.changed(), None, "no second read without a new change");
    }

    /// Two writes in one mtime tick — what a coarse filesystem reports, and
    /// what an mtime-only check misses — are both seen. `terminal disallow`
    /// right after `terminal allow` is exactly this pair.
    #[test]
    fn two_writes_in_the_same_mtime_tick_are_both_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let mut cache = Cache::new(dir.path());
        assert_eq!(cache.changed(), Some(TerminalAllowlist::default()));

        write(&path, &list_with(&["aaaa"], &[])).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(cache.changed().expect("the first write is seen").devices.contains("aaaa"));

        // A second write straight away, with a different list of a different
        // length, its mtime forced back to the first's: the mtime alone says
        // nothing changed.
        write(&path, &list_with(&["bbbbbbbb"], &[])).unwrap();
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(before).unwrap();
        drop(file);

        let second = cache.changed().expect("the second write is seen even with the same mtime");
        assert!(second.devices.contains("bbbbbbbb"), "the newest list is the one read");
        assert_eq!(cache.changed(), None);
    }

    /// What the engine sends: `pending`, with `live` naming every device a
    /// client still is (the pending ones are clients too).
    fn devices(pending: &[(&str, &str)], live: &[&str]) -> TerminalDevices {
        let pending = pending_of(pending);
        let live = live.iter().map(|d| d.to_string()).chain(pending.iter().map(|p| p.device.clone())).collect();
        TerminalDevices { pending, live }
    }

    #[test]
    fn merge_keeps_the_approved_devices_as_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        // The owner approved one device in the CLI since the bridge last read.
        write(&path, &list_with(&["aaaa"], &[])).unwrap();

        let sent = devices(&[("cccc", "Pixel 8")], &["aaaa"]);
        let merged = merge(&path, sent.clone());
        assert!(merged.devices.contains("aaaa"), "the device on disk is kept");
        assert_eq!(merged.pending, sent.pending);
        // Merging only reads: the file is unchanged until a write follows.
        assert!(read(&path).pending.is_empty());
    }

    #[test]
    fn an_approved_device_no_client_is_any_more_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&["aaaa", "gone"], &[])).unwrap();

        let writer = Writer::start(path.clone());
        writer.set(devices(&[], &["aaaa"]));
        drop(writer); // joins, so the write has landed
        let list = read(&path);
        assert_eq!(list.devices.iter().map(String::as_str).collect::<Vec<_>>(), ["aaaa"]);
    }

    #[test]
    fn the_writer_merges_and_writes_on_its_own_thread() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        // A device the owner already approved, which the merge must keep.
        write(&path, &list_with(&["aaaa"], &[])).unwrap();

        let writer = Writer::start(path.clone());
        writer.set(devices(&[("cccc", "Pixel 8")], &["aaaa"]));
        drop(writer); // joins, so the write has landed
        let list = read(&path);
        assert!(list.devices.contains("aaaa"), "the approved device on disk is kept");
        assert_eq!(list.pending.len(), 1);
        assert_eq!(list.pending[0].device, "cccc");
    }

    /// A burst of refused devices coalesces: the file holds the last list, not
    /// one write per message.
    #[test]
    fn a_burst_of_refused_devices_leaves_the_last_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let writer = Writer::start(path.clone());
        writer.set(devices(&[("d1", "one")], &[]));
        writer.set(devices(&[("d2", "two")], &[]));
        writer.set(devices(&[("d3", "three")], &[]));
        drop(writer); // joins, so the queue has drained

        let list = read(&path);
        assert_eq!(list.pending.len(), 1, "only the newest list is kept: {:?}", list.pending);
        assert_eq!(list.pending[0].device, "d3");
    }

    /// The lock serializes the read-modify-write: while another holder has it,
    /// `allow` waits rather than racing it.
    #[test]
    fn a_held_lock_makes_allow_wait() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&[], &[("c3d4e5f6", "Pixel 8")])).unwrap();

        // Hold the lock the way the writer thread would, then release it.
        let held = lock_path(&path);
        OpenOptions::new().write(true).create_new(true).open(&held).unwrap();
        let release = held.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            let _ = fs::remove_file(&release);
        });

        let started = Instant::now();
        let message = allow(&path, "c3d4e5f6").expect("the lock is released while we wait");
        assert!(message.contains("c3d4e5f6"));
        assert!(started.elapsed() >= Duration::from_millis(80), "allow did not wait for the lock");
        assert!(!held.exists(), "the lock is released after the write");
    }

    /// A lock file left by a process that died is broken, not waited on: the
    /// CLI must not be stuck for the full wait on a stale lock.
    #[test]
    fn a_stale_lock_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&["aaaa"], &[])).unwrap();

        let held = lock_path(&path);
        let file = OpenOptions::new().write(true).create_new(true).open(&held).unwrap();
        // A holder that died eleven seconds ago.
        file.set_modified(SystemTime::now() - Duration::from_secs(11)).unwrap();
        drop(file);

        let started = Instant::now();
        let message = disallow(&path, "aaaa").expect("the stale lock is broken");
        assert!(message.contains("aaaa"));
        assert!(started.elapsed() < Duration::from_secs(1), "the stale lock was waited on");
        assert!(!held.exists(), "the lock is released after the write");
    }

    #[test]
    fn allow_moves_a_pending_device_and_accepts_an_unambiguous_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&[], &[("c3d4e5f6", "Pixel 8")])).unwrap();

        let message = allow(&path, "c3d4").unwrap();
        assert!(message.contains("c3d4e5f6"));
        let list = read(&path);
        assert!(list.devices.contains("c3d4e5f6"));
        assert!(list.pending.is_empty());
        // Approving it again is not an error.
        assert!(allow(&path, "c3d4e5f6").unwrap().contains("already approved"));
    }

    #[test]
    fn an_ambiguous_prefix_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&[], &[("aaaa1111", "one"), ("aaaa2222", "two")])).unwrap();
        let err = allow(&path, "aaaa").unwrap_err();
        assert!(err.contains("more than one device"), "{err}");
    }

    #[test]
    fn allow_with_no_match_names_how_to_list_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let err = allow(&path, "nope").unwrap_err();
        assert!(err.contains("terminal pending"), "{err}");
    }

    #[test]
    fn disallow_removes_an_approved_device_and_reports_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        write(&path, &list_with(&["aaaa1111", "bbbb2222"], &[])).unwrap();

        let message = disallow(&path, "aaaa").unwrap();
        assert!(message.contains("aaaa1111"));
        assert_eq!(read(&path).devices, ["bbbb2222".to_string()].into_iter().collect());
        assert!(disallow(&path, "cccc").unwrap_err().contains("no approved device"));
    }

    #[test]
    fn pending_lines_name_id_label_and_time() {
        let list = list_with(&[], &[("c3d4e5f6", "Pixel 8")]);
        let lines = pending_lines(&list);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("c3d4e5f6") && lines[0].contains("Pixel 8"), "{}", lines[0]);
    }
}
