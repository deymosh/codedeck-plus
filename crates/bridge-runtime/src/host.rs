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
    let mut stdout = BufReader::new(child.stdout.take().expect("piped")).lines();
    let mut stderr = BufReader::new(child.stderr.take().expect("piped")).lines();
    let mut stderr_open = true;
    loop {
        tokio::select! {
            line = stdout.next_line() => match line {
                Ok(Some(line)) => match decode_host_frame(&line) {
                    Ok(frame) => {
                        let _ = inputs.send(Input::HostFrame(frame));
                    }
                    Err(err) => log::warn!("[Host] Undecodable frame from the agent host ({err}) — dropped"),
                },
                Ok(None) | Err(_) => return (exit_reason(child).await, None),
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(line)) => log::info!("[agent-host] {line}"),
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
