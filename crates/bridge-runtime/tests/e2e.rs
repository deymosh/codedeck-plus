//! The whole bridge, end to end: the real runtime (relays, state files,
//! transcripts) and the real agent host process running its scripted `fake`
//! agent, driven by the real phone core (`client-runtime`) through a relay
//! on loopback. Everything the phone sees crossed a socket as NIP-44
//! encrypted events.
//!
//! Scenario: pair through the pairing window → create a session → input is
//! confirmed and answered → a permission card is answered from the phone →
//! the bridge restarts and resumes the session → the phone reconnects and
//! sync brings its transcript level with the bridge's own, seq for seq.
//!
//! Needs `node` and a built agent host (`pnpm --filter @codedeck/agent-host
//! run build`); `AGENT_HOST_BUNDLE` overrides the path. Ignored by a plain
//! `cargo test` for that reason:
//! `cargo test -p bridge-runtime --test e2e -- --ignored`.

mod support;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use bridge_core::ports::Transcripts as _;
use bridge_runtime::config::{self, Flags};
use bridge_runtime::runtime::{self, Mode, Options, Outcome};
use bridge_runtime::state::StateFile;
use bridge_runtime::transcripts::FileTranscripts;
use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::client_core::stores::outbox::OutboxItemState;
use client_runtime::protocol::crypto::generate_keypair;
use client_runtime::protocol::events::BridgeToPhone;
use client_runtime::{Core, CoreConfig, CoreObserver, CorePorts, Intent, LocalSigner, MemoryTranscriptStore, SystemClock, TimeEntropy, TranscriptStore};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, LocalSet};
#[cfg(unix)]
use base64::engine::general_purpose::STANDARD;
#[cfg(unix)]
use base64::Engine as _;
#[cfg(unix)]
use client_runtime::protocol::crypto::Keypair;
#[cfg(unix)]
use client_runtime::MemoryKv;
#[cfg(unix)]
use nostr_transport::{WsConfig, WsTransport};

const TIMEOUT: Duration = Duration::from_secs(20);

fn bundle() -> PathBuf {
    std::env::var("AGENT_HOST_BUNDLE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/agent-host/dist/main.js"))
}

struct Observer;
impl CoreObserver for Observer {
    fn connection_changed(&self, _: ConnectionStatus, _: bool, _: &[String]) {}
    fn bridge_message(&self, _: String, _: BridgeToPhone) {}
}

/// Keeps the terminal messages the bridge sends this phone. The phone core has
/// no terminal store yet, so it drops them; the observer is where the wire can
/// still be checked.
#[cfg(unix)]
#[derive(Default)]
struct TerminalObserver {
    opened: std::cell::RefCell<Option<client_runtime::protocol::events::TerminalOpenedMsg>>,
    exited: std::cell::RefCell<Option<client_runtime::protocol::events::TerminalExitedMsg>>,
    /// Every terminal-output frame, decoded from its base64, in order.
    output: std::cell::RefCell<Vec<u8>>,
    /// The type of every message seen, for a failure's diagnosis.
    seen: std::cell::RefCell<Vec<String>>,
}

#[cfg(unix)]
impl TerminalObserver {
    fn seen(&self) -> String {
        String::from_utf8_lossy(&self.output.borrow()).into_owned()
    }
    fn refused(&self) -> Option<String> {
        self.exited.borrow().as_ref().map(|m| format!("{m:?}"))
    }
    fn trace(&self) -> String {
        self.seen.borrow().join(", ")
    }
}

#[cfg(unix)]
impl CoreObserver for TerminalObserver {
    fn connection_changed(&self, _: ConnectionStatus, _: bool, _: &[String]) {}
    fn bridge_message(&self, _: String, msg: BridgeToPhone) {
        let name = match &msg {
            BridgeToPhone::TerminalOpened(_) => "terminal-opened",
            BridgeToPhone::TerminalOutput(_) => "terminal-output",
            BridgeToPhone::TerminalInputFrom(_) => "terminal-input-from",
            BridgeToPhone::TerminalExited(_) => "terminal-exited",
            BridgeToPhone::TerminalEvent(_) => "terminal-event",
            _ => "other",
        };
        self.seen.borrow_mut().push(name.to_string());
        match msg {
            BridgeToPhone::TerminalOpened(m) => *self.opened.borrow_mut() = Some(m),
            BridgeToPhone::TerminalExited(m) => *self.exited.borrow_mut() = Some(m),
            BridgeToPhone::TerminalOutput(m) => {
                if let Ok(bytes) = STANDARD.decode(&m.data) {
                    self.output.borrow_mut().extend_from_slice(&bytes);
                }
            }
            _ => {}
        }
    }
}

struct Bridge {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<Outcome, String>>,
    urls: mpsc::UnboundedReceiver<String>,
}

fn start_bridge(relay: &str, home: &Path, workspace: &Path) -> Bridge {
    start_bridge_with(relay, home, workspace, None)
}

/// `terminal_device`: turn terminals on (relays allowed) and approve this
/// device id, for the terminal test. The allowlist file is read when the
/// bridge starts, so it is written before `run`.
fn start_bridge_with(relay: &str, home: &Path, workspace: &Path, terminal_device: Option<&str>) -> Bridge {
    let flags = Flags {
        home: Some(home.into()),
        machine_name: Some("e2e".into()),
        relays: vec![relay.into()],
        workspaces: vec![workspace.into()],
        agent_host: Some(bundle()),
        ..Default::default()
    };
    let mut config = config::load(&flags).expect("config");
    config.host_env.insert("CODEDECK_AGENT_HOST_DRIVERS".into(), "fake".into());
    if let Some(device) = terminal_device {
        config.terminal.enabled = true;
        config.terminal.relays_allowed = true;
        let allow = serde_json::json!({ "devices": [device], "pending": [] });
        std::fs::write(home.join("terminal-allow.json"), allow.to_string()).unwrap();
    }
    let state = StateFile::open(home).unwrap();
    let keys = state.identity().unwrap();
    let (stop, stop_rx) = oneshot::channel();
    let (urls_tx, urls) = mpsc::unbounded_channel();
    let mut options = Options::new(Mode::Run);
    options.signals = false;
    options.stop = Some(stop_rx);
    options.pairing_urls = Some(urls_tx);
    let task = tokio::task::spawn_local(runtime::run(config, state, keys, options));
    Bridge { stop, task, urls }
}

impl Bridge {
    async fn stop(self) {
        let _ = self.stop.send(());
        let outcome = tokio::time::timeout(TIMEOUT, self.task).await.expect("the bridge stops").unwrap();
        assert_eq!(outcome, Ok(Outcome::Stopped));
    }
}

/// Poll `check` until it gives a value (or fail after [`TIMEOUT`]).
async fn until<T, F, Fut>(what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn connected(core: &Core) {
    until("the phone to connect", || async { core.connection_view().await.filter(|v| v.status == "connected").map(|_| ()) }).await;
}

/// The phone's transcript rows for a session, as JSON.
async fn phone_rows(store: &MemoryTranscriptStore, machine: &str, session: &str) -> Vec<(u64, serde_json::Value)> {
    let high = store.seqs(machine, session).await.into_iter().max().unwrap_or(0);
    store.read_range(machine, session, 1, high).await.into_iter().map(|r| (r.seq, r.entry)).collect()
}

async fn has_text(store: &MemoryTranscriptStore, machine: &str, session: &str, needle: &str) -> bool {
    phone_rows(store, machine, session).await.iter().any(|(_, e)| e["text"].as_str().is_some_and(|t| t.contains(needle)))
}

async fn send(core: &Core, machine: &str, session: &str, text: &str, id: &str) {
    core.dispatch(Intent::SendInput { machine: machine.into(), session_id: session.into(), text: text.into(), input_id: id.into() }).await;
    until(&format!("input {id} to be confirmed"), || async {
        core.outbox_view().await.items.iter().any(|i| i.id == id && i.state == OutboxItemState::Confirmed).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node and a built packages/agent-host bundle"]
async fn a_phone_drives_the_real_bridge_through_a_relay() {
    assert!(bundle().exists(), "agent host bundle missing at {} — build packages/agent-host first", bundle().display());
    LocalSet::new()
        .run_until(async {
            let relay = support::relay::start().await;
            let home = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();

            let mut bridge = start_bridge(&relay, home.path(), workspace.path());
            let pairing_url = tokio::time::timeout(TIMEOUT, bridge.urls.recv()).await.expect("a pairing window opens").unwrap();

            // --- the phone ---
            let store = Rc::new(MemoryTranscriptStore::new());
            let core = Core::spawn(
                CoreConfig::new(Rc::new(LocalSigner(generate_keypair())), None, false),
                CorePorts { transcript_store: store.clone(), ..CorePorts::default() },
                Rc::new(Observer),
                Rc::new(SystemClock),
                Rc::new(TimeEntropy),
            )
            .await;
            core.start();

            // --- pairing (a fresh phone has no relays: the link names them) ---
            core.dispatch(Intent::BeginPairing { url: pairing_url, label: "e2e-phone".into() }).await;
            until("pairing", || async {
                let view = core.pairing_view().await?;
                assert_ne!(view.phase, "failed", "pairing failed: {:?}", view.error);
                (view.phase == "paired").then_some(())
            })
            .await;
            let machine = until("the machine", || async { core.machines_view().await.machines.keys().next().cloned() }).await;
            let fake_listed = until("the agent catalog", || async {
                let view = core.machines_view().await;
                let m = view.machines.get(&machine)?;
                m.agents.iter().any(|a| a.id == "fake").then_some(true)
            })
            .await;
            assert!(fake_listed);

            // --- a session on the fake agent ---
            core.dispatch(Intent::CreateSession {
                machine: machine.clone(),
                agent: "fake".into(),
                cwd: None,
                create_cwd: None,
                mode: None,
                effort: None,
                model: None,
                persona: None,
                provider_id: None,
            })
            .await;
            let session = until("the session to appear", || async {
                core.machines_view().await.machines.get(&machine)?.sessions.keys().next().cloned()
            })
            .await;

            // --- input, answered ---
            send(&core, &machine, &session, "hello", "in-1").await;
            until("the echo", || async { has_text(&store, &machine, &session, "echo: hello").await.then_some(()) }).await;

            // --- a permission card answered from the phone ---
            send(&core, &machine, &session, "permission rm -rf build", "in-2").await;
            let request_id = until("the permission card", || async {
                phone_rows(&store, &machine, &session)
                    .await
                    .into_iter()
                    .find(|(_, e)| e["entryType"] == "permission_request")
                    .and_then(|(_, e)| e["requestId"].as_str().map(str::to_string))
            })
            .await;
            core.dispatch(Intent::RespondPermission {
                machine: machine.clone(),
                session_id: session.clone(),
                request_id,
                option_id: "allow".into(),
            })
            .await;
            until("the agent to see the answer", || async {
                has_text(&store, &machine, &session, "permission: allow").await.then_some(())
            })
            .await;

            // --- MCP: a server added from the phone comes back without its
            // token, and is switched off in the session ---
            {
                use client_runtime::protocol::common::{McpAction, McpServerSpec, McpStatus, McpTransport};
                core.dispatch(Intent::McpAction {
                    machine: machine.clone(),
                    agent: "fake".into(),
                    action: McpAction::Add,
                    servers: vec![McpServerSpec {
                        name: "gh".into(),
                        transport: McpTransport::Http {
                            url: "https://mcp.example/mcp?key=e2e-query".into(),
                            headers: [("Authorization".to_string(), "Bearer e2e-secret".to_string())].into(),
                        },
                    }],
                    names: vec![],
                })
                .await;
                let listed = until("the MCP server list", || async {
                    let view = core.machines_view().await;
                    view.machines.get(&machine)?.mcp.get("fake").filter(|a| !a.servers.is_empty() && a.busy.is_empty()).cloned()
                })
                .await;
                assert_eq!(listed.servers[0].target, "https://mcp.example/mcp");
                assert_eq!(listed.servers[0].header_keys, ["Authorization"]);
                // The secrets themselves, not a shared prefix: the view also
                // holds session uuids, and a uuid group ending in "e2e" reads
                // as one, at random.
                let view = format!("{:?}", core.machines_view().await);
                assert!(!view.contains("e2e-secret") && !view.contains("e2e-query"), "no secret reaches the phone");

                core.dispatch(Intent::ToggleSessionMcp { machine: machine.clone(), session_id: session.clone(), name: "gh".into(), enabled: false }).await;
                until("the session to switch the server off", || async {
                    let view = core.machines_view().await;
                    let mcp = view.machines.get(&machine)?.sessions.get(&session)?.mcp.clone()?;
                    mcp.servers.iter().any(|s| s.name == "gh" && s.status == McpStatus::Disabled).then_some(())
                })
                .await;
            }

            // --- restart: the session resumes, the phone catches up ---
            bridge.stop().await;
            let bridge = start_bridge(&relay, home.path(), workspace.path());
            send(&core, &machine, &session, "after restart", "in-3").await;
            until("the echo after the restart", || async {
                has_text(&store, &machine, &session, "echo: after restart").await.then_some(())
            })
            .await;

            let bridge_rows = || {
                let t = FileTranscripts::open(&home.path().join("sessions/transcripts")).unwrap();
                t.read(&session, (1, u64::MAX)).unwrap()
            };
            core.set_online(false);
            until("the phone to go offline", || async {
                core.connection_view().await.filter(|v| v.status != "connected").map(|_| ())
            })
            .await;
            core.set_online(true);
            connected(&core).await;
            let want = bridge_rows();
            until("sync to level the transcripts", || async {
                (phone_rows(&store, &machine, &session).await.len() >= want.len()).then_some(())
            })
            .await;

            let phone = phone_rows(&store, &machine, &session).await;
            for row in bridge_rows() {
                let (_, entry) = phone.iter().find(|(seq, _)| *seq == row.seq).unwrap_or_else(|| panic!("seq {} missing on the phone", row.seq));
                assert_eq!(entry, &serde_json::to_value(&row.entry).unwrap(), "seq {} differs", row.seq);
            }
            let seqs: Vec<u64> = phone.iter().map(|(s, _)| *s).collect();
            assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>(), "no gaps, no duplicates");

            bridge.stop().await;
        })
        .await;
}

/// Publish one phone→bridge message as a raw event: signed by the identity,
/// NIP-44 encrypted from the session key to the bridge (the direction the
/// phone's own API uses), tagged to the bridge, of `kind`.
#[cfg(unix)]
async fn publish(
    transport: &WsTransport,
    identity: &Keypair,
    session: &Keypair,
    bridge: &str,
    kind: u16,
    msg: client_runtime::protocol::commands::PhoneToBridge,
) {
    let plain = client_runtime::protocol::encode_phone_to_bridge(&msg).expect("encodes");
    let content = client_runtime::protocol::crypto::encrypt_to(&session.secret_key, bridge, &plain).expect("encrypts");
    let keys = nostr::Keys::new(identity.secret_key.clone());
    let tag = nostr::Tag::public_key(nostr::PublicKey::from_hex(bridge).unwrap());
    let event = nostr::EventBuilder::new(nostr::Kind::Custom(kind), content).tag(tag).sign_with_keys(&keys).unwrap();
    let signed = client_runtime::protocol::nostr_event::SignedEvent::from_nostr(&event);
    let result = transport.publish_confirmed(&signed, Duration::from_secs(5), 2).await;
    assert!(result.verdict.is_delivered(), "publish of kind {kind}: {:?} {:?}", result.verdict, result.detail);
}

/// The terminal's whole path over a relay: a phone opens a terminal on the
/// bridge, types `echo hi`, and sees the output come back. The keystrokes ride
/// the live kind (which the bridge subscribes to only because the owner allows
/// a terminal over relays), and the output is the bridge's coalesced,
/// relay-paced `terminal-output`. Unix only: the bridge runs a real pty.
#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node and a built packages/agent-host bundle"]
async fn a_phone_opens_a_terminal_and_types_through_the_bridge() {
    use client_runtime::client_core::stores::session_key::{SessionKey, SessionKeyRing, GRANT_LIFETIME_SECS};
    use client_runtime::protocol::commands::{PhoneToBridge, PresenceMsg, TerminalInputMsg, TerminalOpenMsg};
    use client_runtime::protocol::kinds::{COMMAND_KIND, LIVE_KIND};
    use client_runtime::protocol::recipients::device_id;

    assert!(bundle().exists(), "agent host bundle missing at {} — build packages/agent-host first", bundle().display());
    let _ = env_logger::builder().is_test(true).filter_level(log::LevelFilter::Info).try_init();
    LocalSet::new()
        .run_until(async {
            let relay = support::relay::start().await;
            let home = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();

            // A phone whose session key the test already knows: the bridge
            // names the device by it, so the allowlist can name it too.
            let phone = generate_keypair();
            let session = generate_keypair();
            let device = device_id(&session.pubkey_hex);
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            let ring = SessionKeyRing::single(SessionKey {
                keypair: session.clone(),
                expires_at: now_ms / 1000 + GRANT_LIFETIME_SECS,
            });
            let kv = Rc::new(MemoryKv::seeded([(client_runtime::stores::SESSION_KEYS_KEY, ring.encode())]));

            let mut bridge = start_bridge_with(&relay, home.path(), workspace.path(), Some(&device));

            let store = Rc::new(MemoryTranscriptStore::new());
            let observer = Rc::new(TerminalObserver::default());
            let core = Core::spawn(
                CoreConfig::new(Rc::new(LocalSigner(phone.clone())), None, false),
                CorePorts { kv: kv.clone(), transcript_store: store.clone(), ..CorePorts::default() },
                observer.clone(),
                Rc::new(SystemClock),
                Rc::new(TimeEntropy),
            )
            .await;
            core.start();
            let pairing_url = tokio::time::timeout(TIMEOUT, bridge.urls.recv()).await.expect("a pairing window opens").unwrap();
            core.dispatch(Intent::BeginPairing { url: pairing_url, label: "e2e-terminal".into() }).await;
            until("pairing", || async {
                let view = core.pairing_view().await?;
                assert_ne!(view.phase, "failed", "pairing failed: {:?}", view.error);
                (view.phase == "paired").then_some(())
            })
            .await;
            let machine = until("the machine", || async { core.machines_view().await.machines.keys().next().cloned() }).await;

            // The phone core has no terminal API yet, so the terminal messages
            // go out as raw events, encrypted with the session key the pairing
            // just granted.
            let transport = WsTransport::new(WsConfig { relays: vec![relay.clone()], auth: Rc::new(phone.clone()), proxy: None });
            transport.ensure_connected();
            until("the raw relay link", || async { (!transport.connected_relays().is_empty()).then_some(()) }).await;

            publish(
                &transport,
                &phone,
                &session,
                &machine,
                COMMAND_KIND,
                PhoneToBridge::TerminalOpen(TerminalOpenMsg { open_id: "o1".into(), cols: 80, rows: 24, session: None }),
            )
            .await;
            let term = until("terminal-opened", || async {
                if let Some(m) = observer.opened.borrow().as_ref() {
                    return Some(m.term.clone());
                }
                if let Some(why) = observer.refused() {
                    panic!("the bridge refused the open: {why} (saw: {})", observer.trace());
                }
                None
            })
            .await;

            // Say this client shows the terminal: output goes only to the
            // clients that do.
            publish(
                &transport,
                &phone,
                &session,
                &machine,
                COMMAND_KIND,
                PhoneToBridge::Presence(PresenceMsg { away: false, watching: None, watching_terminal: Some(term.clone()) }),
            )
            .await;

            // Type into it, on the live kind.
            publish(
                &transport,
                &phone,
                &session,
                &machine,
                LIVE_KIND,
                PhoneToBridge::TerminalInput(TerminalInputMsg { term: term.clone(), seq: 1, data: STANDARD.encode(b"echo hi\n") }),
            )
            .await;
            until("the echo", || async { observer.seen().contains("hi").then_some(()) }).await;
            assert!(observer.seen().contains("hi"), "the shell's output reached the phone: {:?}", observer.seen());

            bridge.stop().await;
        })
        .await;
}
