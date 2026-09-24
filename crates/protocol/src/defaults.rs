//! A single "defaults view" over this crate's own constants — values a phone
//! would otherwise hand-mirror by eye. Rust stays the one place these are
//! spelled out; the phone fetches this once at boot and renders from it.
//! Agent-specific lists (modes, effort levels) are NOT here: they come from
//! each bridge's agent catalog (`common::AgentDescriptor`).

use crate::common::PROVIDER_BASE_URL_ERROR;
use crate::relays::{DEFAULT_RELAYS, MARMOT_RELAYS};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolDefaults {
    pub default_relays: Vec<String>,
    pub marmot_relays: Vec<String>,
    pub provider_base_url_error: String,
}

pub fn protocol_defaults() -> ProtocolDefaults {
    ProtocolDefaults {
        default_relays: DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect(),
        marmot_relays: MARMOT_RELAYS.iter().map(|s| s.to_string()).collect(),
        provider_base_url_error: PROVIDER_BASE_URL_ERROR.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_carry_the_relay_lists_and_error_text() {
        let d = protocol_defaults();
        assert_eq!(d.default_relays.len(), 3);
        assert_eq!(d.marmot_relays.len(), 2);
        assert_eq!(d.provider_base_url_error, PROVIDER_BASE_URL_ERROR);
    }
}
