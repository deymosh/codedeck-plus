//! The direct link server: phones reach the bridge over its own WebSocket,
//! beside the relays (the wire is `protocol::direct`).
//!
//! - `wss://` on [`DirectConfig::listen`], with a self-signed certificate
//!   kept in `<home>/direct/`; the heartbeat advertises its SHA-256, which
//!   phones pin (no CA: private addresses and VPN names work).
//! - `ws://` on [`DirectConfig::onion_listen`], loopback only, for an onion
//!   service to forward to.
//!
//! The `wss://` listener also serves the bridge's web page (`crate::web`): a
//! request that is not a WebSocket upgrade is a page request. The onion
//! listener serves no page.
//!
//! A connection must finish its TLS and WebSocket handshakes within
//! `HANDSHAKE_TIMEOUT`, then answer the challenge with a paired identity's
//! HELLO within `HELLO_TIMEOUT`. Then it gets every event the bridge publishes
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
use protocol::kinds::{COMMAND_KIND, LIVE_KIND};
use protocol::nostr_event::SignedEvent;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
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
/// Connections one host holds at once (an IPv6 host by its /64). A phone
/// holds one and a browser a few; the cap keeps a single host — a flood of
/// page requests or of handshakes left hanging — from taking the slots the
/// phones need.
const MAX_CONNECTIONS_PER_HOST: usize = 8;
/// Events kept for resuming, at most (besides [`OUTBOX_SECS`]).
const OUTBOX_CAP: usize = 5000;
/// Largest frame accepted from a phone. Commands are small; an image goes
/// through Blossom or relay-sized chunks.
const MAX_FRAME_BYTES: usize = 256 * 1024;
/// How many terminal-output frames one connection may have waiting. Bounded,
/// because a terminal is the bridge's lowest-priority traffic: when the lane
/// is full the oldest frame is dropped, and the phone sees a gap in the
/// terminal's byte offsets and asks for a replay from the ring. A lost frame
/// costs a round trip, never the phone's other traffic.
const TERMINAL_LANE_CAP: usize = 64;
/// Frames queued for one connection, a guard on the queue's own overhead.
/// Together with [`FRAME_LANE_BYTES`] it bounds a queue only while the
/// connection is stalled; a pass larger than either bound is not by itself a
/// reason to close it (see [`FRAME_LANE_STALL`]).
const FRAME_LANE_CAP: usize = 4096;
/// Bytes of frames one connection may have waiting. Checked together with
/// [`FRAME_LANE_STALL`]: exceeding it while the serve loop is still taking
/// frames is a big burst (a sync sends every unacked chunk in one tick), not
/// a phone that stopped reading.
const FRAME_LANE_BYTES: usize = 64 * 1024 * 1024;
/// How long a connection may go without the serve loop taking a frame before
/// a queue over either bound means it stopped reading. A queue that grows
/// past the bound while frames are still going out is just a big sync pass;
/// closing it there would make a pass larger than the bound impossible to
/// deliver, as the phone would reconnect and be handed the same pass again.
const FRAME_LANE_STALL: Duration = Duration::from_secs(30);

/// The bounds one direct-link server runs with. Production uses the numbers
/// above; a test passes small ones, so it never opens sixty-four sockets or
/// waits out a production timeout to see a refusal.
#[derive(Clone, Copy)]
struct Limits {
    handshake: Duration,
    hello: Duration,
    idle: Duration,
    max_connections: usize,
    max_per_host: usize,
    max_frame_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            handshake: HANDSHAKE_TIMEOUT,
            hello: HELLO_TIMEOUT,
            idle: IDLE_TIMEOUT,
            max_connections: MAX_CONNECTIONS,
            max_per_host: MAX_CONNECTIONS_PER_HOST,
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn short(key: &str) -> &str {
    &key[..8.min(key.len())]
}

/// What the runtime needs of a running direct link.
pub struct Direct {
    pub hub: Rc<Hub>,
    /// The web page served on the `wss://` listener.
    pub web: Rc<crate::web::Web>,
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
    /// Connections open now by host (`web::rate_key`).
    open_by_host: RefCell<HashMap<std::net::IpAddr, usize>>,
}

struct Conn {
    identity: String,
    /// The recipient tags its `HELLO` named: only those copies go to it.
    recipients: HashSet<String>,
    frames: Rc<FrameLane>,
    /// Terminal output for this connection, on a lane of its own: it goes out
    /// only when `frames` has nothing waiting, so a terminal can never delay
    /// the phone's other traffic.
    term: Rc<TermLane>,
}

/// A connection's ordinary lane. Shared between the publisher (which pushes)
/// and the connection's serve loop (which takes frames out and is woken by
/// it). It keeps its own queue rather than a bounded channel so a burst
/// larger than the bounds can still be delivered to a phone that is reading:
/// the bounds decide whether the phone has *stopped* reading, not how big one
/// publish pass may be.
struct FrameLane {
    queue: RefCell<VecDeque<String>>,
    bytes: Cell<usize>,
    /// When the serve loop last took a frame out.
    last_taken: Cell<std::time::Instant>,
    /// Whether the publisher gave up on this connection.
    closed: Cell<bool>,
    wake: tokio::sync::Notify,
}

impl FrameLane {
    fn new() -> Self {
        Self {
            queue: RefCell::new(VecDeque::new()),
            bytes: Cell::new(0),
            last_taken: Cell::new(std::time::Instant::now()),
            closed: Cell::new(false),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// Queue a frame; false once the connection has been closed as stalled.
    /// An over-cap queue while frames are still being taken is accepted: it
    /// is a big burst, and the phone will drain it.
    fn push(&self, frame: String) -> bool {
        if self.closed.get() {
            return false;
        }
        let mut queue = self.queue.borrow_mut();
        // The stall clock runs only while frames wait: a link that sat idle
        // has not stalled, and its next burst starts the clock afresh.
        if queue.is_empty() {
            self.last_taken.set(std::time::Instant::now());
        }
        let over = self.bytes.get() + frame.len() > FRAME_LANE_BYTES || queue.len() >= FRAME_LANE_CAP;
        if over && self.last_taken.get().elapsed() >= FRAME_LANE_STALL {
            drop(queue);
            self.closed.set(true);
            self.wake.notify_one();
            return false;
        }
        self.bytes.set(self.bytes.get() + frame.len());
        queue.push_back(frame);
        drop(queue);
        self.wake.notify_one();
        true
    }

    fn pop(&self) -> Option<String> {
        let frame = self.queue.borrow_mut().pop_front()?;
        self.bytes.set(self.bytes.get().saturating_sub(frame.len()));
        self.last_taken.set(std::time::Instant::now());
        Some(frame)
    }

    fn is_closed(&self) -> bool {
        self.closed.get()
    }

    /// Stop accepting frames and wake the serve loop, which sends its
    /// `closed` frame and ends. The lane is shared with that loop, so
    /// dropping the connection is not enough to end it.
    fn close(&self) {
        self.closed.set(true);
        self.wake.notify_one();
    }

    /// Ready once a frame is waiting or the lane is closed. A `push` while
    /// nobody waits leaves `Notify`'s permit behind, so no wake-up is lost
    /// between the check and the wait.
    async fn ready(&self) {
        while self.queue.borrow().is_empty() && !self.closed.get() {
            self.wake.notified().await;
        }
    }

    /// Pretend the serve loop has taken nothing for longer than the stall
    /// window.
    #[cfg(test)]
    fn stall_for_test(&self) {
        self.last_taken.set(std::time::Instant::now() - FRAME_LANE_STALL - Duration::from_secs(1));
    }
}

/// A connection's low-priority lane: terminal-output frames, bounded, oldest
/// dropped first when full. Shared between the publisher (which pushes) and
/// the connection's serve loop (which sends and is woken by it).
#[derive(Default)]
struct TermLane {
    queue: RefCell<VecDeque<String>>,
    wake: tokio::sync::Notify,
}

impl TermLane {
    fn push(&self, frame: String) {
        {
            let mut queue = self.queue.borrow_mut();
            if queue.len() >= TERMINAL_LANE_CAP {
                queue.pop_front();
            }
            queue.push_back(frame);
        }
        self.wake.notify_one();
    }

    fn pop(&self) -> Option<String> {
        self.queue.borrow_mut().pop_front()
    }

    /// Ready once a frame is waiting. A `push` while nobody waits leaves
    /// `Notify`'s permit behind, so no wake-up is lost between the check and
    /// the wait.
    async fn ready(&self) {
        while self.queue.borrow().is_empty() {
            self.wake.notified().await;
        }
    }
}

impl Conn {
    fn reads(&self, identity: &str, event: &SignedEvent) -> bool {
        self.identity == identity && recipient_of(event).is_some_and(|tag| self.recipients.contains(tag))
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // Every path that forgets a connection — unpairing, shutdown, a
        // stalled lane — must also end its serve loop. The loop holds its
        // own reference to the lane, so closing it is what ends the loop.
        self.frames.close();
    }
}

/// The recipient tag of a copy the bridge published.
fn recipient_of(event: &SignedEvent) -> Option<&str> {
    event
        .tags
        .iter()
        .find(|t| t.first().map(String::as_str) == Some(protocol::recipients::RECIPIENT_TAG))
        .and_then(|t| t.get(1))
        .map(String::as_str)
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
            open_by_host: RefCell::default(),
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

    /// `event`, published for `identity`: to its connections that read its
    /// copy now, and to the outbox for one that resumes later. `terminal` says
    /// the copy is terminal output, which rides the connection's low-priority
    /// lane instead of its normal one.
    pub fn deliver(&self, identity: &str, event: &SignedEvent, terminal: bool) {
        let now = now_secs();
        {
            let mut outbox = self.outbox.borrow_mut();
            while outbox.front().is_some_and(|(_, e)| e.created_at + OUTBOX_SECS < now) || outbox.len() >= OUTBOX_CAP {
                outbox.pop_front();
            }
            outbox.push_back((identity.to_string(), event.clone()));
        }
        let frame = encode_direct_frame(&DirectFrame::Event(event.clone()));
        let mut full = Vec::new();
        {
            let conns = self.conns.borrow();
            for (id, conn) in conns.iter().filter(|(_, c)| c.reads(identity, event)) {
                if terminal {
                    conn.term.push(frame.clone());
                } else if !conn.frames.push(frame.clone()) {
                    // The phone has stopped taking frames: close the
                    // connection so it reconnects and resyncs, rather than
                    // growing the queue without limit.
                    full.push(*id);
                }
            }
        }
        if full.is_empty() {
            return;
        }
        let mut conns = self.conns.borrow_mut();
        for id in &full {
            conns.remove(id);
        }
        log::warn!("[Direct] Closed {} connection(s) that stopped reading", full.len());
    }

    /// What was published for connection `id` from `since` (seconds) on.
    fn since(&self, id: u64, since: u64) -> Vec<SignedEvent> {
        let conns = self.conns.borrow();
        let Some(conn) = conns.get(&id) else { return Vec::new() };
        self.outbox
            .borrow()
            .iter()
            .filter(|(i, e)| e.created_at >= since && conn.reads(i, e))
            .map(|(_, e)| e.clone())
            .collect()
    }

    fn register(&self, identity: &str, recipients: Vec<String>) -> (u64, Rc<FrameLane>, Rc<TermLane>) {
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        let frames = Rc::new(FrameLane::new());
        let term = Rc::new(TermLane::default());
        let conn = Conn {
            identity: identity.to_string(),
            recipients: recipients.into_iter().collect(),
            frames: Rc::clone(&frames),
            term: Rc::clone(&term),
        };
        self.conns.borrow_mut().insert(id, conn);
        (id, frames, term)
    }

    fn unregister(&self, id: u64) {
        self.conns.borrow_mut().remove(&id);
    }

    fn close_all(&self) {
        self.conns.borrow_mut().clear();
    }

    /// Hand a phone's event to the engine if it is a command from `identity`
    /// to this bridge, or terminal input on the live kind (the engine takes
    /// only `terminal-input` on that kind); the answer for its `OK`.
    fn accept(&self, identity: &str, event: SignedEvent) -> Result<(), &'static str> {
        if event.kind != COMMAND_KIND && event.kind != LIVE_KIND {
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
        let inbound = InboundEvent { id: event.id, pubkey: event.pubkey, created_at: event.created_at, content: event.content, kind: event.kind };
        let _ = self.inputs.send(Input::RelayEvent { event: inbound, via: Via::Direct });
        Ok(())
    }
}

/// Start the listeners `config` asks for; `None` when it asks for none.
/// `web_config` is what the page's config API reads and writes.
pub async fn start(
    config: &DirectConfig,
    home: &Path,
    bridge_pubkey: String,
    inputs: mpsc::UnboundedSender<Input>,
    web_config: crate::web::ConfigView,
) -> Result<Option<Direct>, String> {
    if !config.enabled() {
        log::info!("[Direct] Off (no direct listener configured)");
        return Ok(None);
    }
    let npub = protocol::crypto::npub_from_hex(&bridge_pubkey).unwrap_or_else(|_| bridge_pubkey.clone());
    let web = crate::web::Web::new(npub, &config.endpoints, inputs.clone(), home, web_config);
    let hub = Hub::new(bridge_pubkey, inputs);
    let limits = Limits::default();
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
        let web = Rc::clone(&web);
        tasks.push(tokio::task::spawn_local(async move {
            let pages = Rc::clone(&web);
            accept_loop(listener, hub, Some(web), move |stream| {
                let acceptor = acceptor.clone();
                let pages = Rc::clone(&pages);
                async move {
                    // A TLS handshake opens with a handshake record (0x16);
                    // anything else is a browser that typed `http://`, which
                    // is sent to the `https://` page rather than handed TLS
                    // bytes it cannot read.
                    let mut first = [0u8; 1];
                    if matches!(stream.peek(&mut first).await, Ok(1) if first[0] != 0x16) {
                        crate::web::redirect_to_https(stream, &pages).await;
                        return None;
                    }
                    acceptor.accept(stream).await.ok()
                }
            }, limits)
            .await
        }));
    }
    if let Some(addr) = config.onion_listen {
        let listener = TcpListener::bind(addr).await.map_err(|e| format!("direct link: cannot listen on {addr}: {e}"))?;
        log::info!("[Direct] Listening on ws://{addr} for an onion service");
        let hub = Rc::clone(&hub);
        tasks.push(tokio::task::spawn_local(async move {
            accept_loop(listener, hub, None, |stream| async move { Some(stream) }, limits).await
        }));
    }
    let endpoints = advertised_endpoints(config, bound_wss, in_container());
    for endpoint in &endpoints {
        log::info!("[Direct] Advertising {endpoint}");
    }
    // The page is on the same `wss://` listener, so it is wherever phones
    // are told to dial it (`localhost` too, on the machine itself).
    for page in endpoints.iter().filter_map(|e| e.strip_prefix("wss://")) {
        log::info!("[Web] The bridge's web page: https://{}/", page.trim_end_matches('/'));
    }
    if endpoints.is_empty() {
        log::info!(
            "[Direct] Advertising no address: in a container the bridge sees only its own. \
             Add the host's address to direct.endpoints, or on the phone (the machine's page)."
        );
    }
    Ok(Some(Direct { hub, web, info: DirectInfo { endpoints, cert_sha256 }, tasks }))
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

async fn accept_loop<S, F, Fut>(listener: TcpListener, hub: Rc<Hub>, web: Option<Rc<crate::web::Web>>, secure: F, limits: Limits)
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
        if hub.open.get() >= limits.max_connections {
            log::warn!("[Direct] Refusing {peer}: {} connections open", limits.max_connections);
            continue;
        }
        let host = crate::web::rate_key(peer.ip());
        {
            let mut by_host = hub.open_by_host.borrow_mut();
            let held = by_host.entry(host).or_insert(0);
            if *held >= limits.max_per_host {
                log::info!("[Direct] Refusing {peer}: {} connections open from that host", limits.max_per_host);
                continue;
            }
            *held += 1;
        }
        hub.open.set(hub.open.get() + 1);
        let hub = Rc::clone(&hub);
        let web = web.clone();
        let secured = secure(stream);
        tokio::task::spawn_local(async move {
            if let Ok(Some(stream)) = tokio::time::timeout(limits.handshake, secured).await {
                match web {
                    Some(web) => route(stream, peer.ip(), &hub, &web, limits).await,
                    None => serve(stream, &hub, limits).await,
                }
            }
            hub.open.set(hub.open.get() - 1);
            let mut by_host = hub.open_by_host.borrow_mut();
            if let Some(held) = by_host.get_mut(&host) {
                *held -= 1;
                if *held == 0 {
                    by_host.remove(&host);
                }
            }
        });
    }
}

/// A connection on the listener that also serves the web page: read the
/// request head, then hand a WebSocket upgrade to the direct link (with the
/// bytes already read put back in front) and anything else to the page.
async fn route<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, peer: IpAddr, hub: &Hub, web: &crate::web::Web, limits: Limits) {
    let Ok(Some(head)) = tokio::time::timeout(limits.handshake, crate::web::read_head(&mut stream)).await else { return };
    if crate::web::is_websocket(&head) {
        serve(Replay { prefix: head, at: 0, inner: stream }, hub, limits).await;
    } else {
        crate::web::serve(&head, stream, peer, web).await;
    }
}

/// A stream that yields `prefix` before reading on from `inner`: the request
/// head [`route`] read to tell a WebSocket from a page, given back to the
/// WebSocket handshake that needs it.
struct Replay<S> {
    prefix: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for Replay<S> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.at < self.prefix.len() {
            let n = (self.prefix.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.prefix[at..at + n]);
            self.at += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Replay<S> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// One connection: the handshake, then events both ways.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(stream: S, hub: &Hub, limits: Limits) {
    let config = WebSocketConfig {
        max_message_size: Some(limits.max_frame_bytes),
        max_frame_size: Some(limits.max_frame_bytes),
        ..Default::default()
    };
    let Ok(Ok(ws)) = tokio::time::timeout(limits.handshake, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await
    else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let send = |frame: &DirectFrame| Message::Text(encode_direct_frame(frame));

    let challenge = hex::encode(rand::random::<[u8; 16]>());
    if sink.send(send(&DirectFrame::Challenge(challenge.clone()))).await.is_err() {
        return;
    }
    let hello = tokio::time::timeout(limits.hello, next_text(&mut source)).await.ok().flatten();
    let (auth, since, recipients) = match hello.as_deref().map(decode_direct_frame) {
        Some(Ok(DirectFrame::Hello { auth, since, recipients })) => (auth, since, recipients),
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

    let (id, frames, term) = hub.register(&identity, recipients);
    log::info!("[Direct] {}... connected", short(&identity));
    let mut ok = sink.send(send(&DirectFrame::Ready)).await.is_ok();
    for event in hub.since(id, since) {
        ok = ok && sink.send(send(&DirectFrame::Event(event))).await.is_ok();
    }
    while ok {
        // The normal lane first, always: a terminal frame goes out only when
        // nothing else is waiting.
        if let Some(text) = frames.pop() {
            ok = sink.send(Message::Text(text)).await.is_ok();
            continue;
        }
        if frames.is_closed() {
            // Unpaired, the bridge is stopping, or the publisher gave up on
            // a connection that stopped taking frames.
            let _ = sink.send(send(&DirectFrame::Closed("closed".into()))).await;
            break;
        }
        tokio::select! {
            biased;
            () = frames.ready() => {
                if let Some(text) = frames.pop() {
                    ok = sink.send(Message::Text(text)).await.is_ok();
                }
            },
            incoming = tokio::time::timeout(limits.idle, source.next()) => match incoming {
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
            // Terminal output last, one frame per turn: the loop then looks at
            // the normal lane and at the phone's own frames again before the
            // next one, so a terminal's backlog (up to its whole lane) never
            // stands in front of a session's event or a phone's command — on
            // an onion endpoint a megabyte of it could take seconds.
            () = term.ready() => {
                if let Some(text) = term.pop() {
                    ok = sink.send(Message::Text(text)).await.is_ok();
                }
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
    use tokio::task::LocalSet;

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
        signed(from, to, COMMAND_KIND)
    }

    fn signed(from: &protocol::crypto::Keypair, to: &str, kind: u16) -> SignedEvent {
        let keys = nostr::Keys::new(from.secret_key.clone());
        let tag = nostr::Tag::public_key(nostr::PublicKey::from_hex(to).unwrap());
        let event = nostr::EventBuilder::new(nostr::Kind::Custom(kind), "x").tag(tag).sign_with_keys(&keys).unwrap();
        SignedEvent::from_nostr(&event)
    }

    /// A copy for the client reading `recipient`.
    fn copy_for(recipient: &str, created_at: u64) -> SignedEvent {
        let mut event = command(&generate_keypair(), &generate_keypair().pubkey_hex);
        event.tags.push(vec!["c".into(), recipient.into()]);
        SignedEvent { created_at, ..event }
    }

    #[test]
    fn the_outbox_keeps_an_hour_per_identity_and_replays_a_client_its_own_copies() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into(), "q".into()]);
        let now = now_secs();
        let old = copy_for("p1", now - OUTBOX_SECS - 5);
        let (mine, other_client, untagged) = (copy_for("p1", now), copy_for("p2", now), command(&generate_keypair(), &generate_keypair().pubkey_hex));
        for event in [&old, &mine, &other_client, &untagged] {
            hub.deliver("p", event, false);
        }
        // Another identity naming p's tag reads nothing of p's.
        hub.deliver("q", &copy_for("q1", now), false);
        let (p1, _, _) = hub.register("p", vec!["p1".into()]);
        let (q, _, _) = hub.register("q", vec!["p1".into()]);
        assert_eq!(hub.since(p1, 0), std::slice::from_ref(&mine), "the stale one was dropped; only p1's copy");
        assert!(hub.since(p1, mine.created_at + 1).is_empty());
        assert!(hub.since(q, 0).is_empty());
        hub.set_paired(&["p".into()]);
        let (q1, _, _) = hub.register("q", vec!["q1".into()]);
        assert!(hub.since(q1, 0).is_empty(), "an unpaired identity's events go");
    }

    #[test]
    fn only_commands_from_the_identity_to_this_bridge_are_accepted() {
        let (inputs, mut rx) = mpsc::unbounded_channel();
        let (bridge, phone) = (generate_keypair(), generate_keypair());
        let hub = Hub::new(bridge.pubkey_hex.clone(), inputs);
        assert!(hub.accept(&phone.pubkey_hex, command(&phone, &bridge.pubkey_hex)).is_ok());
        assert!(matches!(rx.try_recv(), Ok(Input::RelayEvent { via: Via::Direct, .. })));
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
    fn terminal_input_on_the_live_kind_is_accepted_from_the_same_identity() {
        let (inputs, mut rx) = mpsc::unbounded_channel();
        let (bridge, phone) = (generate_keypair(), generate_keypair());
        let hub = Hub::new(bridge.pubkey_hex.clone(), inputs);
        // The keystrokes ride the live kind; the engine routes them by kind,
        // so it is set here too.
        assert!(hub.accept(&phone.pubkey_hex, signed(&phone, &bridge.pubkey_hex, LIVE_KIND)).is_ok());
        assert!(matches!(rx.try_recv(), Ok(Input::RelayEvent { event, via: Via::Direct }) if event.kind == LIVE_KIND));
        // Still only from the authenticated identity, and to this bridge.
        assert!(hub.accept(&phone.pubkey_hex, signed(&generate_keypair(), &bridge.pubkey_hex, LIVE_KIND)).is_err());
        assert!(hub.accept(&phone.pubkey_hex, signed(&phone, &generate_keypair().pubkey_hex, LIVE_KIND)).is_err());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_connections_terminal_lane_drops_the_oldest_when_full() {
        let lane = TermLane::default();
        for i in 0..TERMINAL_LANE_CAP {
            lane.push(format!("f{i}"));
        }
        assert_eq!(lane.pop().as_deref(), Some("f0"));
        // Refill to the cap and then one more: the oldest of what is left
        // goes, and the newest is kept, so the phone sees a gap and replays.
        lane.push("a".into());
        lane.push("b".into());
        assert_eq!(lane.pop().as_deref(), Some("f2"));
        let mut last = None;
        while let Some(f) = lane.pop() {
            last = Some(f);
        }
        assert_eq!(last.as_deref(), Some("b"));
    }

    /// A copy for a client, with `bytes` of content so its encoded frame has
    /// a size like a sync chunk's.
    fn big_copy_for(recipient: &str, bytes: usize, created_at: u64) -> SignedEvent {
        SignedEvent { content: "x".repeat(bytes), ..copy_for(recipient, created_at) }
    }

    #[test]
    fn a_sync_sized_burst_of_large_chunks_does_not_close_a_healthy_connection() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into()]);
        let (id, _, _) = hub.register("p", vec!["p1".into()]);
        let event = big_copy_for("p1", 60 * 1024, now_secs());
        // A sync sends every unacked chunk in one engine tick, so a long
        // transcript arrives as a burst the socket has not started draining.
        for _ in 0..200 {
            hub.deliver("p", &event, false);
        }
        assert!(hub.conns.borrow().contains_key(&id), "a healthy burst stays under the byte bound");
    }

    #[test]
    fn a_sync_pass_larger_than_the_byte_bound_still_reaches_a_reading_phone() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into()]);
        let (id, _, _) = hub.register("p", vec!["p1".into()]);
        let event = big_copy_for("p1", 1024 * 1024, now_secs());
        let frame_len = encode_direct_frame(&DirectFrame::Event(event.clone())).len();
        // One pass can be bigger than the bound. While the serve loop is
        // still taking frames this is a burst to deliver, not a stalled
        // phone; closing it would make the pass impossible to complete.
        let count = FRAME_LANE_BYTES / frame_len + 2;
        for _ in 0..count {
            hub.deliver("p", &event, false);
        }
        assert!(hub.conns.borrow().contains_key(&id), "{count} frames of {frame_len} bytes are one pass, not a stall");
    }

    #[test]
    fn a_connection_that_stops_taking_frames_is_closed_after_a_stall() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into()]);
        let (id, frames, _) = hub.register("p", vec!["p1".into()]);
        let event = copy_for("p1", now_secs());
        // Fill past the frame guard while the lane is fresh.
        for _ in 0..FRAME_LANE_CAP {
            hub.deliver("p", &event, false);
        }
        assert!(hub.conns.borrow().contains_key(&id), "the guard alone does not close a connection that is reading");
        // Nothing taken for the stall window: the next delivery gives up.
        frames.stall_for_test();
        hub.deliver("p", &event, false);
        assert!(hub.conns.borrow().get(&id).is_none());
        assert!(frames.is_closed(), "the serve loop is told to close");
    }

    #[test]
    fn a_burst_after_a_long_idle_is_not_a_stall() {
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        hub.set_paired(&["p".into()]);
        let (id, frames, _) = hub.register("p", vec!["p1".into()]);
        let event = copy_for("p1", now_secs());
        // Nothing was taken for a long time because nothing was queued.
        frames.stall_for_test();
        for _ in 0..=FRAME_LANE_CAP {
            hub.deliver("p", &event, false);
        }
        assert!(hub.conns.borrow().contains_key(&id), "an idle link that gets a burst is reading, not stalled");
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

    // --- the listener's bounds ---

    /// A plain listener (no TLS, no page) on a loopback port, with `limits`.
    /// The accept task lives on the test's `LocalSet`.
    async fn plain_listener(limits: Limits) -> (SocketAddr, Rc<Hub>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (inputs, _rx) = mpsc::unbounded_channel();
        let hub = Hub::new("b".into(), inputs);
        let accepting = Rc::clone(&hub);
        tokio::task::spawn_local(accept_loop(listener, accepting, None, |stream| async move { Some(stream) }, limits));
        (addr, hub)
    }

    /// Wait until the accept loop has opened `n` connections: its counters
    /// move before the handshake, so this is the state the next connect sees.
    async fn connections_reach(hub: &Hub, n: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while hub.open.get() != n {
            assert!(tokio::time::Instant::now() < deadline, "the accept loop did not open {n} connection(s); open={}", hub.open.get());
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    /// The next connection is accepted, then closed before any handshake:
    /// reading it yields end-of-file.
    async fn assert_refused_and_closed(addr: SocketAddr, hub: &Hub, open_now: usize) {
        use tokio::io::AsyncReadExt;
        let mut refused = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), refused.read(&mut buf))
            .await
            .expect("the refused connection is closed")
            .expect("the refused connection is readable to its end");
        assert_eq!(read, 0, "the connection over a cap is closed, not served");
        assert_eq!(hub.open.get(), open_now, "a refused connection takes no slot");
    }

    #[tokio::test]
    async fn one_host_past_its_connection_cap_is_refused() {
        LocalSet::new()
            .run_until(async {
                let limits = Limits { max_connections: 8, max_per_host: 1, handshake: Duration::from_secs(5), ..Limits::default() };
                let (addr, hub) = plain_listener(limits).await;
                let _held = tokio::net::TcpStream::connect(addr).await.unwrap();
                connections_reach(&hub, 1).await;
                assert_refused_and_closed(addr, &hub, 1).await;
            })
            .await;
    }

    #[tokio::test]
    async fn the_total_connection_cap_refuses_the_next_one() {
        LocalSet::new()
            .run_until(async {
                let limits = Limits { max_connections: 1, max_per_host: 8, handshake: Duration::from_secs(5), ..Limits::default() };
                let (addr, hub) = plain_listener(limits).await;
                let _held = tokio::net::TcpStream::connect(addr).await.unwrap();
                connections_reach(&hub, 1).await;
                assert_refused_and_closed(addr, &hub, 1).await;
            })
            .await;
    }

    async fn next_ws_frame(ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> DirectFrame {
        loop {
            match ws.next().await.expect("the socket is open").expect("a valid frame") {
                Message::Text(text) => return decode_direct_frame(&text).unwrap(),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn a_peer_that_never_says_hello_is_dropped_after_the_hello_timeout() {
        LocalSet::new()
            .run_until(async {
                // The production wait is a minute; the test says 50 ms.
                let limits = Limits { hello: Duration::from_millis(50), handshake: Duration::from_secs(5), ..Limits::default() };
                let (addr, _hub) = plain_listener(limits).await;
                let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
                let (mut ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}"), tcp).await.expect("the WebSocket handshake");
                assert!(matches!(next_ws_frame(&mut ws).await, DirectFrame::Challenge(_)));
                let answer = tokio::time::timeout(Duration::from_secs(5), next_ws_frame(&mut ws))
                    .await
                    .expect("a silent peer is answered once its hello deadline passes");
                assert_eq!(answer, DirectFrame::Closed("expected HELLO".into()));
            })
            .await;
    }

    #[tokio::test]
    async fn a_frame_over_the_socket_limit_closes_the_connection() {
        LocalSet::new()
            .run_until(async {
                let limits = Limits { max_frame_bytes: 1024, hello: Duration::from_secs(5), handshake: Duration::from_secs(5), ..Limits::default() };
                let (addr, hub) = plain_listener(limits).await;
                let phone = generate_keypair();
                hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));
                let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
                let (mut ws, _) = tokio_tungstenite::client_async(format!("ws://{addr}"), tcp).await.expect("the WebSocket handshake");
                let DirectFrame::Challenge(challenge) = next_ws_frame(&mut ws).await else { panic!("expected a challenge") };
                let auth = build_auth_event(&phone, "ws://direct", &challenge, now_secs() * 1000).unwrap();
                let hello = DirectFrame::Hello { auth, since: 0, recipients: vec![] };
                ws.send(Message::Text(encode_direct_frame(&hello))).await.unwrap();
                assert_eq!(next_ws_frame(&mut ws).await, DirectFrame::Ready);

                // One text message larger than the server accepts.
                ws.send(Message::Text("x".repeat(limits.max_frame_bytes + 1))).await.unwrap();
                let ended = tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        match ws.next().await {
                            Some(Ok(Message::Text(text))) => panic!("an oversize frame was delivered: {text}"),
                            Some(Ok(_)) => continue,
                            Some(Err(_)) | None => break,
                        }
                    }
                })
                .await;
                assert!(ended.is_ok(), "an oversize frame ends the connection");
                assert!(hub.conns.borrow().is_empty(), "the connection was unregistered");
            })
            .await;
    }
}

