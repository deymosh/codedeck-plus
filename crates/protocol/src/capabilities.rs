//! Protocol version + capability negotiation. Port of
//! `packages/protocol/src/capabilities.ts`.
//!
//! The bridge advertises `protocol_version` + `capabilities` on the session-list
//! heartbeat; the client stamps commands with `v` (and optionally `caps`).
//! Feature gating is on capability **strings**, never version comparisons — a
//! new feature is one new string, not a version-ladder entry.
//!
//! Three tiers (do not add a new string as a "gate" unless a peer that has not
//! seen it would otherwise hard-fail):
//!
//! * **HARD GATE** — absence changes behaviour: [`IMAGES`], [`CUSTOM_PROVIDERS`]
//!   (client gates on the bridge heartbeat), [`DIFF`] (bridge gates emission on
//!   every heard-from client's command `caps`).
//! * **PRESENCE MARKER** — feature is unconditional in v10; detection is on
//!   payload data: [`SYNC_1`], [`FOLDERS`], [`GSD`], [`USAGE`], [`MODELS`],
//!   [`DEVICE_ACTIONS`]. The string is kept only so a session list is
//!   self-describing.
//! * **TRANSPORT BEACON** — [`CHUNKED`]: advertised on both sides, gated by
//!   neither. Fragmentation lives below the semantic layer.

/// v10 = the monorepo rebuild (kind split, transcript sync, tombstones, host
/// discrimination, input acks). Clean break from v9 — no pre-v10 compatibility.
pub const PROTOCOL_VERSION: u32 = 10;

// PRESENCE MARKER — transcript sync v1; always runs, nothing checks this.
pub const SYNC_1: &str = "sync/1";
// PRESENCE MARKER — folder listing; client gates on `folders[]`/`roots[]`.
pub const FOLDERS: &str = "folders";
// PRESENCE MARKER — GSD snapshots; UI gates on `gsd.available`.
pub const GSD: &str = "gsd";
// HARD GATE (client-side) — image upload; the attach control shows only when
// this is in the machine's heartbeat capabilities.
pub const IMAGES: &str = "images";
// PRESENCE MARKER — on-device test sessions; no client UI sends them.
pub const DEVICE_ACTIONS: &str = "device-actions";
// PRESENCE MARKER — usage snapshots; client requests unconditionally.
pub const USAGE: &str = "usage";
// PRESENCE MARKER — live model list; client re-requests unconditionally.
pub const MODELS: &str = "models";
// HARD GATE (bridge-side, on the client's command `caps`) — coloured diff cards.
// Bridge advertises "I can produce diff entries"; the client advertises "I can
// render them". Emission defaults OFF until a capable client proves itself (a
// pre-diff client hard-fails zod on the unknown entryType and drops the message).
pub const DIFF: &str = "diff";
// HARD GATE (client-side) — custom AI provider profiles. The client must gate
// ALL provider UI and send on it; an old bridge silently strips the unknown
// `providerId` and runs the session on the wrong provider/account.
pub const CUSTOM_PROVIDERS: &str = "custom-providers";
// TRANSPORT BEACON — oversize-event `chunk` fragmentation. Advertised on both
// sides, gated by neither.
pub const CHUNKED: &str = "chunked";

/// Every capability the reference bridge ships with (advertised wholesale).
pub const ALL_BRIDGE_CAPABILITIES: [&str; 10] = [
    SYNC_1, FOLDERS, GSD, IMAGES, DEVICE_ACTIONS, USAGE, MODELS, DIFF, CUSTOM_PROVIDERS, CHUNKED,
];

/// Capabilities the reference client stamps on outgoing command `caps` (strings
/// it can RENDER). The bridge only ever reads [`DIFF`] from this; [`CHUNKED`] is
/// a transport beacon so the negotiated pair is observable.
pub const ALL_PHONE_CAPABILITIES: [&str; 2] = [DIFF, CHUNKED];

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
    fn protocol_version_is_10() {
        assert_eq!(PROTOCOL_VERSION, 10);
    }

    #[test]
    fn bridge_advertises_all_ten() {
        assert_eq!(ALL_BRIDGE_CAPABILITIES.len(), 10);
        assert!(ALL_BRIDGE_CAPABILITIES.contains(&"sync/1"));
        assert!(ALL_BRIDGE_CAPABILITIES.contains(&"custom-providers"));
    }

    #[test]
    fn phone_advertises_only_diff_and_chunked() {
        assert_eq!(ALL_PHONE_CAPABILITIES, ["diff", "chunked"]);
    }

    #[test]
    fn host_kind_round_trips_and_rejects_unknown() {
        for k in [BridgeHostKind::Cli, BridgeHostKind::Vscode, BridgeHostKind::Service] {
            assert_eq!(BridgeHostKind::from_wire(k.as_wire()), Some(k));
        }
        assert_eq!(BridgeHostKind::from_wire("desktop"), None);
    }
}
