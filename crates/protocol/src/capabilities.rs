//! Protocol version + capability negotiation.
//!
//! The bridge advertises `protocol_version` + `capabilities` on the session-list
//! heartbeat; the client stamps commands with `v` (and optionally `caps`).
//! Feature gating is on capability **strings** and on the per-agent catalog
//! (`AgentDescriptor::supports`), never on version comparisons — a new feature
//! is one new string or one new `supports` flag, not a version-ladder entry.
//!
//! What an individual AGENT can do (models, usage, custom providers, GSD) is
//! catalog data, not a capability: capabilities describe the BRIDGE. Tiers
//! (do not add a string as a "gate" unless a peer that has not seen it would
//! otherwise hard-fail):
//!
//! * **HARD GATE** — absence changes behaviour: [`IMAGES`] (the client shows
//!   image attach only when the bridge advertises it).
//! * **PRESENCE MARKER** — detection is on payload data: [`SYNC_1`],
//!   [`FOLDERS`], [`DEVICE_ACTIONS`]. Kept so a session list is
//!   self-describing.
//! * **TRANSPORT BEACON** — [`CHUNKED`]: advertised on both sides, gated by
//!   neither. Fragmentation lives below the semantic layer.

/// v11 = the agent-neutral protocol: per-agent catalog, typed transcript
/// entries, typed answers, `set-option`. Clean break from v10 — no v10
/// compatibility.
pub const PROTOCOL_VERSION: u32 = 11;

// PRESENCE MARKER — transcript sync v1; always runs, nothing checks this.
pub const SYNC_1: &str = "sync/1";
// PRESENCE MARKER — folder listing; client gates on `folders[]`/`roots[]`.
pub const FOLDERS: &str = "folders";
// HARD GATE (client-side) — image upload; the attach control shows only when
// this is in the machine's heartbeat capabilities.
pub const IMAGES: &str = "images";
// PRESENCE MARKER — on-device test sessions; no client UI sends them.
pub const DEVICE_ACTIONS: &str = "device-actions";
// TRANSPORT BEACON — oversize-event `chunk` fragmentation. Advertised on both
// sides, gated by neither.
pub const CHUNKED: &str = "chunked";

/// Every capability the reference bridge ships with.
pub const ALL_BRIDGE_CAPABILITIES: [&str; 5] = [SYNC_1, FOLDERS, IMAGES, DEVICE_ACTIONS, CHUNKED];

/// Capabilities the reference client stamps on outgoing command `caps`.
pub const ALL_PHONE_CAPABILITIES: [&str; 1] = [CHUNKED];

/// Which host binary a bridge runs as — a UI badge only; identity is the keypair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BridgeHostKind {
    Cli,
    Vscode,
    Service,
}

impl BridgeHostKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Vscode => "vscode",
            Self::Service => "service",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "cli" => Some(Self::Cli),
            "vscode" => Some(Self::Vscode),
            "service" => Some(Self::Service),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_11() {
        assert_eq!(PROTOCOL_VERSION, 11);
    }

    #[test]
    fn capability_lists() {
        assert_eq!(ALL_BRIDGE_CAPABILITIES, ["sync/1", "folders", "images", "device-actions", "chunked"]);
        assert_eq!(ALL_PHONE_CAPABILITIES, ["chunked"]);
    }

    #[test]
    fn host_kind_round_trips_and_rejects_unknown() {
        for k in [BridgeHostKind::Cli, BridgeHostKind::Vscode, BridgeHostKind::Service] {
            assert_eq!(BridgeHostKind::from_wire(k.as_wire()), Some(k));
        }
        assert_eq!(BridgeHostKind::from_wire("desktop"), None);
    }
}
