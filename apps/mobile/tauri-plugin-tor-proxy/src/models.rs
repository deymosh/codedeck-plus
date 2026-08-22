use serde::{Deserialize, Serialize};

// Both structs cross the boundary in BOTH directions: JS -> Rust (a Tauri
// #[tauri::command] arg/return, which needs Deserialize/Serialize
// respectively) AND Rust -> Kotlin via run_mobile_plugin, whose `payload`
// needs Serialize and whose typed response needs DeserializeOwned — so
// EnableRequest needs both derives (arg in, payload out) and so does
// EnableResponse (response in, return value out).

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnableRequest {
    /// Orbot's SOCKS5 host — normally "127.0.0.1", Orbot runs on the same device.
    pub host: String,
    /// Orbot's SOCKS5 port — 9050 by default (Orbot's "SOCKS" proxy mode, not
    /// its separate all-apps VPN mode).
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnableResponse {
    /// False when `androidx.webkit.ProxyController`'s PROXY_OVERRIDE feature
    /// isn't available on this device's WebView provider — the caller should
    /// tell the user their WebView is too old rather than silently proxying
    /// nothing.
    pub supported: bool,
}
