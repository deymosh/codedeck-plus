use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceStatusResponse {
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStateRequest {
    /// Human-readable connection-FSM state for the persistent notification.
    pub text: String,
}

/// CDX-027: boot snapshot of the native connectivity source.
/// `supported: false` (desktop) tells JS to keep its `navigator.onLine`
/// fallback; Android answers `true` with the real default-network state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectivitySnapshot {
    pub supported: bool,
    pub online: bool,
}

/// One native connectivity change, streamed over the watch channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectivityUpdate {
    pub online: bool,
}
