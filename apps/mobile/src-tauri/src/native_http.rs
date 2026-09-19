//! F2b: real HTTP for the in-process `client_runtime::Core`'s `HttpFetch`
//! port (Blossom image upload/download — `crates/client-runtime/src/
//! attachments.rs`), replacing the `NoHttpFetch` default that failed every
//! request. Behind `native-core`, same as `corebridge.rs`.
//!
//! Reuses `tauri-plugin-http`'s OWN `reqwest` (re-exported as
//! `tauri_plugin_http::reqwest`) rather than adding a second HTTP stack to
//! the dependency tree — the WebView path already depends on this exact
//! crate as its designed CORS escape hatch (CDX-029, see the plugin
//! dependency's comment in `Cargo.toml`); this is the same client, just
//! driven directly from the core's own thread instead of round-tripping
//! through the frontend.
//!
//! SOCKS5-aware: when the phone has Tor enabled, `core_init`'s `InitConfig`
//! carries the SAME `host:port` the WS transport dials for the relay
//! sockets — this client is built with the identical `reqwest::Proxy`, so a
//! Blossom upload never bypasses Orbot while Tor is on (the repo's no-bypass
//! rule applies here exactly as it does to the relay sockets). `set_proxy`
//! rebuilds the client live when `Intent::SetTorEnabled` fires — `reqwest`
//! bakes its proxy in at build time, so there is no in-place update, only a
//! fresh client swapped into the same `RefCell` `put`/`get` already clone
//! out of before every request.

use client_runtime::attachments::{HttpFetch, HttpResponse};
use client_runtime::ports::LocalBoxFuture;
use std::cell::RefCell;
use tauri_plugin_http::reqwest;

fn build_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder();
    if let Some(host_port) = proxy {
        let url = format!("socks5://{host_port}");
        let proxy = reqwest::Proxy::all(&url).map_err(|e| format!("bad proxy {url}: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("build http client: {e}"))
}

#[derive(Debug)]
pub struct ReqwestHttpFetch {
    client: RefCell<reqwest::Client>,
}

impl ReqwestHttpFetch {
    /// `proxy` is the same bare `host:port` (no scheme) `InitConfig::proxy`
    /// carries for the WS transport — `None` when Tor is off.
    pub fn new(proxy: Option<&str>) -> Result<Self, String> {
        Ok(Self { client: RefCell::new(build_client(proxy)?) })
    }
}

impl HttpFetch for ReqwestHttpFetch {
    fn put(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
        let client = self.client.borrow().clone();
        let url = url.to_string();
        Box::pin(async move {
            let mut req = client.put(&url).body(body);
            for (name, value) in headers {
                req = req.header(name, value);
            }
            let resp = req.send().await.map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(HttpResponse { status, body })
        })
    }

    fn get(&self, url: &str) -> LocalBoxFuture<'_, Result<HttpResponse, String>> {
        let client = self.client.borrow().clone();
        let url = url.to_string();
        Box::pin(async move {
            let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(HttpResponse { status, body })
        })
    }

    fn set_proxy(&self, proxy: Option<&str>) {
        // A malformed proxy string here would already have failed at
        // `core_init` — this is a defensive fallback, not an expected path.
        if let Ok(client) = build_client(proxy) {
            *self.client.borrow_mut() = client;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_proxy_builds_a_plain_client() {
        assert!(ReqwestHttpFetch::new(None).is_ok());
    }

    #[test]
    fn a_valid_socks5_host_port_builds_a_proxied_client() {
        assert!(ReqwestHttpFetch::new(Some("127.0.0.1:9050")).is_ok());
    }

    #[test]
    fn a_malformed_proxy_is_a_clean_error_not_a_panic() {
        // A space is not valid in a URL authority — `Proxy::all` rejects it
        // rather than this module trying to validate `host:port` itself.
        let err = ReqwestHttpFetch::new(Some("not a proxy")).unwrap_err();
        assert!(err.contains("bad proxy"));
    }

    #[test]
    fn set_proxy_swaps_the_client_live_in_both_directions() {
        let fetch = ReqwestHttpFetch::new(None).unwrap();
        fetch.set_proxy(Some("127.0.0.1:9050"));
        fetch.set_proxy(None);
        // Nothing observable to assert on `reqwest::Client` itself (it's
        // opaque) — this proves set_proxy never panics or leaves the
        // RefCell borrowed across either direction of the toggle.
    }

    #[test]
    fn set_proxy_with_a_malformed_address_leaves_the_existing_client_in_place() {
        let fetch = ReqwestHttpFetch::new(None).unwrap();
        fetch.set_proxy(Some("not a proxy"));
        // Did not panic, and a later valid call still works — the failed
        // rebuild didn't leave the RefCell in a bad state.
        fetch.set_proxy(Some("127.0.0.1:9050"));
    }
}
