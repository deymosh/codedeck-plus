//! Release acceptance: what a release must still do end to end that the
//! scripted `e2e` scenario does not reach, run with the real phone core
//! (`client-runtime`) against a throwaway bridge on a loopback relay.
//!
//! - A deleted session stays gone across a bridge restart, and the phone's
//!   session key was granted within the protocol's lifetime.
//! - OpenCode MCP changes made from the phone survive bridge (and so
//!   OpenCode) restarts: they live in OpenCode's global config, here a
//!   throwaway one.
//! - A real OpenCode session on a free model answers, and the same
//!   conversation answers again after a bridge restart.
//!
//! Needs `node`, a built agent host, and for the OpenCode scenarios the
//! OpenCode binary in an agent cache (`CODEDECK_AGENT_CACHE`, `/agents` in
//! the dev container) and, for the model, network access. Ignored by a plain
//! `cargo test`:
//! `CODEDECK_AGENT_CACHE=/agents cargo test -p bridge-runtime --test acceptance -- --ignored --test-threads 1`.

mod support;

use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use bridge_runtime::config::{self, Flags};
use bridge_runtime::runtime::{self, Mode, Options, Outcome};
use bridge_runtime::state::StateFile;
use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::protocol::common::{McpAction, McpServerSpec, McpTransport};
use client_runtime::protocol::crypto::generate_keypair;
use client_runtime::protocol::events::BridgeToPhone;
use client_runtime::{Core, CoreConfig, CoreObserver, CorePorts, Intent, LocalSigner, MemoryTranscriptStore, SystemClock, TimeEntropy, TranscriptStore};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, LocalSet};

const TIMEOUT: Duration = Duration::from_secs(30);
/// A real model, over the network, takes longer than any scripted agent.
const MODEL_TIMEOUT: Duration = Duration::from_secs(180);
const FREE_MODEL: &str = "opencode/deepseek-v4.1-flash-free";

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

/// Where a bridge keeps everything: its home and workspace, and the
/// throwaway XDG dirs OpenCode reads its global config from.
struct Machine {
    home: tempfile::TempDir,
    workspace: tempfile::TempDir,
    xdg: tempfile::TempDir,
    drivers: &'static str,
}

impl Machine {
    fn new(drivers: &'static str) -> Self {
        Self { home: tempfile::tempdir().unwrap(), workspace: tempfile::tempdir().unwrap(), xdg: tempfile::tempdir().unwrap(), drivers }
    }

    fn opencode_config(&self) -> PathBuf {
        self.xdg.path().join("config/opencode/opencode.json")
    }

    fn start(&self, relay: &str) -> Bridge {
        let flags = Flags {
            home: Some(self.home.path().into()),
            machine_name: Some("acceptance".into()),
            relays: vec![relay.into()],
            workspaces: vec![self.workspace.path().into()],
            agent_host: Some(bundle()),
            ..Default::default()
        };
        let mut config = config::load(&flags).expect("config");
        let env = &mut config.host_env;
        env.insert("CODEDECK_AGENT_HOST_DRIVERS".into(), self.drivers.into());
        if let Ok(cache) = std::env::var("CODEDECK_AGENT_CACHE") {
            env.insert("CODEDECK_AGENT_CACHE".into(), cache);
        }
        for (name, dir) in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state")] {
            env.insert(name.into(), self.xdg.path().join(dir).to_string_lossy().into_owned());
        }
        let state = StateFile::open(self.home.path()).unwrap();
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

    /// The bridge's stored state, as JSON.
    fn state(&self) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(self.home.path().join("state.json")).unwrap()).unwrap()
    }
}

struct Bridge {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<Outcome, String>>,
    urls: mpsc::UnboundedReceiver<String>,
}

impl Bridge {
    async fn stop(self) {
        let _ = self.stop.send(());
        let outcome = tokio::time::timeout(TIMEOUT, self.task).await.expect("the bridge stops").unwrap();
        assert_eq!(outcome, Ok(Outcome::Stopped));
    }
}

async fn until_within<T, F, Fut>(limit: Duration, what: &str, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn until<T, F, Fut>(what: &str, check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    until_within(TIMEOUT, what, check).await
}

/// A fresh phone, paired with the bridge through its pairing window.
async fn paired_phone(bridge: &mut Bridge, store: Rc<MemoryTranscriptStore>) -> (Core, String) {
    let core = Core::spawn(
        CoreConfig::new(Rc::new(LocalSigner(generate_keypair())), None, false, None),
        CorePorts { transcript_store: store, ..CorePorts::default() },
        Rc::new(Observer),
        Rc::new(SystemClock),
        Rc::new(TimeEntropy),
    )
    .await;
    core.start();
    let url = tokio::time::timeout(TIMEOUT, bridge.urls.recv()).await.expect("a pairing window opens").unwrap();
    core.dispatch(Intent::BeginPairing { url, label: "acceptance".into() }).await;
    until("pairing", || async {
        let view = core.pairing_view().await?;
        assert_ne!(view.phase, "failed", "pairing failed: {:?}", view.error);
        (view.phase == "paired").then_some(())
    })
    .await;
    let machine = until("the machine", || async { core.machines_view().await.machines.keys().next().cloned() }).await;
    (core, machine)
}

async fn create_session(core: &Core, machine: &str, agent: &str, model: Option<&str>) -> String {
    let before: Vec<String> = core.machines_view().await.machines.get(machine).map(|m| m.sessions.keys().cloned().collect()).unwrap_or_default();
    core.dispatch(Intent::CreateSession {
        machine: machine.into(),
        agent: agent.into(),
        cwd: None,
        create_cwd: None,
        mode: None,
        effort: None,
        model: model.map(str::to_string),
        persona: None,
        provider_id: None,
    })
    .await;
    until_within(MODEL_TIMEOUT, &format!("a new {agent} session"), || async {
        let view = core.machines_view().await;
        view.machines.get(machine)?.sessions.keys().find(|s| !before.contains(s)).cloned()
    })
    .await
}

async fn session_listed(core: &Core, machine: &str, session: &str) -> bool {
    core.machines_view().await.machines.get(machine).is_some_and(|m| m.sessions.contains_key(session))
}

/// Every agent text the phone holds for a session, joined.
async fn agent_text(store: &MemoryTranscriptStore, machine: &str, session: &str) -> String {
    let high = store.seqs(machine, session).await.into_iter().max().unwrap_or(0);
    store
        .read_range(machine, session, 1, high)
        .await
        .into_iter()
        .filter(|r| r.entry["entryType"] == "text" && r.entry["role"] == "agent")
        .filter_map(|r| r.entry["text"].as_str().map(str::to_string))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every row the phone holds for a session, one line each: what a timed-out
/// wait shows, so a failure says what did arrive.
async fn transcript_dump(store: &MemoryTranscriptStore, machine: &str, session: &str) -> String {
    let high = store.seqs(machine, session).await.into_iter().max().unwrap_or(0);
    store
        .read_range(machine, session, 1, high)
        .await
        .into_iter()
        .map(|r| format!("{} {}", r.seq, r.entry.to_string().chars().take(200).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Wait until the phone holds an agent answer containing `needle`; on
/// a timeout, fail with the whole transcript.
async fn answered(store: &MemoryTranscriptStore, machine: &str, session: &str, needle: &str) {
    let deadline = tokio::time::Instant::now() + MODEL_TIMEOUT;
    while !agent_text(store, machine, session).await.to_lowercase().contains(needle) {
        if tokio::time::Instant::now() >= deadline {
            panic!("no answer containing {needle:?}; the phone holds:\n{}", transcript_dump(store, machine, session).await);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node and a built packages/agent-host bundle"]
async fn a_deleted_session_stays_gone_across_a_restart() {
    LocalSet::new()
        .run_until(async {
            let relay = support::relay::start().await;
            let machine_dir = Machine::new("fake");
            let mut bridge = machine_dir.start(&relay);
            let store = Rc::new(MemoryTranscriptStore::new());
            let (core, machine) = paired_phone(&mut bridge, store).await;

            // The phone's session key was granted, within the protocol's
            // lifetime (an older phone's longer grant would be refused).
            let state = machine_dir.state();
            let phones: serde_json::Value = serde_json::from_str(state["kv"]["pairedPhones"].as_str().map_or(&state["kv"]["pairedPhones"].to_string(), |s| s)).unwrap();
            let expires = phones[0]["clients"][0]["key"]["expiresAt"].as_u64().expect("a session key was granted");
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            let max = client_runtime::protocol::commands::SESSION_KEY_MAX_LIFETIME_SECS;
            assert!(expires > now && expires <= now + max, "grant runs {} s, at most {max}", expires.saturating_sub(now));

            let keep = create_session(&core, &machine, "fake", None).await;
            let gone = create_session(&core, &machine, "fake", None).await;
            core.dispatch(Intent::DeleteSession { machine: machine.clone(), session_id: gone.clone(), label: None }).await;
            // The delete is held for its undo window, then sent; the
            // bridge's registry is where it lands.
            until("the bridge to forget the deleted session", || async {
                let registry = machine_dir.state()["kv"]["registry"].clone();
                let text = registry.to_string();
                (text.contains(&keep) && !text.contains(&format!("\"sessionId\":\"{gone}\"")) && !text.contains(&format!("\\\"sessionId\\\":\\\"{gone}\\\""))).then_some(())
            })
            .await;

            bridge.stop().await;
            let _bridge = machine_dir.start(&relay);
            core.dispatch(Intent::RefreshSessions { machine: machine.clone() }).await;
            until("the restarted bridge's list", || async { session_listed(&core, &machine, &keep).await.then_some(()) }).await;
            tokio::time::sleep(Duration::from_secs(2)).await;
            assert!(!session_listed(&core, &machine, &gone).await, "a deleted session came back after the restart");
            _bridge.stop().await;
        })
        .await;
}

/// Whether the phone lists MCP server `name` for OpenCode and if it is
/// enabled: `Some(None)` when it is not listed, `None` while a change is in
/// flight or nothing is known yet.
async fn mcp_server(core: &Core, machine: &str, name: &str) -> Option<Option<bool>> {
    let view = core.machines_view().await;
    let agent = view.machines.get(machine)?.mcp.get("opencode")?.clone();
    agent.busy.is_empty().then(|| agent.servers.iter().find(|s| s.name == name).map(|s| s.enabled))
}

/// Make an MCP change from the phone until the phone lists the outcome
/// `done` wants. A bridge that has just restarted answers "try again in a
/// moment" while its agent host starts, so a person would try again, and so
/// does this.
async fn mcp_until(core: &Core, machine: &str, action: McpAction, servers: Vec<McpServerSpec>, names: Vec<String>, done: fn(Option<bool>) -> bool) {
    let deadline = tokio::time::Instant::now() + MODEL_TIMEOUT;
    loop {
        core.dispatch(Intent::McpAction { machine: machine.into(), agent: "opencode".into(), action, servers: servers.clone(), names: names.clone() })
            .await;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if mcp_server(core, machine, "fs").await.is_some_and(done) {
                return;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for the MCP change {action:?} to take");
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node, a built agent host and the OpenCode binary in CODEDECK_AGENT_CACHE"]
async fn opencode_mcp_changes_from_the_phone_survive_restarts() {
    let _ = env_logger::builder().is_test(true).filter_level(log::LevelFilter::Info).try_init();
    LocalSet::new()
        .run_until(async {
            let relay = support::relay::start().await;
            let machine_dir = Machine::new("opencode");
            let mut bridge = machine_dir.start(&relay);
            let store = Rc::new(MemoryTranscriptStore::new());
            let (core, machine) = paired_phone(&mut bridge, store).await;
            let secret = "acceptance-secret-0123456789";

            let add = McpServerSpec {
                name: "fs".into(),
                transport: McpTransport::Stdio { command: "true".into(), args: vec![], env: [("API_KEY".to_string(), secret.to_string())].into() },
            };
            mcp_until(&core, &machine, McpAction::Add, vec![add], vec![], |s| s == Some(true)).await;
            let file = std::fs::read_to_string(machine_dir.opencode_config()).expect("OpenCode's global config was written");
            assert!(file.contains("\"fs\""), "the server is in OpenCode's config: {file}");
            assert!(!format!("{:?}", core.machines_view().await).contains(secret), "no secret reaches the phone");

            // Restart: switching it off works only if the restarted OpenCode
            // still has it.
            bridge.stop().await;
            let bridge = machine_dir.start(&relay);
            mcp_until(&core, &machine, McpAction::Disable, vec![], vec!["fs".into()], |s| s == Some(false)).await;
            let file = std::fs::read_to_string(machine_dir.opencode_config()).unwrap();
            assert!(file.contains("\"enabled\": false"), "the switch is in the file: {file}");

            // Restart: it is still there, so removing it works.
            bridge.stop().await;
            let bridge = machine_dir.start(&relay);
            mcp_until(&core, &machine, McpAction::Remove, vec![], vec!["fs".into()], |s| s.is_none()).await;

            bridge.stop().await;
            let bridge = machine_dir.start(&relay);
            core.dispatch(Intent::RequestMcp { machine: machine.clone(), agent: "opencode".into() }).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
            assert_eq!(mcp_server(&core, &machine, "fs").await, Some(None), "a removed server stays removed");
            let file = std::fs::read_to_string(machine_dir.opencode_config()).unwrap();
            assert!(!file.contains("\"fs\""), "and is out of the file: {file}");
            bridge.stop().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node, a built agent host, the OpenCode binary and network access for a free model"]
async fn an_opencode_session_answers_and_resumes_across_a_restart() {
    let _ = env_logger::builder().is_test(true).filter_level(log::LevelFilter::Info).try_init();
    LocalSet::new()
        .run_until(async {
            let relay = support::relay::start().await;
            let machine_dir = Machine::new("opencode");
            let mut bridge = machine_dir.start(&relay);
            let store = Rc::new(MemoryTranscriptStore::new());
            let (core, machine) = paired_phone(&mut bridge, store.clone()).await;

            let session = create_session(&core, &machine, "opencode", Some(FREE_MODEL)).await;
            let say = |text: &'static str, id: &'static str| {
                let core = &core;
                let machine = machine.clone();
                let session = session.clone();
                async move {
                    core.dispatch(Intent::SendInput { machine, session_id: session, text: text.into(), input_id: id.into() }).await;
                }
            };
            say("Reply with the single word PINEAPPLE and nothing else.", "in-1").await;
            answered(&store, &machine, &session, "pineapple").await;
            let native = |state: serde_json::Value| state["kv"]["registry"].to_string();
            let before = native(machine_dir.state());

            bridge.stop().await;
            let bridge = machine_dir.start(&relay);
            say("Which word did you reply with before? Answer with that word in lower case only.", "in-2").await;
            // The first answer already holds the word: the second turn is
            // known by its own reply, so wait for a second answer.
            let first = agent_text(&store, &machine, &session).await.len();
            let deadline = tokio::time::Instant::now() + MODEL_TIMEOUT;
            while agent_text(&store, &machine, &session).await.len() <= first {
                if tokio::time::Instant::now() >= deadline {
                    panic!("no answer after the restart; the phone holds:\n{}", transcript_dump(&store, &machine, &session).await);
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            answered(&store, &machine, &session, "pineapple").await;
            assert!(session_listed(&core, &machine, &session).await, "the same session continues");
            let after = native(machine_dir.state());
            let conversation = |registry: &str| registry.split("nativeSessionId").nth(1).map(|s| s.chars().take(60).collect::<String>());
            assert_eq!(conversation(&before), conversation(&after), "the same OpenCode conversation was resumed");
            bridge.stop().await;
        })
        .await;
}
