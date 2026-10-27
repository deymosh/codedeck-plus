//! The phone's end of a direct link to one bridge (the wire is
//! `protocol::direct`).
//!
//! A [`DirectLink`] keeps one connection to a bridge up while any of its
//! endpoints answers, trying them in order and backing off between rounds
//! the way the relay transport does. `wss://` endpoints are pinned to the
//! certificate hash the bridge's heartbeat advertises (no CA: private
//! addresses and VPN names work). A direct link goes to the user's own
//! bridge on a network they set up (a LAN, a VPN), so it is dialled directly
//! whether or not a SOCKS5 proxy (Orbot) is set: Orbot is there to hide the
//! phone from public relays. The exception is an `.onion` endpoint, which
//! only Tor reaches: it is dialled through the proxy, and skipped without
//! one. Cleartext `ws://` only goes to an onion service, or to loopback for
//! tests.
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
/// Most bytes the link buffers: frames queued for the socket plus events
/// awaiting the bridge's OK. The phone is memory-constrained, and a bridge
/// that stops reading must cost the link, not an unbounded queue.
const OUTBOUND_BUDGET: usize = 16 * 1024 * 1024;

/// Where and how to reach one bridge.
pub struct DirectConfig {
    /// `wss://host:port` or `ws://<name>.onion:port`, in the order to try.
    pub endpoints: Vec<String>,
    /// The SHA-256 (lowercase hex) of the certificate `wss://` endpoints
    /// serve. Without it no `wss://` endpoint is dialled.
    pub cert_sha256: Option<String>,
    /// SOCKS5 `host:port` (Orbot), used for `.onion` endpoints only; without
    /// it those are skipped.
    pub proxy: Option<String>,
    /// The recipient tags of the copies this client reads (its `HELLO`
    /// names them): the bridge sends it those only.
    pub recipients: Vec<String>,
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

/// A publish awaiting the bridge's `OK`, with the byte length of the frame it
/// reserved from the outbound budget and a token identifying this publish.
/// A superseded publish with the same event id must not remove its
/// replacement's entry when its own wait ends.
type PendingPublish = (oneshot::Sender<(bool, String)>, usize, u64);

struct Inner {
    config: DirectConfig,
    handlers: DirectHandlers,
    /// The live connection's endpoint and outbound queue.
    up: RefCell<Option<(String, mpsc::UnboundedSender<Message>)>>,
    /// Publishes awaiting the bridge's `OK`, by event id, each with the byte
    /// length of its frame.
    pending: RefCell<HashMap<String, PendingPublish>>,
    /// Bytes of frames sitting in the outbound queue (decremented as they are
    /// written) and of publishes still awaiting an `OK`.
    queued_bytes: Cell<usize>,
    pending_bytes: Cell<usize>,
    /// Source of the token that ties a cleanup to the exact publish it ends.
    pending_seq: Cell<u64>,
    /// Byte cap on `queued_bytes + pending_bytes`; a field so tests can shrink
    /// it without allocating the production budget.
    budget: Cell<usize>,
    /// The newest event seen (seconds), where the next connection resumes.
    newest: Cell<u64>,
    ping_every: Cell<Duration>,
    /// Skips the backoff wait (the network came back).
    wake: Notify,
    /// Ends the live link now; the serve loop wakes even from a socket write
    /// that a bridge which stopped reading has left blocked.
    close: Notify,
    task: RefCell<Option<AbortHandle>>,
}

impl Inner {
    /// End the live link now: stop accepting publishes and wake the serve
    /// loop, even one parked in a socket write. Dropping the sender alone
    /// leaves a writer blocked behind a bridge that stopped reading, so the
    /// loop never reaches its cleanup: the link would look up forever and
    /// never redial.
    fn close_link(&self) {
        self.up.borrow_mut().take();
        self.close.notify_one();
    }

    /// Forget every publish awaiting an OK. Dropping the senders resolves the
    /// callers as unanswered, and releases the bytes they reserved.
    fn clear_pending(&self) {
        self.pending.borrow_mut().clear();
        self.pending_bytes.set(0);
    }

    /// Take one waiting publish, releasing the bytes its frame reserved.
    fn take_pending(&self, id: &str) -> Option<oneshot::Sender<(bool, String)>> {
        let entry = self.pending.borrow_mut().remove(id);
        if let Some((_, len, _)) = &entry {
            self.pending_bytes.set(self.pending_bytes.get().saturating_sub(*len));
        }
        entry.map(|(tx, _, _)| tx)
    }

    /// Take the pending publish for `id` only if it is still the one `token`
    /// identifies: a superseded publish ending its own wait must not remove
    /// the replacement registered under the same event id.
    fn take_pending_if(&self, id: &str, token: u64) -> Option<oneshot::Sender<(bool, String)>> {
        let mut map = self.pending.borrow_mut();
        let mine = map.get(id).is_some_and(|(_, _, t)| *t == token);
        let entry = if mine { map.remove(id) } else { None };
        drop(map);
        if let Some((_, len, _)) = &entry {
            self.pending_bytes.set(self.pending_bytes.get().saturating_sub(*len));
        }
        entry.map(|(tx, _, _)| tx)
    }
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
            queued_bytes: Cell::new(0),
            pending_bytes: Cell::new(0),
            pending_seq: Cell::new(0),
            budget: Cell::new(OUTBOUND_BUDGET),
            newest: Cell::new(now_secs().saturating_sub(FIRST_RESUME_SECS)),
            ping_every: Cell::new(PING_EVERY),
            wake: Notify::new(),
            close: Notify::new(),
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
        self.0.clear_pending();
        self.0.queued_bytes.set(0);
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
        let frame = encode_direct_frame(&DirectFrame::Event(event.clone()));
        let len = frame.len();
        // A publish of the same event replaces the waiter already registered
        // for it: release the bytes that entry reserved, or they stay counted
        // against the budget with nothing left to release them.
        self.0.take_pending(&event.id);
        // A bridge that stops reading must not let the unbounded queue grow
        // past the budget. Fail this publish and close the link (the caller
        // falls back to the relays) rather than drop a frame silently.
        if self.0.queued_bytes.get().saturating_add(self.0.pending_bytes.get()).saturating_add(len)
            > self.0.budget.get()
        {
            log::warn!(
                "[Direct] outbound budget ({} bytes) exceeded — closing the link",
                self.0.budget.get()
            );
            self.0.close_link();
            return None;
        }
        let token = self.0.pending_seq.get() + 1;
        self.0.pending_seq.set(token);
        let (tx, rx) = oneshot::channel();
        self.0.pending.borrow_mut().insert(event.id.clone(), (tx, len, token));
        self.0.pending_bytes.set(self.0.pending_bytes.get().saturating_add(len));
        if outbound.send(Message::Text(frame)).is_err() {
            self.0.take_pending_if(&event.id, token);
            return None;
        }
        self.0.queued_bytes.set(self.0.queued_bytes.get().saturating_add(len));
        match tokio::time::timeout(within, rx).await {
            Ok(Ok((true, _))) => Some(PublishResult { verdict: PublishVerdict::Accepted, detail: None }),
            Ok(Ok((false, message))) => Some(PublishResult { verdict: PublishVerdict::Rejected, detail: Some(message) }),
            _ => {
                self.0.take_pending_if(&event.id, token);
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
                // Only Tor reaches an onion service.
                let onion = host.ends_with(".onion");
                if onion && config.proxy.is_none() {
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
        let proxy = if is_onion(endpoint) { self.0.config.proxy.clone() } else { None };
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
        ws.send(Message::Text(encode_direct_frame(&DirectFrame::Hello { auth, since, recipients: self.0.config.recipients.clone() })))
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
                    let len = match &message {
                        Message::Text(text) => text.len(),
                        _ => 0,
                    };
                    // Raced against the close signal: a bridge that stopped
                    // reading can leave this write pending forever.
                    let written = tokio::select! {
                        result = sink.send(message) => result.is_ok(),
                        _ = self.0.close.notified() => false,
                    };
                    if !written { break; }
                    // Written: it no longer occupies the outbound queue.
                    self.0.queued_bytes.set(self.0.queued_bytes.get().saturating_sub(len));
                }
                _ = ping.tick() => {
                    if last_heard.elapsed() > dead_after(self.0.ping_every.get()) {
                        log::info!("[Direct] {endpoint} went silent");
                        break;
                    }
                    let written = tokio::select! {
                        result = sink.send(Message::Ping(Vec::new())) => result.is_ok(),
                        _ = self.0.close.notified() => false,
                    };
                    if !written { break; }
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
                // Idle close: nothing is being written, so end at once.
                _ = self.0.close.notified() => break,
            }
        }
        self.0.up.borrow_mut().take();
        self.0.clear_pending();
        self.0.queued_bytes.set(0);
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
                        tags: event.tags,
                        content: event.content,
                    };
                    (self.0.handlers.on_event)(event);
                } else {
                    log::warn!("[Direct] Dropping an event that does not verify");
                }
                true
            }
            Ok(DirectFrame::Ok { id, accepted, message }) => {
                if let Some(waiter) = self.0.take_pending(&id) {
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

/// Whether `endpoint`'s host is an onion service.
fn is_onion(endpoint: &str) -> bool {
    Url::parse(endpoint).ok().and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase().ends_with(".onion"))).unwrap_or(false)
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
    use crate::test_support::wait_until;
    use protocol::crypto::generate_keypair;
    use tokio::net::TcpListener;
    use tokio::task::LocalSet;

    fn link_with_handlers(config: DirectConfig, handlers: DirectHandlers) -> DirectLink {
        // Not started: the caller drives `connect` / `serve` itself.
        DirectLink(Rc::new(Inner {
            config,
            handlers,
            up: RefCell::default(),
            pending: RefCell::default(),
            queued_bytes: Cell::new(0),
            pending_bytes: Cell::new(0),
            pending_seq: Cell::new(0),
            budget: Cell::new(OUTBOUND_BUDGET),
            newest: Cell::new(0),
            ping_every: Cell::new(PING_EVERY),
            wake: Notify::new(),
            close: Notify::new(),
            task: RefCell::default(),
        }))
    }

    fn link_with(endpoints: &[&str], pin: Option<&str>, proxy: Option<&str>) -> DirectLink {
        // Not started: only `usable` is exercised.
        link_with_handlers(
            DirectConfig {
                endpoints: endpoints.iter().map(|e| e.to_string()).collect(),
                cert_sha256: pin.map(str::to_string),
                proxy: proxy.map(str::to_string),
                recipients: Vec::new(),
                auth: Rc::new(generate_keypair()),
            },
            DirectHandlers { on_event: Rc::new(|_| {}), on_state: Rc::new(|_| {}) },
        )
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
    fn with_orbot_onion_endpoints_are_added_and_the_rest_stay() {
        assert_eq!(
            link_with(&ALL, Some("ab"), Some("127.0.0.1:9050")).usable(),
            ["wss://192.168.1.20:7447", "wss://abc.onion:7447", "ws://abc.onion:7448", "ws://127.0.0.1:7447"],
            "the user's own endpoints are dialled directly, onion ones through Orbot"
        );
    }

    fn a_signed_event(id: &str, content: &str) -> SignedEvent {
        SignedEvent {
            id: id.into(),
            pubkey: "p".repeat(64),
            created_at: 1,
            kind: 4515,
            tags: Vec::new(),
            content: content.into(),
            sig: "s".repeat(64),
        }
    }

    /// A link with its queue open (no serve loop reading it) and a test budget.
    fn up_link(budget: usize) -> (DirectLink, mpsc::UnboundedReceiver<Message>) {
        let link = link_with(&[], None, None);
        link.0.budget.set(budget);
        let (tx, rx) = mpsc::unbounded_channel();
        *link.0.up.borrow_mut() = Some(("ws://127.0.0.1:1".to_string(), tx));
        (link, rx)
    }

    #[tokio::test]
    async fn a_publish_past_the_outbound_budget_fails_and_closes_the_link() {
        LocalSet::new()
            .run_until(async {
                let ev = a_signed_event("e1", &"x".repeat(400));
                let len = encode_direct_frame(&DirectFrame::Event(ev.clone())).len();
                let (link, mut rx) = up_link(len + len / 2);

                // The first publish is queued and waiting for its OK.
                let first = {
                    let (link, ev) = (link.clone(), ev.clone());
                    tokio::task::spawn_local(async move { link.publish(&ev, Duration::from_millis(100)).await })
                };
                let _frame = rx.recv().await.expect("the first frame was queued");

                // The second would push the link past its budget: it fails now
                // and the link closes instead of growing.
                assert!(link.publish(&ev, Duration::from_millis(50)).await.is_none());
                assert!(link.0.up.borrow().is_none(), "the link was closed");
                assert!(first.await.unwrap().is_none(), "the queued publish got no OK");
            })
            .await;
    }

    #[tokio::test]
    async fn an_ok_releases_the_bytes_its_publish_reserved() {
        LocalSet::new()
            .run_until(async {
                let ev = a_signed_event("e1", "hello");
                let len = encode_direct_frame(&DirectFrame::Event(ev.clone())).len();
                // The queued frame plus one more reservation fit, but the
                // queued frame plus two do not.
                let (link, mut rx) = up_link(len * 3 - 1);

                let waiting = {
                    let (link, ev) = (link.clone(), ev.clone());
                    tokio::task::spawn_local(async move { link.publish(&ev, Duration::from_secs(2)).await })
                };
                let _frame = rx.recv().await.expect("the frame was queued");

                let ok = encode_direct_frame(&DirectFrame::Ok {
                    id: "e1".into(),
                    accepted: true,
                    message: String::new(),
                });
                assert!(link.on_frame(&ok));
                assert_eq!(waiting.await.unwrap().unwrap().verdict, PublishVerdict::Accepted);

                // The OK released the reservation: a second publish now fits
                // the budget (without the release it would fail and close the
                // link). Not written (no serve loop), and the link is still up.
                let next = a_signed_event("e2", "hello");
                assert!(
                    link.publish(&next, Duration::from_millis(20)).await.is_none(),
                    "no OK is ever sent for the second publish"
                );
                assert!(rx.try_recv().is_ok(), "the second publish fit the budget after the first released its bytes");
                assert!(link.0.up.borrow().is_some());
            })
            .await;
    }

    #[tokio::test]
    async fn closing_the_link_ends_a_serve_blocked_on_a_write_and_reports_it_down() {
        LocalSet::new()
            .run_until(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("ws://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let (tcp, _) = listener.accept().await.unwrap();
                    let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    // Never read: once the socket buffers fill, a write blocks.
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    let _ = ws.close(None).await;
                });

                let states: Rc<RefCell<Vec<Option<String>>>> = Rc::default();
                let recorded = Rc::clone(&states);
                let link = link_with_handlers(
                    DirectConfig {
                        endpoints: Vec::new(),
                        cert_sha256: None,
                        proxy: None,
                        recipients: Vec::new(),
                        auth: Rc::new(generate_keypair()),
                    },
                    DirectHandlers {
                        on_event: Rc::new(|_| {}),
                        on_state: Rc::new(move |state| recorded.borrow_mut().push(state)),
                    },
                );

                let ws = dial(&url, None, None).await.unwrap();
                let serving = link.clone();
                let endpoint = url.clone();
                let serve = tokio::task::spawn_local(async move { serving.serve(ws, &endpoint).await });
                wait_until(|| states.borrow().last().is_some_and(|s| s.is_some())).await;

                // Larger than the socket buffers: with a peer that never
                // reads, the serve loop cannot finish this write.
                let ev = a_signed_event("big", &"x".repeat(8 * 1024 * 1024));
                let publisher = link.clone();
                let publish =
                    tokio::task::spawn_local(async move { publisher.publish(&ev, Duration::from_secs(10)).await });
                tokio::time::sleep(Duration::from_millis(200)).await;

                link.0.close_link();
                tokio::time::timeout(Duration::from_secs(2), serve)
                    .await
                    .expect("the link ended despite the blocked write")
                    .unwrap();
                assert!(states.borrow().last().is_some_and(|s| s.is_none()), "the link reported itself down");
                assert!(publish.await.unwrap().is_none(), "the pending publish was failed");

                server.abort();
            })
            .await;
    }

    #[tokio::test]
    async fn a_same_id_publish_releases_the_superseded_reservation() {
        LocalSet::new()
            .run_until(async {
                let ev = a_signed_event("e1", "hello");
                let len = encode_direct_frame(&DirectFrame::Event(ev.clone())).len();
                let (link, mut rx) = up_link(len * 4);

                let first = {
                    let (link, ev) = (link.clone(), ev.clone());
                    tokio::task::spawn_local(async move { link.publish(&ev, Duration::from_secs(2)).await })
                };
                let _frame = rx.recv().await.expect("the first frame was queued");

                let second = {
                    let (link, ev) = (link.clone(), ev.clone());
                    tokio::task::spawn_local(async move { link.publish(&ev, Duration::from_secs(2)).await })
                };
                let _frame = rx.recv().await.expect("the replacement frame was queued");
                assert!(first.await.unwrap().is_none(), "the superseded publish got no answer");

                // The superseded waiter released its bytes: with the budget at
                // four frames, a third distinct publish fits only because the
                // first reservation was given back (otherwise it would exceed
                // the budget and close the link).
                let third = a_signed_event("e2", "hello");
                assert!(link.publish(&third, Duration::from_millis(20)).await.is_none(), "no OK is sent");
                assert!(rx.try_recv().is_ok(), "the third publish fit, so the superseded reservation was released");
                assert!(link.0.up.borrow().is_some());

                let ok = encode_direct_frame(&DirectFrame::Ok {
                    id: "e1".into(),
                    accepted: true,
                    message: String::new(),
                });
                assert!(link.on_frame(&ok));
                assert_eq!(second.await.unwrap().unwrap().verdict, PublishVerdict::Accepted);
            })
            .await;
    }

    #[test]
    fn only_onion_endpoints_go_through_the_proxy() {
        assert!(is_onion("wss://abc.onion:7447"));
        assert!(is_onion("ws://ABC.ONION:7448"));
        assert!(!is_onion("wss://192.168.1.20:7447"));
        assert!(!is_onion("wss://laptop.tail1234.ts.net:7447"));
    }

    /// A minimal direct-link server: a fresh self-signed certificate over TLS,
    /// then a WebSocket that sends a CHALLENGE, waits for the HELLO and
    /// answers READY. Returns the `wss://` endpoint and the certificate's
    /// SHA-256 — what the bridge's heartbeat advertises as the pin.
    async fn direct_server() -> (String, String) {
        use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

        let made = rcgen::generate_simple_self_signed(vec!["codedeck-bridge".to_string()]).expect("make a certificate");
        let cert = made.cert.der().to_vec();
        let pin: String = Sha256::digest(&cert).iter().map(|b| format!("{b:02x}")).collect();
        let key = made.key_pair.serialize_der();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .expect("a valid certificate and key");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the direct server");
        let addr = listener.local_addr().expect("the direct server's address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls).await else { return };
                    let challenge = encode_direct_frame(&DirectFrame::Challenge("challenge".to_string()));
                    if ws.send(Message::Text(challenge)).await.is_err() {
                        return;
                    }
                    while let Some(Ok(message)) = ws.next().await {
                        if let Message::Text(text) = message {
                            if matches!(decode_direct_frame(&text), Ok(DirectFrame::Hello { .. })) {
                                let _ = ws.send(Message::Text(encode_direct_frame(&DirectFrame::Ready))).await;
                                break;
                            }
                        }
                    }
                    // Stay open until the client closes: a READY it has not
                    // read yet must not be lost to an abrupt close.
                    while let Some(Ok(_)) = ws.next().await {}
                });
            }
        });
        (format!("wss://{addr}"), pin)
    }

    /// A direct link's certificate is trusted only when it is exactly the one
    /// the bridge advertised, so a LAN man-in-the-middle (or a rebinding DNS
    /// answer) cannot impersonate the bridge even though no CA vouches for it.
    #[tokio::test]
    async fn a_direct_link_refuses_a_certificate_that_does_not_match_the_pin_and_connects_with_the_matching_one() {
        let (endpoint, pin) = direct_server().await;

        let wrong = link_with(&[&endpoint], Some(&"00".repeat(32)), None);
        let err = match wrong.connect(&endpoint).await {
            Ok(_) => panic!("a certificate that is not the pinned one must not bring the link up"),
            Err(err) => err,
        };
        assert!(
            err.contains("does not match the bridge's pin"),
            "the handshake must fail on the pin, not for another reason: {err}"
        );

        let right = link_with(&[&endpoint], Some(&pin), None);
        right.connect(&endpoint).await.expect("the advertised pin brings the link up");
    }

    /// An `.onion` endpoint is only reachable through Tor, so it is dialled
    /// through the proxy — and by name, since the phone's own resolver cannot
    /// resolve onion addresses at all.
    #[tokio::test]
    async fn an_onion_direct_endpoint_is_dialled_through_the_proxy_by_name() {
        let (proxy, request) = crate::test_support::socks5_proxy().await;
        let err = match dial("ws://abc.onion:7447", Some(proxy.to_string()), None).await {
            Ok(_) => panic!("the proxy closes after CONNECT, so no link can come up"),
            Err(err) => err,
        };
        assert!(!err.starts_with("socks5:"), "the proxy answered, so the dial must not fail in SOCKS5: {err}");

        let request = tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .expect("the onion endpoint was not dialled through the SOCKS5 proxy")
            .expect("the SOCKS5 proxy reported its CONNECT");
        assert_eq!(request.atyp, 3, "an onion address must be resolved by Tor, not by the phone's resolver");
        assert_eq!(request.host, "abc.onion");
        assert_eq!(request.port, 7447);
    }

    /// A direct link to the user's own bridge is not relay traffic: it is
    /// dialled directly even while Orbot is set, and Orbot never sees it.
    #[tokio::test]
    async fn a_direct_endpoint_on_the_lan_is_dialled_directly_even_when_a_proxy_is_set() {
        let (endpoint, pin) = direct_server().await;
        // A listening address, not a dead one: an endpoint wrongly sent
        // through the proxy would reach this listener and fail there instead
        // of coming up.
        let (proxy, proxy_connections) = crate::test_support::counting_listener().await;
        let link = link_with(&[&endpoint], Some(&pin), Some(&proxy.to_string()));

        link.connect(&endpoint).await.expect("a LAN endpoint is dialled directly, not through Orbot");
        assert_eq!(
            proxy_connections.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a non-onion direct endpoint was sent through the proxy"
        );
    }
}
