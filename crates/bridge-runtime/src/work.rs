//! Slow work the engine hands out as effects: git, HTTP checks, pubkey
//! registration. Each returns (or reports) on its own; none may take the
//! bridge down.
//!
//! HTTP to the user's Nostr servers (a Blossom server, a relay's or Blossom
//! server's admin endpoint) goes through [`NostrHttp`]. Provider endpoints
//! are the agent host's business, not the bridge's.

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

use crate::config::RegisterEndpoint;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("the HTTP client builds")
}

/// HTTP to Nostr servers. With a Tor proxy set it all goes through the
/// proxy, as every relay connection does — those servers learn no more
/// about the bridge than the relays do — except to loopback, which never
/// leaves the machine. Without one it goes direct, and an onion service is
/// out of reach.
#[derive(Clone)]
pub struct NostrHttp {
    direct: reqwest::Client,
    tor: Option<reqwest::Client>,
}

impl NostrHttp {
    /// `tor_proxy` is `host:port`. A proxy client that cannot be built is an
    /// error, never a silent fallback to direct.
    pub fn new(tor_proxy: Option<&str>) -> Result<Self, String> {
        let tor = match tor_proxy {
            None => None,
            Some(addr) => {
                let err = |e: reqwest::Error| format!("Tor proxy {addr:?}: {e}");
                let proxy = reqwest::Proxy::all(format!("socks5h://{addr}")).map_err(err)?;
                Some(reqwest::Client::builder().timeout(HTTP_TIMEOUT).proxy(proxy).build().map_err(err)?)
            }
        };
        Ok(Self { direct: http_client(), tor })
    }

    /// The client for `url`; an error for an onion service without Tor.
    pub fn for_url(&self, url: &str) -> Result<&reqwest::Client, String> {
        let host = url_host(url);
        match &self.tor {
            _ if is_loopback(&host) => Ok(&self.direct),
            Some(tor) => Ok(tor),
            None if is_onion(&host) => Err(format!("{host} needs the bridge's Tor proxy (CODEDECK_TOR_PROXY_URL)")),
            None => Ok(&self.direct),
        }
    }
}

/// The URL's host, lower-case; empty when it does not parse.
fn url_host(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default()
}

fn is_onion(host: &str) -> bool {
    host.strip_suffix(".onion").is_some_and(|name| !name.is_empty() && !name.ends_with('.'))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "[::1]") || host.starts_with("127.")
}

/// Whether `url` is `http://` to an onion service: cleartext is fine there,
/// Tor encrypts the whole path.
pub fn is_onion_http(url: &str) -> bool {
    url.starts_with("http://") && is_onion(&url_host(url))
}

/// `git rev-parse HEAD` in `cwd`; None when it is not a repository (or git
/// is missing or slow).
pub async fn git_head(cwd: &Path) -> Option<String> {
    let run = Command::new("git").arg("-C").arg(cwd).args(["rev-parse", "HEAD"]).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(5), run).await.ok()?.ok()?;
    let head = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !head.is_empty()).then_some(head)
}

/// Register a paired phone's pubkey with an admin endpoint
/// (`POST {pubkey}` with a Bearer token; 200 already registered, 201
/// registered). The token never goes over plaintext except to loopback or an
/// onion service.
pub async fn register_pubkey(http: &NostrHttp, endpoint: &RegisterEndpoint, pubkey_hex: &str) -> Result<&'static str, String> {
    // https, or http to loopback or an onion service: this is Nostr
    // traffic, which never crosses a network in cleartext (provider base
    // URLs may also use the LAN; this endpoint may not).
    if !protocol::common::is_https_or_loopback_url(&endpoint.url) && !is_onion_http(&endpoint.url) {
        return Err("insecure endpoint (the admin token requires https)".into());
    }
    if pubkey_hex.len() != 64 || !pubkey_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid pubkey".into());
    }
    let res = http
        .for_url(&endpoint.url)?
        .post(&endpoint.url)
        .bearer_auth(&endpoint.token)
        .json(&serde_json::json!({"pubkey": pubkey_hex.to_lowercase()}))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    match res.status().as_u16() {
        200 => Ok("already registered"),
        201 => Ok("registered"),
        status => Err(format!("HTTP {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registration_refuses_plaintext_and_bad_keys_before_any_request() {
        let http = NostrHttp::new(None).unwrap();
        let insecure = RegisterEndpoint { url: "http://relay.example/api".into(), token: "t".into() };
        assert!(register_pubkey(&http, &insecure, &"a".repeat(64)).await.unwrap_err().contains("insecure"));
        let smuggled = RegisterEndpoint { url: r"http://relay.example\@localhost/api".into(), token: "t".into() };
        assert!(register_pubkey(&http, &smuggled, &"a".repeat(64)).await.unwrap_err().contains("insecure"));
        let lookalike = RegisterEndpoint { url: "http://abc.onion.example.com/api".into(), token: "t".into() };
        assert!(register_pubkey(&http, &lookalike, &"a".repeat(64)).await.unwrap_err().contains("insecure"));
        let ok = RegisterEndpoint { url: "https://relay.example/api".into(), token: "t".into() };
        assert_eq!(register_pubkey(&http, &ok, "zz").await.unwrap_err(), "invalid pubkey");
        let onion = RegisterEndpoint { url: "http://abcdef.onion/api".into(), token: "t".into() };
        assert!(register_pubkey(&http, &onion, &"a".repeat(64)).await.unwrap_err().contains("Tor proxy"));
    }

    #[test]
    fn nostr_http_goes_through_tor_when_set_except_to_loopback() {
        let direct = NostrHttp::new(None).unwrap();
        assert!(direct.for_url("https://blossom.example/x").is_ok());
        assert!(direct.for_url("http://abcdef.onion/x").unwrap_err().contains("abcdef.onion"));
        let tor = NostrHttp::new(Some("127.0.0.1:9050")).unwrap();
        for url in ["https://blossom.example/x", "http://abcdef.onion/x"] {
            assert!(std::ptr::eq(tor.for_url(url).unwrap(), tor.tor.as_ref().unwrap()), "{url}");
        }
        assert!(std::ptr::eq(tor.for_url("http://127.0.0.1:3000/x").unwrap(), &tor.direct));
        assert!(std::ptr::eq(tor.for_url("http://localhost/x").unwrap(), &tor.direct));
        assert!(is_onion_http("http://abcdef.onion:3000/x"));
        assert!(!is_onion_http("https://abcdef.onion/x"));
        assert!(!is_onion_http("http://.onion/x"));
        assert!(!is_onion_http("http://abcdef.onion.example.com/x"));
    }

    #[tokio::test]
    async fn git_head_is_none_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(git_head(dir.path()).await, None);
    }
}
