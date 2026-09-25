//! Session transcripts on disk: `<dir>/<session id>.jsonl`, one
//! `{"seq":n,"entry":{…}}` per line, keyed by session id only.
//!
//! Seqs come from the engine and are never renumbered; pruning drops old
//! lines and keeps the rest as they were. A crash can tear the last line
//! mid-write, so loading drops every line that does not parse (rewriting the
//! file without it) and recovers the highest seq from what remains.

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
        Ok(Self { dir: dir.to_path_buf() })
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

    fn rewrite(&self, session_id: &str, lines: &[String]) -> Result<(), String> {
        let mut content = lines.join("\n");
        if !content.is_empty() {
            content.push('\n');
        }
        write_private(&self.path(session_id), content.as_bytes()).map_err(|e| e.to_string())
    }
}

impl Transcripts for FileTranscripts {
    fn load(&mut self) -> Result<BTreeMap<String, u64>, String> {
        let mut highs = BTreeMap::new();
        for entry in fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let name = entry.map_err(|e| e.to_string())?.file_name().to_string_lossy().into_owned();
            let Some(session_id) = session_of(&name) else { continue };
            let lines = self.lines(&session_id)?;
            let valid: Vec<String> = lines.iter().filter(|l| parse_line(l).is_some()).cloned().collect();
            let dropped = lines.iter().filter(|l| !l.trim().is_empty()).count() - valid.len();
            if dropped > 0 {
                log::warn!("[Transcripts] {name}: dropping {dropped} torn or invalid line(s)");
                self.rewrite(&session_id, &valid)?;
            }
            let high = valid.iter().filter_map(|l| parse_line(l)).map(|e| e.seq).max().unwrap_or(0);
            highs.insert(session_id, high);
        }
        Ok(highs)
    }

    fn append(&mut self, session_id: &str, seq: u64, entry: &OutputEntry) -> Result<(), String> {
        let mut line = serde_json::to_string(&SyncEntry { seq, entry: entry.clone() }).map_err(|e| e.to_string())?;
        line.push('\n');
        let path = self.path(session_id);
        let mut f = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
        crate::state::restrict(&path, 0o600);
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())
    }

    fn read(&self, session_id: &str, (from, to): SeqRange) -> Result<Vec<SyncEntry>, String> {
        Ok(self.lines(session_id)?.iter().filter_map(|l| parse_line(l)).filter(|e| e.seq >= from && e.seq <= to).collect())
    }

    fn prune(&mut self, session_id: &str, keep_last: usize) -> Result<(), String> {
        let valid: Vec<String> = self.lines(session_id)?.into_iter().filter(|l| parse_line(l).is_some()).collect();
        if valid.len() <= keep_last {
            return Ok(());
        }
        self.rewrite(session_id, &valid[valid.len() - keep_last..])
    }

    fn remove(&mut self, session_id: &str) -> Result<(), String> {
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
    fn session_ids_cannot_escape_the_directory() {
        assert_eq!(file_name("../../etc/passwd"), "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd.jsonl");
        assert_eq!(session_of(&file_name("a/b.c")).as_deref(), Some("a/b.c"));
        assert_eq!(session_of("readme.txt"), None);
    }
}
