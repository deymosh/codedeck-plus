use serde::{Deserialize, Serialize};

/// Result of a join/leave request. `state_json` mirrors the engine's `stateJson` (UiState) so the
/// JS layer can render mesh status (connected, mesh /32, peers) without a second round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshStatusResponse {
    /// Whether the VpnService tunnel is currently up.
    pub running: bool,
    /// Engine UiState JSON (`stateJson`), or empty string if the engine isn't initialized yet.
    #[serde(default)]
    pub state_json: String,
}

/// Generic engine action passthrough. `action_json` is a serialized `NativeAppAction` (the same
/// contract nvpn's own shells use): import invite, create/join network, settings patch, etc.
/// The response is the engine's post-action `stateJson`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshActionRequest {
    pub action_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshActionResponse {
    pub state_json: String,
}

/// Result of `prepare_adb`: enable Wireless Debugging (we hold WRITE_SECURE_SETTINGS, granted once)
/// so the laptop can `adb connect` over the mesh without USB or a human tap. `enabled` is false if
/// the one-time grant hasn't been done. The (rotating) listener PORT is intentionally not reported:
/// an unprivileged app can't read adbd's socket on Android 10+, so the Bridge discovers it itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareAdbResponse {
    #[serde(default)]
    pub enabled: bool,
}
