//! The bridge's web page as a client, end to end: the real runtime and agent
//! host (its scripted `fake` agent), a real phone core paired through a relay
//! on loopback, and a browser played by this test over real TLS — its own
//! P-256 key, the sign-in the phone approves, then a session driven over the
//! signed stream.
//!
//! Needs `node` and a built agent host, like `e2e.rs`:
//! `cargo test -p bridge-runtime --test web_page -- --ignored`.
//!
//! `hold_a_bridge_for_a_real_browser` is a tool rather than a test: with
//! `CODEDECK_WEB_HOLD=<file>` it runs the same bridge and phone, prints the
//! page's address, and has the phone approve every code written to `<file>`
//! for `CODEDECK_WEB_HOLD_SECS` (default 300), so a real browser can be
//! pointed at the page.

mod support;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use bridge_runtime::config::{self, Flags};
use bridge_runtime::runtime::{self, Mode, Options};
use bridge_runtime::state::StateFile;
use client_runtime::client_core::connection::ConnectionStatus;
use client_runtime::protocol::crypto::generate_keypair;
use client_runtime::protocol::events::BridgeToPhone;
use client_runtime::{Core, CoreConfig, CoreObserver, CorePorts, Intent, LocalSigner, MemoryTranscriptStore, SystemClock, TimeEntropy};
use futures_util::{SinkExt, StreamExt};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use protocol::web::{decode_web_frame, encode_web_frame, signed_input, WebFrame};
use rustls::pki_types::ServerName;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio::task::LocalSet;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

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

/// A free loopback port for the page's listener.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// The bridge with its direct link (and so its page) on `port`, and a phone
/// paired with it. Returns the phone and the machine it knows.
async fn bridge_and_phone(home: &Path, workspace: &Path, port: u16) -> (Core, String, oneshot::Sender<()>) {
    let relay = support::relay::start().await;
    let flags = Flags {
        home: Some(home.into()),
        machine_name: Some("web".into()),
        relays: vec![relay],
        workspaces: vec![workspace.into()],
        agent_host: Some(bundle()),
        ..Default::default()
    };
    let mut config = config::load(&flags).expect("config");
    config.host_env.insert("CODEDECK_AGENT_HOST_DRIVERS".into(), "fake".into());
    config.direct.listen = Some(format!("127.0.0.1:{port}").parse().unwrap());
    config.direct.endpoints = vec![format!("wss://127.0.0.1:{port}")];
    let state = StateFile::open(home).unwrap();
    let keys = state.identity().unwrap();
    let (stop, stop_rx) = oneshot::channel();
    let (urls_tx, mut urls) = tokio::sync::mpsc::unbounded_channel();
    let mut options = Options::new(Mode::Run);
    options.signals = false;
    options.stop = Some(stop_rx);
    options.pairing_urls = Some(urls_tx);
    tokio::task::spawn_local(runtime::run(config, state, keys, options));
    let pairing_url = tokio::time::timeout(TIMEOUT, urls.recv()).await.expect("a pairing window opens").unwrap();

    let core = Core::spawn(
        CoreConfig::new(Rc::new(LocalSigner(generate_keypair())), None, false, None),
        CorePorts { transcript_store: Rc::new(MemoryTranscriptStore::new()), ..CorePorts::default() },
        Rc::new(Observer),
        Rc::new(SystemClock),
        Rc::new(TimeEntropy),
    )
    .await;
    core.start();
    core.dispatch(Intent::BeginPairing { url: pairing_url, label: "web-phone".into() }).await;
    until("pairing", || async {
        let view = core.pairing_view().await?;
        assert_ne!(view.phase, "failed", "pairing failed: {:?}", view.error);
        (view.phase == "paired").then_some(())
    })
    .await;
    let machine = until("the machine", || async { core.machines_view().await.machines.keys().next().cloned() }).await;
    // A session can start only once the agent host has reported its
    // catalog; before that a create-session is refused.
    until("the agent catalog", || async {
        core.machines_view().await.machines.get(&machine)?.agents.iter().any(|a| a.id == "fake").then_some(())
    })
    .await;
    (core, machine, stop)
}

/// The browser: a key, a cookie, and TLS pinned to the certificate the
/// bridge made in `home` — what a user checks against the phone's pin.
struct Browser {
    port: u16,
    tls: tokio_rustls::TlsConnector,
    key: SigningKey,
    cookie: Option<String>,
}

impl Browser {
    fn new(home: &Path, port: u16) -> Self {
        let cert = std::fs::read(home.join("direct/cert.der")).expect("the page's certificate");
        let pin = hex::encode(Sha256::digest(&cert));
        let tls = tokio_rustls::TlsConnector::from(Arc::new(nostr_transport::direct::pinned_client_config(&pin)));
        Self { port, tls, key: SigningKey::from_bytes(&[42u8; 32].into()).unwrap(), cookie: None }
    }

    fn public_key(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_encoded_point(false).as_bytes())
    }

    fn id(&self) -> String {
        hex::encode(Sha256::digest(self.key.verifying_key().to_encoded_point(false).as_bytes()))[..16].to_string()
    }

    async fn tls(&self) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        self.tls.connect(ServerName::try_from("codedeck-bridge").unwrap(), tcp).await.unwrap()
    }

    /// One HTTPS request as a browser on the page makes it: (status, JSON).
    async fn request(&mut self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut stream = self.tls().await;
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let cookie = self.cookie.as_ref().map(|c| format!("Cookie: __Host-codedeck={c}\r\n")).unwrap_or_default();
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://127.0.0.1:{port}\r\n{cookie}\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
            port = self.port,
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        let _ = stream.read_to_end(&mut raw).await;
        let text = String::from_utf8_lossy(&raw).to_string();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        if let Some(value) = head.lines().find_map(|l| l.strip_prefix("Set-Cookie: __Host-codedeck=")) {
            self.cookie = Some(value.split(';').next().unwrap().to_string());
        }
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn sign(&self, challenge: &str, seq: u64, body: &str) -> String {
        let sig: Signature = self.key.sign(&signed_input(&machine_npub(), &self.id(), challenge, seq, body));
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
    }
}

/// The page's machine, as `/api/me` names it (set once the browser asked).
static MACHINE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
fn machine_npub() -> String {
    MACHINE.get().cloned().unwrap_or_default()
}

type Stream = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

async fn next(ws: &mut Stream) -> WebFrame {
    loop {
        let msg = tokio::time::timeout(TIMEOUT, ws.next()).await.expect("a frame in time").expect("open").unwrap();
        if let Message::Text(text) = msg {
            return decode_web_frame(&text).unwrap();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs node and a built packages/agent-host bundle"]
async fn a_browser_signed_in_by_the_phone_drives_a_session_over_its_signed_stream() {
    assert!(bundle().exists(), "agent host bundle missing at {} — build packages/agent-host first", bundle().display());
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let port = free_port();
            let (core, machine, stop) = bridge_and_phone(home.path(), workspace.path(), port).await;
            let mut browser = Browser::new(home.path(), port);

            // --- sign-in: the key goes with the start, the phone approves ---
            let (status, started) = browser.request("POST", "/api/sign-in", Some(json!({ "key": browser.public_key() }))).await;
            assert_eq!(status, 200, "{started}");
            let code = started["code"].as_str().unwrap().to_string();
            core.dispatch(Intent::WebSignIn { machine: machine.clone(), code }).await;
            let me = until("the phone to let the browser in", || {
                let mut b = Browser { cookie: browser.cookie.clone(), ..Browser::new(home.path(), port) };
                async move {
                    let (_, me) = b.request("GET", "/api/me", None).await;
                    (me["state"] == "signed-in").then_some(me)
                }
            })
            .await;
            assert_eq!(me["id"], browser.id(), "the browser let in is the key's");
            MACHINE.set(me["machine"].as_str().unwrap().to_string()).unwrap();

            // --- the cookie alone gets nothing beyond its own state ---
            let (status, _) = browser.request("GET", "/api/config", None).await;
            assert_eq!(status, 404);

            // --- the stream ---
            let tls = browser.tls().await;
            let mut request = format!("wss://127.0.0.1:{port}/api/stream").into_client_request().unwrap();
            request.headers_mut().insert("Origin", format!("https://127.0.0.1:{port}").parse().unwrap());
            request.headers_mut().insert("Cookie", format!("__Host-codedeck={}", browser.cookie.clone().unwrap()).parse().unwrap());
            let (mut ws, _) = tokio_tungstenite::client_async(request, tls).await.expect("the stream opens");
            let WebFrame::Challenge(challenge) = next(&mut ws).await else { panic!("a challenge") };
            ws.send(Message::Text(encode_web_frame(&WebFrame::Hello { sig: browser.sign(&challenge, 0, "") }))).await.unwrap();
            assert_eq!(next(&mut ws).await, WebFrame::Ready);

            let mut seq = 0;
            let mut command = async |ws: &mut Stream, msg: Value| {
                seq += 1;
                let body = msg.to_string();
                let frame = WebFrame::Cmd { seq, body: body.clone(), sig: browser.sign(&challenge, seq, &body) };
                ws.send(Message::Text(encode_web_frame(&frame))).await.unwrap();
            };
            command(&mut ws, json!({"v":12,"type":"create-session","agent":"fake"})).await;

            // The browser hears the session become ready, then drives it.
            let mut session = None;
            let mut echoed = false;
            let deadline = tokio::time::Instant::now() + TIMEOUT;
            while !echoed {
                assert!(tokio::time::Instant::now() < deadline, "the session and its echo, in time");
                match next(&mut ws).await {
                    WebFrame::Ok { accepted, message, .. } => assert!(accepted, "{message}"),
                    WebFrame::Msg(text) => {
                        let msg: Value = serde_json::from_str(&text).unwrap();
                        assert_ne!(msg["type"], "session-failed", "the session did not start: {msg}");
                        if msg["type"] == "session-ready" && session.is_none() {
                            let id = msg["session"]["id"].as_str().unwrap().to_string();
                            command(&mut ws, json!({"v":12,"type":"presence","watching":id})).await;
                            command(&mut ws, json!({"v":12,"type":"input","sessionId":id,"text":"hello","inputId":"w1"})).await;
                            session = Some(id);
                        }
                        let text = msg["entries"].as_array().into_iter().flatten().filter_map(|e| e["text"].as_str()).collect::<String>();
                        echoed |= msg["type"] == "output" && text.contains("echo: hello");
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }

            // A file attached in two chunks lands in the workspace, the
            // agent is told where, and the browser hears it arrived.
            let session = session.unwrap();
            for (i, part) in ["bm90ZXMg", "ZnJvbSBhIGJyb3dzZXI="].into_iter().enumerate() {
                let chunk = json!({"v":12,"type":"upload-file","sessionId":session,"uploadId":"w-up","filename":"notes.md",
                                   "mimeType":"text/markdown","base64Data":part,"text":"read this","chunkIndex":i,"totalChunks":2,
                                   "inputId":"w-file"});
                command(&mut ws, chunk).await;
            }
            let (mut attached, mut acked) = (None, false);
            let attached = loop {
                assert!(tokio::time::Instant::now() < deadline + TIMEOUT, "the file's echo and its ack, in time");
                match next(&mut ws).await {
                    WebFrame::Ok { accepted, message, .. } => assert!(accepted, "{message}"),
                    WebFrame::Msg(text) => {
                        let msg: Value = serde_json::from_str(&text).unwrap();
                        let text = msg["entries"].as_array().into_iter().flatten().filter_map(|e| e["text"].as_str()).collect::<String>();
                        assert_ne!(msg["type"], "input-failed", "{msg}");
                        acked |= msg["type"] == "input-ack" && msg["inputId"] == "w-file";
                        if msg["type"] == "output" && text.contains("echo: read this") {
                            attached = Some(text);
                        }
                    }
                    other => panic!("unexpected {other:?}"),
                }
                if let (Some(text), true) = (&attached, acked) {
                    break text.clone();
                }
            };
            let path = attached.split("[Attached file: ").nth(1).and_then(|rest| rest.split(']').next()).expect("the file's path");
            assert!(Path::new(path).parent().is_some_and(|dir| dir.ends_with(Path::new(".codedeck").join("uploads"))), "{path}");
            assert_eq!(std::fs::read_to_string(path).unwrap(), "notes from a browser");

            // The phone sees the session the browser made: one engine, two clients.
            until("the phone to list the browser's session", || async {
                core.machines_view().await.machines.get(&machine)?.sessions.contains_key(&session).then_some(())
            })
            .await;

            // Signing out from the phone closes the stream at once.
            core.dispatch(Intent::SignOutWebBrowser { machine: machine.clone(), id: browser.id() }).await;
            loop {
                match next(&mut ws).await {
                    WebFrame::Closed(reason) => {
                        assert_eq!(reason, "signed-out");
                        break;
                    }
                    _ => continue,
                }
            }
            let _ = stop.send(());
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "a tool: holds a bridge for a real browser when CODEDECK_WEB_HOLD names a code file"]
async fn hold_a_bridge_for_a_real_browser() {
    let Ok(code_file) = std::env::var("CODEDECK_WEB_HOLD") else { return };
    let secs: u64 = std::env::var("CODEDECK_WEB_HOLD_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let port: u16 = std::env::var("CODEDECK_WEB_HOLD_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or_else(free_port);
            let (core, machine, stop) = bridge_and_phone(home.path(), workspace.path(), port).await;
            println!("PAGE https://127.0.0.1:{port}/");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
            let mut approved = String::new();
            while tokio::time::Instant::now() < deadline {
                let code = std::fs::read_to_string(&code_file).unwrap_or_default().trim().to_string();
                if !code.is_empty() && code != approved {
                    println!("APPROVING {code}");
                    core.dispatch(Intent::WebSignIn { machine: machine.clone(), code: code.clone() }).await;
                    approved = code;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let _ = stop.send(());
        })
        .await;
}
