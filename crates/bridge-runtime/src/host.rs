//! The agent host process: `node <agent-host>/main.js`, speaking the driver
//! protocol on stdin/stdout. Its stderr goes to the bridge log, prefixed.
//!
//! When it exits it is started again, after a backoff that grows while it
//! keeps dying quickly (1 s doubling to 30 s, reset once a run has lasted a
//! minute). The engine hears [`Input::HostDown`] and [`Input::HostUp`] and
//! restarts sessions on its own.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use agent_protocol::codec::MAX_LINE_BYTES;
use agent_protocol::{decode_host_frame, encode_frame, BridgeFrame};
use bridge_core::Input;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// How long a stopping host gets to exit on its own before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct HostCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl HostCommand {
    pub fn node(node: &str, bundle: PathBuf, env: BTreeMap<String, String>) -> Self {
        Self { program: node.to_string(), args: vec![bundle.to_string_lossy().into_owned()], env }
    }
}

enum Cmd {
    Frame(String),
    Stop(oneshot::Sender<()>),
}

/// Talks to the supervisor task.
#[derive(Clone)]
pub struct HostHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl HostHandle {
    /// Write a frame to the running host (dropped while it is down — the
    /// engine does not send then).
    pub fn send(&self, frame: &BridgeFrame) {
        let _ = self.tx.send(Cmd::Frame(encode_frame(frame)));
    }

    /// Close the host's stdin (its signal to end every session and exit),
    /// wait for it, and stop supervising.
    pub async fn stop(&self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Cmd::Stop(done)).is_ok() {
            let _ = wait.await;
        }
    }
}

pub fn supervise(command: HostCommand, inputs: mpsc::UnboundedSender<Input>) -> HostHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::task::spawn_local(run(command, inputs, rx));
    HostHandle { tx }
}

async fn run(command: HostCommand, inputs: mpsc::UnboundedSender<Input>, mut rx: mpsc::UnboundedReceiver<Cmd>) {
    let mut backoff = BACKOFF_MIN;
    loop {
        let started = Instant::now();
        let mut child = match spawn(&command) {
            Ok(child) => child,
            Err(err) => {
                log::error!("[Host] Could not start the agent host ({} {:?}): {err}", command.program, command.args);
                if wait_or_stop(&mut rx, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        log::info!("[Host] Agent host started (pid {:?})", child.id());
        let _ = inputs.send(Input::HostUp);
        let (reason, stopping) = serve(&mut child, &inputs, &mut rx).await;
        if let Some(done) = stopping {
            let _ = done.send(());
            return;
        }
        log::warn!("[Host] Agent host exited: {reason}");
        let _ = inputs.send(Input::HostDown { reason });
        if started.elapsed() >= HEALTHY_RUN {
            backoff = BACKOFF_MIN;
        }
        if wait_or_stop(&mut rx, backoff).await {
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

fn spawn(command: &HostCommand) -> std::io::Result<Child> {
    Command::new(&command.program)
        .args(&command.args)
        .envs(&command.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// Sleep `delay`, dropping frames meanwhile; true when asked to stop.
async fn wait_or_stop(rx: &mut mpsc::UnboundedReceiver<Cmd>, delay: Duration) -> bool {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return false,
            cmd = rx.recv() => match cmd {
                None => return true,
                Some(Cmd::Stop(done)) => {
                    let _ = done.send(());
                    return true;
                }
                Some(Cmd::Frame(_)) => log::debug!("[Host] Frame dropped: the agent host is down"),
            }
        }
    }
}

/// Pump one host process until it exits (why) or a stop is asked (the
/// requester, after the host is gone).
async fn serve(
    child: &mut Child,
    inputs: &mpsc::UnboundedSender<Input>,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
) -> (String, Option<oneshot::Sender<()>>) {
    let mut stdin = child.stdin.take();
    let mut stdout = BoundedLines::new(child.stdout.take().expect("piped"), MAX_LINE_BYTES);
    let mut stderr = BoundedLines::new(child.stderr.take().expect("piped"), MAX_LOG_LINE_BYTES);
    let mut stderr_open = true;
    loop {
        tokio::select! {
            line = stdout.next_line() => match line {
                Ok(Some(Ok(line))) => match decode_host_frame(&line) {
                    Ok(frame) => {
                        let _ = inputs.send(Input::HostFrame(frame));
                    }
                    Err(err) => log::warn!("[Host] Undecodable frame from the agent host ({err}) — dropped"),
                },
                Ok(Some(Err(len))) => log::warn!(
                    "[Host] A {len}-byte frame from the agent host exceeds the {MAX_LINE_BYTES}-byte limit — dropped"
                ),
                Ok(None) | Err(_) => return (exit_reason(child).await, None),
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(Ok(line))) => log::info!("[agent-host] {line}"),
                Ok(Some(Err(len))) => log::info!("[agent-host] <{len}-byte line elided>"),
                _ => stderr_open = false,
            },
            cmd = rx.recv() => match cmd {
                Some(Cmd::Frame(line)) => {
                    let Some(pipe) = stdin.as_mut() else { continue };
                    let write = async {
                        pipe.write_all(line.as_bytes()).await?;
                        pipe.write_all(b"\n").await?;
                        pipe.flush().await
                    };
                    if let Err(err) = write.await {
                        log::warn!("[Host] Writing to the agent host failed: {err}");
                    }
                }
                Some(Cmd::Stop(done)) => {
                    drop(stdin.take());
                    if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_err() {
                        log::warn!("[Host] The agent host did not exit in {STOP_GRACE:?} — killing it");
                        let _ = child.kill().await;
                    }
                    return ("stopped".into(), Some(done));
                }
                None => {
                    let _ = child.kill().await;
                    return ("stopped".into(), None);
                }
            },
        }
    }
}

/// Longest stderr line logged whole.
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;

/// `\n`-separated lines with a length cap enforced WHILE reading: a longer
/// line is consumed and discarded chunk by chunk, never held in memory whole
/// (`BufReader::lines` would buffer all of it before any check could run, so
/// a runaway host could exhaust the bridge's memory with one line).
///
/// Cancel-safe, like `Lines::next_line`: all progress lives in `self`, and
/// input is consumed only in the same poll that records it.
struct BoundedLines<R> {
    reader: BufReader<R>,
    max: usize,
    line: Vec<u8>,
    /// Bytes of an overlong line dropped so far; 0 while not discarding.
    discarded: usize,
}

impl<R: tokio::io::AsyncRead + Unpin> BoundedLines<R> {
    fn new(inner: R, max: usize) -> Self {
        Self { reader: BufReader::new(inner), max, line: Vec::new(), discarded: 0 }
    }

    /// `Some(Ok(line))` (lossy UTF-8, without the `\n`), `Some(Err(len))`
    /// for a line over the cap, or `None` at the end of the stream.
    async fn next_line(&mut self) -> std::io::Result<Option<Result<String, usize>>> {
        loop {
            let available = self.reader.fill_buf().await?;
            if available.is_empty() {
                // A final line without its `\n` still counts.
                return Ok(if self.discarded > 0 || !self.line.is_empty() { Some(self.take()) } else { None });
            }
            let (chunk, used, ended) = match available.iter().position(|&b| b == b'\n') {
                Some(i) => (&available[..i], i + 1, true),
                None => (available, available.len(), false),
            };
            if self.discarded > 0 || self.line.len() + chunk.len() > self.max {
                self.discarded += self.line.len() + chunk.len();
                self.line = Vec::new();
            } else {
                self.line.extend_from_slice(chunk);
            }
            self.reader.consume(used);
            if ended {
                return Ok(Some(self.take()));
            }
        }
    }

    fn take(&mut self) -> Result<String, usize> {
        if self.discarded > 0 {
            return Err(std::mem::take(&mut self.discarded));
        }
        let line = std::mem::take(&mut self.line);
        let line = line.strip_suffix(b"\r").unwrap_or(&line);
        Ok(String::from_utf8_lossy(line).into_owned())
    }
}

async fn exit_reason(child: &mut Child) -> String {
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status.to_string(),
        Ok(Err(err)) => err.to_string(),
        Err(_) => {
            let _ = child.kill().await;
            "its output closed; killed".into()
        }
    }
}

#[cfg(test)]
mod bounded_lines_tests {
    use super::*;

    async fn lines(input: &'static [u8], max: usize) -> Vec<Result<String, usize>> {
        // A 3-byte pipe: every line straddles several reads.
        let (mut tx, rx) = tokio::io::duplex(3);
        tokio::spawn(async move {
            tx.write_all(input).await.unwrap();
        });
        let mut reader = BoundedLines::new(rx, max);
        let mut out = Vec::new();
        while let Some(line) = reader.next_line().await.unwrap() {
            out.push(line);
        }
        out
    }

    #[tokio::test]
    async fn lines_within_the_cap_come_through_whole() {
        assert_eq!(
            lines(b"one\ntwo\r\n\nlast", 8).await,
            vec![Ok("one".into()), Ok("two".into()), Ok(String::new()), Ok("last".into())]
        );
    }

    #[tokio::test]
    async fn an_overlong_line_is_reported_by_length_and_the_next_one_survives() {
        assert_eq!(
            lines(b"short\nthis line is too long\nok\ntoo long again", 8).await,
            vec![Ok("short".into()), Err(21), Ok("ok".into()), Err(14)]
        );
    }

    #[tokio::test]
    async fn invalid_utf8_is_kept_lossily_instead_of_ending_the_stream() {
        assert_eq!(lines(b"a\xffb\nnext\n", 8).await, vec![Ok("a\u{fffd}b".into()), Ok("next".into())]);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use agent_protocol::{BridgeMessage, Frame, HostMessage};

    fn sh(script: &str) -> HostCommand {
        HostCommand { program: "sh".into(), args: vec!["-c".into(), script.into()], env: BTreeMap::new() }
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<Input>) -> Input {
        tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("an input").expect("open")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn frames_flow_both_ways_and_a_dead_host_is_restarted() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (tx, mut rx) = mpsc::unbounded_channel();
                // Echo one reply per line read, then exit.
                let host = supervise(sh(r#"read line; echo '{"v":1,"id":"b1","kind":"ack"}'; exit 3"#), tx);
                assert!(matches!(next(&mut rx).await, Input::HostUp));
                host.send(&Frame::request("b1", BridgeMessage::Interrupt { session_id: "s".into() }));
                match next(&mut rx).await {
                    Input::HostFrame(f) => assert_eq!((f.id.as_deref(), f.message), (Some("b1"), HostMessage::Ack)),
                    other => panic!("{other:?}"),
                }
                assert!(matches!(next(&mut rx).await, Input::HostDown { reason } if reason.contains('3')));
                assert!(matches!(next(&mut rx).await, Input::HostUp), "restarted after the backoff");
                host.stop().await;
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stop_closes_stdin_and_waits_for_the_exit() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let host = supervise(sh("cat >/dev/null"), tx);
                assert!(matches!(next(&mut rx).await, Input::HostUp));
                tokio::time::timeout(Duration::from_secs(5), host.stop()).await.expect("stops promptly");
            })
            .await;
    }
}
