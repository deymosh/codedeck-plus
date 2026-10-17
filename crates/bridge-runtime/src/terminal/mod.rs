//! The bridge's terminals: the pty a phone types into, the ring of its
//! output, and the recording of what happened in it.
//!
//! The engine decides everything a terminal does — who may open one, who may
//! type, what order input goes in — and emits effects; this module is the
//! other half, the part that owns a real pty and a real child process. It
//! starts a shell in a pseudo-terminal (a unix pty, ConPTY on Windows, so an
//! interactive program behaves as it does over ssh), reads what the shell
//! writes, keeps the last 256 KiB of it for a phone that comes back, and
//! writes a recording of the whole session under the bridge's home.
//!
//! Three things shape the design:
//!
//! - **The shell runs with a built environment, never the bridge's.** The
//!   bridge's own environment can hold the agents' provider keys — the user
//!   exported them for the agents, and only each driver knows which are
//!   secrets — so the shell is handed only what a shell needs, and nothing
//!   else survives. A terminal is a shell as the bridge's user, which is
//!   strictly more than an agent in its most permissive mode, so nothing of
//!   the bridge's own context is passed on.
//! - **A pty is a thread.** Reading a pty blocks, and the bridge's event
//!   loop must not, so each terminal gets one reader thread that does
//!   nothing but read and hand bytes on. Everything else — the ring, the
//!   engine — stays on the event loop.
//! - **A terminal never slows the phones' links.** The bridge runs relays,
//!   the direct links, the web page and the engine on one thread, so no
//!   terminal may block it or flood it. A terminal's input and its recording
//!   each have a thread of their own, and the bridge only ever hands work
//!   over: input goes through a bounded queue and is dropped when it is
//!   full, and the recording is written by a thread that reads a channel.
//!   Output is paced rather than passed through — the reader thread is
//!   throttled by a small queue, and the coalescer emits at most one frame
//!   per 16 ms — so a shell writing faster than the phones can be sent it
//!   runs at that pace, like a terminal on a slow line, instead of spending
//!   the bridge's thread on it.

mod cast;
mod ring;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver as StdReceiver, Sender as StdSender, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use bridge_core::Input;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use protocol::common::TerminalEndReason;
use tokio::sync::mpsc;

pub use cast::Cast;
use ring::Ring;

/// How often a terminal's output is handed to the engine. The engine
/// publishes it to the phones showing the terminal; the transport coalesces
/// again per link (16 ms on the direct link, 100 ms on relays). This is also
/// the pace a terminal runs at: whatever a shell writes, at most one frame
/// goes out per interval, so a fast writer cannot spend the bridge's thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// The most one frame carries. A shell writing faster than a frame per
/// interval fills the queues behind it and blocks on its own pty, which is
/// what makes it run at this pace rather than the bridge's.
const FLUSH_BYTES: usize = 16 * 1024;
/// How much a reader thread asks for at a time.
const READ_BYTES: usize = 16 * 1024;
/// How many input chunks a terminal's writer thread may be behind before the
/// bridge stops queuing. Input is a keystroke or a paste, so this is a lot:
/// past it the program is not reading what it is sent.
const INPUT_QUEUE: usize = 64;
/// How many chunks of output the reader thread may run ahead of the
/// coalescer before it blocks. A small queue, because this is the
/// backpressure that paces a shell writing faster than the phones can be
/// sent it.
const OUTPUT_QUEUE: usize = 4;

/// What a terminal's recorder thread is told to write. The echo state is
/// read on the bridge's thread (a quick ioctl), so the event already says
/// whether what was typed was a secret.
enum CastEvent {
    /// What the shell wrote.
    Output(Vec<u8>),
    /// What was typed, echoed by the shell itself.
    Input(Vec<u8>),
    /// What was typed with echo off: the size, never the bytes.
    InputHidden(usize),
    /// What was typed where the platform has no echo state to read: the size,
    /// with no claim either way.
    InputCount(usize),
    Resize(u16, u16),
    /// Tests only: a marker the recorder answers once it has written
    /// everything sent before it, so a test can read the file and know it is
    /// complete. Unix only, because only the unix tests spawn a shell.
    #[cfg(all(test, unix))]
    Sync(StdSender<()>),
}

/// One terminal the bridge is running: the pty, where its input and its
/// recording go, and how to end it.
struct Pty {
    /// The control end: resizing, and reading the terminal's termios to see
    /// whether it is echoing.
    master: Box<dyn MasterPty + Send>,
    /// A handle that can signal the child without owning it: the reader
    /// thread owns the child (it is the one that waits for it), and this is
    /// how the event loop ends a terminal the engine decided is over.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The last of the terminal's output, for a phone that comes back.
    ring: Rc<RefCell<Ring>>,
    /// Set once the shell has been reaped. Signalling a reaped pid is not
    /// harmless — the number may belong to another process by then — so
    /// [`Drop`] checks it before killing, and the reader thread sets it the
    /// moment `wait` returns.
    exited: Arc<AtomicBool>,
    /// Input to the shell, written by a thread of its own. Bounded, and
    /// filled without waiting: a program that has stopped reading its input
    /// must not make the bridge wait.
    input: SyncSender<Vec<u8>>,
    /// What the recorder thread writes down.
    recording: StdSender<CastEvent>,
}

impl Drop for Pty {
    fn drop(&mut self) {
        // The last resort: a pty dropped without an explicit close (the
        // bridge going down, a panic unwinding) must not leave its shell
        // running with nothing attached to it.
        if !self.exited.load(Ordering::SeqCst) {
            let _ = self.killer.kill();
        }
    }
}

/// The bridge's terminals, by the id the engine gave each.
///
/// The engine holds the decisions; this holds the ptys, the rings and the
/// recordings, and drops all of them when the bridge stops — a shell is not
/// meant to outlive the bridge that owns it.
pub struct Terminals {
    /// Where the recordings go (`<home>/audit`).
    audit_dir: PathBuf,
    /// The event loop's channel, for what a terminal reports back.
    inputs: mpsc::UnboundedSender<Input>,
    ptys: HashMap<String, Pty>,
}

impl Terminals {
    pub fn new(audit_dir: PathBuf, inputs: mpsc::UnboundedSender<Input>) -> Self {
        Self { audit_dir, inputs, ptys: HashMap::new() }
    }

    /// Where `term`'s recording goes (`<home>/audit/term-<term>.cast`).
    pub fn recording_path(&self, term: &str) -> PathBuf {
        self.audit_dir.join(format!("term-{term}.cast"))
    }

    /// Start a shell for `term` in `cwd`, `cols`×`rows`, and take it under
    /// this bridge's wing. `command` is the owner's configured
    /// `terminal.command` (a fixed program such as `tmux new -A -s phone`);
    /// `None` runs the shell. `Ok` is what runs, as the phone is told it;
    /// `Err` is why it could not be started, for the audit and the phone.
    ///
    /// `cast` is `term`'s already-opened recording, from [`Cast::open`] on
    /// [`recording_path`](Self::recording_path). Opening it is blocking file
    /// work (create the audit directory, open the file, write and flush the
    /// header), so the caller does it — off the bridge's one thread — and
    /// hands the result in: no process exists until its recording does, and a
    /// failure after the shell has started kills it. A shell nothing can
    /// reconstruct afterwards, or one left running with no terminal attached
    /// to it, is worse than an open that fails.
    pub fn spawn(
        &mut self,
        term: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        command: Option<&[String]>,
        cast: Cast,
    ) -> Result<String, String> {
        let (program, args, shell) = shell_command(command);

        let ring = Rc::new(RefCell::new(Ring::new()));

        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.cwd(cwd);
        apply_env(&mut cmd, &shell);

        let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
        let pair = native_pty_system().openpty(size).map_err(|e| format!("no pty: {e}"))?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("could not start {shell}: {e}"))?;
        // The parent's copy of the slave must go now: while it is open the
        // master never sees EOF, so a shell that exits would leave the
        // reader thread waiting on a terminal that is already gone.
        drop(pair.slave);
        let mut killer = child.clone_killer();
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => return Err(kill_first(&mut killer, format!("no reader for the pty: {e}"))),
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(e) => return Err(kill_first(&mut killer, format!("no writer for the pty: {e}"))),
        };

        let exited = Arc::new(AtomicBool::new(false));

        // The recorder thread owns the file, so a slow disk never reaches
        // the bridge's thread. Its queue is unbounded on purpose: output
        // arrives at most a frame per interval (the reader thread is what
        // the queues throttle), and a bounded queue here would only turn a
        // slow disk into a stalled shell.
        let (recording, recording_rx) = std::sync::mpsc::channel::<CastEvent>();
        if let Err(e) = start_recorder(term, cast, recording_rx) {
            return Err(kill_first(&mut killer, e));
        }

        // The writer thread owns the pty's input end: a write to a program
        // that is not reading blocks there, not on the bridge.
        let (input, input_rx) = sync_channel::<Vec<u8>>(INPUT_QUEUE);
        if let Err(e) = start_writer(term, writer, input_rx) {
            return Err(kill_first(&mut killer, e));
        }

        // The reader thread: read the pty, hand the bytes to the recorder
        // and the coalescer, and when the pty closes, wait for the shell and
        // say it is over.
        let (chunks, chunk_rx) = mpsc::channel::<Vec<u8>>(OUTPUT_QUEUE);
        let inputs = self.inputs.clone();
        let recording_in_thread = recording.clone();
        let term_owned = term.to_string();
        let exited_in_thread = Arc::clone(&exited);
        let started = std::thread::Builder::new().name(format!("pty-{term}")).spawn(move || {
            let mut reader = reader;
            let mut child = child;
            let mut buf = vec![0u8; READ_BYTES];
            loop {
                match reader.read(&mut buf) {
                    // EOF: the slave side is gone, so the shell is exiting
                    // (or has been killed). Anything still buffered has
                    // already been handed on.
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        let _ = recording_in_thread.send(CastEvent::Output(data.clone()));
                        // Bounded: past the coalescer's queue this blocks,
                        // which is what stops a shell writing faster than
                        // the phones can be sent it from running away.
                        if chunks.blocking_send(data).is_err() {
                            break;
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            // Reaping the child is what frees its pid: do it before saying it
            // is gone, so nothing can signal that pid again.
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            exited_in_thread.store(true, Ordering::SeqCst);
            let _ = inputs.send(Input::TerminalExited { term: term_owned, code, reason: TerminalEndReason::Exit });
        });
        if let Err(e) = started {
            // The closure (and with it the child handle) was dropped unsent;
            // the cloned killer still knows how to end the shell.
            return Err(kill_first(&mut killer, format!("could not start a reader thread: {e}")));
        }

        // The coalescer: batch the reader's chunks into the engine's frames.
        tokio::task::spawn_local(coalesce(term.to_string(), chunk_rx, Rc::clone(&ring), self.inputs.clone()));

        self.ptys.insert(term.to_string(), Pty { master: pair.master, killer, ring, exited, input, recording });
        Ok(shell)
    }

    /// Type `bytes` into `term`, and record it. The engine has already
    /// checked the sender is the writer and that nothing earlier is missing.
    ///
    /// Nothing here waits. The write is queued for the terminal's writer
    /// thread, and if that queue is full — the program is not reading what
    /// it is sent — the input is dropped rather than held: a keystroke into
    /// a program that has stopped reading must not become the bridge's
    /// problem, and the phone is told its `seq` was applied either way. What
    /// is dropped is not recorded: the recording says what the shell
    /// received.
    pub fn write(&mut self, term: &str, bytes: &[u8]) {
        let Some(pty) = self.ptys.get(term) else { return };
        // The echo state is a quick ioctl on the pty, so it is read here:
        // the event the recorder gets already says whether the bytes are a
        // secret, and the recorder thread does nothing but write.
        let event = input_event(pty, bytes);
        match pty.input.try_send(bytes.to_vec()) {
            Ok(()) => {
                let _ = pty.recording.send(event);
            }
            Err(TrySendError::Full(_)) => {
                log::warn!("[Terminal] {term} is not reading its input: dropped {} bytes", bytes.len());
            }
            // The writer thread is gone: the shell is over, and the engine
            // will hear about it as an exit.
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// The writer's window changed. An ioctl, which does not block, so it
    /// stays on the bridge's thread.
    pub fn resize(&mut self, term: &str, cols: u16, rows: u16) {
        let Some(pty) = self.ptys.get_mut(term) else { return };
        if let Err(e) = pty.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }) {
            log::warn!("[Terminal] could not resize {term}: {e}");
        }
        let _ = pty.recording.send(CastEvent::Resize(cols, rows));
    }

    /// The output to send a client that attached to `term` from byte `from`:
    /// the offset it really starts at (the ring's oldest when `from` is
    /// older than what is kept, so the phone learns to reset its screen) and
    /// the bytes. `None` when there is nothing to send.
    pub fn replay(&self, term: &str, from: u64) -> Option<(u64, Vec<u8>)> {
        let pty = self.ptys.get(term)?;
        let ring = pty.ring.borrow();
        if ring.is_empty() {
            return None;
        }
        let (offset, data) = ring.read_from(from);
        (!data.is_empty()).then_some((offset, data))
    }

    /// Hang up `term`: signal the shell and drop the pty. The engine has
    /// already ended it; this is the shell's part.
    pub fn close(&mut self, term: &str) {
        if let Some(mut pty) = self.ptys.remove(term) {
            let _ = pty.killer.kill();
            pty.exited.store(true, Ordering::SeqCst);
        }
    }

    /// Forget `term` without signalling it: the shell has already exited
    /// (that is why the engine was told), so its pid must not be signalled
    /// again — by the time the reader thread reaped it, the number could
    /// belong to another process.
    pub fn forget(&mut self, term: &str) {
        if let Some(pty) = self.ptys.remove(term) {
            pty.exited.store(true, Ordering::SeqCst);
        }
    }

    /// Tests only: wait until `term`'s recorder has written everything it
    /// was sent before this call, so a test can read the file and see a
    /// whole session. Unix only, because only the unix tests spawn a shell.
    #[cfg(all(test, unix))]
    fn flush_recording(&self, term: &str) {
        let Some(pty) = self.ptys.get(term) else { return };
        let (done, wait) = std::sync::mpsc::channel();
        if pty.recording.send(CastEvent::Sync(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(5));
        }
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        // The bridge is stopping: every shell it started ends with it. This
        // is explicit rather than left to the map being dropped, because the
        // reader threads hold nothing of the map — but a shell whose reader
        // thread is still blocked in `read` would otherwise outlive us.
        for (_, mut pty) in std::mem::take(&mut self.ptys) {
            let _ = pty.killer.kill();
            pty.exited.store(true, Ordering::SeqCst);
        }
    }
}

/// The recording event for one input chunk.
///
/// A shell that turns echo off is asking for something it does not want on
/// screen — a password, a key — and the bytes a person types then are the
/// one thing the recording must never hold. So the pty's echo state is read
/// at the moment of the write: echoing, the bytes are kept; not echoing, or
/// echoing in a way that cannot be read (a ConPTY), only the size is, since
/// losing a keystroke to a byte count is a small loss and writing a password
/// to disk is not.
fn input_event(pty: &Pty, bytes: &[u8]) -> CastEvent {
    match echo_state(pty) {
        Some(true) => CastEvent::Input(bytes.to_vec()),
        Some(false) => CastEvent::InputHidden(bytes.len()),
        None => CastEvent::InputCount(bytes.len()),
    }
}

#[cfg(unix)]
fn echo_state(pty: &Pty) -> Option<bool> {
    pty.master.get_termios().map(|t| t.local_flags.contains(nix::sys::termios::LocalFlags::ECHO))
}

/// A ConPTY exposes no echo state, so nothing can say whether what was typed
/// was echoed or hidden.
#[cfg(not(unix))]
fn echo_state(_pty: &Pty) -> Option<bool> {
    None
}

/// The thread that owns a terminal's input end.
fn start_writer(term: &str, mut writer: Box<dyn Write + Send>, input: StdReceiver<Vec<u8>>) -> Result<(), String> {
    let name = format!("pty-in-{term}");
    let term = term.to_string();
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            while let Ok(chunk) = input.recv() {
                if let Err(e) = writer.write_all(&chunk).and_then(|()| writer.flush()) {
                    // A write that fails means the pty is gone; the reader
                    // thread reports the shell's exit, so there is nothing
                    // to do here but stop.
                    log::warn!("[Terminal] could not write to {term}: {e}");
                    return;
                }
            }
        })
        .map(|_| ())
        .map_err(|e| format!("could not start a writer thread: {e}"))
}

/// The thread that owns a terminal's recording.
fn start_recorder(term: &str, cast: Cast, events: StdReceiver<CastEvent>) -> Result<(), String> {
    let name = format!("pty-cast-{term}");
    std::thread::Builder::new()
        .name(name)
        .spawn(move || {
            let mut cast = cast;
            while let Ok(event) = events.recv() {
                match event {
                    CastEvent::Output(bytes) => cast.output(&bytes),
                    CastEvent::Input(bytes) => cast.input(&bytes),
                    CastEvent::InputHidden(bytes) => cast.input_hidden(bytes),
                    CastEvent::InputCount(bytes) => cast.input_count(bytes),
                    CastEvent::Resize(cols, rows) => cast.resize(cols, rows),
                    #[cfg(all(test, unix))]
                    CastEvent::Sync(done) => {
                        let _ = done.send(());
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|e| format!("could not start a recorder thread: {e}"))
}

/// Batch what a reader thread hands over into engine frames: at most one
/// [`Input::TerminalOutput`] per [`FLUSH_INTERVAL`], and never more than
/// [`FLUSH_BYTES`] in it. What is beyond waits for the next interval, in
/// order and contiguous, so a shell that writes faster than the phones can
/// be sent it runs at this pace — its output backs up through the bounded
/// queue to the reader thread, and the reader thread's blocking send fills
/// the pty, which blocks the shell's own write, as a terminal on a slow line
/// does.
///
/// The bytes go on the wire base64 (the engine's input carries them that
/// way, and the phone decodes them). Chunks are contiguous in the terminal's
/// stream — one reader thread writes them in the order the shell produced
/// them — so a frame is one range and its offset is the first chunk's.
async fn coalesce(
    term: String,
    mut chunks: mpsc::Receiver<Vec<u8>>,
    ring: Rc<RefCell<Ring>>,
    inputs: mpsc::UnboundedSender<Input>,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut start: u64 = 0;
    loop {
        // Gather for one interval, but no more than a frame's worth: past
        // that the channel is left alone and the shell waits.
        let deadline = tokio::time::Instant::now() + FLUSH_INTERVAL;
        while pending.len() < FLUSH_BYTES {
            match tokio::time::timeout_at(deadline, chunks.recv()).await {
                Ok(Some(data)) => {
                    let offset = ring.borrow_mut().push(&data);
                    if pending.is_empty() {
                        start = offset;
                    }
                    pending.extend_from_slice(&data);
                }
                Ok(None) => {
                    // The reader thread is gone: the terminal is over. Send
                    // what is left, in order, a frame at a time.
                    while !pending.is_empty() {
                        let take = pending.len().min(FLUSH_BYTES);
                        emit(&term, start, &pending[..take], &inputs);
                        pending.drain(..take);
                        start += take as u64;
                    }
                    return;
                }
                Err(_) => break,
            }
        }
        if pending.len() >= FLUSH_BYTES {
            // A frame is in hand: hold it until the interval is up, so the
            // shell is paced by the interval rather than by how fast the
            // bridge's thread can run.
            tokio::time::sleep_until(deadline).await;
        }
        if !pending.is_empty() {
            let take = pending.len().min(FLUSH_BYTES);
            emit(&term, start, &pending[..take], &inputs);
            pending.drain(..take);
            start += take as u64;
        }
    }
}

fn emit(term: &str, offset: u64, data: &[u8], inputs: &mpsc::UnboundedSender<Input>) {
    let _ = inputs.send(Input::TerminalOutput { term: term.to_string(), offset, data: STANDARD.encode(data) });
}

/// What to run in a terminal: the owner's configured command, else the
/// shell. `Ok` is (program, arguments, what the phone is told is running).
fn shell_command(command: Option<&[String]>) -> (String, Vec<String>, String) {
    if let Some(parts) = command {
        if let Some((program, args)) = parts.split_first() {
            // The phone shows the whole line: `tmux new -A -s phone` says
            // more about what is running than `tmux` does.
            return (program.clone(), args.to_vec(), parts.join(" "));
        }
    }
    let shell = default_shell();
    (shell.clone(), Vec::new(), shell)
}

/// The shell to run when the owner has configured none. On unix: `$SHELL`,
/// else the account's login shell (unless it is `nologin` or `false`, a
/// service account's), else `/bin/sh` — a service or a container often runs
/// with no `$SHELL`, and `/bin/sh` may be a shell with no line editing or
/// completion (Debian's dash) while the account's is bash. On Windows
/// `pwsh`, else `powershell`, else `cmd` — in that order, the modern
/// PowerShell first, the one every Windows has last.
#[cfg(unix)]
fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let user = nix::unistd::User::from_uid(nix::unistd::getuid()).ok().flatten()?;
            let shell = user.shell.to_str()?.to_string();
            // A service account's "shell" refuses logins; /bin/sh is better.
            let refuses = ["nologin", "false"].contains(&shell.rsplit('/').next().unwrap_or_default());
            (!shell.is_empty() && !refuses).then_some(shell)
        })
        .unwrap_or_else(|| "/bin/sh".to_string())
}

#[cfg(windows)]
fn default_shell() -> String {
    for name in ["pwsh", "powershell", "cmd"] {
        if on_path(name) {
            return name.to_string();
        }
    }
    std::env::var("ComSpec").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "cmd".to_string())
}

/// Whether `name` is a program on `PATH` (on Windows, trying each extension
/// `PATHEXT` names), so the first shell that is actually installed is the
/// one chosen.
#[cfg(windows)]
fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    std::env::split_paths(&path).any(|dir| {
        let base = dir.join(name);
        base.is_file() || exts.split(';').filter(|e| !e.is_empty()).any(|e| dir.join(format!("{name}{e}")).is_file())
    })
}

/// Signal a shell that was started and then could not be taken over, and
/// hand `note` back as the reason. A shell whose pty this bridge is not
/// going to hold must not be left running with nothing attached to it.
fn kill_first(killer: &mut Box<dyn ChildKiller + Send + Sync>, note: String) -> String {
    let _ = killer.kill();
    note
}

/// Hand the shell a built environment: `env_clear` first, because a
/// [`CommandBuilder`] seeds itself with the bridge's own environment (the
/// one that may hold the agents' provider keys), and then only what a shell
/// needs to work.
fn apply_env(cmd: &mut CommandBuilder, shell: &str) {
    cmd.env_clear();
    for (name, value) in built_env(shell) {
        cmd.env(name, value);
    }
}

/// The variables the shell is given, and no others.
#[cfg(unix)]
fn built_env(shell: &str) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    for name in ["PATH", "HOME", "USER", "LANG"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                env.push((name, value));
            }
        }
    }
    if !env.iter().any(|(name, _)| *name == "PATH") {
        env.push(("PATH", "/usr/local/bin:/usr/bin:/bin".to_string()));
    }
    env.push(("SHELL", shell.to_string()));
    // A terminal, so programs colour and page rather than think they are
    // writing to a file.
    env.push(("TERM", "xterm-256color".to_string()));
    env
}

/// On Windows a shell needs the system variables it reads to find programs
/// and its own directories; the same rule applies — only these.
#[cfg(windows)]
fn built_env(_shell: &str) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    for name in ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                env.push((name, value));
            }
        }
    }
    env
}

#[cfg(test)]
mod tests {
    // The environment lock below is deliberately held for a whole test,
    // awaits and all: it is what serializes the tests that spawn a shell
    // against the one that puts a fake secret in the process environment.
    // Each test runs on its own single-threaded runtime, so nothing on that
    // thread can want the lock while it is held.
    #![allow(clippy::await_holding_lock)]

    use super::*;

    /// Tests here read and write the process environment (a pty inherits
    /// none of it, which is what is being checked), and `std::env` is not
    /// safe to mutate while another thread reads it — so they take turns.
    #[cfg(unix)]
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(unix)]
    fn rig() -> (Terminals, mpsc::UnboundedReceiver<Input>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let (inputs, rx) = mpsc::unbounded_channel();
        (Terminals::new(dir.path().join("audit"), inputs), rx, dir)
    }

    /// [`Terminals::spawn`] with the recording opened first, the way the
    /// runtime does it (there from a blocking task). A test is not on the
    /// bridge's thread, so it can open the file here.
    #[cfg(unix)]
    fn spawn(
        terms: &mut Terminals,
        term: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        command: Option<&[String]>,
    ) -> Result<String, String> {
        let cast =
            Cast::open(&terms.recording_path(term), cols, rows).map_err(|e| format!("could not open the recording: {e}"))?;
        terms.spawn(term, cwd, cols, rows, command, cast)
    }

    /// The next `Input::TerminalOutput` from a terminal, or a panic if none
    /// arrives in time.
    #[cfg(unix)]
    async fn next_output(rx: &mut mpsc::UnboundedReceiver<Input>, what: &str) -> (u64, Vec<u8>) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, rx.recv()).await {
                Ok(Some(Input::TerminalOutput { offset, data, .. })) => {
                    return (offset, STANDARD.decode(data).expect("base64 from the bridge"));
                }
                Ok(Some(_)) => {}
                Ok(None) => panic!("the bridge stopped before it sent {what}"),
                Err(_) => panic!("timed out waiting for {what}"),
            }
        }
    }

    /// Read from `rx` until the output so far contains `needle`: the frames
    /// seen (offset and length each), and everything they carried.
    #[cfg(unix)]
    async fn collect_until(rx: &mut mpsc::UnboundedReceiver<Input>, needle: &str) -> (Vec<(u64, usize)>, Vec<u8>) {
        let mut frames: Vec<(u64, usize)> = Vec::new();
        let mut seen = Vec::new();
        loop {
            let (offset, data) = next_output(rx, needle).await;
            frames.push((offset, data.len()));
            seen.extend_from_slice(&data);
            if String::from_utf8_lossy(&seen).contains(needle) {
                return (frames, seen);
            }
        }
    }

    /// Frames are contiguous — nothing is ever dropped between the shell and
    /// the phone, so each one starts where the last ended.
    #[cfg(unix)]
    fn assert_contiguous(frames: &[(u64, usize)]) {
        let mut expected = None;
        for (offset, len) in frames {
            if let Some(expected) = expected {
                assert_eq!(*offset, expected, "a frame started where it should not: {frames:?}");
            }
            expected = Some(*offset + *len as u64);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_runs_and_its_output_frames_are_contiguous_with_growing_offsets() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, mut rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                let shell = spawn(&mut terms, "t1", &cwd, 80, 24, None).expect("a shell");
                assert!(shell.ends_with("sh"), "the shell is {shell}");

                terms.write("t1", b"echo one\n");
                let (mut frames, _) = collect_until(&mut rx, "one").await;

                // A second command, well past the flush interval, so its
                // output is a frame of its own.
                tokio::time::sleep(Duration::from_millis(80)).await;
                terms.write("t1", b"echo two\n");
                frames.extend(collect_until(&mut rx, "two").await.0);

                assert!(frames.len() >= 2, "two commands should not be one frame: {frames:?}");
                assert_contiguous(&frames);
                assert!(frames[0].0 < frames[1].0);

                terms.close("t1");
            })
            .await;
    }

    /// The invariant the runtime relies on: by the time `spawn` returns (and
    /// so by the time any shell could write anything), the recording exists
    /// with its header already flushed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_spawned_terminal_has_its_recording_with_a_header_before_any_output() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, _rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                spawn(&mut terms, "t7", &cwd, 80, 24, None).expect("a shell");

                let cast = std::fs::read_to_string(dir.path().join("audit").join("term-t7.cast"))
                    .expect("the recording exists as soon as the shell does");
                let header: serde_json::Value =
                    serde_json::from_str(cast.lines().next().expect("a header line")).expect("a JSON header");
                assert_eq!(header["version"], 2);
                assert_eq!(header["width"], 80);
                assert_eq!(header["height"], 24);

                terms.close("t7");
            })
            .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_shell_gets_a_built_environment_and_nothing_of_the_bridges() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, mut rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                // A variable only the bridge's own environment holds — a
                // provider key the user exported for the agents. It must not
                // reach a shell that runs as the bridge's user.
                std::env::set_var("CODEDECK_TEST_SECRET", "must-not-leak");
                spawn(&mut terms, "t2", &cwd, 80, 24, Some(&["env".to_string()])).expect("env runs");
                let (_, out) = collect_until(&mut rx, "PATH=").await;
                std::env::remove_var("CODEDECK_TEST_SECRET");

                let text = String::from_utf8_lossy(&out).into_owned();
                assert!(!text.contains("CODEDECK_TEST_SECRET"), "the bridge's environment leaked:\n{text}");
                assert!(text.contains("TERM=xterm-256color"), "no TERM:\n{text}");
                assert!(text.contains("PATH="), "no PATH:\n{text}");
                let names: Vec<&str> =
                    text.lines().filter_map(|line| line.split_once('=').map(|(name, _)| name)).collect();
                for name in names {
                    assert!(
                        ["PATH", "HOME", "USER", "LANG", "SHELL", "TERM"].contains(&name),
                        "the shell was given a variable it should not have: {name}"
                    );
                }
                terms.close("t2");
            })
            .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn input_typed_with_echo_off_is_recorded_as_its_size_not_its_bytes() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, mut rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                spawn(&mut terms, "t3", &cwd, 80, 24, None).expect("a shell");

                // The shell turns its own echo off, the way a password prompt
                // does, and says so once it has. The marker is split in the
                // command (`RE""ADY`), so the shell's echo of the command line
                // itself — which comes before `stty` has run — does not count
                // as the shell being ready.
                terms.write("t3", b"stty -echo; echo RE\"\"ADY\n");
                collect_until(&mut rx, "READY").await;
                terms.write("t3", b"hunter2\n");
                terms.flush_recording("t3");

                let cast = std::fs::read_to_string(dir.path().join("audit").join("term-t3.cast")).expect("a recording");
                assert!(cast.contains("[input hidden: 8 bytes]"), "echo-off input was not hidden:\n{cast}");
                assert!(!cast.contains("hunter2"), "echo-off input was recorded:\n{cast}");
                // What was typed while the shell was still echoing is kept.
                assert!(cast.contains("stty -echo"), "echoing input was not recorded:\n{cast}");

                terms.close("t3");
            })
            .await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_that_exits_reports_its_code_and_its_recording_is_complete() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, mut rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                spawn(&mut terms, "t4", &cwd, 80, 24, None).expect("a shell");
                terms.write("t4", b"echo bye; exit 7\n");

                let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                loop {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    match tokio::time::timeout(left, rx.recv()).await {
                        Ok(Some(Input::TerminalExited { term, code, reason })) => {
                            assert_eq!(term, "t4");
                            assert_eq!(reason, TerminalEndReason::Exit);
                            assert_eq!(code, Some(7));
                            break;
                        }
                        Ok(Some(_)) => {}
                        Ok(None) | Err(_) => panic!("the shell's exit was never reported"),
                    }
                }
                terms.forget("t4");
                // The shell's last words reach the recorder's thread through
                // its own queue, so wait for that thread to catch up.
                terms.flush_recording("t4");

                let cast = std::fs::read_to_string(dir.path().join("audit").join("term-t4.cast")).expect("a recording");
                assert!(cast.contains("bye"), "the recording missed the output:\n{cast}");
            })
            .await;
    }

    /// A program that has stopped reading its input must not make the
    /// bridge wait: the write is queued and the call returns.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_write_does_not_wait_for_a_program_that_is_not_reading() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, _rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                spawn(&mut terms, "t5", &cwd, 80, 24, Some(&["sleep".to_string(), "30".to_string()])).expect("sleep runs");
                // Far more than any pty's input buffer: written to the pty
                // directly, this would block once the buffer filled.
                let big = vec![b'x'; 1024 * 1024];
                let started = std::time::Instant::now();
                terms.write("t5", &big);
                let took = started.elapsed();
                assert!(took < Duration::from_millis(200), "the write waited {took:?} on a program that is not reading");
                terms.close("t5");
            })
            .await;
    }

    /// Output is paced: a shell that writes as fast as it can is served at
    /// one frame per interval, so it costs the bridge's thread a bounded
    /// amount however much it writes.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_that_writes_faster_than_it_is_read_is_paced_by_the_interval() {
        let _guard = env_lock();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let (mut terms, mut rx, dir) = rig();
                let cwd = dir.path().to_str().expect("a utf-8 temp path").to_string();
                spawn(&mut terms, "t6", &cwd, 80, 24, None).expect("a shell");

                let started = tokio::time::Instant::now();
                terms.write("t6", b"yes | head -c 1000000\n");
                let mut frames: Vec<(u64, usize)> = Vec::new();
                let mut received = 0usize;
                let deadline = started + Duration::from_secs(60);
                while received < 1_000_000 {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    match tokio::time::timeout(left, rx.recv()).await {
                        Ok(Some(Input::TerminalOutput { offset, data, .. })) => {
                            let len = STANDARD.decode(&data).expect("base64 from the bridge").len();
                            frames.push((offset, len));
                            received += len;
                        }
                        Ok(Some(_)) => {}
                        Ok(None) | Err(_) => panic!("timed out after {received} bytes"),
                    }
                }
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                assert_contiguous(&frames);
                // One frame per interval is the cap: any more would mean the
                // shell was served faster than the terminal's own pace.
                assert!(
                    frames.len() as f64 <= elapsed_ms / 16.0 + 2.0,
                    "{} frames in {elapsed_ms:.0} ms — the cap is one per 16 ms",
                    frames.len()
                );
                terms.close("t6");
            })
            .await;
    }

    /// `terminal.command` is a hook for the owner's own program; the engine
    /// passes `None` today, so the only thing to check here is that the line
    /// is taken apart as it is written.
    #[test]
    fn a_configured_command_runs_its_program_with_its_arguments() {
        let command = vec!["tmux".to_string(), "new".to_string(), "-A".to_string(), "-s".to_string(), "phone".to_string()];
        let (program, args, shown) = shell_command(Some(&command));
        assert_eq!(program, "tmux");
        assert_eq!(args, ["new", "-A", "-s", "phone"]);
        assert_eq!(shown, "tmux new -A -s phone");
        // An empty command falls back to the shell rather than running
        // nothing.
        let (program, args, shown) = shell_command(Some(&[]));
        assert!(!program.is_empty());
        assert!(args.is_empty());
        assert_eq!(program, shown);
    }

    /// A terminal the engine never told us about is not a panic: a message
    /// can arrive after the terminal it names is gone.
    #[test]
    fn acting_on_a_terminal_that_is_not_there_does_nothing() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let (inputs, _rx) = mpsc::unbounded_channel();
        let mut terms = Terminals::new(dir.path().to_path_buf(), inputs);
        terms.write("gone", b"x");
        terms.resize("gone", 100, 40);
        terms.close("gone");
        terms.forget("gone");
        assert!(terms.replay("gone", 0).is_none());
    }
}
