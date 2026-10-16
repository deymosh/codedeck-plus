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
//! `HttpOnly`, `SameSite=Strict`); it lapses after 30 days, and a restart
//! ends it, since signed-in browsers are kept in memory only.
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

use std::cell::RefCell;
use std::collections::HashMap;
use std::net::IpAddr;
use std::rc::Rc;
use std::time::Duration;

use base64::Engine as _;
use bridge_core::Input;
use protocol::events::SessionListMsg;
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
    order: std::cell::Cell<u64>,
    inputs: mpsc::UnboundedSender<Input>,
    /// Sign-in switched off for development (`CODEDECK_WEB_NO_SIGN_IN=1`):
    /// a browser on a loopback or private address is let in without a
    /// phone. Never on by default, logged loudly, and shown on the page.
    no_sign_in: bool,
}

impl Web {
    pub fn new(machine_npub: String, endpoints: &[String], inputs: mpsc::UnboundedSender<Input>) -> Rc<Self> {
        let hosts = endpoints.iter().filter_map(|url| endpoint_host(url)).collect();
        let no_sign_in = std::env::var("CODEDECK_WEB_NO_SIGN_IN").is_ok_and(|v| v == "1");
        if no_sign_in {
            log::warn!(
                "[Web] SIGN-IN IS OFF (CODEDECK_WEB_NO_SIGN_IN=1): any browser on a loopback or private \
                 address sees this bridge's page without a phone. For development only."
            );
        }
        Rc::new(Self {
            machine_npub,
            hosts,
            heartbeat: RefCell::default(),
            browsers: RefCell::default(),
            starts: RefCell::default(),
            order: std::cell::Cell::new(1),
            inputs,
            no_sign_in,
        })
    }

    /// The heartbeat the bridge just published, which the status page shows.
    pub fn set_heartbeat(&self, list: &SessionListMsg) {
        *self.heartbeat.borrow_mut() = Some(list.clone());
    }

    /// A phone of `by` sent `code`, and the engine matched it to a code this
    /// page showed: that browser is signed in.
    pub fn signed_in(&self, code: &str, by: &str) {
        let now = now_ms();
        for browser in self.browsers.borrow_mut().values_mut() {
            if matches!(&browser.access, Access::Pending { code: c, .. } if c == code) {
                log::info!("[Web] A browser at {} signed in", browser.peer);
                browser.access = Access::SignedIn { by: by.to_string(), since_ms: now, expires_ms: now + SESSION_TTL_MS };
                // The session's age is from its sign-in, so the cap below
                // drops the longest signed in, never the one just let in.
                browser.order = self.next_order();
            }
        }
        let mut browsers = self.browsers.borrow_mut();
        evict_oldest(&mut browsers, MAX_SESSIONS, |b| matches!(b.access, Access::SignedIn { .. }));
    }

    fn browser(&self, token: Option<&str>) -> Option<(String, Browser)> {
        let key = token_key(token?);
        let now = now_ms();
        let mut browsers = self.browsers.borrow_mut();
        let expired = match browsers.get(&key)?.access {
            Access::Pending { expires_ms, .. } | Access::SignedIn { expires_ms, .. } => expires_ms <= now,
        };
        if expired {
            browsers.remove(&key);
            return None;
        }
        browsers.get(&key).map(|b| (key, b.clone()))
    }

    /// Start a sign-in for a browser at `peer`: a new code, and the cookie
    /// that names it. `None` when the address started too many lately.
    fn start_sign_in(&self, peer: IpAddr) -> Option<(String, String)> {
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
        browsers.insert(token_key(&token), Browser { access: Access::Pending { code: code.clone(), expires_ms }, peer, order: self.next_order() });
        let _ = self.inputs.send(Input::WebSignInPending { code: code.clone(), expires_ms });
        for dropped in evict_oldest(&mut browsers, MAX_PENDING, |b| matches!(b.access, Access::Pending { .. })) {
            self.withdraw(&dropped);
        }
        Some((token, code))
    }

    fn sign_out(&self, key: &str) {
        let removed = self.browsers.borrow_mut().remove(key);
        if let Some(browser) = removed {
            self.withdraw(&browser);
        }
    }

    fn next_order(&self) -> u64 {
        let order = self.order.get();
        self.order.set(order + 1);
        order
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
            "noSignIn": self.no_sign_in,
            "heartbeat": heartbeat.as_ref().map(|h| serde_json::to_value(h).unwrap_or(serde_json::Value::Null)),
        })
        .to_string()
    }
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

/// What sign-in starts are counted by: an IPv4 address, or an IPv6
/// address's /64. One host holds a whole /64 and can pick any address in it,
/// so counting single IPv6 addresses would let it start without limit.
fn rate_key(peer: IpAddr) -> IpAddr {
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
    // No route reads a body yet (a POST says what it does by its path), but
    // one that came is read off whole, bounded, so the request ends cleanly.
    let arrived = buf.len() - head;
    if arrived < length {
        let mut rest = vec![0u8; length - arrived];
        tokio::time::timeout(BODY_TIMEOUT, stream.read_exact(&mut rest)).await.map_err(|_| 408u16)?.map_err(|_| 400u16)?;
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
    })
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
}

impl Response {
    fn new(status: u16, content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self { status, content_type, body: body.into(), set_cookie: None }
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
    let response = match read_request(buf, &mut stream).await {
        Ok(request) => route(&request, peer, web),
        Err(status) => Response::error(status),
    };
    write_response(&mut stream, response).await;
}

fn route(request: &Request, peer: IpAddr, web: &Web) -> Response {
    let Some(host) = request.host.as_deref().filter(|h| host_allowed(h, &web.hosts)) else {
        return Response::error(403);
    };
    if request.method == "POST" && request.origin.as_deref() != Some(&format!("https://{host}")) {
        return Response::error(403);
    }
    let browser = if web.no_sign_in && is_local(peer) {
        Some((String::new(), Browser { access: Access::SignedIn { by: "sign-in switched off".into(), since_ms: 0, expires_ms: u64::MAX }, peer, order: 0 }))
    } else {
        web.browser(request.cookie.as_deref())
    };
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Response::new(200, "text/html; charset=utf-8", INDEX_HTML),
        ("GET", "/app.js") => Response::new(200, "text/javascript; charset=utf-8", APP_JS),
        ("GET", "/app.css") => Response::new(200, "text/css; charset=utf-8", APP_CSS),
        ("GET", "/api/me") => Response::json(200, me_json(browser.as_ref().map(|(_, b)| b))),
        ("POST", "/api/sign-in") => match web.start_sign_in(peer) {
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
        ("GET", "/api/status") => match browser {
            Some((_, Browser { access: Access::SignedIn { by, since_ms, .. }, .. })) => Response::json(200, web.status_json(&by, since_ms)),
            _ => Response::error(401),
        },
        (_, "/" | "/app.js" | "/app.css" | "/api/me" | "/api/sign-in" | "/api/sign-in/qr.svg" | "/api/sign-out" | "/api/status") => {
            Response::error(405)
        }
        _ => Response::error(404),
    }
}

/// Loopback, a private network (RFC 1918, unique-local IPv6) or link-local:
/// where the development switch lets a browser in without a phone.
fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private())
        }
    }
}

fn me_json(browser: Option<&Browser>) -> String {
    let now = now_ms();
    match browser.map(|b| &b.access) {
        Some(Access::Pending { code, expires_ms }) => {
            serde_json::json!({ "state": "pending", "code": code, "expiresInMs": expires_ms.saturating_sub(now) })
        }
        Some(Access::SignedIn { by, since_ms, expires_ms }) => {
            serde_json::json!({ "state": "signed-in", "by": by, "since": since_ms, "noSignIn": *expires_ms == u64::MAX })
        }
        None => serde_json::json!({ "state": "signed-out" }),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web() -> (Rc<Web>, mpsc::UnboundedReceiver<Input>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Web::new("npub1machine".into(), &["wss://box.tail1234.ts.net:7447".into()], tx), rx)
    }

    fn request(method: &str, path: &str, host: &str) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            host: Some(host.into()),
            origin: (method == "POST").then(|| format!("https://{host}")),
            cookie: None,
        }
    }

    const PEER: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 20));

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
        let (web, _) = web();
        let mut post = request("POST", "/api/sign-in", "192.168.1.5:7447");
        post.origin = Some("https://evil.example".into());
        assert_eq!(route(&post, PEER, &web).status, 403);
        post.origin = None;
        assert_eq!(route(&post, PEER, &web).status, 403);
    }

    #[test]
    fn the_status_needs_a_signed_in_browser() {
        let (web, mut inputs) = web();
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
        let (web, _) = web();
        for i in 0..STARTS_PER_MINUTE {
            let peer = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 0, 0, 0, i as u16 + 1));
            assert!(web.start_sign_in(peer).is_some());
        }
        let same_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 9, 9, 9, 9));
        assert!(web.start_sign_in(same_64).is_none(), "another address in the same /64 counts as the same host");
        let other_64 = IpAddr::V6(std::net::Ipv6Addr::new(0x2001, 0xdb8, 1, 3, 0, 0, 0, 1));
        assert!(web.start_sign_in(other_64).is_some());
    }

    #[test]
    fn a_pending_browser_dropped_or_signed_out_withdraws_its_code() {
        let (web, mut inputs) = web();
        let mut first = None;
        for i in 0..=MAX_PENDING {
            // A peer of its own each, so the rate limit does not interfere.
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, (i / 250) as u8, (i % 250) as u8 + 1));
            let (token, code) = web.start_sign_in(peer).expect("a start");
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

        let (token, code) = web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 9, 9, 9))).unwrap();
        while inputs.try_recv().is_ok() {}
        web.sign_out(&token_key(&token));
        assert!(matches!(inputs.try_recv(), Ok(Input::WebSignInWithdrawn { code: c }) if c == code));
    }

    #[test]
    fn signed_in_browsers_are_capped_by_the_longest_signed_in() {
        let (web, _) = web();
        let mut tokens = Vec::new();
        for i in 0..=MAX_SESSIONS {
            let peer = IpAddr::V4(std::net::Ipv4Addr::new(10, 1, (i / 250) as u8, (i % 250) as u8 + 1));
            let (token, code) = web.start_sign_in(peer).unwrap();
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
        let (web, _) = web();
        for _ in 0..STARTS_PER_MINUTE {
            assert!(web.start_sign_in(PEER).is_some());
        }
        assert!(web.start_sign_in(PEER).is_none());
        assert!(web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 21))).is_some());
    }

    #[test]
    fn pending_sign_ins_are_capped() {
        let (web, _) = web();
        for i in 0..(MAX_PENDING as u8 + 10) {
            web.start_sign_in(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, i))).unwrap();
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
}
