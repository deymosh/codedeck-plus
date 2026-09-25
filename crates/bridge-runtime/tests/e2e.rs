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
use client_runtime::{Core, CoreConfig, CoreObserver, CorePorts, Intent, MemoryTranscriptStore, SystemClock, TimeEntropy, TranscriptStore};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, LocalSet};

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

struct Bridge {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<Outcome, String>>,
    urls: mpsc::UnboundedReceiver<String>,
}

fn start_bridge(relay: &str, home: &Path, workspace: &Path) -> Bridge {
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
                CoreConfig::new(vec![relay.clone()], generate_keypair(), None, false),
                CorePorts { transcript_store: store.clone(), ..CorePorts::default() },
                Rc::new(Observer),
                Rc::new(SystemClock),
                Rc::new(TimeEntropy),
            )
            .await;
            core.start();
            connected(&core).await;

            // --- pairing ---
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
                provider_id: None,
                test_session: None,
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
