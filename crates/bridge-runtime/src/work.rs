//! Slow work the engine hands out as effects: git, HTTP checks, pubkey
//! registration. Each returns (or reports) on its own; none may take the
//! bridge down.
//!
//! HTTP here goes direct, never through the Tor proxy: that proxy carries
//! relay traffic only.

use std::path::Path;
use std::time::Duration;

use tokio::process::Command;

use crate::config::RegisterEndpoint;

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("the HTTP client builds")
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
/// provider's own endpoint. 401/403 = invalid; any other status = valid; a
/// network error = could not tell. The caller has already checked that
/// `base_url` is https (or loopback http).
pub async fn check_provider_token(http: &reqwest::Client, base_url: &str, token: &str, model: &str) -> Option<bool> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]});
    match http.post(&url).bearer_auth(token).header("anthropic-version", "2023-06-01").json(&body).send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            log::info!("[Work] Provider token check at {base_url}: status {status}");
            Some(status != 401 && status != 403)
        }
        Err(err) => {
            log::warn!("[Work] Provider token check at {base_url} failed (network): {err}");
            None
        }
    }
}

fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(v6) = host.strip_prefix('[') { v6.split(']').next().unwrap_or("") } else { host.rsplit_once(':').map_or(host, |(h, _)| h) };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Register a paired phone's pubkey with an admin endpoint
/// (`POST {pubkey}` with a Bearer token; 200 already registered, 201
/// registered). The token never goes over plaintext except to loopback.
pub async fn register_pubkey(http: &reqwest::Client, endpoint: &RegisterEndpoint, pubkey_hex: &str) -> Result<&'static str, String> {
    if !(endpoint.url.starts_with("https://") || is_loopback_http(&endpoint.url)) {
        return Err("insecure endpoint (the admin token requires https)".into());
    }
    if pubkey_hex.len() != 64 || !pubkey_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid pubkey".into());
    }
    let res = http
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
    fn only_loopback_may_use_plain_http() {
        assert!(is_loopback_http("http://localhost:8787/api/register-agent"));
        assert!(is_loopback_http("http://127.0.0.1/x"));
        assert!(is_loopback_http("http://[::1]:80/x"));
        assert!(!is_loopback_http("http://relay.example/x"));
        assert!(!is_loopback_http("https://localhost/x"));
    }

    #[tokio::test]
    async fn registration_refuses_plaintext_and_bad_keys_before_any_request() {
        let http = http_client();
        let insecure = RegisterEndpoint { url: "http://relay.example/api".into(), token: "t".into() };
        assert!(register_pubkey(&http, &insecure, &"a".repeat(64)).await.unwrap_err().contains("insecure"));
        let ok = RegisterEndpoint { url: "https://relay.example/api".into(), token: "t".into() };
        assert_eq!(register_pubkey(&http, &ok, "zz").await.unwrap_err(), "invalid pubkey");
    }

    #[tokio::test]
    async fn git_head_is_none_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(git_head(dir.path()).await, None);
    }
}
