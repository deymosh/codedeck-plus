//! Session transcripts on disk: `<dir>/<session id>.jsonl`, one
//! `{"seq":n,"entry":{…}}` per line, keyed by session id only.
//!
//! Seqs come from the engine and are never renumbered; pruning drops old
//! lines and keeps the rest as they were. A crash can tear the last line
//! mid-write, so loading drops every line that does not parse (rewriting the
//! file without it) and recovers the highest seq from what remains.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use bridge_core::ports::Transcripts;
use protocol::common::OutputEntry;
use protocol::events::SyncEntry;
use protocol::ranges::SeqRange;

use crate::state::write_private;

pub struct FileTranscripts {
    dir: PathBuf,
    /// The parsed entries of the most recently read session. Sync reads a
    /// long transcript range by range and uploads chunk by chunk; without
    /// this, each read re-read and re-parsed the whole file.
    cache: RefCell<Option<Cached>>,
    #[cfg(test)]
    parses: std::cell::Cell<usize>,
}

struct Cached {
    session_id: String,
    /// In seq order, so a range is a binary search away.
    entries: Vec<SyncEntry>,
}

/// Session ids come from the engine (uuids), but the file name must never be
/// able to escape the directory whatever they contain.
fn file_name(session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_string() } else { format!("%{:02X}", c as u32) })
        .collect();
    format!("{safe}.jsonl")
}

fn session_of(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".jsonl")?;
    let mut out = String::new();
    let mut chars = stem.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
        } else {
            out.push(c);
        }
    }
    Some(out)
}

fn parse_line(line: &str) -> Option<SyncEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str::<SyncEntry>(line).ok().filter(|e| e.seq >= 1)
}

impl FileTranscripts {
    pub fn open(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            cache: RefCell::new(None),
            #[cfg(test)]
            parses: std::cell::Cell::new(0),
        })
    }

    fn path(&self, session_id: &str) -> PathBuf {
        self.dir.join(file_name(session_id))
    }

    fn lines(&self, session_id: &str) -> Result<Vec<String>, String> {
        match fs::File::open(self.path(session_id)) {
            Ok(f) => BufReader::new(f).lines().collect::<Result<_, _>>().map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// The session's entries, in seq order. This is the one place a transcript
    /// is parsed; `read` goes through the cache first.
    fn parse(&self, session_id: &str) -> Result<Vec<SyncEntry>, String> {
        #[cfg(test)]
        self.parses.set(self.parses.get() + 1);
        let mut entries: Vec<SyncEntry> = self.lines(session_id)?.iter().filter_map(|l| parse_line(l)).collect();
        entries.sort_by_key(|e| e.seq);
        Ok(entries)
    }

    /// Write `lines` back exactly as they were read — a rewrite drops lines,
    /// it never re-serializes the ones it keeps, so a field this build does
    /// not model survives.
    fn write_lines(&self, session_id: &str, lines: &[String]) -> Result<(), String> {
        let mut content = lines.join("\n");
        if !content.is_empty() {
            content.push('\n');
        }
        write_private(&self.path(session_id), content.as_bytes()).map_err(|e| e.to_string())
    }

    fn cached(&self, session_id: &str) -> Result<(), String> {
        let mut cache = self.cache.borrow_mut();
        if cache.as_ref().is_none_or(|c| c.session_id != session_id) {
            let entries = self.parse(session_id)?;
            *cache = Some(Cached { session_id: session_id.to_string(), entries });
        }
        Ok(())
    }

    /// Replace the cache for `session_id`, if it is the one cached.
    fn cache_entries(&self, session_id: &str, entries: Vec<SyncEntry>) {
        if let Some(cache) = self.cache.borrow_mut().as_mut().filter(|c| c.session_id == session_id) {
            cache.entries = entries;
        }
    }

    fn forget(&self, session_id: &str) {
        let mut cache = self.cache.borrow_mut();
        if cache.as_ref().is_some_and(|c| c.session_id == session_id) {
            *cache = None;
        }
    }
}

impl Transcripts for FileTranscripts {
    fn load(&mut self) -> Result<BTreeMap<String, u64>, String> {
        let mut highs = BTreeMap::new();
        for entry in fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let name = match entry {
                Ok(e) => e.file_name().to_string_lossy().into_owned(),
                Err(e) => {
                    log::warn!("[Transcripts] Skipping an unreadable directory entry: {e}");
                    continue;
                }
            };
            let Some(session_id) = session_of(&name) else { continue };
            // One unreadable transcript must not cost every other session its
            // seq high: this file is skipped, the rest are loaded.
            let lines = match self.lines(&session_id) {
                Ok(lines) => lines,
                Err(e) => {
                    log::warn!("[Transcripts] {name}: skipped, cannot read it: {e}");
                    continue;
                }
            };
            let entries: Vec<SyncEntry> = lines.iter().filter_map(|l| parse_line(l)).collect();
            let valid: Vec<String> = lines.iter().filter(|l| parse_line(l).is_some()).cloned().collect();
            let present = lines.iter().filter(|l| !l.trim().is_empty()).count();
            let high = entries.iter().map(|e| e.seq).max().unwrap_or(0);
            if valid.len() < present {
                log::warn!("[Transcripts] {name}: dropping {} torn or invalid line(s)", present - valid.len());
                if let Err(e) = self.write_lines(&session_id, &valid) {
                    log::warn!("[Transcripts] {name}: cannot rewrite it without them: {e}");
                }
                // The file changed under the cache; the next read reparses it.
                self.forget(&session_id);
            }
            highs.insert(session_id, high);
        }
        Ok(highs)
    }

    fn append(&mut self, session_id: &str, seq: u64, entry: &OutputEntry) -> Result<(), String> {
        let record = SyncEntry { seq, entry: entry.clone() };
        let mut line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        line.push('\n');
        let path = self.path(session_id);
        let mut f = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
        crate::state::restrict(&path, 0o600);
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        if let Some(cache) = self.cache.get_mut().as_mut().filter(|c| c.session_id == session_id) {
            // Seqs come from the engine and increase, so this is an append at
            // the end; the search keeps a replayed seq in order anyway.
            let at = cache.entries.partition_point(|e| e.seq < seq);
            cache.entries.insert(at, record);
        }
        Ok(())
    }

    fn read(&self, session_id: &str, (from, to): SeqRange) -> Result<Vec<SyncEntry>, String> {
        self.cached(session_id)?;
        let cache = self.cache.borrow();
        let cached = cache.as_ref().expect("just cached");
        let start = cached.entries.partition_point(|e| e.seq < from);
        let end = cached.entries.partition_point(|e| e.seq <= to);
        Ok(cached.entries[start..end].to_vec())
    }

    fn prune(&mut self, session_id: &str, keep_last: usize) -> Result<(), String> {
        let lines = self.lines(session_id)?;
        let valid: Vec<String> = lines.iter().filter(|l| parse_line(l).is_some()).cloned().collect();
        if valid.len() <= keep_last {
            return Ok(());
        }
        let kept = &valid[valid.len() - keep_last..];
        self.write_lines(session_id, kept)?;
        let entries = kept.iter().filter_map(|l| parse_line(l)).collect();
        self.cache_entries(session_id, entries);
        Ok(())
    }

    fn remove(&mut self, session_id: &str) -> Result<(), String> {
        self.forget(session_id);
        match fs::remove_file(self.path(session_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::EntryBody;

    fn entry(text: &str) -> OutputEntry {
        OutputEntry::new("t", EntryBody::Status { text: text.into() })
    }

    fn seqs(entries: &[SyncEntry]) -> Vec<u64> {
        entries.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn appends_read_back_by_range_and_survive_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        for seq in 1..=5 {
            t.append("s1", seq, &entry("x")).unwrap();
        }
        t.append("s2", 1, &entry("y")).unwrap();
        assert_eq!(seqs(&t.read("s1", (2, 4)).unwrap()), [2, 3, 4]);
        assert!(t.read("nope", (1, 9)).unwrap().is_empty());
        let highs = FileTranscripts::open(dir.path()).unwrap().load().unwrap();
        assert_eq!((highs["s1"], highs["s2"]), (5, 1));
    }

    #[test]
    fn a_torn_last_line_is_dropped_at_load() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        t.append("s", 1, &entry("a")).unwrap();
        t.append("s", 2, &entry("b")).unwrap();
        let path = dir.path().join("s.jsonl");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(br#"{"seq":3,"entry":{"timest"#).unwrap();
        assert_eq!(t.load().unwrap()["s"], 2);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }

    #[test]
    fn prune_keeps_the_last_entries_without_renumbering() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        for seq in 1..=10 {
            t.append("s", seq, &entry("x")).unwrap();
        }
        t.prune("s", 3).unwrap();
        assert_eq!(seqs(&t.read("s", (1, 100)).unwrap()), [8, 9, 10]);
        assert_eq!(t.load().unwrap()["s"], 10);
        t.remove("s").unwrap();
        t.remove("s").unwrap();
        assert!(t.load().unwrap().is_empty());
    }

    #[test]
    fn repeated_reads_of_a_session_parse_the_file_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        for seq in 1..=5 {
            t.append("s1", seq, &entry("x")).unwrap();
        }
        for _ in 0..3 {
            assert_eq!(seqs(&t.read("s1", (2, 4)).unwrap()), [2, 3, 4]);
        }
        assert_eq!(t.parses.get(), 1, "the range reads reused the parsed entries");
        // One other session fits in the cache; going back to the first parses
        // it again rather than growing the cache without bound.
        assert!(t.read("s2", (1, 9)).unwrap().is_empty());
        assert_eq!(t.parses.get(), 2);
        assert_eq!(seqs(&t.read("s1", (5, 5)).unwrap()), [5]);
        assert_eq!(t.parses.get(), 3);
    }

    #[test]
    fn the_cache_follows_appends_prunes_and_removals() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        for seq in 1..=3 {
            t.append("s", seq, &entry("x")).unwrap();
        }
        assert_eq!(seqs(&t.read("s", (1, 100)).unwrap()), [1, 2, 3]);
        t.append("s", 4, &entry("y")).unwrap();
        assert_eq!(t.parses.get(), 1, "an append updates the cached entries");
        assert_eq!(seqs(&t.read("s", (1, 100)).unwrap()), [1, 2, 3, 4]);
        t.prune("s", 2).unwrap();
        assert_eq!(seqs(&t.read("s", (1, 100)).unwrap()), [3, 4]);
        t.remove("s").unwrap();
        assert!(t.read("s", (1, 100)).unwrap().is_empty());
        assert!(!dir.path().join("s.jsonl").exists(), "reading after a removal does not recreate it");
    }

    #[test]
    fn an_unreadable_transcript_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        t.append("good", 1, &entry("a")).unwrap();
        // Something that is named like a transcript but cannot be read as
        // one: a directory, whose read fails on every platform.
        fs::create_dir(dir.path().join("bad.jsonl")).unwrap();
        let highs = t.load().unwrap();
        assert_eq!(highs.get("good"), Some(&1));
        assert!(!highs.contains_key("bad"), "the bad file is skipped, the good one keeps its seq high");
    }

    /// One JSON line for `seq`, with a field this build does not model.
    fn line_with_future_field(seq: u64) -> String {
        let mut value = serde_json::to_value(SyncEntry { seq, entry: entry("x") }).unwrap();
        value.as_object_mut().unwrap().insert("futureField".into(), serde_json::json!(42));
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn a_rewrite_keeps_the_kept_lines_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        // A valid line carrying a field this build does not model, then a
        // torn one; load rewrites the file without the torn line.
        fs::write(&path, format!("{}\n{{\"seq\":2,\"ent", line_with_future_field(1))).unwrap();
        let mut t = FileTranscripts::open(dir.path()).unwrap();
        assert_eq!(t.load().unwrap()["s"], 1);
        assert!(fs::read_to_string(&path).unwrap().contains("futureField"), "the surviving line was not re-serialized");

        // The same through pruning: the kept line keeps its unknown field.
        fs::write(&path, format!("{}\n{}\n{}\n", entry_line(4), entry_line(5), line_with_future_field(6))).unwrap();
        t.prune("s", 2).unwrap();
        let kept = fs::read_to_string(&path).unwrap();
        assert!(kept.contains("futureField"));
        assert_eq!(seqs(&t.read("s", (1, 100)).unwrap()), [5, 6]);
    }

    fn entry_line(seq: u64) -> String {
        serde_json::to_string(&SyncEntry { seq, entry: entry("x") }).unwrap()
    }

    #[test]
    fn session_ids_cannot_escape_the_directory() {
        assert_eq!(file_name("../../etc/passwd"), "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd.jsonl");
        assert_eq!(session_of(&file_name("a/b.c")).as_deref(), Some("a/b.c"));
        assert_eq!(session_of("readme.txt"), None);
    }
}
