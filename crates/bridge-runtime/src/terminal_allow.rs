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
//! The bridge re-reads it, cached by modification time, so a change takes
//! effect without a restart: [`Cache::changed`] is one `metadata` call, and
//! the file is read only when its mtime moved.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::SystemTime;

use bridge_core::{PendingDevice, TerminalAllowlist};

/// The file's name in the bridge home.
pub const ALLOWLIST_FILE: &str = "terminal-allow.json";

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

/// The allowlist file and the modification time last seen. The runtime shares
/// one of these between the command path and its periodic check, so a change
/// is noticed once and read once.
pub struct Cache {
    path: PathBuf,
    seen: Option<SystemTime>,
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
        let mtime = fs::metadata(&self.path).ok().and_then(|m| m.modified().ok());
        if self.checked && mtime == self.seen {
            return None;
        }
        self.checked = true;
        self.seen = mtime;
        Some(read(&self.path))
    }

    /// The engine's refused-device list merged with the approved devices as
    /// they are on disk now (the owner may have approved or withdrawn one in
    /// the CLI while this bridge ran). Nothing is written here: the caller
    /// hands the result to a [`Writer`] thread and to the engine, whose own
    /// copy of the approved devices may otherwise be a file change behind.
    /// Reading on the runtime thread is fine; writing the file is not.
    pub fn merge_pending(&self, pending: &[PendingDevice]) -> TerminalAllowlist {
        let mut list = read(&self.path);
        list.pending = pending.to_vec();
        list
    }
}

/// Writes the allowlist on a thread of its own, so the bridge's single runtime
/// thread never touches the file (the same reason the audit has a writer
/// thread). Fed whole lists in order; each list is complete, so the last write
/// wins.
pub struct Writer {
    tx: Option<Sender<TerminalAllowlist>>,
    thread: Option<JoinHandle<()>>,
}

impl Writer {
    pub fn start(path: PathBuf) -> Writer {
        let (tx, rx) = mpsc::channel::<TerminalAllowlist>();
        let thread = std::thread::Builder::new()
            .name("terminal-allow".into())
            .spawn(move || {
                while let Ok(list) = rx.recv() {
                    if let Err(err) = write(&path, &list) {
                        log::warn!("[Terminal] cannot write the allowlist: {err}");
                    }
                }
            })
            .map_err(|e| log::error!("[Terminal] cannot start the allowlist writer thread: {e}"))
            .ok();
        Writer { tx: Some(tx), thread }
    }

    /// Queue a list to write. Dropping the returned handle later flushes it.
    pub fn write(&self, list: TerminalAllowlist) {
        if let Some(tx) = &self.tx {
            if tx.send(list).is_err() {
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
/// `target` is the id, or an unambiguous prefix of one.
pub fn allow(path: &Path, target: &str) -> Result<String, String> {
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
pub fn disallow(path: &Path, target: &str) -> Result<String, String> {
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
        TerminalAllowlist {
            devices: devices.iter().map(|d| d.to_string()).collect(),
            pending: pending
                .iter()
                .map(|(device, label)| PendingDevice {
                    device: device.to_string(),
                    label: Some(label.to_string()),
                    last_seen_ms: 1_700_000_000_000,
                })
                .collect(),
        }
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
    fn the_cache_re_reads_only_when_the_mtime_moved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let mut cache = Cache::new(dir.path());

        // The first check reads (an absent file reads as empty)...
        assert_eq!(cache.changed(), Some(TerminalAllowlist::default()));
        // ...and a second with nothing changed is one metadata call and None.
        assert_eq!(cache.changed(), None);

        // A write is noticed once (the file went from absent to present, so
        // its mtime moved), and not read again until it moves again.
        write(&path, &list_with(&["aaaa"], &[])).unwrap();
        let seen = cache.changed().expect("the changed file is read");
        assert!(seen.devices.contains("aaaa"));
        assert_eq!(cache.changed(), None, "no second read without a new change");
    }

    #[test]
    fn merge_pending_keeps_the_approved_devices_as_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        // The owner approved one device in the CLI since the bridge last read.
        write(&path, &list_with(&["aaaa"], &[])).unwrap();

        let cache = Cache::new(dir.path());
        let pending = vec![PendingDevice { device: "cccc".into(), label: Some("Pixel 8".into()), last_seen_ms: 5 }];
        let merged = cache.merge_pending(&pending);
        assert!(merged.devices.contains("aaaa"), "the device on disk is kept");
        assert_eq!(merged.pending, pending);
        // Merging only reads: the file is unchanged until a Writer writes it.
        assert!(read(&path).pending.is_empty());
    }

    #[test]
    fn the_writer_writes_on_its_own_thread() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ALLOWLIST_FILE);
        let writer = Writer::start(path.clone());
        writer.write(list_with(&["aaaa"], &[("cccc", "Pixel 8")]));
        drop(writer); // joins, so the write has landed
        let list = read(&path);
        assert!(list.devices.contains("aaaa"));
        assert_eq!(list.pending.len(), 1);
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
