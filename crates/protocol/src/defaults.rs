//! A single "defaults view" over this crate's own constants — the values a
//! phone-side dropdown/relay-list/error-string used to hand-mirror by eye
//! (`packages/protocol`'s zod schemas, and before that a plain TS literal).
//! Rust stays the one place these are spelled out; the phone fetches this
//! once at boot and renders from it, the same way it fetches a `*View` for
//! everything else — see `common::EffortLevel`/`PermissionMode`,
//! `capabilities::CUSTOM_PROVIDERS`, and `relays::{DEFAULT_RELAYS,
//! MARMOT_RELAYS}` for the underlying sources of truth this only reads from.

use crate::capabilities::CUSTOM_PROVIDERS;
use crate::common::{EffortLevel, PermissionMode, PROVIDER_BASE_URL_ERROR};
use crate::relays::{DEFAULT_RELAYS, MARMOT_RELAYS};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolDefaults {
    /// Every value `EffortLevel` accepts, in the order a picker should list
    /// them — `bypassPermissions` has no `PermissionMode` counterpart by
    /// design (see `common::PermissionMode`'s own doc comment).
    pub effort_levels: Vec<EffortLevel>,
    pub permission_modes: Vec<PermissionMode>,
    pub default_relays: Vec<String>,
    pub marmot_relays: Vec<String>,
    /// The `custom-providers` capability string (`CAPABILITIES.customProviders`
    /// on the old TS side) — the one capability constant the phone UI reads.
    pub custom_providers_capability: String,
    pub provider_base_url_error: String,
}

pub fn protocol_defaults() -> ProtocolDefaults {
    ProtocolDefaults {
        effort_levels: vec![
            EffortLevel::Low,
            EffortLevel::Medium,
            EffortLevel::High,
            EffortLevel::Xhigh,
            EffortLevel::Max,
            EffortLevel::Auto,
        ],
        permission_modes: vec![PermissionMode::Default, PermissionMode::AcceptEdits, PermissionMode::Plan],
        default_relays: DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect(),
        marmot_relays: MARMOT_RELAYS.iter().map(|s| s.to_string()).collect(),
        custom_providers_capability: CUSTOM_PROVIDERS.to_string(),
        provider_base_url_error: PROVIDER_BASE_URL_ERROR.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::is_valid_provider_base_url;

    #[test]
    fn every_effort_level_and_permission_mode_variant_is_listed_exactly_once() {
        let d = protocol_defaults();
        assert_eq!(d.effort_levels.len(), 6, "{:?}", d.effort_levels);
        assert_eq!(d.permission_modes.len(), 3, "{:?}", d.permission_modes);
        assert_eq!(d.default_relays.len(), 3);
        assert_eq!(d.marmot_relays.len(), 2);
        assert_eq!(d.custom_providers_capability, "custom-providers");
        assert!(is_valid_provider_base_url("https://api.example.com"));
        assert_eq!(d.provider_base_url_error, PROVIDER_BASE_URL_ERROR);
    }
}
