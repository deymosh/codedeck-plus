//! Slow work the engine hands out as effects: git, HTTP checks, pubkey
//! registration. Each returns (or reports) on its own; none may take the
//! bridge down.
//!
//! HTTP to the user's Nostr servers (a Blossom server, a relay's or Blossom
//! server's admin endpoint) goes through [`NostrHttp`]; the rest (provider
//! token checks and model lists) goes direct — the Tor proxy is for Nostr
//! traffic.

use std::path::Path;
use std::time::Duration;

use protocol::common::ProviderModel;
use tokio::process::Command;

use crate::config::RegisterEndpoint;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("the HTTP client builds")
}

/// HTTP to a provider profile's endpoint, carrying its token. Redirects are
/// not followed: one could lead the token to another host, or off https —
/// only the URL the profile names (and the https rule passed) may see it.
pub fn provider_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("the HTTP client builds")
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

/// Check a provider token with the smallest possible request to the
/// provider's own endpoint. The caller has already checked that `base_url`
/// is https (or loopback http).
pub async fn check_provider_token(http: &reqwest::Client, base_url: &str, token: &str, model: &str) -> Option<bool> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]});
    match http.post(&url).bearer_auth(token).header("anthropic-version", "2023-06-01").json(&body).send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            log::info!("[Work] Provider token check at {base_url}: status {status}");
            token_verdict(status)
        }
        Err(err) => {
            log::warn!("[Work] Provider token check at {base_url} failed (network): {err}");
            None
        }
    }
}

/// How many of a provider's models a profile keeps: the list is for a phone
/// screen, and every phone gets it with each profile list.
const MAX_PROVIDER_MODELS: usize = 200;
/// The most of a model list that is read. Some providers describe every
/// model at length (OpenRouter's list is a few megabytes); the rest is
/// dropped rather than buffered without bound.
const MAX_MODEL_LIST_BYTES: usize = 16 * 1024 * 1024;
/// The longest model id or label kept; anything longer is not a model name.
const MAX_MODEL_NAME_CHARS: usize = 200;

/// The models the provider at `base_url` serves, from its `/v1/models` (or
/// `/models`, when the base URL already ends in `/v1`). The token goes in
/// both headers providers read it from: `Authorization` (OpenAI-style) and
/// `x-api-key` (Anthropic-style); either way it goes only to this URL. The
/// caller has already checked that `base_url` is https (or loopback http).
pub async fn fetch_provider_models(http: &reqwest::Client, base_url: &str, token: &str) -> Result<Vec<ProviderModel>, String> {
    let url = provider_models_url(base_url);
    let mut res = http
        .get(&url)
        .bearer_auth(token)
        .header("x-api-key", token)
        .header("anthropic-version", "2023-06-01")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|err| {
            log::warn!("[Work] Model list from {base_url} failed (network): {err}");
            "the provider could not be reached".to_string()
        })?;
    let status = res.status().as_u16();
    log::info!("[Work] Model list from {base_url}: status {status}");
    match status {
        200..=299 => {}
        401 | 403 => return Err(format!("the provider refused the token (HTTP {status})")),
        _ => return Err(format!("HTTP {status} from {url}")),
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|err| format!("the answer broke off: {err}"))? {
        if body.len() + chunk.len() > MAX_MODEL_LIST_BYTES {
            return Err("the model list is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|_| "the answer is not a model list".to_string())?;
    Ok(parse_provider_models(&json))
}

/// Where a provider lists its models: under `/v1` of its root, unless the
/// root already ends in `/v1`.
fn provider_models_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = reqwest::Url::parse(base).map(|u| u.path().to_string()).unwrap_or_default();
    if path.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// The models in a provider's answer: the OpenAI-shaped `data` array, a
/// `models` array or a bare array, of objects with an `id` (and maybe a
/// `display_name` or `name`) or of plain id strings. Duplicates, blanks,
/// oversized names and anything that is not a model are dropped.
fn parse_provider_models(body: &serde_json::Value) -> Vec<ProviderModel> {
    let list = match body {
        serde_json::Value::Array(list) => Some(list),
        serde_json::Value::Object(map) => map.get("data").or_else(|| map.get("models")).and_then(|v| v.as_array()),
        _ => None,
    };
    let fits = |s: &str| !s.trim().is_empty() && s.chars().count() <= MAX_MODEL_NAME_CHARS && !s.chars().any(char::is_control);
    let mut models: Vec<ProviderModel> = Vec::new();
    for entry in list.into_iter().flatten() {
        let (id, named) = match entry {
            serde_json::Value::String(id) => (id.as_str(), None),
            serde_json::Value::Object(map) => match map.get("id").and_then(|v| v.as_str()) {
                Some(id) => (id, map.get("display_name").or_else(|| map.get("name")).and_then(|v| v.as_str())),
                None => continue,
            },
            _ => continue,
        };
        if !fits(id) || models.iter().any(|m| m.id == id) {
            continue;
        }
        let label = named.filter(|n| fits(n) && *n != id).map(str::to_string);
        models.push(ProviderModel { id: id.to_string(), label });
        if models.len() >= MAX_PROVIDER_MODELS {
            break;
        }
    }
    models
}

/// What a token check's HTTP status says about the token. 401/403: rejected.
/// Success, or an error the provider only returns once it has accepted the
/// credentials (a malformed request, a rate limit): valid. Anything else —
/// 404 from a wrong base URL, a redirect, a 5xx — never reached the
/// credential check, so it proves nothing either way.
fn token_verdict(status: u16) -> Option<bool> {
    match status {
        401 | 403 => Some(false),
        200..=299 | 400 | 422 | 429 => Some(true),
        _ => None,
    }
}

/// Register a paired phone's pubkey with an admin endpoint
/// (`POST {pubkey}` with a Bearer token; 200 already registered, 201
/// registered). The token never goes over plaintext except to loopback or an
/// onion service.
pub async fn register_pubkey(http: &NostrHttp, endpoint: &RegisterEndpoint, pubkey_hex: &str) -> Result<&'static str, String> {
    // The same https-or-loopback-http rule as provider base URLs, plus
    // http to an onion service.
    if !protocol::common::is_valid_provider_base_url(&endpoint.url) && !is_onion_http(&endpoint.url) {
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

    #[test]
    fn only_a_status_past_the_credential_check_is_a_token_verdict() {
        assert_eq!(token_verdict(200), Some(true));
        assert_eq!(token_verdict(400), Some(true));
        assert_eq!(token_verdict(429), Some(true));
        assert_eq!(token_verdict(401), Some(false));
        assert_eq!(token_verdict(403), Some(false));
        assert_eq!(token_verdict(404), None, "a wrong base URL says nothing about the token");
        assert_eq!(token_verdict(301), None);
        assert_eq!(token_verdict(500), None);
        assert_eq!(token_verdict(503), None);
    }

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

    #[test]
    fn a_model_list_is_read_under_v1_of_the_root() {
        assert_eq!(provider_models_url("https://openrouter.ai/api"), "https://openrouter.ai/api/v1/models");
        assert_eq!(provider_models_url("https://openrouter.ai/api/"), "https://openrouter.ai/api/v1/models");
        assert_eq!(provider_models_url("https://gw.example/v1"), "https://gw.example/v1/models");
    }

    #[test]
    fn a_model_list_keeps_what_names_a_model() {
        let body = serde_json::json!({"data": [
            {"id": "a/b", "name": "B"},
            {"id": "c", "display_name": "C", "name": "ignored"},
            {"id": "d", "name": "d"},
            {"id": "a/b"},
            {"id": "  "},
            {"id": "bad\u{7}id"},
            {"id": "x".repeat(201)},
            {"no": "id"},
            7,
        ]});
        let ids: Vec<(String, Option<String>)> = parse_provider_models(&body).into_iter().map(|m| (m.id, m.label)).collect();
        assert_eq!(ids, [("a/b".into(), Some("B".into())), ("c".into(), Some("C".into())), ("d".into(), None)]);
        assert_eq!(parse_provider_models(&serde_json::json!(["x", "y"])).len(), 2);
        assert_eq!(parse_provider_models(&serde_json::json!({"models": [{"id": "z"}]})).len(), 1);
        assert!(parse_provider_models(&serde_json::json!({"error": "nope"})).is_empty());
        let many: Vec<_> = (0..250).map(|i| serde_json::json!({"id": format!("m{i}")})).collect();
        assert_eq!(parse_provider_models(&serde_json::json!({"data": many})).len(), MAX_PROVIDER_MODELS);
    }

    /// A one-shot HTTP server on loopback: answers the first request with
    /// `response` and hands back the request it read.
    async fn serve_once(response: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (base, task)
    }

    #[tokio::test]
    async fn a_model_list_is_asked_with_the_token_and_never_follows_a_redirect() {
        let http = provider_http_client();
        let (base, req) = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 22\r\nconnection: close\r\n\r\n{\"data\":[{\"id\":\"m1\"}]}",
        )
        .await;
        let models = fetch_provider_models(&http, &base, "tok-1").await.unwrap();
        assert_eq!(models, [ProviderModel { id: "m1".into(), label: None }]);
        let req = req.await.unwrap().to_lowercase();
        assert!(req.starts_with("get /v1/models "), "{req}");
        assert!(req.contains("authorization: bearer tok-1") && req.contains("x-api-key: tok-1"), "{req}");

        let (base, _) = serve_once("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        assert!(fetch_provider_models(&http, &base, "t").await.unwrap_err().contains("refused the token"));

        let (base, _) =
            serve_once("HTTP/1.1 302 Found\r\nlocation: http://elsewhere.example/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        assert!(fetch_provider_models(&http, &base, "t").await.unwrap_err().contains("HTTP 302"));
    }

    #[tokio::test]
    async fn git_head_is_none_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(git_head(dir.path()).await, None);
    }
}
