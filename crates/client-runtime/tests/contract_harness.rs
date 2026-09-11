//! F2b Capa 2 Go/No-Go gate (migration plan §4): drives the REAL
//! `client_runtime::Core` against `tools/contract-harness` — a real
//! `BridgeCore` + `FakeSdkFacade` reachable over a genuine `ws://` socket.
//! Process + socket, no FFI shim.
//!
//! Ignored by default: it needs Node and the harness's own build. From the
//! repo root:
//!
//!   cd tools/contract-harness && pnpm install && pnpm build
//!   cargo test -p client-runtime --test contract_harness -- --ignored
//!
//! Scenario (the plan's Scenario A, first slice — pair → session → live
//! output → input ack; a bridge-restart + reconnect + sync-gap-refill
//! extension is tracked as a fast-follow in docs/CLIENT-CORE.md):
//!
//!   pairing window → session in the bridge's default folder → live output
//!   lands in the transcript store → input via the outbox reaches confirmed.

use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;
use std::time::Duration;

use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::client_core::crypto::generate_keypair;
use client_runtime::client_core::stores::outbox::OutboxItemState;
use client_runtime::client_core::wire::events::BridgeToPhone;
use client_runtime::{
    Core, CoreConfig, CoreObserver, CorePorts, Intent, MemoryTranscriptStore, SystemClock,
    TimeEntropy, TranscriptStore,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::task::LocalSet;

fn harness_bundle_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/contract-harness/out/main.js")
}

/// A line-oriented client for the harness's stdin/stdout control protocol
/// (`tools/contract-harness/README.md`). One request in flight at a time —
/// exactly what this test needs.
struct Harness {
    child: tokio::process::Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Harness {
    async fn spawn() -> (Self, String) {
        let bundle = harness_bundle_path();
        assert!(
            bundle.exists(),
            "harness bundle missing at {bundle:?} — run `pnpm build` in tools/contract-harness first"
        );
        let mut child = Command::new("node")
            .arg(&bundle)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn node tools/contract-harness/out/main.js");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let mut lines = BufReader::new(stdout).lines();

        let ready_line = lines
            .next_line()
            .await
            .expect("read ready line")
            .expect("harness exited before printing a ready line");
        let ready: serde_json::Value =
            serde_json::from_str(&ready_line).expect("ready line is JSON");
        assert_eq!(ready["type"], "ready", "first line was not the ready line: {ready}");
        let ws_url = ready["wsUrl"]
            .as_str()
            .expect("ready line carries wsUrl")
            .to_string();

        (
            Self {
                child,
                stdin,
                lines,
                next_id: 0,
            },
            ws_url,
        )
    }

    /// Send one control command and wait for its (successful) response's
    /// `result`. Panics with the harness's own error message on failure —
    /// there is no path in this test that expects one.
    async fn call(&mut self, cmd: &str, mut fields: serde_json::Value) -> serde_json::Value {
        self.next_id += 1;
        let id = self.next_id.to_string();
        let obj = fields.as_object_mut().expect("fields is a JSON object");
        obj.insert("id".to_string(), serde_json::json!(id));
        obj.insert("cmd".to_string(), serde_json::json!(cmd));

        let line = format!("{fields}\n");
        self.stdin
            .write_all(line.as_bytes())
            .await
            .expect("write control command");

        let raw = self
            .lines
            .next_line()
            .await
            .expect("read control response")
            .expect("harness stdout closed before answering");
        let resp: serde_json::Value = serde_json::from_str(&raw).expect("response is JSON");
        assert_eq!(resp["id"], serde_json::json!(id), "response id mismatch: {resp}");
        assert_eq!(resp["ok"], true, "harness command `{cmd}` failed: {resp}");
        resp["result"].clone()
    }

    async fn shutdown(mut self) {
        let _ = self.call("shutdown", serde_json::json!({})).await;
        let _ = self.child.wait().await;
    }
}

/// Captures the semantic event stream so the test can assert on it; every
/// other `CoreObserver` callback is a no-op (this test drives everything
/// through polling the views, matching how a UI binding would).
#[derive(Default)]
struct Observer;
impl CoreObserver for Observer {
    fn connection_changed(&self, _status: ConnectionStatus, _needs_pairing_check: bool) {}
    fn bridge_message(&self, _machine: String, _msg: BridgeToPhone) {}
}

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const POLL_TIMEOUT: Duration = Duration::from_secs(15);

async fn sleep_a_bit() {
    tokio::time::sleep(POLL_INTERVAL).await;
}

#[tokio::test]
#[ignore = "needs Node + `pnpm build` in tools/contract-harness — see module docs"]
async fn pair_session_output_and_input_ack_over_a_real_socket() {
    LocalSet::new()
        .run_until(async {
            let (mut harness, ws_url) = Harness::spawn().await;

            let phone_identity = generate_keypair();
            let transcript_store = Rc::new(MemoryTranscriptStore::new());
            let ports = CorePorts {
                transcript_store: transcript_store.clone(),
                ..CorePorts::default()
            };
            let core = Core::spawn(
                CoreConfig::new(vec![ws_url], phone_identity, None, false),
                ports,
                Rc::new(Observer),
                Rc::new(SystemClock),
                Rc::new(TimeEntropy),
            )
            .await;
            core.start();

            // --- connect (vacuous — nothing paired yet) ---
            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            loop {
                if let Some(view) = core.connection_view().await {
                    if view.status == "connected" {
                        break;
                    }
                }
                assert!(tokio::time::Instant::now() < deadline, "never reached connected");
                sleep_a_bit().await;
            }

            // --- pair through the harness's real pairing window ---
            let pairing = harness.call("open-pairing-window", serde_json::json!({})).await;
            let pairing_url = pairing["url"].as_str().unwrap().to_string();
            core.dispatch(Intent::BeginPairing {
                url: pairing_url,
                label: "contract-harness-rust-test".to_string(),
            })
            .await;

            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            loop {
                if let Some(view) = core.pairing_view().await {
                    assert_ne!(view.phase, "failed", "pairing failed: {:?}", view.error);
                    if view.phase == "paired" {
                        break;
                    }
                }
                assert!(tokio::time::Instant::now() < deadline, "pairing never settled");
                sleep_a_bit().await;
            }

            let machine = core
                .machines_view()
                .await
                .machines
                .keys()
                .next()
                .cloned()
                .expect("the paired machine is visible after pairing");

            // --- create a session, then let the harness's fake SDK answer ---
            core.dispatch(Intent::CreateSession {
                machine: machine.clone(),
                cwd: None,
                create_cwd: None,
                model: None,
                default_effort: None,
                provider_id: None,
                test_session: None,
            })
            .await;

            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            let session_id = loop {
                let sessions = harness.call("list-sdk-sessions", serde_json::json!({})).await;
                if let Some(id) = sessions.as_array().and_then(|a| a.last()).and_then(|v| v.as_str()) {
                    break id.to_string();
                }
                assert!(tokio::time::Instant::now() < deadline, "no SDK session was spawned");
                sleep_a_bit().await;
            };

            harness
                .call(
                    "emit-sdk-message",
                    serde_json::json!({
                        "sessionId": session_id,
                        "message": {
                            "type": "system", "subtype": "init", "session_id": format!("sdk-{session_id}"),
                            "model": "claude-test-1", "permissionMode": "plan",
                            "claude_code_version": "2.0.0", "apiKeySource": "none", "cwd": "/work",
                            "tools": [], "mcp_servers": [], "slash_commands": [],
                            "output_style": "default", "skills": [], "plugins": [], "uuid": "u-init",
                        },
                    }),
                )
                .await;

            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            loop {
                let mv = core.machines_view().await;
                if mv
                    .machines
                    .get(&machine)
                    .is_some_and(|m| m.sessions.contains_key(&session_id))
                {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "session never became visible on the phone");
                sleep_a_bit().await;
            }

            // --- live output lands in the transcript store ---
            harness
                .call(
                    "emit-sdk-message",
                    serde_json::json!({
                        "sessionId": session_id,
                        "message": {
                            "type": "assistant", "session_id": format!("sdk-{session_id}"),
                            "parent_tool_use_id": null,
                            "message": {
                                "model": "claude-test-1",
                                "content": [{ "type": "text", "text": "hello from the real bridge" }],
                            },
                        },
                    }),
                )
                .await;

            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            loop {
                let seqs = transcript_store.seqs(&machine, &session_id).await;
                if seqs.len() >= 2 {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "live output never reached the transcript");
                sleep_a_bit().await;
            }

            // --- input through the outbox reaches Confirmed via input-ack ---
            core.dispatch(Intent::SendInput {
                machine: machine.clone(),
                session_id: session_id.clone(),
                text: "hello from the real client-runtime".to_string(),
                input_id: "in-1".to_string(),
            })
            .await;

            let deadline = tokio::time::Instant::now() + POLL_TIMEOUT;
            loop {
                let outbox = core.outbox_view().await;
                if outbox
                    .items
                    .iter()
                    .any(|item| item.id == "in-1" && item.state == OutboxItemState::Confirmed)
                {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "input was never confirmed");
                sleep_a_bit().await;
            }

            harness.shutdown().await;
        })
        .await;
}
