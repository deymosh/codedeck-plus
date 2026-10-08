//! Protocol version + capabilities.
//!
//! The bridge advertises `protocol_version` + `capabilities` on the session-list
//! heartbeat; commands carry neither. Feature gating is on capability
//! **strings** and on the per-agent catalog (`AgentDescriptor::supports`),
//! never on version comparisons — a new feature is one new string or one new
//! `supports` flag, not a version-ladder entry. A different
//! `protocol_version` means the two ends cannot talk at all, and a phone says
//! so rather than guessing.
//!
//! What an individual AGENT can do (models, usage, custom providers, GSD) is
//! catalog data, not a capability: capabilities describe the BRIDGE. Every
//! capability is a gate — absence changes what a phone does — and a string
//! is added only when a phone that relied on it against a bridge without it
//! would otherwise fail:
//!
//! * [`FILES`]: the phone shows the attach control only when the bridge
//!   advertises it;
//! * [`SESSION_KEYS`]: the phone grants a session key only to a bridge that
//!   honours one.

/// v11 = the agent-neutral protocol: per-agent catalog, typed transcript
/// entries, typed answers, `set-option`. Clean break from v10 — no v10
/// compatibility.
pub const PROTOCOL_VERSION: u32 = 11;

// Session attachments of any kind (`upload-file`); the attach control shows
// only when this is in the machine's heartbeat capabilities.
pub const FILES: &str = "files";
// The bridge honours `session-key` grants: it
// reads command payloads encrypted with a granted key and encrypts to it. A
// client grants a key only when this is advertised; a bridge without it
// could not read a payload encrypted with one.
pub const SESSION_KEYS: &str = "session-keys";

/// Every capability the reference bridge ships with.
pub const ALL_BRIDGE_CAPABILITIES: [&str; 2] = [FILES, SESSION_KEYS];

/// Which host binary a bridge runs as — a UI badge only; identity is the keypair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BridgeHostKind {
    Cli,
    Service,
}

impl BridgeHostKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Service => "service",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "cli" => Some(Self::Cli),
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
    fn capability_list() {
        assert_eq!(ALL_BRIDGE_CAPABILITIES, ["files", "session-keys"]);
    }

    #[test]
    fn host_kind_round_trips_and_rejects_unknown() {
        for k in [BridgeHostKind::Cli, BridgeHostKind::Service] {
            assert_eq!(BridgeHostKind::from_wire(k.as_wire()), Some(k));
        }
        assert_eq!(BridgeHostKind::from_wire("desktop"), None);
    }
}
