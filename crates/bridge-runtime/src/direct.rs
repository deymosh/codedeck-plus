//! The direct link server: phones reach the bridge over its own WebSocket,
//! beside the relays (the wire is `protocol::direct`).
//!
//! - `wss://` on [`DirectConfig::listen`], with a self-signed certificate
//!   kept in `<home>/direct/`; the heartbeat advertises its SHA-256, which
//!   phones pin (no CA: private addresses and VPN names work).
//! - `ws://` on [`DirectConfig::onion_listen`], loopback only, for an onion
//!   service to forward to.
//!
//! A connection must finish its TLS and WebSocket handshakes within
//! [`HANDSHAKE_TIMEOUT`], then answer the challenge with a paired identity's
//! HELLO within [`HELLO_TIMEOUT`]. Then it gets every event the bridge publishes
//! for that identity (and those of the last hour since its resume point),
//! and its command events go to the engine exactly as a relay's would: the
//! engine drops one it already saw by its id. Unpairing a phone closes its
//! connections.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use bridge_core::{InboundEvent, Input, Via};
use futures_util::{SinkExt, StreamExt};
use protocol::direct::{
    check_direct_auth, decode_direct_frame, encode_direct_frame, event_is_valid, DirectFrame, DirectInfo, OUTBOX_SECS,
};
use protocol::kinds::COMMAND_KIND;
use protocol::nostr_event::SignedEvent;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::config::DirectConfig;

/// How long a new connection has for its TLS and WebSocket handshakes.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long it then has to say HELLO. The phone signs it with its identity,
/// which may wait on the user approving it in a signer app.
const HELLO_TIMEOUT: Duration = Duration::from_secs(60);
/// A connection silent this long (the phone pings well within it) is dropped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(400);
/// Connections served at once, authenticated or not.
const MAX_CONNECTIONS: usize = 64;
/// Events kept for resuming, at most (besides [`OUTBOX_SECS`]).
const OUTBOX_CAP: usize = 5000;
/// Largest frame accepted from a phone. Commands are small; an image goes
/// through Blossom or relay-sized chunks.
const MAX_FRAME_BYTES: usize = 256 * 1024;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn short(key: &str) -> &str {
    &key[..8.min(key.len())]
}

/// What the runtime needs of a running direct link.
pub struct Direct {
    pub hub: Rc<Hub>,
    /// What the heartbeat advertises.
    pub info: DirectInfo,
    tasks: Vec<JoinHandle<()>>,
}

impl Direct {
    pub fn shutdown(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.hub.close_all();
    }
}

/// The live connections and the outbox, shared by the listeners and the
/// publisher.
pub struct Hub {
    bridge_pubkey: String,
    inputs: mpsc::UnboundedSender<Input>,
    paired: RefCell<HashSet<String>>,
    conns: RefCell<HashMap<u64, Conn>>,
    next_id: Cell<u64>,
    /// Published events, oldest first, with the identity each is for.
    outbox: RefCell<VecDeque<(String, SignedEvent)>>,
    open: Cell<usize>,
}

struct Conn {
    identity: String,
    frames: mpsc::UnboundedSender<String>,
}

impl Hub {
    pub fn new(bridge_pubkey: String, inputs: mpsc::UnboundedSender<Input>) -> Rc<Self> {
        Rc::new(Self {
            bridge_pubkey,
            inputs,
            paired: RefCell::default(),
            conns: RefCell::default(),
            next_id: Cell::new(0),
            outbox: RefCell::default(),
            open: Cell::new(0),
        })
    }

    /// The identities allowed to connect. Connections of any other are
    /// closed.
    pub fn set_paired(&self, identities: &[String]) {
        let paired: HashSet<String> = identities.iter().cloned().collect();
        self.conns.borrow_mut().retain(|_, c| paired.contains(&c.identity));
        self.outbox.borrow_mut().retain(|(identity, _)| paired.contains(identity));
        *self.paired.borrow_mut() = paired;
    }

    /// `event`, published for `identity`: to its connections now, and to the
    /// outbox for one that resumes later.
    pub fn deliver(&self, identity: &str, event: &SignedEvent) {
        let now = now_secs();
        {
            let mut outbox = self.outbox.borrow_mut();
            while outbox.front().is_some_and(|(_, e)| e.created_at + OUTBOX_SECS < now) || outbox.len() >= OUTBOX_CAP {
                outbox.pop_front();
            }
            outbox.push_back((identity.to_string(), event.clone()));
        }
        let frame = encode_direct_frame(&DirectFrame::Event(event.clone()));
        for conn in self.conns.borrow().values().filter(|c| c.identity == identity) {
            let _ = conn.frames.send(frame.clone());
        }
    }

    /// What was published for `identity` from `since` (seconds) on.
    fn since(&self, identity: &str, since: u64) -> Vec<SignedEvent> {
        self.outbox
            .borrow()
            .iter()
            .filter(|(i, e)| i == identity && e.created_at >= since)
            .map(|(_, e)| e.clone())
            .collect()
    }

    fn register(&self, identity: &str) -> (u64, mpsc::UnboundedReceiver<String>) {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        let (frames, rx) = mpsc::unbounded_channel();
        self.conns.borrow_mut().insert(id, Conn { identity: identity.to_string(), frames });
        (id, rx)
    }

    fn unregister(&self, id: u64) {
        self.conns.borrow_mut().remove(&id);
    }

    fn close_all(&self) {
        self.conns.borrow_mut().clear();
    }

    /// Hand a phone's event to the engine if it is a command from `identity`
    /// to this bridge; the answer for its `OK`.
    fn accept(&self, identity: &str, event: SignedEvent) -> Result<(), &'static str> {
        if event.kind != COMMAND_KIND {
            return Err("invalid: not a command");
        }
        if event.pubkey != identity {
            return Err("invalid: not from the authenticated identity");
        }
        let to_us = event
            .tags
            .iter()
            .any(|t| t.first().map(String::as_str) == Some("p") && t.get(1) == Some(&self.bridge_pubkey));
        if !to_us {
            return Err("invalid: not addressed to this bridge");
        }
        if !event_is_valid(&event) {
            return Err("invalid: bad signature");
        }
        let inbound = InboundEvent { id: event.id, pubkey: event.pubkey, created_at: event.created_at, content: event.content };
        let _ = self.inputs.send(Input::RelayEvent { event: inbound, via: Via::Commands });
        Ok(())
    }
}

/// Start the listeners `config` asks for; `None` when it asks for none.
pub async fn start(
    config: &DirectConfig,
    home: &Path,
    bridge_pubkey: String,
    inputs: mpsc::UnboundedSender<Input>,
) -> Result<Option<Direct>, String> {
    if !config.enabled() {
        log::info!("[Direct] Off (no direct listener configured)");
        return Ok(None);
    }
    let hub = Hub::new(bridge_pubkey, inputs);
    let mut tasks = Vec::new();
    let mut bound_wss = None;
    let mut cert_sha256 = None;

    if let Some(addr) = config.listen {
        let cert = Certificate::load_or_create(&home.join("direct"))?;
        cert_sha256 = Some(cert.sha256_hex());
        let acceptor = cert.acceptor()?;
        let listener = TcpListener::bind(addr).await.map_err(|e| format!("direct link: cannot listen on {addr}: {e}"))?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?;
        bound_wss = Some(bound);
        log::info!("[Direct] Listening on wss://{bound} (certificate sha256 {})", cert.sha256_hex());
        let hub = Rc::clone(&hub);
        tasks.push(tokio::task::spawn_local(async move {
            accept_loop(listener, hub, move |stream| {
                let acceptor = acceptor.clone();
                async move { acceptor.accept(stream).await.ok() }
            })
            .await
        }));
    }
    if let Some(addr) = config.onion_listen {
        let listener = TcpListener::bind(addr).await.map_err(|e| format!("direct link: cannot listen on {addr}: {e}"))?;
        log::info!("[Direct] Listening on ws://{addr} for an onion service");
        let hub = Rc::clone(&hub);
        tasks.push(tokio::task::spawn_local(async move {
            accept_loop(listener, hub, |stream| async move { Some(stream) }).await
        }));
    }
    let endpoints = advertised_endpoints(config, bound_wss, in_container());
    for endpoint in &endpoints {
        log::info!("[Direct] Advertising {endpoint}");
    }
    if endpoints.is_empty() {
        log::info!(
            "[Direct] Advertising no address: in a container the bridge sees only its own. \
             Add the host's address to direct.endpoints, or on the phone (the machine's page)."
        );
    }
    Ok(Some(Direct { hub, info: DirectInfo { endpoints, cert_sha256 }, tasks }))
}

/// The endpoints the heartbeat advertises: the configured ones, led by the
/// `wss://` listener's LAN address when none of them is a `wss://` one —
/// except in a container, whose "LAN address" is its own on the container
/// network, which no phone can reach. The certificate pin rides the
/// heartbeat either way, so an address added on the phone still works.
fn advertised_endpoints(config: &DirectConfig, wss_listener: Option<SocketAddr>, in_container: bool) -> Vec<String> {
    let mut endpoints = config.endpoints.clone();
    if let Some(bound) = wss_listener {
        let explicit = !bound.ip().is_unspecified();
        if !endpoints.iter().any(|e| e.starts_with("wss://")) && (explicit || !in_container) {
            endpoints.insert(0, format!("wss://{}", advertised(bound)));
        }
    }
    endpoints
}

/// Whether the bridge runs in a container (Docker leaves `/.dockerenv`,
/// Podman `/run/.containerenv`).
fn in_container() -> bool {
    std::path::Path::new("/.dockerenv").exists() || std::path::Path::new("/run/.containerenv").exists()
}

/// One line for the start banner and `status`: what phones are told to
/// dial and what the bridge listens on, or "off".
pub fn summary(config: &DirectConfig) -> String {
    if !config.enabled() {
        return "off".into();
    }
    let listening: Vec<String> = config
        .listen
        .map(|a| format!("wss on {a}"))
        .into_iter()
        .chain(config.onion_listen.map(|a| format!("onion service on {a}")))
        .collect();
    let endpoints = advertised_endpoints(config, config.listen, in_container());
    let advertised = if endpoints.is_empty() { "no address advertised".to_string() } else { endpoints.join(", ") };
    format!("{advertised} (listening: {})", listening.join(", "))
}

/// The address phones on the LAN reach `bound` at: itself, or for a
/// wildcard bind the address of the interface the default route uses.
fn advertised(bound: SocketAddr) -> SocketAddr {
    if !bound.ip().is_unspecified() {
        return bound;
    }
    SocketAddr::new(lan_ip().unwrap_or(bound.ip()), bound.port())
}

/// This machine's LAN address: the source address the OS would pick for an
/// outside destination. Connecting a UDP socket sends nothing.
fn lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    socket.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_unspecified() && !ip.is_loopback())
}

async fn accept_loop<S, F, Fut>(listener: TcpListener, hub: Rc<Hub>, secure: F)
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
    F: Fn(tokio::net::TcpStream) -> Fut + 'static,
    Fut: std::future::Future<Output = Option<S>> + 'static,
{
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(err) => {
                log::warn!("[Direct] Accept failed: {err}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        if hub.open.get() >= MAX_CONNECTIONS {
            log::warn!("[Direct] Refusing {peer}: {MAX_CONNECTIONS} connections open");
            continue;
        }
        hub.open.set(hub.open.get() + 1);
        let hub = Rc::clone(&hub);
        let secured = secure(stream);
        tokio::task::spawn_local(async move {
            if let Ok(Some(stream)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, secured).await {
                serve(stream, &hub).await;
            }
            hub.open.set(hub.open.get() - 1);
        });
    }
}

/// One connection: the handshake, then events both ways.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(stream: S, hub: &Hub) {
    let config = WebSocketConfig { max_message_size: Some(MAX_FRAME_BYTES), max_frame_size: Some(MAX_FRAME_BYTES), ..Default::default() };
    let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await
    else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let send = |frame: &DirectFrame| Message::Text(encode_direct_frame(frame));

    let challenge = hex::encode(rand::random::<[u8; 16]>());
    if sink.send(send(&DirectFrame::Challenge(challenge.clone()))).await.is_err() {
        return;
    }
    let hello = tokio::time::timeout(HELLO_TIMEOUT, next_text(&mut source)).await.ok().flatten();
    let (auth, since) = match hello.as_deref().map(decode_direct_frame) {
        Some(Ok(DirectFrame::Hello { auth, since })) => (auth, since),
        _ => {
            let _ = sink.send(send(&DirectFrame::Closed("expected HELLO".into()))).await;
            return;
        }
    };
    let identity = match check_direct_auth(&auth, &challenge, now_secs()) {
        Ok(identity) if hub.paired.borrow().contains(&identity) => identity,
        Ok(_) => {
            let _ = sink.send(send(&DirectFrame::Closed("not paired".into()))).await;
            return;
        }
        Err(err) => {
            let _ = sink.send(send(&DirectFrame::Closed(err.to_string()))).await;
            return;
        }
    };

    let (id, mut outbound) = hub.register(&identity);
    log::info!("[Direct] {}... connected", short(&identity));
    let mut ok = sink.send(send(&DirectFrame::Ready)).await.is_ok();
    for event in hub.since(&identity, since) {
        ok = ok && sink.send(send(&DirectFrame::Event(event))).await.is_ok();
    }
    while ok {
        tokio::select! {
            frame = outbound.recv() => match frame {
                Some(text) => ok = sink.send(Message::Text(text)).await.is_ok(),
                None => {
                    // Unpaired, or the bridge is stopping.
                    let _ = sink.send(send(&DirectFrame::Closed("closed".into()))).await;
                    ok = false;
                }
            },
            incoming = tokio::time::timeout(IDLE_TIMEOUT, source.next()) => match incoming {
                Ok(Some(Ok(Message::Text(text)))) => match decode_direct_frame(&text) {
                    Ok(DirectFrame::Event(event)) => {
                        let id = event.id.clone();
                        let answer = hub.accept(&identity, event);
                        let frame = DirectFrame::Ok { id, accepted: answer.is_ok(), message: answer.err().unwrap_or("").to_string() };
                        ok = sink.send(send(&frame)).await.is_ok();
                    }
                    _ => {
                        let _ = sink.send(send(&DirectFrame::Closed("unexpected frame".into()))).await;
                        ok = false;
                    }
                },
                // Pings are answered by the WebSocket layer on the next
                // write; flush so a phone that only pings gets its pong.
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => ok = sink.flush().await.is_ok(),
                Ok(Some(Ok(Message::Binary(_) | Message::Frame(_)))) => {}
                _ => ok = false,
            },
        }
    }
    hub.unregister(id);
    log::info!("[Direct] {}... disconnected", short(&identity));
}

async fn next_text<S>(source: &mut S) -> Option<String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match source.next().await? {
            Ok(Message::Text(text)) => return Some(text),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

/// The direct link's self-signed certificate and key, made once and kept.
struct Certificate {
    cert: Vec<u8>,
    key: Vec<u8>,
}

impl Certificate {
    fn load_or_create(dir: &Path) -> Result<Self, String> {
        let (cert_path, key_path) = (dir.join("cert.der"), dir.join("key.der"));
        if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            return Ok(Self { cert, key });
        }
        let made = rcgen::generate_simple_self_signed(vec!["codedeck-bridge".to_string()])
            .map_err(|e| format!("direct link: cannot make a certificate: {e}"))?;
        let this = Self { cert: made.cert.der().to_vec(), key: made.key_pair.serialize_der() };
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        crate::state::restrict(dir, 0o700);
        std::fs::write(&key_path, &this.key).map_err(|e| format!("cannot write {}: {e}", key_path.display()))?;
        crate::state::restrict(&key_path, 0o600);
        std::fs::write(&cert_path, &this.cert).map_err(|e| format!("cannot write {}: {e}", cert_path.display()))?;
        Ok(this)
    }

    fn sha256_hex(&self) -> String {
        hex::encode(Sha256::digest(&self.cert))
    }

    fn acceptor(&self) -> Result<tokio_rustls::TlsAcceptor, String> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.cert.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone())),
            )
            .map_err(|e| format!("direct link: bad certificate: {e}"))?;
        Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::generate_keypair;
    use protocol::nip42::build_auth_event;

    #[test]
    fn a_container_does_not_advertise_its_own_address() {
        let wildcard: SocketAddr = "0.0.0.0:7447".parse().unwrap();
        let config = DirectConfig { listen: Some(wildcard), ..DirectConfig::default() };
        // On a host: the LAN address (whatever this machine's is).
        assert_eq!(advertised_endpoints(&config, Some(wildcard), false).len(), 1);
        // In a container: nothing, unless configured.
        assert!(advertised_endpoints(&config, Some(wildcard), true).is_empty());
        let configured = DirectConfig { endpoints: vec!["wss://192.168.1.20:7447".into()], ..config.clone() };
        assert_eq!(advertised_endpoints(&configured, Some(wildcard), true), vec!["wss://192.168.1.20:7447"]);
        // A listener bound to one address advertises that address anywhere.
        let bound: SocketAddr = "192.168.1.20:7447".parse().unwrap();
        assert_eq!(advertised_endpoints(&DirectConfig { listen: Some(bound), ..DirectConfig::default() }, Some(bound), true), vec!["wss://192.168.1.20:7447"]);
    }

    #[test]
    fn the_summary_names_what_phones_dial_and_what_is_listening() {
        assert_eq!(summary(&DirectConfig::default()), "off");
        let lan = DirectConfig {
            listen: Some("0.0.0.0:7447".parse().unwrap()),
            onion_listen: None,
            endpoints: vec!["wss://192.168.1.18:7447".into()],
        };
        assert_eq!(summary(&lan), "wss://192.168.1.18:7447 (listening: wss on 0.0.0.0:7447)");
        // No wss:// endpoint configured: the listener's own address leads.
        let both = DirectConfig {
            listen: Some("127.0.0.1:7447".parse().unwrap()),
            onion_listen: Some("127.0.0.1:7448".parse().unwrap()),
            endpoints: vec!["ws://abc.onion:7448".into()],
        };
        assert_eq!(
            summary(&both),
            "wss://127.0.0.1:7447, ws://abc.onion:7448 (listening: wss on 127.0.0.1:7447, onion service on 127.0.0.1:7448)"
        );
    }

    fn command(from: &protocol::crypto::Keypair, to: &str) -> SignedEvent {
        let keys = nostr::Keys::new(from.secret_key.clone());
        let tag = nostr::Tag::public_key(nostr::PublicKey::from_hex(to).unwrap());
        let event = nostr::EventBuilder::new(nostr::Kind::Custom(COMMAND_KIND), "x").tag(tag).sign_with_keys(&keys).unwrap();
        SignedEvent::from_nostr(&event)
    }

    #[test]
    fn the_outbox_keeps_an_hour_per_identity() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into(), "q".into()]);
        let old = SignedEvent { created_at: now_secs() - OUTBOX_SECS - 5, ..command(&generate_keypair(), &generate_keypair().pubkey_hex) };
        let new = command(&generate_keypair(), &generate_keypair().pubkey_hex);
        hub.deliver("p", &old);
        hub.deliver("p", &new);
        hub.deliver("q", &new);
        assert_eq!(hub.since("p", 0), std::slice::from_ref(&new), "the stale one was dropped");
        assert!(hub.since("p", new.created_at + 1).is_empty());
        hub.set_paired(&["p".into()]);
        assert!(hub.since("q", 0).is_empty(), "an unpaired identity's events go");
    }

    #[test]
    fn only_commands_from_the_identity_to_this_bridge_are_accepted() {
        let (inputs, mut rx) = mpsc::unbounded_channel();
        let (bridge, phone) = (generate_keypair(), generate_keypair());
        let hub = Hub::new(bridge.pubkey_hex.clone(), inputs);
        assert!(hub.accept(&phone.pubkey_hex, command(&phone, &bridge.pubkey_hex)).is_ok());
        assert!(matches!(rx.try_recv(), Ok(Input::RelayEvent { via: Via::Commands, .. })));
        assert!(hub.accept(&phone.pubkey_hex, command(&generate_keypair(), &bridge.pubkey_hex)).is_err());
        assert!(hub.accept(&phone.pubkey_hex, command(&phone, &generate_keypair().pubkey_hex)).is_err());
        let mut forged = command(&phone, &bridge.pubkey_hex);
        forged.content = "tampered".into();
        assert!(hub.accept(&phone.pubkey_hex, forged).is_err());
        let auth = build_auth_event(&phone, "wss://x", "c", now_secs() * 1000).unwrap();
        assert!(hub.accept(&phone.pubkey_hex, auth).is_err(), "not a command");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_certificate_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let first = Certificate::load_or_create(dir.path()).unwrap();
        let again = Certificate::load_or_create(dir.path()).unwrap();
        assert_eq!(first.sha256_hex(), again.sha256_hex());
        assert_eq!(first.sha256_hex().len(), 64);
        assert!(first.acceptor().is_ok());
    }
}
