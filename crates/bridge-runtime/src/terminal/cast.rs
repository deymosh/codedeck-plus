//! The recording of one terminal, in asciicast v2 — replayable with
//! `asciinema play`, and readable only by the bridge's user.
//!
//! A recording is a line per thing that happened: the header, then output
//! (`o`), input (`i`) and resizes (`r`), each with the seconds since the
//! recording started. It is written under `<home>/audit/` (`0700`, file
//! `0600` on unix), the same place the terminal audit log lives.
//!
//! What a command printed can be a secret (`cat .env`), and so can what was
//! typed — a password prompt turns the terminal's echo off, and the bytes a
//! person types then are the one thing that must never reach the file. So the
//! caller checks the pty's echo state before recording a chunk and records a
//! byte count instead of the bytes when it is off. When the state cannot be
//! read at all it is treated as off: losing a keystroke to a placeholder is a
//! small loss, writing a password to disk is not.

#[cfg(unix)]
use std::fs::DirBuilder;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// The directory recordings live in, created `0700` like the bridge's own
/// state, so nothing but the bridge's user can list them.
#[cfg(unix)]
const DIR_MODE: u32 = 0o700;
/// A recording's own mode: it may hold anything a command printed.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;

/// One terminal's recording.
pub struct Cast {
    out: BufWriter<File>,
    /// Event times are seconds since this, as asciicast v2 wants.
    started: Instant,
}

impl Cast {
    /// Open `<dir>/<name>` and write the v2 header. The directory is created
    /// if it is not there, and both carry the modes above on unix.
    pub fn open(path: &Path, cols: u16, rows: u16) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            create_dir(dir)?;
        }
        let file = open_file(path)?;
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let mut cast = Self { out: BufWriter::new(file), started: Instant::now() };
        // The header is an object, not an event: the terminal's size as it
        // opened, and when that was.
        writeln!(cast.out, "{{\"version\":2,\"width\":{cols},\"height\":{rows},\"timestamp\":{timestamp}}}")?;
        cast.out.flush()?;
        Ok(cast)
    }

    /// What the terminal wrote, as text. A pty's output is a byte stream that
    /// need not be valid UTF-8 (a program can print half a sequence, or
    /// arbitrary bytes); asciicast carries text, so it is lossily decoded —
    /// the phone redraws from the same bytes it was sent, and the recording
    /// is for a person reading it later.
    pub fn output(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        self.event("o", &text);
    }

    /// What was typed, when the terminal was echoing: the shell's own echo
    /// will also appear in the output, which is how asciicast normally reads.
    pub fn input(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        self.event("i", &text);
    }

    /// What was typed while the terminal had echo off — a password. Only its
    /// size is kept: the bytes are exactly what the terminal was hiding.
    pub fn input_hidden(&mut self, bytes: usize) {
        self.event("i", &format!("[input hidden: {bytes} bytes]"));
    }

    /// What was typed where the platform gives no echo state to read (a
    /// ConPTY): the bytes are not recorded, and neither is whether they were
    /// hidden, because nothing can say.
    pub fn input_count(&mut self, bytes: usize) {
        self.event("i", &format!("[input: {bytes} bytes]"));
    }

    /// The writer's window changed.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.event("r", &format!("{cols}x{rows}"));
    }

    /// Append one `[seconds, code, data]` event. Flushed per event so a
    /// bridge that dies mid-session still leaves everything up to that point
    /// readable.
    fn event(&mut self, code: &str, data: &str) {
        let at = self.started.elapsed().as_secs_f64();
        let line = serde_json::json!([at, code, data]).to_string();
        if writeln!(self.out, "{line}").and_then(|_| self.out.flush()).is_err() {
            // A recording that cannot be written must not take the terminal
            // down with it: the shell keeps running, and the terminal audit
            // log still says what happened.
            log::warn!("[Terminal] could not append to a recording");
        }
    }
}

#[cfg(unix)]
fn create_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match DirBuilder::new().mode(DIR_MODE).create(dir) {
        Ok(()) => Ok(()),
        // Already there: keep whatever the owner set, like the state file.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(not(unix))]
fn create_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::create_dir(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn open_file(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().write(true).create(true).truncate(true).mode(FILE_MODE).open(path)
}

#[cfg(not(unix))]
fn open_file(path: &Path) -> std::io::Result<File> {
    // Windows has no unix modes; the file inherits the directory's ACL.
    OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn writes_a_v2_header_and_one_event_per_thing_that_happened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit").join("term-x.cast");
        let mut cast = Cast::open(&path, 80, 24).unwrap();
        cast.output(b"hello");
        cast.input(b"ls\n");
        cast.input_hidden(8);
        cast.resize(100, 40);

        let lines = lines(&path);
        assert_eq!(lines[0]["version"], 2);
        assert_eq!(lines[0]["width"], 80);
        assert_eq!(lines[0]["height"], 24);
        assert!(lines[0]["timestamp"].as_u64().unwrap() > 0);
        assert_eq!(lines[1], serde_json::json!([lines[1][0], "o", "hello"]));
        assert_eq!(lines[2], serde_json::json!([lines[2][0], "i", "ls\n"]));
        assert_eq!(lines[3], serde_json::json!([lines[3][0], "i", "[input hidden: 8 bytes]"]));
        assert_eq!(lines[4], serde_json::json!([lines[4][0], "r", "100x40"]));
        // Times only move forward, and the first is at or after zero.
        let times: Vec<f64> = lines[1..].iter().map(|l| l[0].as_f64().unwrap()).collect();
        assert!(times.windows(2).all(|w| w[0] <= w[1]));
    }

    #[cfg(unix)]
    #[test]
    fn the_recording_and_its_directory_are_the_bridge_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit").join("term-y.cast");
        Cast::open(&path, 80, 24).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = std::fs::metadata(dir.path().join("audit")).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
    }
}
