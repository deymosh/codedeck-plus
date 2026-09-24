//! The real agent host, spawned over a pipe and spoken to with this crate's
//! codec: every frame it writes must decode, and the protocol's request,
//! reply and event paths must work end to end. Claude Code runs in test
//! mode, so its real adapter and permission policy produce the entries being
//! decoded — the check that the TypeScript side emits exactly what the Rust
//! types accept.
//!
//! Needs `node` and a built host (`pnpm --filter @codedeck/agent-host run
//! build`); `AGENT_HOST_BUNDLE` overrides the bundle path. Ignored by a plain
//! `cargo test` for that reason: `cargo test -p agent-protocol --test
//! agent_host -- --ignored`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use agent_protocol::{
    decode_host_frame, encode_frame, BridgeMessage, Frame, HostFrame, HostMessage, QuestionOutcome,
    SelectOutcome, SessionEvent, StartSession,
};
use protocol::common::EntryBody;

const TIMEOUT: Duration = Duration::from_secs(20);

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<String>,
    seen: Vec<HostFrame>,
    next_id: u32,
    /// Host requests already answered.
    taken: Vec<String>,
}

impl Host {
    fn spawn() -> Self {
        let bundle = std::env::var("AGENT_HOST_BUNDLE")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/agent-host/dist/main.js").into());
        let mut child = Command::new("node")
            .arg(&bundle)
            .env("CODEDECK_AGENT_HOST_DRIVERS", "fake,claude-code")
            .env("CODEDECK_TEST_MODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn node {bundle}: {e}"));
        let stdout = child.stdout.take().unwrap();
        let (tx, frames) = channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        Host { child, stdin, frames, seen: Vec::new(), next_id: 0, taken: Vec::new() }
    }

    fn send(&mut self, id: Option<String>, message: BridgeMessage) {
        let frame = match id {
            Some(id) => Frame::request(id, message),
            None => Frame::notification(message),
        };
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{}", encode_frame(&frame)).unwrap();
        stdin.flush().unwrap();
    }

    /// Send a request; returns its id.
    fn request(&mut self, message: BridgeMessage) -> String {
        self.next_id += 1;
        let id = format!("b{}", self.next_id);
        self.send(Some(id.clone()), message);
        id
    }

    /// Read frames until one satisfies `pred`. Every frame read must decode.
    fn until(&mut self, what: &str, pred: impl Fn(&HostFrame) -> bool) -> HostFrame {
        if let Some(f) = self.seen.iter().find(|f| pred(f)) {
            return f.clone();
        }
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = match self.frames.recv_timeout(left) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => panic!("timed out waiting for {what}; saw {:#?}", self.seen),
                Err(RecvTimeoutError::Disconnected) => panic!("host exited while waiting for {what}"),
            };
            let frame = decode_host_frame(&line).unwrap_or_else(|e| panic!("undecodable host frame ({e}): {line}"));
            self.seen.push(frame.clone());
            if pred(&frame) {
                return frame;
            }
        }
    }

    fn reply_to(&mut self, id: &str) -> HostMessage {
        self.until(&format!("reply to {id}"), |f| f.id.as_deref() == Some(id) && f.message.is_reply()).message
    }

    fn event(&mut self, what: &str, session: &str, pred: impl Fn(&SessionEvent) -> bool) -> SessionEvent {
        let frame = self.until(what, |f| {
            matches!(&f.message, HostMessage::SessionEvent { session_id, event } if session_id == session && pred(event))
        });
        let HostMessage::SessionEvent { event, .. } = frame.message else { unreachable!() };
        event
    }

    /// Wait for an agent text entry containing `needle`.
    fn text(&mut self, session: &str, needle: &str) {
        self.event(&format!("text containing {needle:?}"), session, |e| {
            matches!(e, SessionEvent::Entries { entries } if entries.iter().any(|en|
                matches!(&en.body, EntryBody::Text { text, .. } if text.contains(needle))))
        });
    }

    /// Wait for a request the host sends and return (frame id, message).
    fn host_request(&mut self, what: &str, pred: impl Fn(&HostMessage) -> bool) -> (String, HostMessage) {
        let taken = std::mem::take(&mut self.taken);
        let frame = self.until(what, |f| {
            !f.message.is_reply() && f.id.as_ref().is_some_and(|id| !taken.contains(id)) && pred(&f.message)
        });
        self.taken = taken;
        let id = frame.id.unwrap();
        self.taken.push(id.clone());
        (id, frame.message)
    }

    fn start(&mut self, session: &str, agent: &str, mode: Option<&str>) {
        let id = self.request(BridgeMessage::StartSession(Box::new(StartSession {
            session_id: session.into(),
            agent: agent.into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            mode: mode.map(Into::into),
            effort: None,
            model: None,
            resume: None,
            credentials: Default::default(),
            env: Default::default(),
            provider: None,
            host_tools: vec![],
            deny_secret_paths: false,
        })));
        assert_eq!(self.reply_to(&id), HostMessage::Ack);
        self.event("ready", session, |e| matches!(e, SessionEvent::Ready {}));
    }

    fn prompt(&mut self, session: &str, text: &str) {
        let id = self.request(BridgeMessage::Prompt { session_id: session.into(), text: text.into() });
        assert_eq!(self.reply_to(&id), HostMessage::Ack);
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn selected(option: &str) -> SelectOutcome {
    SelectOutcome::Selected { option_id: option.into() }
}

#[test]
#[ignore = "needs node and a built packages/agent-host bundle"]
fn the_agent_host_speaks_the_driver_protocol() {
    let mut host = Host::spawn();

    // --- initialize: both drivers advertised ---
    let id = host.request(BridgeMessage::Initialize { bridge_version: "test".into() });
    let HostMessage::Initialized { agents, .. } = host.reply_to(&id) else { panic!("initialized") };
    let ids: Vec<_> = agents.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, ["fake", "claude-code"]);
    let claude = &agents[1];
    assert!(claude.modes.iter().any(|m| m.id == "plan"));
    assert_eq!(claude.credentials[0].env_var.as_deref(), Some("ANTHROPIC_API_KEY"));

    // --- the fake agent: a permission round trip ---
    host.start("f1", "fake", None);
    host.prompt("f1", "permission rm -rf build");
    let (req, message) = host.host_request("request-permission", |m| matches!(m, HostMessage::RequestPermission(_)));
    let HostMessage::RequestPermission(p) = message else { unreachable!() };
    assert_eq!((p.session_id.as_str(), p.title.as_str()), ("f1", "rm -rf build"));
    host.send(Some(req), BridgeMessage::PermissionOutcome(selected("allow")));
    host.text("f1", "permission: allow");

    // --- Claude Code (test mode): real adapter + permission policy ---
    host.start("c1", "claude-code", Some("acceptEdits"));

    host.prompt("c1", "/test-tool");
    let (req, message) = host.host_request("Read permission", |m| matches!(m, HostMessage::RequestPermission(_)));
    let HostMessage::RequestPermission(p) = message else { unreachable!() };
    assert_eq!((p.tool_name.as_str(), p.title.as_str()), ("Read", "/example/test-mode.txt"));
    host.send(Some(req), BridgeMessage::PermissionOutcome(selected("allow")));
    host.text("c1", "Read the file");

    host.prompt("c1", "/test-question-multiple");
    let (req, message) = host.host_request("questions", |m| matches!(m, HostMessage::AskQuestion(_)));
    let HostMessage::AskQuestion(q) = message else { unreachable!() };
    assert_eq!(q.questions.len(), 2);
    host.send(
        Some(req),
        BridgeMessage::QuestionOutcome(QuestionOutcome::Answered { answers: vec!["Rust".into(), "Dev".into()] }),
    );
    host.text("c1", "received Rust, Dev");

    host.prompt("c1", "/test-plan");
    host.event("the plan", "c1", |e| {
        matches!(e, SessionEvent::Entries { entries } if entries.iter().any(|en| matches!(en.body, EntryBody::Plan { .. })))
    });
    let (req, message) = host.host_request("plan approval", |m| matches!(m, HostMessage::RequestPlanApproval(_)));
    let HostMessage::RequestPlanApproval(plan) = message else { unreachable!() };
    assert!(plan.options.iter().any(|o| o.id == "revise"));
    host.send(Some(req), BridgeMessage::PlanOutcome(selected("default")));
    host.text("c1", "Plan approved");
    host.event("the mode switch", "c1", |e| matches!(e, SessionEvent::Info { mode: Some(m), .. } if m == "default"));

    // --- an unknown agent is an error reply, not a crash ---
    let id = host.request(BridgeMessage::ListModels { agent: "pi".into() });
    assert!(matches!(host.reply_to(&id), HostMessage::Error { .. }));

    // --- closing stdin shuts the host down cleanly ---
    drop(host.stdin.take());
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        if let Some(status) = host.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "host did not exit after stdin closed");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "host exit status {status}");
}
