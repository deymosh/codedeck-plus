//! The bridge's web page: what the bridge is doing, for a browser on the
//! machine, the LAN or a VPN.
//!
//! It is served on the direct link's `wss://` listener — the same port and
//! the same self-signed certificate (whose SHA-256 the heartbeat already
//! carries, so a paired phone can show what the browser should see). A
//! request that asks for a WebSocket goes on to the direct link as before;
//! any other is a page request, handled here. Nothing is served in
//! cleartext: the onion listener (plain `ws://` on loopback, for Tor) serves
//! no page.
//!
//! A browser signs in with the owner's phone, never with a password: the page
//! shows a short code (and a QR of it), and a paired phone sends that code as
//! a signed command, which the engine matches (`engine::web`). Until then the
//! browser sees only the sign-in page. The session lives in a cookie the
//! server alone can read, and only HTTPS carries it (`__Host-`, `Secure`,
//! `HttpOnly`, `SameSite=Strict`); it lapses after 30 days. Signed-in
//! browsers survive a restart — they are kept in `<home>/web-sessions.json`,
//! keyed by the SHA-256 of the cookie's value so the file holds no token a
//! copy could be replayed from — and signing out or revoking ends one.
//!
//! Signed in, the page can also read and change a little: `GET /api/browsers`
//! lists the signed-in browsers and `POST /api/browsers/sign-out` ends one;
//! `GET /api/devices` shows the paired identities and their clients;
//! `GET /api/config` shows the config as it is in effect and
//! `POST /api/config` changes the safe set of keys (never a path or a
//! listener).
//!
//! Hardening, since a LAN or VPN is not a trusted place:
//! - the `Host` must be an IP address, `localhost`, or a host the direct
//!   link's endpoints name — a DNS name an attacker points at this machine
//!   is refused (and its certificate would not match anyway);
//! - every `POST` must carry an `Origin` equal to the page's own;
//! - every response forbids framing, sniffing, referrers, caching and any
//!   script, style or connection not from the page itself (CSP);
//! - sign-in starts are rate-limited per address, pending codes and
//!   sessions are capped, and requests are bounded in size and time.
//!
//! The page never shows a secret: what it reads is the heartbeat, which by
//! protocol carries credential status and never a credential.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use base64::Engine as _;
use bridge_core::{Input, PairedPhone};
use protocol::events::WebBrowserInfo;
use protocol::web::BrowserKey;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// Largest request head accepted (request line and headers).
pub const MAX_HEAD_BYTES: usize = 16 * 1024;
/// Largest request body accepted; the page only ever posts a few fields.
const MAX_BODY_BYTES: usize = 16 * 1024;
/// How long a request has to arrive whole once its head has.
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a sign-in code shown on the page can be approved.
pub const PENDING_TTL_MS: u64 = 5 * 60 * 1000;
/// How long a signed-in browser stays signed in, at most.
const SESSION_TTL_MS: u64 = 30 * 24 * 3600 * 1000;
/// How long a signed-in browser stays signed in without signing anything: a
/// browser left behind lapses well before its 30 days.
pub(crate) const IDLE_TTL_MS: u64 = 7 * 24 * 3600 * 1000;
/// Streams one browser may hold open (its tabs).
const MAX_STREAMS_PER_BROWSER: usize = 4;
/// Streams open at once, every browser together.
const MAX_STREAMS: usize = 16;
/// How often a signed-in browser's `lastSeenMs` is written to disk at most;
/// a request touches it in memory every time, but the file no more often.
const LAST_SEEN_WRITE_MS: u64 = 60 * 1000;
/// Pending sign-ins kept at once; the oldest goes first past it. The
/// engine keeps as many codes, and is told of every one dropped here, so a
/// phone is never told it let in a browser this page no longer knows.
const MAX_PENDING: usize = bridge_core::MAX_WEB_SIGN_IN_CODES;
/// Signed-in browsers kept at once; the oldest goes first past it.
const MAX_SESSIONS: usize = 64;
/// Sign-in starts allowed per address per minute.
const STARTS_PER_MINUTE: u32 = 10;
/// Addresses whose sign-in starts are counted at once; the oldest windows go
/// first past it, so the count costs bounded memory whatever the peers.
const MAX_START_WINDOWS: usize = 4096;
/// The session cookie. `__Host-` makes the browser keep it only when it was
/// set over HTTPS, for the whole site, by this exact host.
const COOKIE: &str = "__Host-codedeck";
/// The characters a sign-in code is drawn from: no 0/O, 1/I/L, so it can be
/// read off a screen and typed on a phone without doubt.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/// How many hex characters of a browser's public id there are.
const ID_LEN: usize = protocol::web::BROWSER_ID_LEN;
/// Longest `User-Agent` kept for a browser; the header is the client's, so it
/// is bounded before it is stored or shown.
const AGENT_MAX_CHARS: usize = 120;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const APP_CSS: &str = include_str!("../web/app.css");
const FAVICON_PNG: &[u8] = include_bytes!("../web/favicon.png");

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where one browser stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Access {
    /// Showing `code`, waiting for a phone to send it.
    Pending { code: String, expires_ms: u64 },
    /// Signed in by `by` (the identity that approved it).
    SignedIn { by: String, since_ms: u64, expires_ms: u64 },
}

#[derive(Debug, Clone)]
struct Browser {
    access: Access,
    /// The key the browser made for this sign-in, sent with its start: every
    /// frame on its stream must be signed by it. Its id is the browser's.
    key: BrowserKey,
    peer: IpAddr,
    /// When it got where it stands, as a count: what the caps drop the
    /// lowest of (a clock can give two browsers the same millisecond).
    order: u64,
    /// The `User-Agent` of the request that started the sign-in, cleaned
    /// (control characters stripped, at most [`AGENT_MAX_CHARS`]). Shown on
    /// the page so the owner can tell one browser from another.
    agent: String,
    /// When it last signed something on its stream: only a signature moves
    /// it, so a copied cookie cannot keep a sign-in alive. Kept in memory on
    /// every one, written at most every [`LAST_SEEN_WRITE_MS`].
    last_seen_ms: u64,
}

impl Browser {
    /// When it stops being let in: a pending code's lapse, or for a signed-in
    /// browser the sooner of its 30 days and [`IDLE_TTL_MS`] since it last
    /// signed anything.
    fn lapses_ms(&self) -> u64 {
        match self.access {
            Access::Pending { expires_ms, .. } => expires_ms,
            Access::SignedIn { expires_ms, .. } => expires_ms.min(self.last_seen_ms.saturating_add(IDLE_TTL_MS)),
        }
    }
}

/// A browser allowed to open a stream: its cookie names a signed-in one.
#[derive(Debug)]
pub(crate) struct StreamGrant {
    /// The SHA-256 of its cookie: how the page finds it again.
    pub key: String,
    /// Its public id.
    pub id: String,
    /// The npub of the identity that let it in.
    pub by: String,
    pub browser_key: BrowserKey,
}

/// An open stream as its server holds it: its number, its lane, and the cell
/// the page leaves its closing reason in.
pub(crate) type OpenStream = (u64, Rc<crate::direct::FrameLane>, Rc<Cell<&'static str>>);

/// One open stream of a browser.
struct WebStream {
    /// The browser's cookie hash.
    key: String,
    id: String,
    lane: Rc<crate::direct::FrameLane>,
    /// Why the page closed it, for its `CLOSED` frame.
    reason: Rc<Cell<&'static str>>,
}

/// What the page's config API needs: where `config.json` lives, and the view
/// of the config as it is in effect (flags and environment already applied).
#[derive(Clone, Default)]
pub struct ConfigView {
    pub path: PathBuf,
    pub fields: Vec<Value>,
}

/// One signed-in browser as it is kept on disk. Never a token: the `key` is
/// already the token's SHA-256, so a copy of this file cannot be replayed as
/// a cookie.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    key: String,
    /// The browser's public key (base64url of the raw point). A record
    /// without one predates browser keys and is skipped: that browser signs
    /// in again.
    #[serde(default)]
    public_key: String,
    by: String,
    since_ms: u64,
    expires_ms: u64,
    last_seen_ms: u64,
    peer: String,
    agent: String,
}

/// A paired phone as the devices API shows it: the identity, its label and
/// each client's key expiry. Never a secret — a session key's public half is
/// not shown either, since only its lapse matters to the page.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub npub: String,
    pub label: String,
    pub paired_at: String,
    pub clients: Vec<ClientView>,
}

/// One client of a paired identity.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    /// When the client's session key lapses (seconds since the Unix epoch).
    pub expires_at: u64,
    /// Until when (ms) the client counts as present.
    pub present_until_ms: u64,
}

/// The page's state: the latest heartbeat and the browsers it knows.
pub struct Web {
    machine_npub: String,
    /// Host names (lowercase, no port) a request may name besides an IP
    /// address and `localhost`.
    hosts: Vec<String>,
    /// By the SHA-256 of the cookie's value, so the table holds no token a
    /// memory dump could replay.
    browsers: RefCell<HashMap<String, Browser>>,
    /// Sign-in starts in the current minute, by [`rate_key`].
    starts: RefCell<HashMap<IpAddr, (u64, u32)>>,
    /// The next [`Browser::order`].
    order: Cell<u64>,
    inputs: mpsc::UnboundedSender<Input>,
    /// Where the signed-in browsers are kept between restarts.
    sessions_path: PathBuf,
    /// The config file the config API writes.
    config_file: PathBuf,
    /// The config as it is in effect, for the config API to show.
    config_fields: RefCell<Vec<Value>>,
    /// The paired identities, refreshed whenever the heartbeat is.
    devices: RefCell<Vec<DeviceView>>,
    /// When `lastSeenMs` was last written to disk.
    last_persist_ms: Cell<u64>,
    /// Where the browsers file is written, off the bridge's thread.
    writer: Writer,
    /// Page requests being served now ([`MAX_PAGE_REQUESTS`]).
    serving: Cell<usize>,
    /// The browsers' open streams, by a number of their own.
    streams: RefCell<HashMap<u64, WebStream>>,
    next_stream: Cell<u64>,
    /// The clock (ms since the Unix epoch); a test moves it.
    clock: Box<dyn Fn() -> u64>,
}

impl Web {
    pub fn new(
        machine_npub: String,
        endpoints: &[String],
        inputs: mpsc::UnboundedSender<Input>,
        home: &Path,
        config: ConfigView,
    ) -> Rc<Self> {
        Self::with_clock(machine_npub, endpoints, inputs, home, config, Box::new(now_ms))
    }

    pub(crate) fn with_clock(
        machine_npub: String,
        endpoints: &[String],
        inputs: mpsc::UnboundedSender<Input>,
        home: &Path,
        config: ConfigView,
        clock: Box<dyn Fn() -> u64>,
    ) -> Rc<Self> {
        let hosts = endpoints.iter().filter_map(|url| endpoint_host(url)).collect();
        let sessions_path = home.join("web-sessions.json");
        let browsers = load_sessions(&sessions_path, clock());
        let order = browsers.values().map(|b| b.order).max().unwrap_or(0) + 1;
        if !browsers.is_empty() {
            log::info!("[Web] {} signed-in browser(s) restored from {}", browsers.len(), sessions_path.display());
        }
        Rc::new(Self {
            machine_npub,
            hosts,
            browsers: RefCell::new(browsers),
            starts: RefCell::default(),
            order: Cell::new(order),
            inputs,
            sessions_path,
            config_file: config.path,
            config_fields: RefCell::new(config.fields),
            devices: RefCell::default(),
            last_persist_ms: Cell::new(0),
            writer: Writer::spawn(),
            serving: Cell::new(0),
            streams: RefCell::default(),
            next_stream: Cell::new(1),
            clock,
        })
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    /// The machine this page belongs to (its npub): part of every signed
    /// input, so a signature for another bridge is good for nothing here.
    pub(crate) fn machine(&self) -> &str {
        &self.machine_npub
    }

    /// Where a browser's verified commands go: the engine's inputs.
    pub(crate) fn inputs(&self) -> &mpsc::UnboundedSender<Input> {
        &self.inputs
    }

    /// The paired identities, refreshed alongside the heartbeat: what the
    /// devices API shows. Only what is not a secret goes in.
    pub fn set_devices(&self, phones: &[PairedPhone]) {
        let devices = phones
            .iter()
            .map(|phone| DeviceView {
                npub: phone.npub.clone(),
                label: phone.label.clone(),
                paired_at: phone.paired_at.clone(),
                clients: phone
                    .clients
                    .iter()
                    .map(|client| ClientView { expires_at: client.key.expires_at, present_until_ms: client.present_until_ms })
                    .collect(),
            })
            .collect();
        *self.devices.borrow_mut() = devices;
    }

    /// A phone of `by` sent `code`, and the engine matched it to a code this
    /// page showed: that browser is signed in.
    pub fn signed_in(&self, code: &str, by: &str) {
        let now = self.now();
        {
            let mut browsers = self.browsers.borrow_mut();
            for browser in browsers.values_mut() {
                if matches!(&browser.access, Access::Pending { code: c, .. } if c == code) {
                    log::info!("[Web] A browser at {} signed in", browser.peer);
                    browser.access = Access::SignedIn { by: by.to_string(), since_ms: now, expires_ms: now + SESSION_TTL_MS };
                    browser.last_seen_ms = now;
                    // The session's age is from its sign-in, so the cap below
                    // drops the longest signed in, never the one just let in.
                    browser.order = self.next_order();
                }
            }
            evict_oldest(&mut browsers, MAX_SESSIONS, |b| matches!(b.access, Access::SignedIn { .. }));
        }
        self.close_orphan_streams();
        self.persist();
    }

    /// The browser a cookie names, by its key, unless it has lapsed — a
    /// lapsed one is ended here. A cookie alone never moves `lastSeenMs`:
    /// only a signature does ([`Self::seen`]).
    fn browser(&self, token: Option<&str>) -> Option<(String, Browser)> {
        self.by_key(&token_key(token?))
    }

    /// [`Self::browser`], by the cookie's hash.
    fn by_key(&self, key: &str) -> Option<(String, Browser)> {
        let lapsed = self.browsers.borrow().get(key)?.lapses_ms() <= self.now();
        if lapsed {
            self.sign_out_for(key, protocol::web::closed::EXPIRED);
            return None;
        }
        self.browsers.borrow().get(key).map(|b| (key.to_string(), b.clone()))
    }

    /// The browser `key` signed a frame: it is in use, so its idle limit
    /// starts again. The file follows at most once a minute.
    pub(crate) fn seen(&self, key: &str) {
        let now = self.now();
        if let Some(browser) = self.browsers.borrow_mut().get_mut(key) {
            browser.last_seen_ms = now;
        }
        if now.saturating_sub(self.last_persist_ms.get()) >= LAST_SEEN_WRITE_MS {
            self.last_persist_ms.set(now);
            self.persist();
        }
    }

    /// Start a sign-in for a browser at `peer` (its `User-Agent` is `agent`)
    /// holding `key`: a new code, and the cookie that names it. The key is
    /// bound here, before any phone sees the code, so the code an identity
    /// approves names exactly one key. `None` when the address started too
    /// many lately.
    fn start_sign_in(&self, peer: IpAddr, agent: &str, key: BrowserKey) -> Option<(String, String)> {
        let now = self.now();
        {
            let mut starts = self.starts.borrow_mut();
            starts.retain(|_, (window, _)| now - *window < 60_000);
            let key = rate_key(peer);
            while !starts.contains_key(&key) && starts.len() >= MAX_START_WINDOWS {
                let Some(oldest) = starts.iter().min_by_key(|(_, (window, _))| *window).map(|(k, _)| *k) else { break };
                starts.remove(&oldest);
            }
            let entry = starts.entry(key).or_insert((now, 0));
            if entry.1 >= STARTS_PER_MINUTE {
                return None;
            }
            entry.1 += 1;
        }
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        let code = new_code();
        let expires_ms = now + PENDING_TTL_MS;
        let mut browsers = self.browsers.borrow_mut();
        browsers.retain(|_, b| b.lapses_ms() > now);
        let browser = Browser {
            access: Access::Pending { code: code.clone(), expires_ms },
            key,
            peer,
            order: self.next_order(),
            agent: agent.to_string(),
            last_seen_ms: now,
        };
        browsers.insert(token_key(&token), browser);
        let _ = self.inputs.send(Input::WebSignInPending { code: code.clone(), expires_ms });
        // Pending browsers are not written to disk, so a dropped one needs no
        // persist — but the file may have lost an expired signed-in one above.
        for dropped in evict_oldest(&mut browsers, MAX_PENDING, |b| matches!(b.access, Access::Pending { .. })) {
            self.withdraw(&dropped);
        }
        drop(browsers);
        // A lapsed signed-in browser reaped above may still hold a stream.
        self.close_orphan_streams();
        Some((token, code))
    }

    fn sign_out(&self, key: &str) {
        self.sign_out_for(key, protocol::web::closed::SIGNED_OUT);
    }

    /// End the browser `key`: its record, its code if it was showing one,
    /// and its streams, each closed with `reason`.
    fn sign_out_for(&self, key: &str, reason: &'static str) {
        let removed = self.browsers.borrow_mut().remove(key);
        if let Some(browser) = removed {
            self.withdraw(&browser);
            self.persist();
        }
        let ended: Vec<u64> = self.streams.borrow().iter().filter(|(_, s)| s.key == key).map(|(n, _)| *n).collect();
        for n in ended {
            self.end_stream(n, reason);
        }
    }

    /// Sign out the browser whose id (the first `ID_LEN` hex characters of
    /// its key) is `id`; false when no signed-in browser has it. Any
    /// signed-in browser may sign out any other: they are all the owner's.
    /// The engine asks for this on `web-browser-sign-out`, and the page's own
    /// API on `POST /api/browsers/sign-out` — one path, so the two cannot
    /// end different browsers.
    pub fn revoke(&self, id: &str) -> bool {
        if id.len() != ID_LEN {
            return false;
        }
        let key = self
            .browsers
            .borrow()
            .iter()
            .find(|(_, browser)| browser.key.id() == id && matches!(browser.access, Access::SignedIn { .. }))
            .map(|(key, _)| key.clone());
        match key {
            Some(key) => {
                self.sign_out(&key);
                true
            }
            None => false,
        }
    }

    /// Sign out every browser the identity `by` (an npub) let in: it is no
    /// longer paired, and what it let in goes with it.
    pub fn end_by(&self, by: &str) {
        let keys: Vec<String> = self
            .browsers
            .borrow()
            .iter()
            .filter(|(_, b)| matches!(&b.access, Access::SignedIn { by: approver, .. } if approver == by))
            .map(|(key, _)| key.clone())
            .collect();
        if !keys.is_empty() {
            log::info!("[Web] {} browser(s) signed out: the identity that let them in was unpaired", keys.len());
        }
        for key in keys {
            self.sign_out(&key);
        }
    }

    fn next_order(&self) -> u64 {
        let order = self.order.get();
        self.order.set(order + 1);
        order
    }

    /// Write the signed-in browsers to disk, owner-only and atomically. A
    /// pending one is not written (its code is short-lived and useless after
    /// a restart), and no token ever is — only the key's SHA-256.
    fn persist(&self) {
        let mut sessions: Vec<StoredSession> = self
            .browsers
            .borrow()
            .iter()
            .filter_map(|(key, browser)| match &browser.access {
                Access::SignedIn { by, since_ms, expires_ms } => Some(StoredSession {
                    key: key.clone(),
                    public_key: browser.key.to_base64url(),
                    by: by.clone(),
                    since_ms: *since_ms,
                    expires_ms: *expires_ms,
                    last_seen_ms: browser.last_seen_ms,
                    peer: browser.peer.to_string(),
                    agent: browser.agent.clone(),
                }),
                Access::Pending { .. } => None,
            })
            .collect();
        sessions.sort_by(|a, b| a.since_ms.cmp(&b.since_ms).then_with(|| a.key.cmp(&b.key)));
        let Ok(json) = serde_json::to_vec_pretty(&sessions) else { return };
        self.writer.write(self.sessions_path.clone(), json);
    }

    /// The listeners in effect, from the config the page shows.
    fn listeners(&self) -> crate::config::WebListeners {
        let fields = self.config_fields.borrow();
        let running = |key: &str| fields.iter().any(|f| f["key"] == key && !f["value"].is_null());
        crate::config::WebListeners { direct: running("direct.listen"), onion: running("direct.onionListen") }
    }

    /// The page stopped showing a pending browser's code: the engine must not
    /// let a phone use it.
    fn withdraw(&self, browser: &Browser) {
        if let Access::Pending { code, .. } = &browser.access {
            let _ = self.inputs.send(Input::WebSignInWithdrawn { code: code.clone() });
        }
    }

    /// The signed-in browsers, oldest signed in first: what a
    /// `web-browsers-request` is answered with, from a phone or a browser.
    /// `expiresMs` is when each actually lapses — the sooner of its 30 days
    /// and its idle limit. A browser whose sign-in has lapsed is left out: it
    /// is only reaped when it next asks for something, and until then it is
    /// not signed in.
    pub fn browsers(&self) -> Vec<WebBrowserInfo> {
        let now = self.now();
        let mut rows: Vec<(u64, WebBrowserInfo)> = self
            .browsers
            .borrow()
            .values()
            .filter(|browser| browser.lapses_ms() > now)
            .filter_map(|browser| match &browser.access {
                Access::SignedIn { by, since_ms, .. } => Some((
                    browser.order,
                    WebBrowserInfo {
                        id: browser.key.id(),
                        by: by.clone(),
                        since_ms: *since_ms,
                        last_seen_ms: browser.last_seen_ms,
                        expires_ms: browser.lapses_ms(),
                        peer: browser.peer.to_string(),
                        agent: browser.agent.clone(),
                    },
                )),
                Access::Pending { .. } => None,
            })
            .collect();
        rows.sort_by_key(|(order, _)| *order);
        rows.into_iter().map(|(_, info)| info).collect()
    }

    /// The paired identities, for the `devices` page request.
    fn devices_json(&self) -> String {
        serde_json::json!({ "devices": self.devices.borrow().clone() }).to_string()
    }

    /// The config as it is in effect, for the `config` page request.
    fn config_json(&self) -> String {
        serde_json::json!({ "fields": self.config_fields.borrow().clone() }).to_string()
    }

    /// Apply a `config-set` page request's body: only safe-set keys, each validated,
    /// then written to the config file keeping every other key. `by` is the
    /// approver's npub, for the log line (key names only, never a value).
    fn apply_config(&self, body: &[u8], by: &str) -> Response {
        let Ok(doc) = serde_json::from_slice::<Value>(body) else { return Response::error(400) };
        let Some(obj) = doc.as_object() else { return Response::error(400) };
        if obj.keys().any(|key| key != "set") {
            return Response::error(400);
        }
        let empty = serde_json::Map::new();
        let set = match obj.get("set") {
            None => &empty,
            Some(Value::Object(map)) => map,
            Some(_) => return Response::error(400),
        };
        let mut changes: Vec<(String, Option<Value>)> = Vec::new();
        for (key, value) in set {
            if !crate::config::WEB_EDITABLE.contains(&key.as_str()) {
                return bad_request(key, "not a setting the page may change");
            }
            if let Err(message) = crate::config::validate_web_value(key, value, self.listeners()) {
                return bad_request(key, &message);
            }
            changes.push((key.clone(), Some(value.clone())));
        }
        if changes.is_empty() {
            return bad_request("", "nothing to change");
        }
        let mut response = Response::json(200, serde_json::json!({ "ok": true, "restartNeeded": true }).to_string());
        response.config_write = Some(ConfigWrite { path: self.config_file.clone(), changes, by: by[..8.min(by.len())].to_string() });
        response
    }
}

impl Web {
    /// Whether a stream request may be upgraded: an allowed `Host`, an
    /// `Origin` that is the page's own (a browser sends cookies on a
    /// cross-site WebSocket handshake too), and a cookie naming a signed-in
    /// browser. Checked before any signature work, so a stranger costs one
    /// hash. The error is the HTTP status to refuse with.
    pub(crate) fn stream_grant(&self, head: &[u8]) -> Result<StreamGrant, u16> {
        let request = parse_head(head).ok_or(400u16)?;
        let host = request.host.as_deref().filter(|h| host_allowed(h, &self.hosts)).ok_or(403u16)?;
        if request.origin.as_deref() != Some(&format!("https://{host}")) {
            return Err(403);
        }
        match self.browser(request.cookie.as_deref()) {
            Some((key, Browser { access: Access::SignedIn { by, .. }, key: browser_key, .. })) if self.is_paired(&by) => {
                Ok(StreamGrant { id: browser_key.id(), key, by, browser_key })
            }
            _ => Err(401),
        }
    }

    /// Whether the identity `by` (an npub) is paired now, as the heartbeat
    /// last told the page.
    fn is_paired(&self, by: &str) -> bool {
        self.devices.borrow().iter().any(|d| d.npub == by)
    }

    /// Close every stream whose browser is no longer signed in: one dropped
    /// to make room, or lapsed and reaped, would otherwise stay open.
    fn close_orphan_streams(&self) {
        let orphans: Vec<u64> = {
            let browsers = self.browsers.borrow();
            self.streams
                .borrow()
                .iter()
                .filter(|(_, s)| !matches!(browsers.get(&s.key), Some(Browser { access: Access::SignedIn { .. }, .. })))
                .map(|(n, _)| *n)
                .collect()
        };
        for n in orphans {
            self.end_stream(n, protocol::web::closed::SIGNED_OUT);
        }
    }

    /// Open a stream for `grant`: its lane, and the cell its closing reason
    /// is left in. `None` past the caps (per browser, and in all). The first
    /// stream of a browser makes it a present client of its identity.
    pub(crate) fn open_stream(&self, grant: &StreamGrant) -> Option<OpenStream> {
        let mut streams = self.streams.borrow_mut();
        let of_browser = streams.values().filter(|s| s.key == grant.key).count();
        if streams.len() >= MAX_STREAMS || of_browser >= MAX_STREAMS_PER_BROWSER {
            return None;
        }
        let n = self.next_stream.get();
        self.next_stream.set(n + 1);
        let lane = Rc::new(crate::direct::FrameLane::new());
        let reason = Rc::new(Cell::new(protocol::web::closed::SIGNED_OUT));
        streams.insert(n, WebStream { key: grant.key.clone(), id: grant.id.clone(), lane: Rc::clone(&lane), reason: Rc::clone(&reason) });
        if of_browser == 0 {
            let _ = self.inputs.send(Input::WebBrowserOnline { id: grant.id.clone(), by: grant.by.clone() });
        }
        Some((n, lane, reason))
    }

    /// The stream `n` ended (either side). A browser whose last stream it
    /// was gets nothing more until it opens one.
    pub(crate) fn close_stream(&self, n: u64) {
        let Some(stream) = self.streams.borrow_mut().remove(&n) else { return };
        let others = self.streams.borrow().values().any(|s| s.key == stream.key);
        if !others {
            let _ = self.inputs.send(Input::WebBrowserOffline { id: stream.id });
        }
    }

    /// Close stream `n` from the page's side, with `reason`.
    fn end_stream(&self, n: u64, reason: &'static str) {
        if let Some(stream) = self.streams.borrow().get(&n) {
            stream.reason.set(reason);
            stream.lane.close();
        }
        self.close_stream(n);
    }

    /// Queue `message` (a `BridgeToPhone`, encoded) on each stream of the
    /// browser `id`. A browser whose sign-in lapsed is ended instead; one
    /// that stopped reading is closed as busy, never waited on — the phones'
    /// links share this thread.
    pub fn deliver(&self, id: &str, message: &str) {
        let targets: Vec<(u64, String, Rc<crate::direct::FrameLane>)> =
            self.streams.borrow().iter().filter(|(_, s)| s.id == id).map(|(n, s)| (*n, s.key.clone(), Rc::clone(&s.lane))).collect();
        let Some((_, key, _)) = targets.first() else { return };
        if self.by_key(key).is_none() {
            self.close_orphan_streams();
            return;
        }
        let frame = protocol::web::encode_web_frame(&protocol::web::WebFrame::Msg(message.to_string()));
        for (n, _, lane) in targets {
            if !lane.push(frame.clone()) {
                log::info!("[Web] A browser stopped reading its stream; closing it");
                self.end_stream(n, protocol::web::closed::BUSY);
            }
        }
    }

    /// Whether the browser `key` is still signed in: what each frame on its
    /// stream is checked against, so a lapse or a sign-out ends the stream
    /// at its next frame even when nothing was sent to it.
    pub(crate) fn still_signed_in(&self, key: &str) -> bool {
        matches!(self.by_key(key), Some((_, Browser { access: Access::SignedIn { .. }, .. })))
    }

    /// Answer a page request (its `body`, already verified) from browser
    /// `by`'s stream: `{status, body}`, and a config write to make first
    /// when it changes the config.
    pub(crate) fn page_request(&self, body: &str, by: &str) -> (u16, String, Option<ConfigWrite>) {
        // Only for a browser whose identity is still paired: one restored
        // from disk after its phone was unpaired must not reach the config
        // before the engine has ended it.
        if !self.is_paired(by) {
            return (403, error_body(403), None);
        }
        let Ok(doc) = serde_json::from_str::<Value>(body) else { return (400, error_body(400), None) };
        match doc.get("type").and_then(Value::as_str) {
            Some("devices") => (200, self.devices_json(), None),
            Some("config") => (200, self.config_json(), None),
            Some("config-set") => {
                let set = serde_json::json!({ "set": doc.get("set").cloned().unwrap_or(Value::Null) });
                let mut response = self.apply_config(set.to_string().as_bytes(), by);
                let write = response.config_write.take();
                (response.status, String::from_utf8(response.body).unwrap_or_default(), write)
            }
            _ => (400, error_body(400), None),
        }
    }
}

fn error_body(status: u16) -> String {
    serde_json::json!({ "error": reason(status) }).to_string()
}

/// The fields of a request head the stream's gate reads.
fn parse_head(buf: &[u8]) -> Option<Request> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);
    if !matches!(parsed.parse(buf), Ok(httparse::Status::Complete(_))) {
        return None;
    }
    let header = |name: &str| {
        parsed.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).and_then(|h| std::str::from_utf8(h.value).ok()).map(str::to_string)
    };
    Some(Request {
        method: parsed.method.unwrap_or("").to_string(),
        path: parsed.path.unwrap_or("").split('?').next().unwrap_or("").to_string(),
        host: header("host"),
        origin: header("origin"),
        cookie: header("cookie").and_then(|all| cookie_value(&all)),
        user_agent: header("user-agent"),
        body: Vec::new(),
    })
}

/// The session cookie's value in a `Cookie` header.
fn cookie_value(all: &str) -> Option<String> {
    all.split(';').find_map(|pair| pair.trim().strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
}

/// Whether the request head in `buf` asks for the browser's stream rather
/// than the direct link: a WebSocket upgrade of [`STREAM_PATH`].
pub fn is_stream_request(buf: &[u8]) -> bool {
    parse_head(buf).is_some_and(|r| r.path == STREAM_PATH)
}

/// Where a browser opens its stream.
pub const STREAM_PATH: &str = "/api/stream";

/// Refuse a request with `status` and close the connection.
pub(crate) async fn refuse<S: AsyncWrite + Unpin>(stream: &mut S, status: u16) {
    write_response(stream, Response::error(status)).await;
}

/// Make a validated config write, off the bridge's thread: `{status, body}`.
pub(crate) async fn write_config_now(write: ConfigWrite) -> (u16, String) {
    let response = write_config(write).await;
    (response.status, String::from_utf8(response.body).unwrap_or_default())
}

/// The signed-in browsers a previous run left in `path`, expired ones
/// dropped. A missing or unreadable file is an empty set, with a warning: a
/// page that will not start is worse than one whose browsers sign in again.
fn load_sessions(path: &Path, now: u64) -> HashMap<String, Browser> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            log::warn!("[Web] cannot read {}: {e}; starting with no signed-in browsers", path.display());
            return HashMap::new();
        }
    };
    let stored: Vec<StoredSession> = match serde_json::from_str(&raw) {
        Ok(stored) => stored,
        Err(e) => {
            log::warn!("[Web] ignoring {}: {e}; starting with no signed-in browsers", path.display());
            return HashMap::new();
        }
    };
    let mut browsers = HashMap::new();
    let mut order = 1;
    for session in stored {
        // A key is always 64 hex characters; anything else is not one this
        // page wrote, so it is dropped rather than trusted.
        let Ok(peer) = session.peer.parse::<IpAddr>() else { continue };
        let Some(key) = BrowserKey::parse(&session.public_key) else { continue };
        let access = Access::SignedIn { by: session.by, since_ms: session.since_ms, expires_ms: session.expires_ms };
        let browser = Browser { access, key, peer, order, agent: session.agent, last_seen_ms: session.last_seen_ms };
        if browser.lapses_ms() <= now || session.key.len() != 64 {
            continue;
        }
        browsers.insert(session.key, browser);
        order += 1;
    }
    browsers
}

/// Drop the oldest browsers matching `which` until at most `cap` of them are
/// left, and return them.
fn evict_oldest(browsers: &mut HashMap<String, Browser>, cap: usize, which: impl Fn(&Browser) -> bool) -> Vec<Browser> {
    let mut dropped = Vec::new();
    loop {
        let matching: Vec<(&String, &Browser)> = browsers.iter().filter(|(_, b)| which(b)).collect();
        if matching.len() <= cap {
            return dropped;
        }
        let Some(oldest) = matching.iter().min_by_key(|(_, b)| b.order).map(|(k, _)| (*k).clone()) else { return dropped };
        dropped.extend(browsers.remove(&oldest));
    }
}

/// Page requests served at once; past it a request is answered 503.
const MAX_PAGE_REQUESTS: usize = 16;

/// Writes files in order on a thread of its own. The bridge runs on one
/// thread, and a write ends in an fsync that a slow disk (or a Docker
/// Desktop volume) can hold for tens of milliseconds — time every relay and
/// phone link would otherwise wait. Writes keep their order, so the file on
/// disk is always the latest one handed over.
struct Writer {
    tx: std::sync::mpsc::Sender<WriterJob>,
}

enum WriterJob {
    Write(PathBuf, Vec<u8>),
    /// Answered once every earlier write is done (tests).
    #[cfg(test)]
    Flush(std::sync::mpsc::Sender<()>),
}

impl Writer {
    fn spawn() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<WriterJob>();
        let spawned = std::thread::Builder::new().name("codedeck-web-writer".into()).spawn(move || {
            for job in rx {
                match job {
                    WriterJob::Write(path, bytes) => {
                        if let Err(e) = crate::state::write_private(&path, &bytes) {
                            log::warn!("[Web] cannot write {}: {e}", path.display());
                        }
                    }
                    #[cfg(test)]
                    WriterJob::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        if let Err(e) = spawned {
            log::warn!("[Web] no writer thread ({e}); signed-in browsers will not survive a restart");
        }
        Self { tx }
    }

    fn write(&self, path: PathBuf, bytes: Vec<u8>) {
        let _ = self.tx.send(WriterJob::Write(path, bytes));
    }

    #[cfg(test)]
    fn flush(&self) {
        let (done, wait) = std::sync::mpsc::channel();
        if self.tx.send(WriterJob::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

/// What sign-in starts are counted by: an IPv4 address, or an IPv6
/// address's /64. One host holds a whole /64 and can pick any address in it,
/// so counting single IPv6 addresses would let it start without limit.
pub(crate) fn rate_key(peer: IpAddr) -> IpAddr {
    match peer {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

fn token_key(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Eight characters in two groups (`K7QM-4XPA`): about 39 bits, guessed only
/// by sending a signed command from a paired phone within its five minutes.
fn new_code() -> String {
    let bytes = rand::random::<[u8; 8]>();
    let chars: String = bytes.iter().map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char).collect();
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// The host part of a direct endpoint URL, lowercase.
fn endpoint_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    let host = if let Some(v6) = authority.strip_prefix('[') { v6.split(']').next()? } else { authority.split(':').next()? };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Where the head of the request in `buf` ends, once it has.
pub fn head_len(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Whether the request head in `buf` asks for a WebSocket.
pub fn is_websocket(buf: &[u8]) -> bool {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    if request.parse(buf).is_err() {
        return false;
    }
    request.headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("upgrade") && std::str::from_utf8(h.value).is_ok_and(|v| v.trim().eq_ignore_ascii_case("websocket"))
    })
}

/// One parsed request.
struct Request {
    method: String,
    path: String,
    host: Option<String>,
    origin: Option<String>,
    cookie: Option<String>,
    user_agent: Option<String>,
    /// The body, read off whole and bounded (empty for a request without one).
    body: Vec<u8>,
}

/// Parse the request whose head is in `buf` (with whatever of its body came
/// with it), reading the rest of the body from `stream`.
async fn read_request<S: AsyncRead + Unpin>(buf: &[u8], stream: &mut S) -> Result<Request, u16> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);
    let head = match parsed.parse(buf) {
        Ok(httparse::Status::Complete(n)) => n,
        _ => return Err(400),
    };
    let header = |name: &str| {
        parsed.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).and_then(|h| std::str::from_utf8(h.value).ok()).map(str::to_string)
    };
    let length: usize = match header("content-length") {
        Some(v) => v.trim().parse().map_err(|_| 400u16)?,
        None => 0,
    };
    if length > MAX_BODY_BYTES || header("transfer-encoding").is_some() {
        return Err(413);
    }
    // The body is read off whole and bounded, so the request ends cleanly
    // even for a route that does not look at it.
    let arrived = (buf.len() - head).min(length);
    let mut body = buf[head..head + arrived].to_vec();
    if arrived < length {
        let mut rest = vec![0u8; length - arrived];
        tokio::time::timeout(BODY_TIMEOUT, stream.read_exact(&mut rest)).await.map_err(|_| 408u16)?.map_err(|_| 400u16)?;
        body.extend_from_slice(&rest);
    }
    let cookie = header("cookie").and_then(|all| {
        all.split(';').find_map(|pair| pair.trim().strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
    });
    Ok(Request {
        method: parsed.method.unwrap_or("").to_string(),
        path: parsed.path.unwrap_or("").split('?').next().unwrap_or("").to_string(),
        host: header("host"),
        origin: header("origin"),
        cookie,
        user_agent: header("user-agent"),
        body,
    })
}

/// A request's `User-Agent`, safe to store and show: control characters (a
/// newline above all) removed, at most [`AGENT_MAX_CHARS`] characters.
fn clean_agent(raw: Option<&str>) -> String {
    raw.unwrap_or("").chars().filter(|c| !c.is_control()).take(AGENT_MAX_CHARS).collect()
}

/// Whether `host` (a `Host` header: name and optional port) may be served.
fn host_allowed(host: &str, hosts: &[String]) -> bool {
    let name = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, port)| if port.chars().all(|c| c.is_ascii_digit()) { name } else { host })
    };
    let name = name.to_ascii_lowercase();
    !name.is_empty() && (name.parse::<IpAddr>().is_ok() || name == "localhost" || hosts.contains(&name))
}

/// A response, written whole and the connection closed.
struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    set_cookie: Option<String>,
    /// A config write this answer waits on, done off the bridge's thread
    /// ([`serve`]): the answer stands only if it succeeds.
    config_write: Option<ConfigWrite>,
}

/// Config-file changes the page validated, still to be written.
pub(crate) struct ConfigWrite {
    path: PathBuf,
    changes: Vec<(String, Option<Value>)>,
    /// Who asked, for the log line (an npub prefix).
    by: String,
}

impl Response {
    fn new(status: u16, content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, content_type, body: body.into(), set_cookie: None, config_write: None }
    }

    fn json(status: u16, body: String) -> Self {
        Self::new(status, "application/json", body)
    }

    fn error(status: u16) -> Self {
        Self::json(status, serde_json::json!({ "error": reason(status) }).to_string())
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Error",
    }
}

async fn write_response<S: AsyncWrite + Unpin>(stream: &mut S, response: Response) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\
         Referrer-Policy: no-referrer\r\nCross-Origin-Opener-Policy: same-origin\r\n\
         Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; \
         connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len(),
    );
    if let Some(cookie) = response.set_cookie {
        head.push_str(&format!("Set-Cookie: {cookie}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&response.body).await;
    let _ = stream.shutdown().await;
}

fn session_cookie(token: &str, max_age_secs: u64) -> String {
    format!("{COOKIE}={token}; Path=/; Max-Age={max_age_secs}; Secure; HttpOnly; SameSite=Strict")
}

/// Answer a plain-HTTP request that reached the TLS port with a redirect to
/// the same page over HTTPS. Nothing else is served in cleartext, and a
/// `Host` the page would refuse gets no redirect, so this is no open
/// redirector.
pub async fn redirect_to_https<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, web: &Web) {
    let Ok(Some(head)) = tokio::time::timeout(BODY_TIMEOUT, read_head(&mut stream)).await else { return };
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    let host = match request.parse(&head) {
        Ok(httparse::Status::Complete(_)) => {
            request.headers.iter().find(|h| h.name.eq_ignore_ascii_case("host")).and_then(|h| std::str::from_utf8(h.value).ok()).map(str::to_string)
        }
        _ => None,
    };
    let path = request.path.filter(|p| p.starts_with('/') && !p.starts_with("//")).unwrap_or("/");
    let reply = match host.filter(|h| host_allowed(h, &web.hosts)) {
        Some(host) => format!("HTTP/1.1 301 Moved Permanently
Location: https://{host}{path}
Content-Length: 0
Connection: close

"),
        None => "HTTP/1.1 400 Bad Request
Content-Length: 0
Connection: close

".to_string(),
    };
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Read until the request head is complete (with whatever followed it in the
/// same reads), or `None` past [`MAX_HEAD_BYTES`] or at the end.
pub async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    while head_len(&buf).is_none() {
        if buf.len() >= MAX_HEAD_BYTES {
            return None;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..read]);
    }
    Some(buf)
}

/// Serve one page request whose head is in `buf`, from a browser at `peer`.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(buf: &[u8], mut stream: S, peer: IpAddr, web: &Web) {
    // The page shares the bridge's one thread with the relays, the engine
    // and the phones' links: past this many requests at once, a page request
    // is turned away rather than let it queue work in front of theirs.
    if web.serving.get() >= MAX_PAGE_REQUESTS {
        write_response(&mut stream, Response::error(503)).await;
        return;
    }
    web.serving.set(web.serving.get() + 1);
    let mut response = match read_request(buf, &mut stream).await {
        Ok(request) => route(&request, peer, web),
        Err(status) => Response::error(status),
    };
    if let Some(write) = response.config_write.take() {
        response = write_config(write).await;
    }
    web.serving.set(web.serving.get() - 1);
    write_response(&mut stream, response).await;
}

/// Write validated config changes on the blocking pool: a write ends in an
/// fsync, which on a slow disk would stall every phone's traffic for as long
/// if it ran on the bridge's thread.
async fn write_config(write: ConfigWrite) -> Response {
    let ConfigWrite { path, changes, by } = write;
    let keys: Vec<String> = changes.iter().map(|(key, _)| key.clone()).collect();
    match tokio::task::spawn_blocking(move || crate::config::write_web_settings(&path, &changes)).await {
        Ok(Ok(())) => {
            log::info!("[Web] config changed by {by}: keys {}", keys.join(", "));
            Response::json(200, serde_json::json!({ "ok": true, "restartNeeded": true }).to_string())
        }
        Ok(Err(err)) => {
            log::warn!("[Web] config write failed: {err}");
            Response::error(500)
        }
        Err(err) => {
            log::warn!("[Web] config write did not run: {err}");
            Response::error(500)
        }
    }
}

fn route(request: &Request, peer: IpAddr, web: &Web) -> Response {
    let Some(host) = request.host.as_deref().filter(|h| host_allowed(h, &web.hosts)) else {
        return Response::error(403);
    };
    if request.method == "POST" && request.origin.as_deref() != Some(&format!("https://{host}")) {
        return Response::error(403);
    }
    let browser = web.browser(request.cookie.as_deref());
    let now = web.now();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Response::new(200, "text/html; charset=utf-8", INDEX_HTML),
        ("GET", "/app.js") => Response::new(200, "text/javascript; charset=utf-8", APP_JS),
        ("GET", "/app.css") => Response::new(200, "text/css; charset=utf-8", APP_CSS),
        ("GET", "/favicon.png") => Response::new(200, "image/png", FAVICON_PNG),
        ("GET", "/api/me") => Response::json(200, me_json(browser.as_ref().map(|(_, b)| b), &web.machine_npub, now)),
        ("POST", "/api/sign-in") => {
            let Some(key) = sign_in_key(&request.body) else { return Response::error(400) };
            match web.start_sign_in(peer, &clean_agent(request.user_agent.as_deref()), key) {
                Some((token, code)) => {
                    let mut response = Response::json(200, serde_json::json!({ "state": "pending", "code": code, "expiresInMs": PENDING_TTL_MS }).to_string());
                    response.set_cookie = Some(session_cookie(&token, SESSION_TTL_MS / 1000));
                    response
                }
                None => Response::error(429),
            }
        }
        ("GET", "/api/sign-in/qr.svg") => match browser {
            Some((_, Browser { access: Access::Pending { code, .. }, .. })) => {
                let url = format!("codedeck://web-sign-in?machine={}&code={code}", web.machine_npub);
                match crate::qr::svg(&url) {
                    Some(svg) => Response::new(200, "image/svg+xml", svg),
                    None => Response::error(404),
                }
            }
            _ => Response::error(404),
        },
        // Ending its own sign-in is the one thing a cookie alone may do.
        ("POST", "/api/sign-out") => {
            if let Some((key, _)) = browser {
                web.sign_out(&key);
            }
            let mut response = Response::json(200, me_json(None, &web.machine_npub, now));
            response.set_cookie = Some(session_cookie("", 0));
            response
        }
        (_, "/" | "/app.js" | "/app.css" | "/favicon.png" | "/api/me" | "/api/sign-in" | "/api/sign-in/qr.svg" | "/api/sign-out") => Response::error(405),
        _ => Response::error(404),
    }
}

/// The browser's public key a sign-in start carries (`{"key": …}`), or
/// `None` when it carries none a browser could sign with.
fn sign_in_key(body: &[u8]) -> Option<BrowserKey> {
    let doc: Value = serde_json::from_slice(body).ok()?;
    BrowserKey::parse(doc.get("key")?.as_str()?)
}

/// A 400 naming the setting at fault, so the page can point at it.
fn bad_request(key: &str, message: &str) -> Response {
    Response::json(400, serde_json::json!({ "error": message, "key": key }).to_string())
}

/// What `GET /api/me` answers: where the browser stands, and what it needs
/// to sign on its stream — the machine and its own id.
fn me_json(browser: Option<&Browser>, machine: &str, now: u64) -> String {
    match browser {
        Some(Browser { access: Access::Pending { code, expires_ms }, key, .. }) => serde_json::json!({
            "state": "pending", "code": code, "expiresInMs": expires_ms.saturating_sub(now), "machine": machine, "id": key.id(),
        }),
        Some(browser @ Browser { access: Access::SignedIn { by, since_ms, .. }, key, .. }) => serde_json::json!({
            "state": "signed-in", "by": by, "since": since_ms, "lapses": browser.lapses_ms(), "machine": machine, "id": key.id(),
        }),
        None => serde_json::json!({ "state": "signed-out", "machine": machine }),
    }
    .to_string()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::{Signature, SigningKey};

    /// A browser's key pair, as WebCrypto makes one: the signing half stays
    /// with the test (the browser), the public half is what the page sends.
    pub(crate) struct TestKey {
        signing: SigningKey,
        pub public: BrowserKey,
    }

    impl TestKey {
        pub(crate) fn new(seed: u8) -> Self {
            let signing = SigningKey::from_bytes(&[seed.max(1); 32].into()).expect("a scalar");
            let raw = signing.verifying_key().to_encoded_point(false);
            let public = BrowserKey::parse(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())).unwrap();
            Self { signing, public }
        }

        pub(crate) fn base64url(&self) -> String {
            self.public.to_base64url()
        }

        /// Sign `input` as WebCrypto does: `r‖s`, base64url.
        pub(crate) fn sign(&self, input: &[u8]) -> String {
            let sig: Signature = self.signing.sign(input);
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
        }
    }

    /// A clock the test moves.
    pub(crate) fn clock() -> (Rc<Cell<u64>>, Box<dyn Fn() -> u64>) {
        let now = Rc::new(Cell::new(1_800_000_000_000u64));
        let read = Rc::clone(&now);
        (now, Box::new(move || read.get()))
    }

    /// A page over `home` on the clock `now`, its config view showing `fields`.
    pub(crate) fn page(home: &Path, fields: Vec<Value>, now: Box<dyn Fn() -> u64>) -> (Rc<Web>, mpsc::UnboundedReceiver<Input>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let config = ConfigView { path: home.join("config.json"), fields };
        let web = Web::with_clock("npub1machine".into(), &["wss://box.tail1234.ts.net:7447".into()], tx, home, config, now);
        // The identity the tests sign browsers in with is paired, as the
        // heartbeat tells the page.
        web.set_devices(&[phone("npub1owner")]);
        (web, rx)
    }

    /// A paired identity, as the heartbeat hands it to the page.
    fn phone(npub: &str) -> bridge_core::PairedPhone {
        bridge_core::PairedPhone {
            npub: npub.into(),
            pubkey_hex: "ab".repeat(32),
            label: "Pixel".into(),
            paired_at: "2026-01-02T03:04:05Z".into(),
            clients: Vec::new(),
        }
    }

    /// A page over a fresh temp dir, which the caller must keep alive.
    fn web() -> (Rc<Web>, mpsc::UnboundedReceiver<Input>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (web, rx) = page(dir.path(), Vec::new(), Box::new(now_ms));
        (web, rx, dir)
    }

    /// Start a sign-in at [`PEER`] with `key` and have the owner approve it,
    /// returning the browser's cookie token.
    pub(crate) fn sign_in_with(web: &Web, inputs: &mut mpsc::UnboundedReceiver<Input>, key: &TestKey) -> String {
        let (token, _) = web.start_sign_in(PEER, "Mozilla/5.0", key.public.clone()).expect("a start");
        let code = loop {
            match inputs.try_recv() {
                Ok(Input::WebSignInPending { code, .. }) => break code,
                Ok(_) => continue,
                Err(_) => panic!("the engine is told the code"),
            }
        };
        web.signed_in(&code, "npub1owner");
        token
    }

    fn sign_in(web: &Web, inputs: &mut mpsc::UnboundedReceiver<Input>) -> String {
        sign_in_with(web, inputs, &TestKey::new(7))
    }

    fn request(method: &str, path: &str, host: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            host: Some(host.into()),
            origin: (method == "POST").then(|| format!("https://{host}")),
            cookie: None,
            user_agent: None,
            body: Vec::new(),
        }
    }

    /// The head of a stream request, as a browser on the page sends it.
    pub(crate) fn stream_head(origin: &str, cookie: Option<&str>) -> Vec<u8> {
        let cookie = cookie.map(|c| format!("Cookie: {COOKIE}={c}\r\n")).unwrap_or_default();
        format!(
            "GET {STREAM_PATH} HTTP/1.1\r\nHost: {HOST}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{cookie}\r\n"
        )
        .into_bytes()
    }

    pub(crate) const PEER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 20));
    pub(crate) const HOST: &str = "192.168.1.5:7447";
    const DAY: u64 = 24 * 3600 * 1000;

    #[test]
    fn only_addresses_localhost_and_the_endpoints_hosts_are_served() {
        let hosts = vec!["box.tail1234.ts.net".to_string()];
        for ok in ["192.168.1.5:7447", "localhost:7447", "[::1]:7447", "BOX.tail1234.ts.net:7447", "10.0.0.2"] {
            assert!(host_allowed(ok, &hosts), "{ok}");
        }
        for refused in ["evil.example:7447", "", "box.tail1234.ts.net.evil.example"] {
            assert!(!host_allowed(refused, &hosts), "{refused}");
        }
    }

    #[test]
    fn a_post_from_another_origin_is_refused() {
        let (web, _, _dir) = web();
        let mut post = request("POST", "/api/sign-in", HOST);
        post.body = serde_json::json!({ "key": TestKey::new(1).base64url() }).to_string().into_bytes();
        post.origin = Some("https://evil.example".into());
        assert_eq!(route(&post, PEER, &web).status, 403);
        post.origin = None;
        assert_eq!(route(&post, PEER, &web).status, 403);
    }

    #[test]
    fn a_sign_in_start_needs_a_key_a_browser_can_sign_with() {
        let (web, _, _dir) = web();
        let mut post = request("POST", "/api/sign-in", HOST);
        assert_eq!(route(&post, PEER, &web).status, 400, "no key");
        post.body = br#"{"key":"AAAA"}"#.to_vec();
        assert_eq!(route(&post, PEER, &web).status, 400, "not a point");
        post.body = serde_json::json!({ "key": TestKey::new(1).base64url() }).to_string().into_bytes();
        let started = route(&post, PEER, &web);
        assert_eq!(started.status, 200);
        let cookie = started.set_cookie.unwrap();
        assert!(cookie.contains("Secure") && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    }

    #[test]
    fn every_file_the_page_links_is_served_before_sign_in() {
        let (web, _, _dir) = web();
        let linked: Vec<&str> = INDEX_HTML.split(['"', '\'']).filter(|s| s.starts_with('/') && s.contains('.')).collect();
        assert!(linked.contains(&"/favicon.png"), "{linked:?}");
        for path in linked {
            let served = route(&request("GET", path, HOST), PEER, &web);
            assert_eq!(served.status, 200, "{path}");
        }
        let icon = route(&request("GET", "/favicon.png", HOST), PEER, &web);
        assert_eq!(icon.content_type, "image/png");
    }

    #[test]
    fn a_cookie_alone_reaches_nothing_but_its_own_sign_in() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        let mut me = request("GET", "/api/me", HOST);
        me.cookie = Some(token.clone());
        let body: Value = serde_json::from_slice(&route(&me, PEER, &web).body).unwrap();
        assert_eq!(body["state"], "signed-in");
        assert_eq!(body["machine"], "npub1machine");
        assert_eq!(body["id"], TestKey::new(7).public.id());
        for (method, path) in [
            ("GET", "/api/status"),
            ("GET", "/api/browsers"),
            ("POST", "/api/browsers/sign-out"),
            ("GET", "/api/devices"),
            ("GET", "/api/config"),
            ("POST", "/api/config"),
        ] {
            let mut req = request(method, path, HOST);
            req.cookie = Some(token.clone());
            assert_eq!(route(&req, PEER, &web).status, 404, "{method} {path} answers only on the signed stream");
        }
    }

    #[test]
    fn only_a_signature_keeps_a_browser_signed_in_for_seven_idle_days() {
        let dir = tempfile::tempdir().unwrap();
        let (now, clock) = clock();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock);
        let token = sign_in(&web, &mut inputs);
        let key = token_key(&token);
        let mut me = request("GET", "/api/me", HOST);
        me.cookie = Some(token);

        // Six days of a cookie being shown, and nothing signed.
        for _ in 0..6 {
            now.set(now.get() + DAY);
            route(&me, PEER, &web);
        }
        now.set(now.get() + DAY - 1);
        assert!(web.still_signed_in(&key), "one ms short of seven days");
        now.set(now.get() + 1);
        assert!(!web.still_signed_in(&key), "the cookie did not keep it alive");
    }

    #[test]
    fn a_browser_in_use_still_lapses_after_thirty_days() {
        let dir = tempfile::tempdir().unwrap();
        let (now, clock) = clock();
        let (web, mut inputs) = page(dir.path(), Vec::new(), clock);
        let key = token_key(&sign_in(&web, &mut inputs));
        for _ in 0..29 {
            now.set(now.get() + DAY);
            assert!(web.still_signed_in(&key));
            web.seen(&key);
        }
        let row = &web.browsers()[0];
        assert_eq!(row.expires_ms, row.since_ms + SESSION_TTL_MS, "the list shows when it actually lapses");
        now.set(now.get() + DAY);
        assert!(!web.still_signed_in(&key));
        assert!(web.browsers().is_empty());
    }

    #[test]
    fn the_list_shows_the_idle_lapse_when_it_comes_first() {
        let (web, mut inputs, _dir) = web();
        sign_in(&web, &mut inputs);
        let row = &web.browsers()[0];
        assert_eq!(row.expires_ms, row.last_seen_ms + IDLE_TTL_MS);
    }

    #[test]
    fn the_stream_is_let_through_only_from_the_page_with_a_signed_in_cookie() {
        let (web, mut inputs, _dir) = web();
        let key = TestKey::new(7);
        let token = sign_in_with(&web, &mut inputs, &key);
        let origin = format!("https://{HOST}");
        let grant = web.stream_grant(&stream_head(&origin, Some(&token))).expect("let through");
        assert_eq!(grant.id, key.public.id());
        assert_eq!(grant.by, "npub1owner");
        assert_eq!(web.stream_grant(&stream_head("https://evil.example", Some(&token))).err(), Some(403), "another origin");
        assert_eq!(web.stream_grant(&stream_head(&origin, None)).err(), Some(401), "no cookie");
        assert_eq!(web.stream_grant(&stream_head(&origin, Some("forged"))).err(), Some(401), "a cookie the page never set");

        let (pending, _) = web.start_sign_in(PEER, "", TestKey::new(9).public).unwrap();
        assert_eq!(web.stream_grant(&stream_head(&origin, Some(&pending))).err(), Some(401), "a browser still waiting for its phone");
    }

    #[test]
    fn streams_are_capped_per_browser_and_the_first_and_last_say_so() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        while inputs.try_recv().is_ok() {}
        let grant = web.stream_grant(&stream_head(&format!("https://{HOST}"), Some(&token))).expect("let through");
        let opened: Vec<u64> = (0..MAX_STREAMS_PER_BROWSER).map(|_| web.open_stream(&grant).expect("room").0).collect();
        assert!(web.open_stream(&grant).is_none(), "one tab too many");
        let online: Vec<Input> = std::iter::from_fn(|| inputs.try_recv().ok()).collect();
        assert!(matches!(online.as_slice(), [Input::WebBrowserOnline { .. }]), "online once: {online:?}");
        for n in &opened {
            web.close_stream(*n);
        }
        let offline: Vec<Input> = std::iter::from_fn(|| inputs.try_recv().ok()).collect();
        assert!(matches!(offline.as_slice(), [Input::WebBrowserOffline { .. }]), "offline once: {offline:?}");
    }

    #[test]
    fn signing_out_closes_the_browsers_streams() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        let grant = web.stream_grant(&stream_head(&format!("https://{HOST}"), Some(&token))).expect("let through");
        let (_, lane, reason) = web.open_stream(&grant).unwrap();
        assert!(web.revoke(&grant.id));
        assert!(lane.is_closed());
        assert_eq!(reason.get(), protocol::web::closed::SIGNED_OUT);
    }

    #[test]
    fn an_ipv6_host_is_rate_limited_by_its_slash_64() {
        let (web, _, _dir) = web();
        let key = || TestKey::new(3).public;
        for i in 0..STARTS_PER_MINUTE {
            let peer = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 0, 0, 0, i as u16 + 1));
            assert!(web.start_sign_in(peer, "", key()).is_some());
        }
        let same_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 9, 9, 9, 9));
        assert!(web.start_sign_in(same_64, "", key()).is_none(), "another address in the same /64 counts as the same host");
        let other_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 3, 0, 0, 0, 1));
        assert!(web.start_sign_in(other_64, "", key()).is_some());
    }

    #[test]
    fn a_pending_browser_dropped_or_signed_out_withdraws_its_code() {
        let (web, mut inputs, _dir) = web();
        let mut first = None;
        for i in 0..=MAX_PENDING {
            // A peer of its own each, so the rate limit does not interfere.
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, (i / 250) as u8, (i % 250) as u8 + 1));
            let (token, code) = web.start_sign_in(peer, "", TestKey::new(3).public).expect("a start");
            first.get_or_insert((token, code));
        }
        let (first_token, first_code) = first.unwrap();
        let withdrawn: Vec<String> = std::iter::from_fn(|| inputs.try_recv().ok())
            .filter_map(|input| match input {
                Input::WebSignInWithdrawn { code } => Some(code),
                _ => None,
            })
            .collect();
        assert_eq!(withdrawn, vec![first_code], "the oldest pending browser made room, and its code went with it");
        assert!(web.browser(Some(&first_token)).is_none());

        let (token, code) = web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 9, 9, 9)), "", TestKey::new(3).public).unwrap();
        while inputs.try_recv().is_ok() {}
        web.sign_out(&token_key(&token));
        assert!(matches!(inputs.try_recv(), Ok(Input::WebSignInWithdrawn { code: c }) if c == code));
    }

    #[test]
    fn signed_in_browsers_are_capped_by_the_longest_signed_in() {
        let (web, _, _dir) = web();
        let mut tokens = Vec::new();
        for i in 0..=MAX_SESSIONS {
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 1, (i / 250) as u8, (i % 250) as u8 + 1));
            let (token, code) = web.start_sign_in(peer, "", TestKey::new(3).public).unwrap();
            web.signed_in(&code, "npub1owner");
            tokens.push(token);
        }
        let signed_in = web.browsers.borrow().values().filter(|b| matches!(b.access, Access::SignedIn { .. })).count();
        assert_eq!(signed_in, MAX_SESSIONS);
        assert!(web.browser(Some(&tokens[0])).is_none(), "the first one signed in went first");
        assert!(web.browser(tokens.last().map(String::as_str)).is_some(), "never the one just let in");
    }

    #[test]
    fn sign_in_starts_are_rate_limited_per_address() {
        let (web, _, _dir) = web();
        for _ in 0..STARTS_PER_MINUTE {
            assert!(web.start_sign_in(PEER, "", TestKey::new(3).public).is_some());
        }
        assert!(web.start_sign_in(PEER, "", TestKey::new(3).public).is_none());
        assert!(web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 21)), "", TestKey::new(3).public).is_some());
    }

    #[test]
    fn pending_sign_ins_are_capped() {
        let (web, _, _dir) = web();
        for i in 0..(MAX_PENDING as u8 + 10) {
            web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i)), "", TestKey::new(3).public).unwrap();
        }
        assert!(web.browsers.borrow().len() <= MAX_PENDING);
    }

    #[test]
    fn a_code_is_two_unambiguous_groups() {
        let code = new_code();
        assert_eq!(code.len(), 9);
        assert!(code.chars().enumerate().all(|(i, c)| if i == 4 { c == '-' } else { CODE_ALPHABET.contains(&(c as u8)) }));
    }

    #[test]
    fn a_websocket_upgrade_is_told_apart_from_a_page_request() {
        assert!(is_websocket(b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
        assert!(!is_websocket(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
        assert_eq!(head_len(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
        assert!(is_stream_request(&stream_head("https://x", None)), "the browser's stream");
        assert!(!is_stream_request(b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\r\n"), "a phone's direct link");
    }

    #[test]
    fn signed_in_browsers_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (web, mut inputs) = page(dir.path(), Vec::new(), Box::new(now_ms));
        let key = TestKey::new(7);
        let token = sign_in_with(&web, &mut inputs, &key);
        web.writer.flush();

        // A new page over the same home, as after a restart.
        let (again, _rx) = page(dir.path(), Vec::new(), Box::new(now_ms));
        let grant = again.stream_grant(&stream_head(&format!("https://{HOST}"), Some(&token))).expect("the cookie still works");
        assert_eq!(grant.browser_key, key.public, "and so does the key it signed in with");

        // The file holds the cookie's SHA-256, never the token itself.
        let raw = std::fs::read_to_string(dir.path().join("web-sessions.json")).unwrap();
        assert!(!raw.contains(&token), "no token is written");
        assert!(raw.contains(&token_key(&token)), "the key's hash is");
        assert!(raw.contains("Mozilla/5.0"), "and the User-Agent came along");
    }

    #[test]
    fn an_expired_keyless_or_corrupt_sessions_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("web-sessions.json");
        let record = |public_key: Option<String>, expires: u64| {
            let mut r = serde_json::json!({
                "key": "a".repeat(64), "by": "npub1x", "sinceMs": 1, "expiresMs": expires, "lastSeenMs": now_ms(),
                "peer": "192.168.1.5", "agent": "x",
            });
            if let Some(k) = public_key {
                r["publicKey"] = Value::String(k);
            }
            serde_json::json!([r])
        };
        let empty = |raw: String| {
            std::fs::write(&path, raw).unwrap();
            page(dir.path(), Vec::new(), Box::new(now_ms)).0.browsers.borrow().is_empty()
        };
        assert!(empty(record(Some(TestKey::new(1).base64url()), 2).to_string()), "an expired one is dropped");
        assert!(empty(record(None, u64::MAX).to_string()), "one from before browser keys signs in again");
        assert!(!empty(record(Some(TestKey::new(1).base64url()), u64::MAX).to_string()), "a good one is kept");
        assert!(empty("{not json".into()), "a corrupt file is empty, not fatal");
    }

    #[test]
    fn the_phone_list_names_each_browser_by_its_keys_id() {
        let (web, mut inputs, _dir) = web();
        let first = TestKey::new(7);
        sign_in_with(&web, &mut inputs, &first);
        let (_second, _) = web.start_sign_in(PEER, "curl/8", TestKey::new(8).public).unwrap();
        let code = loop {
            if let Ok(Input::WebSignInPending { code, .. }) = inputs.try_recv() {
                break code;
            }
        };
        web.signed_in(&code, "npub1owner");

        let phone = web.browsers();
        assert_eq!(phone.len(), 2);
        assert_eq!(phone[0].id, first.public.id(), "the id is the key's, never the token's");
        assert_eq!(phone[0].by, "npub1owner");
        assert_eq!(phone[0].peer, "192.168.1.20");
        assert_eq!(phone[1].agent, "curl/8");
        for browser in &phone {
            assert!(browser.since_ms > 0 && browser.expires_ms > browser.since_ms);
        }
    }

    #[test]
    fn revoking_a_browser_ends_its_cookie() {
        let (web, mut inputs, _dir) = web();
        let victim = TestKey::new(7);
        let token = sign_in_with(&web, &mut inputs, &victim);
        assert!(web.still_signed_in(&token_key(&token)));
        assert!(web.revoke(&victim.public.id()));
        assert!(!web.still_signed_in(&token_key(&token)), "the revoked browser's cookie no longer works");
        assert!(!web.revoke("0123456789abcdef"), "an unknown id");
    }

    #[test]
    fn a_browser_whose_identity_is_no_longer_paired_reaches_nothing() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        // Unpaired while the bridge was down: the record survived on disk,
        // the heartbeat no longer lists its identity.
        web.set_devices(&[phone("npub1someoneelse")]);
        assert_eq!(web.page_request(r#"{"type":"config"}"#, "npub1owner").0, 403);
        assert_eq!(web.stream_grant(&stream_head(&format!("https://{HOST}"), Some(&token))).err(), Some(401));
    }

    #[test]
    fn a_browser_dropped_to_make_room_loses_its_streams() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        let grant = web.stream_grant(&stream_head(&format!("https://{HOST}"), Some(&token))).expect("let through");
        let (_, lane, _) = web.open_stream(&grant).unwrap();
        for i in 0..MAX_SESSIONS {
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 2, (i / 250) as u8, (i % 250) as u8 + 1));
            let (_, code) = web.start_sign_in(peer, "", TestKey::new(3).public).unwrap();
            web.signed_in(&code, "npub1owner");
        }
        assert!(lane.is_closed(), "the oldest browser went, and its stream with it");
    }

    #[test]
    fn unpairing_its_identity_ends_a_browser() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
        web.end_by("npub1someoneelse");
        assert!(web.still_signed_in(&token_key(&token)));
        web.end_by("npub1owner");
        assert!(!web.still_signed_in(&token_key(&token)));
    }

    #[test]
    fn the_devices_request_shows_paired_phones_without_any_secret() {
        let (web, _, _dir) = web();
        let phone = bridge_core::PairedPhone {
            npub: "npub1phone".into(),
            pubkey_hex: "ab".repeat(32),
            label: "Pixel".into(),
            paired_at: "2026-01-02T03:04:05Z".into(),
            clients: vec![bridge_core::PhoneClient {
                key: protocol::commands::SessionKeyGrant {
                    pubkey_hex: "cd".repeat(32),
                    bridge_pubkey_hex: "ef".repeat(32),
                    expires_at: 1_800_000_000,
                    replaces: None,
                    label: Some("Pixel 8a".into()),
                },
                previous: None,
                device: "3f9a1c0e7b2d4a58".into(),
                label: Some("Pixel 8a".into()),
                present_until_ms: 1_700_000_000_000,
                presumed: false,
                watch: bridge_core::WatchState::default(),
                watch_terminal: bridge_core::WatchState::default(),
            }],
        };
        web.set_devices(&[phone]);

        let (status, body, write) = web.page_request(r#"{"type":"devices"}"#, "npub1phone");
        assert_eq!(status, 200);
        assert!(write.is_none());
        let json: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["devices"][0]["npub"], "npub1phone");
        assert_eq!(json["devices"][0]["label"], "Pixel");
        assert_eq!(json["devices"][0]["clients"][0]["expiresAt"], 1_800_000_000u64);
        assert_eq!(json["devices"][0]["clients"][0]["presentUntilMs"], 1_700_000_000_000u64);
        assert!(!body.contains(&"ab".repeat(32)), "no identity key");
        assert!(!body.contains(&"cd".repeat(32)), "no session key");
        assert!(!body.contains("pubkey"));
    }

    #[test]
    fn the_config_request_serves_every_field_with_its_value() {
        let dir = tempfile::tempdir().unwrap();
        let fields = vec![serde_json::json!({ "key": "machineName", "value": "desktop", "editable": true, "overridden": false })];
        let (web, _) = page(dir.path(), fields, Box::new(now_ms));
        let (status, body, _) = web.page_request(r#"{"type":"config"}"#, "npub1owner");
        assert_eq!(status, 200);
        let json: Value = serde_json::from_str(&body).unwrap();
        assert!(json["fields"].as_array().unwrap().iter().any(|f| f["key"] == "machineName" && f["value"] == "desktop"));
    }

    #[test]
    fn a_config_set_outside_the_safe_set_is_refused_and_leaves_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let before = r#"{"machineName":"desktop","workspaceRoots":["/srv/w"],"keepMe":42}"#;
        std::fs::write(&path, before).unwrap();
        let (web, _) = page(dir.path(), Vec::new(), Box::new(now_ms));
        let (status, body, write) = web.page_request(r#"{"type":"config-set","set":{"nodePath":"/evil"}}"#, "npub1owner");
        assert_eq!(status, 400);
        assert!(write.is_none());
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["key"], "nodePath");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "the file is untouched");
    }

    #[test]
    fn an_endpoint_the_bridge_has_no_listener_for_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let (web, _) = page(dir.path(), Vec::new(), Box::new(now_ms));
        let (status, _, write) = web.page_request(r#"{"type":"config-set","set":{"direct.endpoints":["ws://abc.onion:7448"]}}"#, "npub1owner");
        assert_eq!(status, 400, "the bridge would refuse to start from it");
        assert!(write.is_none());
    }

    #[test]
    fn a_config_set_writes_the_file_keeping_every_other_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"machineName":"desktop","direct":{"listen":"0.0.0.0:7447"},"keepMe":{"x":1}}"#).unwrap();
        // The bridge runs the direct listener, so a wss:// endpoint is one it can serve.
        let listening = serde_json::json!({ "key": "direct.listen", "value": "0.0.0.0:7447", "editable": false, "overridden": false });
        let (web, _) = page(dir.path(), vec![listening], Box::new(now_ms));
        let request = serde_json::json!({
            "type": "config-set",
            "set": { "machineName": "laptop", "relays": ["wss://relay.example"], "direct.endpoints": ["wss://192.168.1.9:7447"] },
        });
        let (status, body, write) = web.page_request(&request.to_string(), "npub1owner");
        assert_eq!(status, 200);
        let json: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["restartNeeded"], true);
        // The stream makes the write on the blocking pool; here, in place.
        let write = write.expect("a write to do");
        crate::config::write_web_settings(&write.path, &write.changes).unwrap();

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["machineName"], "laptop");
        assert_eq!(written["relays"][0], "wss://relay.example");
        assert_eq!(written["direct"]["endpoints"][0], "wss://192.168.1.9:7447");
        assert_eq!(written["direct"]["listen"], "0.0.0.0:7447", "another key in the same object is kept");
        assert_eq!(written["keepMe"]["x"], 1, "an unknown key is kept");
    }

    #[test]
    fn a_config_set_with_a_bad_value_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let (web, _) = page(dir.path(), Vec::new(), Box::new(now_ms));
        for (key, value) in [
            ("machineName", serde_json::json!("")),
            ("relays", serde_json::json!(["ws://192.168.1.9:7447"])),
            ("direct.endpoints", serde_json::json!(["https://x"])),
            ("transcriptKeepLast", serde_json::json!(-1)),
        ] {
            let request = serde_json::json!({ "type": "config-set", "set": { key: value } });
            assert_eq!(web.page_request(&request.to_string(), "npub1owner").0, 400, "{key}");
        }
    }
}
