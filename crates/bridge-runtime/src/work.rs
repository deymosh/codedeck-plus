//! Slow work the engine hands out as effects: git and HTTP checks. Each
//! returns (or reports) on its own; none may take the bridge down.
//!
//! HTTP to the user's Nostr servers (a Blossom server) goes through
//! [`NostrHttp`]. Provider endpoints are the agent host's business, not the
//! bridge's.

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

use crate::config::Config;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("the HTTP client builds")
}

/// The two transports that carry Nostr traffic — relay connections and
/// HTTP to a Blossom server — built from one config value. They are built
/// together because Tor is all-or-nothing: when the owner set a proxy, a
/// relay dial or a Blossom request that skipped it would tell a Nostr server
/// where the bridge is, which is exactly what the proxy is there to prevent.
/// Both take their proxy from here, so neither path can drift to a direct
/// connection while one is configured.
pub struct NostrTransports {
    pub relays: Vec<String>,
    /// `host:port`, for the relay transport.
    pub proxy: Option<String>,
    pub http: NostrHttp,
}

impl NostrTransports {
    /// A proxy the HTTP client cannot build is an error, never a silent
    /// fallback to a direct connection.
    pub fn from_config(config: &Config) -> Result<Self, String> {
        let proxy = config.tor_proxy.clone();
        let http = NostrHttp::new(proxy.as_deref())?;
        Ok(Self { relays: config.relays.clone(), proxy, http })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

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
