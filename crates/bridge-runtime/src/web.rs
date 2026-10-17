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
//! listener, and a secret only as set/not set).
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
use protocol::events::{SessionListMsg, WebBrowserInfo};
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
/// How long a signed-in browser stays signed in.
const SESSION_TTL_MS: u64 = 30 * 24 * 3600 * 1000;
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
/// How many hex characters of a browser's key are its public id.
const ID_LEN: usize = 16;
/// Longest `User-Agent` kept for a browser; the header is the client's, so it
/// is bounded before it is stored or shown.
const AGENT_MAX_CHARS: usize = 120;

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const APP_CSS: &str = include_str!("../web/app.css");

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
    peer: IpAddr,
    /// When it got where it stands, as a count: what the caps drop the
    /// lowest of (a clock can give two browsers the same millisecond).
    order: u64,
    /// The `User-Agent` of the request that started the sign-in, cleaned
    /// (control characters stripped, at most [`AGENT_MAX_CHARS`]). Shown on
    /// the page so the owner can tell one browser from another.
    agent: String,
    /// When it last made an authenticated request. Kept in memory on every
    /// one, written at most every [`LAST_SEEN_WRITE_MS`].
    last_seen_ms: u64,
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
    heartbeat: RefCell<Option<SessionListMsg>>,
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
}

impl Web {
    pub fn new(
        machine_npub: String,
        endpoints: &[String],
        inputs: mpsc::UnboundedSender<Input>,
        home: &Path,
        config: ConfigView,
    ) -> Rc<Self> {
        let hosts = endpoints.iter().filter_map(|url| endpoint_host(url)).collect();
        let sessions_path = home.join("web-sessions.json");
        let browsers = load_sessions(&sessions_path);
        let order = browsers.values().map(|b| b.order).max().unwrap_or(0) + 1;
        if !browsers.is_empty() {
            log::info!("[Web] {} signed-in browser(s) restored from {}", browsers.len(), sessions_path.display());
        }
        Rc::new(Self {
            machine_npub,
            hosts,
            heartbeat: RefCell::default(),
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
        })
    }

    /// The heartbeat the bridge just published, which the status page shows.
    pub fn set_heartbeat(&self, list: &SessionListMsg) {
        *self.heartbeat.borrow_mut() = Some(list.clone());
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
        let now = now_ms();
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
        self.persist();
    }

    fn browser(&self, token: Option<&str>) -> Option<(String, Browser)> {
        let key = token_key(token?);
        let now = now_ms();
        let mut expired = false;
        let mut touched = false;
        {
            let mut browsers = self.browsers.borrow_mut();
            let browser = browsers.get_mut(&key)?;
            let expires_ms = match browser.access {
                Access::Pending { expires_ms, .. } | Access::SignedIn { expires_ms, .. } => expires_ms,
            };
            if expires_ms <= now {
                expired = true;
            } else if matches!(browser.access, Access::SignedIn { .. }) {
                // An authenticated request: its `lastSeenMs` moves, and the
                // file follows at most once a minute.
                browser.last_seen_ms = now;
                touched = true;
            }
        }
        if expired {
            self.browsers.borrow_mut().remove(&key);
            self.persist();
            return None;
        }
        if touched && now.saturating_sub(self.last_persist_ms.get()) >= LAST_SEEN_WRITE_MS {
            self.last_persist_ms.set(now);
            self.persist();
        }
        self.browsers.borrow().get(&key).map(|b| (key.clone(), b.clone()))
    }

    /// Start a sign-in for a browser at `peer` (its `User-Agent` is `agent`):
    /// a new code, and the cookie that names it. `None` when the address
    /// started too many lately.
    fn start_sign_in(&self, peer: IpAddr, agent: &str) -> Option<(String, String)> {
        let now = now_ms();
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
        browsers.retain(|_, b| match b.access {
            Access::Pending { expires_ms, .. } | Access::SignedIn { expires_ms, .. } => expires_ms > now,
        });
        let browser = Browser {
            access: Access::Pending { code: code.clone(), expires_ms },
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
        Some((token, code))
    }

    fn sign_out(&self, key: &str) {
        let removed = self.browsers.borrow_mut().remove(key);
        if let Some(browser) = removed {
            self.withdraw(&browser);
            self.persist();
        }
    }

    /// Sign out the browser whose id (the first [`ID_LEN`] hex characters of
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
            .find(|(key, browser)| key.starts_with(id) && matches!(browser.access, Access::SignedIn { .. }))
            .map(|(key, _)| key.clone());
        match key {
            Some(key) => {
                self.sign_out(&key);
                true
            }
            None => false,
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

    fn status_json(&self, by: &str, since_ms: u64) -> String {
        let heartbeat = self.heartbeat.borrow();
        serde_json::json!({
            "machine": self.machine_npub,
            "signedInBy": by,
            "signedInSince": since_ms,
            "heartbeat": heartbeat.as_ref().map(|h| serde_json::to_value(h).unwrap_or(serde_json::Value::Null)),
        })
        .to_string()
    }

    /// The signed-in browsers, oldest signed in first, as `(key, info)`. The
    /// page's own list: both `browsers_json` and `browsers` read it, so what
    /// `GET /api/browsers` serves and what a phone's `web-browsers-request`
    /// is answered with can never disagree.
    /// A browser whose sign-in has lapsed is left out: it is only reaped when
    /// it next asks for something, and until then it is not signed in.
    fn browser_rows(&self) -> Vec<(String, WebBrowserInfo)> {
        let now = now_ms();
        let mut rows: Vec<(u64, String, WebBrowserInfo)> = self
            .browsers
            .borrow()
            .iter()
            .filter_map(|(key, browser)| match &browser.access {
                Access::SignedIn { by, since_ms, expires_ms } if *expires_ms > now => Some((
                    browser.order,
                    key.clone(),
                    WebBrowserInfo {
                        id: key[..ID_LEN].to_string(),
                        by: by.clone(),
                        since_ms: *since_ms,
                        last_seen_ms: browser.last_seen_ms,
                        expires_ms: *expires_ms,
                        peer: browser.peer.to_string(),
                        agent: browser.agent.clone(),
                    },
                )),
                _ => None,
            })
            .collect();
        rows.sort_by_key(|(order, _, _)| *order);
        rows.into_iter().map(|(_, key, info)| (key, info)).collect()
    }

    /// The signed-in browsers, oldest signed in first: what a paired phone's
    /// `web-browsers-request` is answered with, from the same rows
    /// `GET /api/browsers` serves.
    pub fn browsers(&self) -> Vec<WebBrowserInfo> {
        self.browser_rows().into_iter().map(|(_, info)| info).collect()
    }

    /// The signed-in browsers, oldest first, for `GET /api/browsers`. Each
    /// row carries `current` — whether it is the browser asking — which only
    /// the page's own request can know.
    fn browsers_json(&self, current: Option<&str>) -> String {
        let rows: Vec<Value> = self
            .browser_rows()
            .into_iter()
            .map(|(key, info)| {
                let mut row = serde_json::to_value(&info).unwrap_or(Value::Null);
                if let Value::Object(map) = &mut row {
                    map.insert("current".to_string(), Value::Bool(current == Some(key.as_str())));
                }
                row
            })
            .collect();
        serde_json::json!({ "browsers": rows }).to_string()
    }

    /// The paired identities, for `GET /api/devices`.
    fn devices_json(&self) -> String {
        serde_json::json!({ "devices": self.devices.borrow().clone() }).to_string()
    }

    /// The config as it is in effect, for `GET /api/config`.
    fn config_json(&self) -> String {
        serde_json::json!({ "fields": self.config_fields.borrow().clone() }).to_string()
    }

    /// Apply a `POST /api/config` body: only safe-set keys, each validated,
    /// then written to the config file keeping every other key. `by` is the
    /// approver's npub, for the log line (key names only, never a value).
    fn apply_config(&self, body: &[u8], by: &str) -> Response {
        let Ok(doc) = serde_json::from_slice::<Value>(body) else { return Response::error(400) };
        let Some(obj) = doc.as_object() else { return Response::error(400) };
        if obj.keys().any(|key| key != "set" && key != "secrets") {
            return Response::error(400);
        }
        let empty = serde_json::Map::new();
        let set = match obj.get("set") {
            None => &empty,
            Some(Value::Object(map)) => map,
            Some(_) => return Response::error(400),
        };
        let secrets = match obj.get("secrets") {
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
        for (key, value) in secrets {
            if !crate::config::WEB_EDITABLE_SECRETS.contains(&key.as_str()) {
                return bad_request(key, "not a secret the page may change");
            }
            if let Err(message) = crate::config::validate_web_secret(key, value) {
                return bad_request(key, &message);
            }
            // `null` clears the token: the key comes out of the file.
            changes.push((key.clone(), (!value.is_null()).then(|| value.clone())));
        }
        if changes.is_empty() {
            return bad_request("", "nothing to change");
        }
        let mut response = Response::json(200, serde_json::json!({ "ok": true, "restartNeeded": true }).to_string());
        response.config_write = Some(ConfigWrite { path: self.config_file.clone(), changes, by: by[..8.min(by.len())].to_string() });
        response
    }
}

/// The signed-in browsers a previous run left in `path`, expired ones
/// dropped. A missing or unreadable file is an empty set, with a warning: a
/// page that will not start is worse than one whose browsers sign in again.
fn load_sessions(path: &Path) -> HashMap<String, Browser> {
    let now = now_ms();
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
        if session.expires_ms <= now || session.key.len() != 64 {
            continue;
        }
        let access = Access::SignedIn { by: session.by, since_ms: session.since_ms, expires_ms: session.expires_ms };
        browsers.insert(
            session.key,
            Browser { access, peer, order, agent: session.agent, last_seen_ms: session.last_seen_ms },
        );
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
struct ConfigWrite {
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
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Response::new(200, "text/html; charset=utf-8", INDEX_HTML),
        ("GET", "/app.js") => Response::new(200, "text/javascript; charset=utf-8", APP_JS),
        ("GET", "/app.css") => Response::new(200, "text/css; charset=utf-8", APP_CSS),
        ("GET", "/api/me") => Response::json(200, me_json(browser.as_ref().map(|(_, b)| b))),
        ("POST", "/api/sign-in") => match web.start_sign_in(peer, &clean_agent(request.user_agent.as_deref())) {
            Some((token, code)) => {
                let mut response = Response::json(200, serde_json::json!({ "state": "pending", "code": code, "expiresInMs": PENDING_TTL_MS }).to_string());
                response.set_cookie = Some(session_cookie(&token, SESSION_TTL_MS / 1000));
                response
            }
            None => Response::error(429),
        },
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
        ("POST", "/api/sign-out") => {
            if let Some((key, _)) = browser {
                web.sign_out(&key);
            }
            let mut response = Response::json(200, me_json(None));
            response.set_cookie = Some(session_cookie("", 0));
            response
        }
        ("GET", "/api/status") => match &browser {
            Some((_, Browser { access: Access::SignedIn { by, since_ms, .. }, .. })) => Response::json(200, web.status_json(by, *since_ms)),
            _ => Response::error(401),
        },
        ("GET", "/api/browsers") => match signed_in(&browser) {
            Some((key, _)) => Response::json(200, web.browsers_json(Some(key))),
            None => Response::error(401),
        },
        ("POST", "/api/browsers/sign-out") => match signed_in(&browser) {
            Some(_) => match sign_out_id(&request.body) {
                Some(id) if web.revoke(&id) => Response::json(200, serde_json::json!({ "ok": true }).to_string()),
                Some(_) => Response::error(404),
                None => Response::error(400),
            },
            None => Response::error(401),
        },
        ("GET", "/api/devices") => match signed_in(&browser) {
            Some(_) => Response::json(200, web.devices_json()),
            None => Response::error(401),
        },
        ("GET", "/api/config") => match signed_in(&browser) {
            Some(_) => Response::json(200, web.config_json()),
            None => Response::error(401),
        },
        ("POST", "/api/config") => match signed_in(&browser) {
            Some((_, by)) => web.apply_config(&request.body, by),
            None => Response::error(401),
        },
        (
            _,
            "/" | "/app.js" | "/app.css" | "/api/me" | "/api/sign-in" | "/api/sign-in/qr.svg" | "/api/sign-out" | "/api/status"
            | "/api/browsers" | "/api/browsers/sign-out" | "/api/devices" | "/api/config",
        ) => Response::error(405),
        _ => Response::error(404),
    }
}

/// The signed-in browser's key and approver, if it is signed in.
fn signed_in(browser: &Option<(String, Browser)>) -> Option<(&str, &str)> {
    match browser {
        Some((key, Browser { access: Access::SignedIn { by, .. }, .. })) => Some((key.as_str(), by.as_str())),
        _ => None,
    }
}

/// The browser id a sign-out POST names, or `None` when the body is not a
/// JSON object with a string `id`.
fn sign_out_id(body: &[u8]) -> Option<String> {
    let doc: Value = serde_json::from_slice(body).ok()?;
    doc.get("id")?.as_str().map(str::to_string)
}

/// A 400 naming the setting at fault, so the page can point at it.
fn bad_request(key: &str, message: &str) -> Response {
    Response::json(400, serde_json::json!({ "error": message, "key": key }).to_string())
}

fn me_json(browser: Option<&Browser>) -> String {
    let now = now_ms();
    match browser.map(|b| &b.access) {
        Some(Access::Pending { code, expires_ms }) => {
            serde_json::json!({ "state": "pending", "code": code, "expiresInMs": expires_ms.saturating_sub(now) })
        }
        Some(Access::SignedIn { by, since_ms, .. }) => {
            serde_json::json!({ "state": "signed-in", "by": by, "since": since_ms })
        }
        None => serde_json::json!({ "state": "signed-out" }),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page over `home`, with no config view.
    fn web_in(home: &Path) -> (Rc<Web>, mpsc::UnboundedReceiver<Input>) {
        web_with_config(home, Vec::new())
    }

    /// A page over `home`, its config API showing `fields`.
    fn web_with_config(home: &Path, fields: Vec<Value>) -> (Rc<Web>, mpsc::UnboundedReceiver<Input>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let config = ConfigView { path: home.join("config.json"), fields };
        (Web::new("npub1machine".into(), &["wss://box.tail1234.ts.net:7447".into()], tx, home, config), rx)
    }

    /// A page over a fresh temp dir, which the caller must keep alive.
    fn web() -> (Rc<Web>, mpsc::UnboundedReceiver<Input>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (web, rx) = web_in(dir.path());
        (web, rx, dir)
    }

    /// Start a sign-in at [`PEER`] and have the owner approve it, returning
    /// the browser's cookie token.
    fn sign_in(web: &Web, inputs: &mut mpsc::UnboundedReceiver<Input>) -> String {
        let (token, _) = web.start_sign_in(PEER, "Mozilla/5.0").expect("a start");
        let Some(Input::WebSignInPending { code, .. }) = inputs.try_recv().ok() else { panic!("the engine is told the code") };
        web.signed_in(&code, "npub1owner");
        token
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

    const PEER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 20));
    const HOST: &str = "192.168.1.5:7447";

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
        let mut post = request("POST", "/api/sign-in", "192.168.1.5:7447");
        post.origin = Some("https://evil.example".into());
        assert_eq!(route(&post, PEER, &web).status, 403);
        post.origin = None;
        assert_eq!(route(&post, PEER, &web).status, 403);
    }

    #[test]
    fn the_status_needs_a_signed_in_browser() {
        let (web, mut inputs, _dir) = web();
        let host = "192.168.1.5:7447";
        assert_eq!(route(&request("GET", "/api/status", host), PEER, &web).status, 401);

        let started = route(&request("POST", "/api/sign-in", host), PEER, &web);
        let cookie = started.set_cookie.clone().unwrap();
        assert!(cookie.contains("Secure") && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let token = cookie.split(';').next().unwrap().strip_prefix(&format!("{COOKIE}=")).unwrap().to_string();
        let Some(Input::WebSignInPending { code, .. }) = inputs.try_recv().ok() else { panic!("the engine is told the code") };

        let mut status = request("GET", "/api/status", host);
        status.cookie = Some(token.clone());
        assert_eq!(route(&status, PEER, &web).status, 401, "a pending browser sees no status");

        web.signed_in(&code, "npub1owner");
        assert_eq!(route(&status, PEER, &web).status, 200);

        let mut out = request("POST", "/api/sign-out", host);
        out.cookie = Some(token);
        route(&out, PEER, &web);
        assert_eq!(route(&status, PEER, &web).status, 401, "signed out");
    }

    #[test]
    fn an_ipv6_host_is_rate_limited_by_its_slash_64() {
        let (web, _, _dir) = web();
        for i in 0..STARTS_PER_MINUTE {
            let peer = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 0, 0, 0, i as u16 + 1));
            assert!(web.start_sign_in(peer, "").is_some());
        }
        let same_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 9, 9, 9, 9));
        assert!(web.start_sign_in(same_64, "").is_none(), "another address in the same /64 counts as the same host");
        let other_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 3, 0, 0, 0, 1));
        assert!(web.start_sign_in(other_64, "").is_some());
    }

    #[test]
    fn a_pending_browser_dropped_or_signed_out_withdraws_its_code() {
        let (web, mut inputs, _dir) = web();
        let mut first = None;
        for i in 0..=MAX_PENDING {
            // A peer of its own each, so the rate limit does not interfere.
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, (i / 250) as u8, (i % 250) as u8 + 1));
            let (token, code) = web.start_sign_in(peer, "").expect("a start");
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

        let (token, code) = web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 9, 9, 9)), "").unwrap();
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
            let (token, code) = web.start_sign_in(peer, "").unwrap();
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
            assert!(web.start_sign_in(PEER, "").is_some());
        }
        assert!(web.start_sign_in(PEER, "").is_none());
        assert!(web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 21)), "").is_some());
    }

    #[test]
    fn pending_sign_ins_are_capped() {
        let (web, _, _dir) = web();
        for i in 0..(MAX_PENDING as u8 + 10) {
            web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i)), "").unwrap();
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
    }

    #[test]
    fn signed_in_browsers_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let (web, mut inputs) = web_in(dir.path());
        let token = sign_in(&web, &mut inputs);
        web.writer.flush();

        // A new page over the same home, as after a restart.
        let (again, _rx) = web_in(dir.path());
        let mut status = request("GET", "/api/status", HOST);
        status.cookie = Some(token.clone());
        assert_eq!(route(&status, PEER, &again).status, 200, "the cookie still works");

        // The file holds the key's SHA-256, never the token itself.
        let raw = std::fs::read_to_string(dir.path().join("web-sessions.json")).unwrap();
        assert!(!raw.contains(&token), "no token is written");
        assert!(raw.contains(&token_key(&token)), "the key's hash is");
        assert!(raw.contains("Mozilla/5.0"), "and the User-Agent came along");
    }

    #[test]
    fn an_expired_or_corrupt_sessions_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("web-sessions.json");
        let expired = serde_json::json!([{
            "key": "a".repeat(64), "by": "npub1x", "sinceMs": 1, "expiresMs": 2, "lastSeenMs": 1,
            "peer": "192.168.1.5", "agent": "x",
        }]);
        std::fs::write(&path, expired.to_string()).unwrap();
        assert!(web_in(dir.path()).0.browsers.borrow().is_empty(), "an expired one is dropped");

        std::fs::write(&path, "{not json").unwrap();
        assert!(web_in(dir.path()).0.browsers.borrow().is_empty(), "a corrupt file is empty, not fatal");
    }

    #[test]
    fn the_browsers_api_lists_browsers_and_marks_the_current_one() {
        let (web, mut inputs, _dir) = web();
        let first = sign_in(&web, &mut inputs);
        let (second, _) = web.start_sign_in(PEER, "curl/8").unwrap();
        let Some(Input::WebSignInPending { code, .. }) = inputs.try_recv().ok() else { panic!("the engine is told the code") };
        web.signed_in(&code, "npub1owner");

        let mut get = request("GET", "/api/browsers", HOST);
        get.cookie = Some(first.clone());
        let response = route(&get, PEER, &web);
        assert_eq!(response.status, 200);
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        let rows = body["browsers"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], &token_key(&first)[..ID_LEN]);
        assert_eq!(rows[0]["current"], true);
        assert_eq!(rows[1]["current"], false);
        assert_eq!(rows[1]["agent"], "curl/8");
        assert_eq!(rows[0]["peer"], "192.168.1.20");
        for field in ["sinceMs", "lastSeenMs", "expiresMs"] {
            assert!(rows[0][field].is_number(), "{field}");
        }
        assert_eq!(rows[0]["by"], "npub1owner");
        assert!(serde_json::from_slice::<Value>(&response.body).unwrap().get("token").is_none());
        assert!(second.len() > ID_LEN, "the full token is not what the page sees");
    }

    #[test]
    fn the_phone_list_is_the_page_list_without_the_current_mark() {
        let (web, mut inputs, _dir) = web();
        let first = sign_in(&web, &mut inputs);
        let (_second, _) = web.start_sign_in(PEER, "curl/8").unwrap();
        let Some(Input::WebSignInPending { code, .. }) = inputs.try_recv().ok() else { panic!("the engine is told the code") };
        web.signed_in(&code, "npub1owner");

        let mut get = request("GET", "/api/browsers", HOST);
        get.cookie = Some(first.clone());
        let body: Value = serde_json::from_slice(&route(&get, PEER, &web).body).unwrap();
        let json_ids: Vec<String> = body["browsers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect();

        // The phone's list and the page's are one list: same rows, same order.
        let phone = web.browsers();
        assert_eq!(phone.iter().map(|b| b.id.clone()).collect::<Vec<_>>(), json_ids);
        assert_eq!(phone[0].id, &token_key(&first)[..ID_LEN], "the id is the key's short public form, never the token");
        assert_eq!(phone[0].by, "npub1owner");
        assert_eq!(phone[0].peer, "192.168.1.20");
        assert_eq!(phone[1].agent, "curl/8");
        for browser in &phone {
            assert!(browser.since_ms > 0 && browser.expires_ms > browser.since_ms);
        }
    }

    #[test]
    fn revoking_another_browser_ends_its_cookie() {
        let (web, mut inputs, _dir) = web();
        let victim = sign_in(&web, &mut inputs);
        let owner = sign_in(&web, &mut inputs);

        let mut status = request("GET", "/api/status", HOST);
        status.cookie = Some(victim.clone());
        assert_eq!(route(&status, PEER, &web).status, 200);

        let mut post = request("POST", "/api/browsers/sign-out", HOST);
        post.cookie = Some(owner);
        post.body = serde_json::json!({ "id": &token_key(&victim)[..ID_LEN] }).to_string().into_bytes();
        assert_eq!(route(&post, PEER, &web).status, 200);
        assert_eq!(route(&status, PEER, &web).status, 401, "the revoked browser's cookie no longer works");

        post.body = serde_json::json!({ "id": "0123456789abcdef" }).to_string().into_bytes();
        assert_eq!(route(&post, PEER, &web).status, 404, "an unknown id");
    }

    #[test]
    fn the_devices_api_shows_paired_phones_without_any_secret() {
        let (web, mut inputs, _dir) = web();
        let token = sign_in(&web, &mut inputs);
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
                watch: bridge_core::WatchState::default(),
                watch_terminal: bridge_core::WatchState::default(),
            }],
        };
        web.set_devices(&[phone]);

        let mut get = request("GET", "/api/devices", HOST);
        get.cookie = Some(token);
        let response = route(&get, PEER, &web);
        assert_eq!(response.status, 200);
        let body = String::from_utf8(response.body).unwrap();
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
    fn the_config_api_shows_secrets_only_as_set_or_not_set() {
        let dir = tempfile::tempdir().unwrap();
        let fields = vec![
            serde_json::json!({ "key": "machineName", "value": "desktop", "editable": true, "secret": false, "overridden": false }),
            serde_json::json!({ "key": "relayRegisterToken", "set": true, "editable": true, "secret": true, "overridden": false }),
        ];
        let (web, mut inputs) = web_with_config(dir.path(), fields);
        let token = sign_in(&web, &mut inputs);

        let mut get = request("GET", "/api/config", HOST);
        get.cookie = Some(token);
        let response = route(&get, PEER, &web);
        assert_eq!(response.status, 200);
        let json: Value = serde_json::from_slice(&response.body).unwrap();
        let fields = json["fields"].as_array().unwrap();
        let secret = fields.iter().find(|f| f["key"] == "relayRegisterToken").unwrap();
        assert_eq!(secret["set"], true);
        assert!(secret.get("value").is_none(), "a secret's value is never sent");
        assert!(fields.iter().any(|f| f["key"] == "machineName" && f["value"] == "desktop"));
    }

    #[test]
    fn a_config_post_outside_the_safe_set_is_refused_and_leaves_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let before = r#"{"machineName":"desktop","workspaceRoots":["/srv/w"],"keepMe":42}"#;
        std::fs::write(&path, before).unwrap();
        let (web, mut inputs) = web_with_config(dir.path(), Vec::new());
        let token = sign_in(&web, &mut inputs);

        let mut post = request("POST", "/api/config", HOST);
        post.cookie = Some(token);
        post.body = serde_json::json!({ "set": { "nodePath": "/evil" } }).to_string().into_bytes();
        let response = route(&post, PEER, &web);
        assert_eq!(response.status, 400);
        assert_eq!(serde_json::from_slice::<Value>(&response.body).unwrap()["key"], "nodePath");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "the file is untouched");
    }

    #[test]
    fn an_endpoint_the_bridge_has_no_listener_for_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{}").unwrap();
        let (web, mut inputs) = web_with_config(dir.path(), Vec::new());
        let mut post = request("POST", "/api/config", HOST);
        post.cookie = Some(sign_in(&web, &mut inputs));
        post.body = serde_json::json!({ "set": { "direct.endpoints": ["ws://abc.onion:7448"] } }).to_string().into_bytes();
        let response = route(&post, PEER, &web);
        assert_eq!(response.status, 400, "the bridge would refuse to start from it");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[test]
    fn a_config_post_writes_the_file_keeping_every_other_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"machineName":"desktop","direct":{"listen":"0.0.0.0:7447"},"keepMe":{"x":1}}"#).unwrap();
        // The bridge runs the direct listener, so a wss:// endpoint is one it can serve.
        let listening = serde_json::json!({ "key": "direct.listen", "value": "0.0.0.0:7447", "editable": false, "secret": false, "overridden": false });
        let (web, mut inputs) = web_with_config(dir.path(), vec![listening]);
        let token = sign_in(&web, &mut inputs);

        let mut post = request("POST", "/api/config", HOST);
        post.cookie = Some(token);
        post.body = serde_json::json!({
            "set": { "machineName": "laptop", "relays": ["wss://relay.example"], "direct.endpoints": ["wss://192.168.1.9:7447"] },
            "secrets": { "relayRegisterToken": "tok-123" },
        })
        .to_string()
        .into_bytes();
        let mut response = route(&post, PEER, &web);
        assert_eq!(response.status, 200);
        // The write runs on the blocking pool in `serve`; here, in place.
        let write = response.config_write.take().expect("a write to do");
        crate::config::write_web_settings(&write.path, &write.changes).unwrap();
        let json: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["restartNeeded"], true);
        assert!(!String::from_utf8_lossy(&response.body).contains("tok-123"), "the token is never in a response");

        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["machineName"], "laptop");
        assert_eq!(written["relays"][0], "wss://relay.example");
        assert_eq!(written["direct"]["endpoints"][0], "wss://192.168.1.9:7447");
        assert_eq!(written["direct"]["listen"], "0.0.0.0:7447", "another key in the same object is kept");
        assert_eq!(written["relayRegisterToken"], "tok-123");
        assert_eq!(written["keepMe"]["x"], 1, "an unknown key is kept");

        // A null secret clears it: the key comes out of the file.
        let mut clear = request("POST", "/api/config", HOST);
        clear.cookie = Some(sign_in(&web, &mut inputs));
        clear.body = serde_json::json!({ "secrets": { "relayRegisterToken": null } }).to_string().into_bytes();
        let mut cleared = route(&clear, PEER, &web);
        assert_eq!(cleared.status, 200);
        let write = cleared.config_write.take().expect("a write to do");
        crate::config::write_web_settings(&write.path, &write.changes).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(written.get("relayRegisterToken").is_none(), "cleared");
    }

    #[test]
    fn a_config_post_with_a_bad_value_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let (web, mut inputs) = web_with_config(dir.path(), Vec::new());
        let token = sign_in(&web, &mut inputs);

        for (key, value) in [
            ("machineName", serde_json::json!("")),
            ("relays", serde_json::json!(["ws://192.168.1.9:7447"])),
            ("direct.endpoints", serde_json::json!(["https://x"])),
            ("transcriptKeepLast", serde_json::json!(-1)),
        ] {
            let mut post = request("POST", "/api/config", HOST);
            post.cookie = Some(token.clone());
            post.body = serde_json::json!({ "set": { key: value } }).to_string().into_bytes();
            assert_eq!(route(&post, PEER, &web).status, 400, "{key}");
        }
    }

    #[test]
    fn every_new_api_needs_a_signed_in_browser() {
        let (web, _rx, _dir) = web();
        for (method, path) in [
            ("GET", "/api/browsers"),
            ("POST", "/api/browsers/sign-out"),
            ("GET", "/api/devices"),
            ("GET", "/api/config"),
            ("POST", "/api/config"),
        ] {
            assert_eq!(route(&request(method, path, HOST), PEER, &web).status, 401, "{method} {path}");
        }
    }
}
