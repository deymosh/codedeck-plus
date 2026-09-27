//! The phone's end of a direct link to one bridge (the wire is
//! `protocol::direct`).
//!
//! A [`DirectLink`] keeps one connection to a bridge up while any of its
//! endpoints answers, trying them in order and backing off between rounds
//! the way the relay transport does. `wss://` endpoints are pinned to the
//! certificate hash the bridge's heartbeat advertises (no CA: private
//! addresses and VPN names work). While a SOCKS5 proxy (Orbot) is set, only
//! `.onion` endpoints are used, dialled through it; without one they are
//! skipped. Cleartext `ws://` only goes to an onion service, or to loopback
//! for tests.
//!
//! The HELLO is signed by the identity through the [`AuthSigner`], like a
//! relay's AUTH. Every event that arrives is checked (id and signature) and
//! handed up; the layer above drops one it already saw on a relay by its id.
//! A publish over the link waits for the bridge's `OK`; a caller falls back
//! to the relays when the link is down or does not answer.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use protocol::direct::{decode_direct_frame, encode_direct_frame, event_is_valid, DirectFrame};
use protocol::nostr_event::SignedEvent;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::AbortHandle;
use tokio::time::Instant;
use tokio_socks::tcp::Socks5Stream;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::either::Either;
use url::Url;

use crate::port::{AuthSigner, NostrEvent};
use crate::publish::{PublishResult, PublishVerdict};
use crate::ws::{dead_after, PING_EVERY, RETRY_BASE, RETRY_MAX};

/// Deadline for TCP, TLS and the WebSocket handshake, direct and through
/// the proxy (building a Tor circuit to an onion service takes a while).
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);
const DIAL_TIMEOUT_PROXIED: Duration = Duration::from_secs(60);
/// How long the bridge has to send its challenge, and to answer the HELLO.
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the identity may take to sign the HELLO (a signer app may ask
/// the user); the bridge waits a minute.
const SIGN_TIMEOUT: Duration = Duration::from_secs(55);
/// A link that stayed up this long counts as healthy: its next failure
/// starts the backoff over.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// On the first connection, ask for this much of what the bridge published
/// before; the relays have delivered the rest.
const FIRST_RESUME_SECS: u64 = 120;
/// Resume a little before the newest event seen, for clock skew.
const RESUME_GRACE_SECS: u64 = 5;

/// Where and how to reach one bridge.
pub struct DirectConfig {
    /// `wss://host:port` or `ws://<name>.onion:port`, in the order to try.
    pub endpoints: Vec<String>,
    /// The SHA-256 (lowercase hex) of the certificate `wss://` endpoints
    /// serve. Without it no `wss://` endpoint is dialled.
    pub cert_sha256: Option<String>,
    /// SOCKS5 `host:port` (Orbot). While set, only `.onion` endpoints are
    /// dialled, through it.
    pub proxy: Option<String>,
    /// Signs the HELLO with the identity.
    pub auth: Rc<dyn AuthSigner>,
}

/// What the link reports.
pub struct DirectHandlers {
    /// A checked event from the bridge.
    pub on_event: Rc<dyn Fn(NostrEvent)>,
    /// The endpoint the link came up on, or `None` when it went down.
    pub on_state: Rc<dyn Fn(Option<String>)>,
}

/// A direct link to one bridge. Cheap to clone; single-threaded (spawns on
/// the current `LocalSet`). Dropping the last clone does not stop it: call
/// [`DirectLink::stop`].
#[derive(Clone)]
pub struct DirectLink(Rc<Inner>);

struct Inner {
    config: DirectConfig,
    handlers: DirectHandlers,
    /// The live connection's endpoint and outbound queue.
    up: RefCell<Option<(String, mpsc::UnboundedSender<Message>)>>,
    /// Publishes awaiting the bridge's `OK`, by event id.
    pending: RefCell<HashMap<String, oneshot::Sender<(bool, String)>>>,
    /// The newest event seen (seconds), where the next connection resumes.
    newest: Cell<u64>,
    ping_every: Cell<Duration>,
    wake: Notify,
    task: RefCell<Option<AbortHandle>>,
}

impl DirectLink {
    /// Start connecting. Must be called inside a `LocalSet`.
    pub fn start(config: DirectConfig, handlers: DirectHandlers) -> Self {
        install_crypto_provider();
        let link = Self(Rc::new(Inner {
            config,
            handlers,
            up: RefCell::default(),
            pending: RefCell::default(),
            newest: Cell::new(now_secs().saturating_sub(FIRST_RESUME_SECS)),
            ping_every: Cell::new(PING_EVERY),
            wake: Notify::new(),
            task: RefCell::default(),
        }));
        let runner = link.clone();
        let task = tokio::task::spawn_local(async move { runner.run().await });
        *link.0.task.borrow_mut() = Some(task.abort_handle());
        link
    }

    /// The endpoint the link is up on.
    pub fn endpoint(&self) -> Option<String> {
        self.0.up.borrow().as_ref().map(|(endpoint, _)| endpoint.clone())
    }

    /// Stop for good: close the connection and fail pending publishes.
    pub fn stop(&self) {
        if let Some(task) = self.0.task.borrow_mut().take() {
            task.abort();
        }
        self.0.pending.borrow_mut().clear();
        if self.0.up.borrow_mut().take().is_some() {
            (self.0.handlers.on_state)(None);
        }
    }

    /// Skip the rest of a backoff wait (the network came back).
    pub fn retry_now(&self) {
        self.0.wake.notify_one();
    }

    /// How often to ping; a link silent for two of these is dropped.
    pub fn set_ping_interval(&self, every: Duration) {
        self.0.ping_every.set(every);
    }

    /// Send `event` over the link and wait up to `within` for the bridge's
    /// `OK`. `None` when the link is down or the bridge did not answer: the
    /// caller publishes to the relays instead.
    pub async fn publish(&self, event: &SignedEvent, within: Duration) -> Option<PublishResult> {
        let outbound = self.0.up.borrow().as_ref().map(|(_, out)| out.clone())?;
        let (tx, rx) = oneshot::channel();
        self.0.pending.borrow_mut().insert(event.id.clone(), tx);
        if outbound.send(Message::Text(encode_direct_frame(&DirectFrame::Event(event.clone())))).is_err() {
            self.0.pending.borrow_mut().remove(&event.id);
            return None;
        }
        match tokio::time::timeout(within, rx).await {
            Ok(Ok((true, _))) => Some(PublishResult { verdict: PublishVerdict::Accepted, detail: None }),
            Ok(Ok((false, message))) => Some(PublishResult { verdict: PublishVerdict::Rejected, detail: Some(message) }),
            _ => {
                self.0.pending.borrow_mut().remove(&event.id);
                None
            }
        }
    }

    /// The endpoints worth dialling with this configuration, in order.
    fn usable(&self) -> Vec<String> {
        let config = &self.0.config;
        config
            .endpoints
            .iter()
            .filter(|url| {
                let Some(host) = Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)) else {
                    return false;
                };
                let onion = host.ends_with(".onion");
                // Orbot on: only onion services, through it; off: none.
                if config.proxy.is_some() != onion {
                    return false;
                }
                if url.starts_with("wss://") {
                    config.cert_sha256.is_some()
                } else {
                    url.starts_with("ws://") && (onion || is_loopback(&host))
                }
            })
            .cloned()
            .collect()
    }

    async fn run(&self) {
        let mut failures = 0u32;
        loop {
            let mut stable = false;
            for endpoint in self.usable() {
                match self.connect(&endpoint).await {
                    Ok(ws) => {
                        let since = Instant::now();
                        self.serve(ws, &endpoint).await;
                        stable = since.elapsed() >= STABLE_AFTER;
                        break;
                    }
                    Err(err) => log::debug!("[Direct] {endpoint}: {err}"),
                }
            }
            failures = if stable { 0 } else { failures.saturating_add(1) };
            let delay = RETRY_BASE.saturating_mul(1 << failures.saturating_sub(1).min(8)).min(RETRY_MAX);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = self.0.wake.notified() => {}
            }
        }
    }

    /// Dial `endpoint` and complete the handshake.
    async fn connect(&self, endpoint: &str) -> Result<Stream, String> {
        let proxy = self.0.config.proxy.clone();
        let deadline = if proxy.is_some() { DIAL_TIMEOUT_PROXIED } else { DIAL_TIMEOUT };
        let mut ws = tokio::time::timeout(deadline, dial(endpoint, proxy, self.0.config.cert_sha256.as_deref()))
            .await
            .map_err(|_| "dial timed out".to_string())??;
        let challenge = match next_frame(&mut ws, FRAME_TIMEOUT).await? {
            DirectFrame::Challenge(c) => c,
            other => return Err(format!("expected a challenge, got {other:?}")),
        };
        let auth = tokio::time::timeout(SIGN_TIMEOUT, self.0.config.auth.sign_auth(endpoint, &challenge, now_ms()))
            .await
            .map_err(|_| "the identity did not sign in time".to_string())??;
        let since = self.0.newest.get().saturating_sub(RESUME_GRACE_SECS);
        ws.send(Message::Text(encode_direct_frame(&DirectFrame::Hello { auth, since })))
            .await
            .map_err(|e| e.to_string())?;
        match next_frame(&mut ws, FRAME_TIMEOUT).await? {
            DirectFrame::Ready => Ok(ws),
            DirectFrame::Closed(reason) => Err(format!("refused: {reason}")),
            other => Err(format!("expected READY, got {other:?}")),
        }
    }

    /// Run an open link until it fails or is closed.
    async fn serve(&self, ws: Stream, endpoint: &str) {
        let (mut sink, mut source) = ws.split();
        let (outbound, mut queue) = mpsc::unbounded_channel();
        *self.0.up.borrow_mut() = Some((endpoint.to_string(), outbound));
        log::info!("[Direct] Up on {endpoint}");
        (self.0.handlers.on_state)(Some(endpoint.to_string()));

        let mut last_heard = Instant::now();
        let mut ping = tokio::time::interval(self.0.ping_every.get());
        ping.tick().await;
        loop {
            tokio::select! {
                message = queue.recv() => {
                    let Some(message) = message else { break };
                    if sink.send(message).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if last_heard.elapsed() > dead_after(self.0.ping_every.get()) {
                        log::info!("[Direct] {endpoint} went silent");
                        break;
                    }
                    if sink.send(Message::Ping(Vec::new())).await.is_err() {
                        break;
                    }
                }
                incoming = source.next() => {
                    last_heard = Instant::now();
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if !self.on_frame(&text) {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
        self.0.up.borrow_mut().take();
        self.0.pending.borrow_mut().clear();
        log::info!("[Direct] Down on {endpoint}");
        (self.0.handlers.on_state)(None);
    }

    /// Handle one frame; false when the bridge closed the link.
    fn on_frame(&self, text: &str) -> bool {
        match decode_direct_frame(text) {
            Ok(DirectFrame::Event(event)) => {
                if event_is_valid(&event) {
                    self.0.newest.set(self.0.newest.get().max(event.created_at));
                    let event = NostrEvent {
                        id: event.id,
                        kind: event.kind,
                        created_at: event.created_at as i64,
                        pubkey: event.pubkey,
                        content: event.content,
                    };
                    (self.0.handlers.on_event)(event);
                } else {
                    log::warn!("[Direct] Dropping an event that does not verify");
                }
                true
            }
            Ok(DirectFrame::Ok { id, accepted, message }) => {
                if let Some(waiter) = self.0.pending.borrow_mut().remove(&id) {
                    let _ = waiter.send((accepted, message));
                }
                true
            }
            Ok(DirectFrame::Closed(reason)) => {
                log::info!("[Direct] The bridge closed the link: {reason}");
                false
            }
            _ => true,
        }
    }
}

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<Either<TcpStream, Socks5Stream<TcpStream>>>>;

async fn next_frame(ws: &mut Stream, within: Duration) -> Result<DirectFrame, String> {
    let wait = async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => return decode_direct_frame(&text).map_err(|e| e.to_string()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) => return Err("unexpected message".to_string()),
                Some(Err(e)) => return Err(e.to_string()),
                None => return Err("closed".to_string()),
            }
        }
    };
    tokio::time::timeout(within, wait).await.map_err(|_| "timed out".to_string())?
}

async fn dial(endpoint: &str, proxy: Option<String>, pin: Option<&str>) -> Result<Stream, String> {
    let url = Url::parse(endpoint).map_err(|e| format!("bad endpoint: {e}"))?;
    let host = url.host_str().ok_or("endpoint has no host")?.to_string();
    let port = url.port_or_known_default().ok_or("endpoint has no port")?;
    let connector = match url.scheme() {
        "wss" => {
            let pin = pin.ok_or("no certificate pin for a wss endpoint")?;
            tokio_tungstenite::Connector::Rustls(Arc::new(pinned_client_config(pin)))
        }
        "ws" if host.ends_with(".onion") || is_loopback(&host) => tokio_tungstenite::Connector::Plain,
        _ => return Err(format!("refusing {endpoint}: wss://, or ws:// only to an onion service")),
    };
    let tcp: Either<TcpStream, Socks5Stream<TcpStream>> = match proxy {
        Some(p) => Either::Right(
            Socks5Stream::connect(p.as_str(), (host.as_str(), port)).await.map_err(|e| format!("socks5: {e}"))?,
        ),
        None => Either::Left(TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("tcp: {e}"))?),
    };
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(url.as_str(), tcp, None, Some(connector))
        .await
        .map_err(|e| format!("handshake: {e}"))?;
    Ok(ws)
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "::1" | "[::1]" | "localhost")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn now_secs() -> u64 {
    now_ms() / 1000
}

fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// A TLS client that trusts exactly the certificate with SHA-256 `pin`, on
/// any host name: the bridge's self-signed certificate, as its heartbeat
/// advertised it. The handshake signature is still verified.
pub fn pinned_client_config(pin: &str) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { sha256: pin.to_ascii_lowercase(), provider }))
        .with_no_client_auth()
}

#[derive(Debug)]
struct Pinned {
    sha256: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let actual: String = Sha256::digest(end_entity.as_ref()).iter().map(|b| format!("{b:02x}")).collect();
        if actual == self.sha256 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("the certificate does not match the bridge's pin".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::generate_keypair;

    fn link_with(endpoints: &[&str], pin: Option<&str>, proxy: Option<&str>) -> DirectLink {
        // Not started: only `usable` is exercised.
        DirectLink(Rc::new(Inner {
            config: DirectConfig {
                endpoints: endpoints.iter().map(|e| e.to_string()).collect(),
                cert_sha256: pin.map(str::to_string),
                proxy: proxy.map(str::to_string),
                auth: Rc::new(generate_keypair()),
            },
            handlers: DirectHandlers { on_event: Rc::new(|_| {}), on_state: Rc::new(|_| {}) },
            up: RefCell::default(),
            pending: RefCell::default(),
            newest: Cell::new(0),
            ping_every: Cell::new(PING_EVERY),
            wake: Notify::new(),
            task: RefCell::default(),
        }))
    }

    const ALL: [&str; 5] = [
        "wss://192.168.1.20:7447",
        "wss://abc.onion:7447",
        "ws://abc.onion:7448",
        "ws://192.168.1.20:7447",
        "ws://127.0.0.1:7447",
    ];

    #[test]
    fn without_orbot_only_clearnet_endpoints_with_a_pin_are_used() {
        assert_eq!(link_with(&ALL, Some("ab"), None).usable(), ["wss://192.168.1.20:7447", "ws://127.0.0.1:7447"]);
        assert_eq!(link_with(&ALL, None, None).usable(), ["ws://127.0.0.1:7447"], "no pin, no wss");
    }

    #[test]
    fn with_orbot_only_onion_endpoints_are_used() {
        assert_eq!(link_with(&ALL, Some("ab"), Some("127.0.0.1:9050")).usable(), ["wss://abc.onion:7447", "ws://abc.onion:7448"]);
    }
}
