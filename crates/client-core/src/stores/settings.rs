//! `settings` store — user settings. Port of the pure half of
//! `apps/mobile/src/core/stores/settings.ts`. Persistence is the runtime's; the
//! only cross-store signal is `RelaysChanged` (reconfigure the transport).

use serde::{Deserialize, Serialize};

use crate::wire::common::{EffortLevel, PermissionMode};
use crate::wire::relays::{DEFAULT_RELAYS, MARMOT_RELAYS};

/// UI-scale slider range (plan §5).
pub const UI_SCALE_MIN: f64 = 0.85;
pub const UI_SCALE_MAX: f64 = 1.4;
pub const UI_SCALE_DEFAULT: f64 = 1.0;

pub fn clamp_ui_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(UI_SCALE_MIN, UI_SCALE_MAX)
    } else {
        UI_SCALE_DEFAULT
    }
}

/// CDX-021 → CDX-036: retired (kept empty as the mechanism for a future dead
/// default — `default_settings`, `hydrate_settings` and `add_relays` all filter
/// through it).
pub const DEAD_DEFAULT_RELAYS: &[&str] = &[];

fn without_dead_relays<S: AsRef<str>>(relays: &[S]) -> Vec<String> {
    relays
        .iter()
        .filter(|r| !DEAD_DEFAULT_RELAYS.contains(&r.as_ref()))
        .map(|r| r.as_ref().to_string())
        .collect()
}

/// Relay lists that were a SHIPPED DEFAULT at some point (no user intent). An
/// install still holding one verbatim never chose it, so `hydrate_settings`
/// lifts it to the current defaults. Any list differing by one entry is
/// customised and passes through untouched. CDX-081: every default change
/// appends the OUTGOING default here in the same commit.
const LEGACY_DEFAULT_RELAY_SETS: &[&[&str]] = &[
    &["wss://relay2.descendant.io", "wss://relay.primal.net"],
    &["wss://relay.primal.net"],
    &["wss://relay.primal.net", "wss://relay.damus.io"],
    &["wss://relay.primal.net", "wss://nostr.oxtr.dev"],
    &[
        "wss://relay2.descendant.io",
        "wss://relay.primal.net",
        "wss://nostr.oxtr.dev",
    ],
];

fn is_untouched_legacy_default(relays: &[String]) -> bool {
    LEGACY_DEFAULT_RELAY_SETS
        .iter()
        .any(|legacy| legacy.len() == relays.len() && legacy.iter().zip(relays).all(|(a, b)| a == b))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsData {
    pub relays: Vec<String>,
    /// UI-scale user multiplier.
    pub ui_scale: f64,
    pub stay_connected: bool,
    /// Route relay traffic through Orbot's SOCKS5 proxy.
    pub tor_proxy_enabled: bool,
    /// Only a designated TEST TARGET device auto-enables Wireless Debugging.
    pub mesh_test_target: bool,
    /// Blossom server for DM attachments (`""` = built-in default).
    pub blossom_server: String,
    /// Permission mode applied to NEW sessions (CDX-047).
    pub default_mode: PermissionMode,
    /// `create-session` default effort — `""` = unset (bridge/SDK default).
    pub default_effort: String,
    /// `create-session` model — `""` = bridge default.
    pub default_model: String,
    /// Master toggle for OS notifications AND the in-app ping (CDX-048).
    pub notifications_enabled: bool,
    pub show_usage_badge: bool,
    pub show_commit_badge: bool,
}

pub fn default_settings() -> SettingsData {
    let relays = without_dead_relays(
        &DEFAULT_RELAYS
            .iter()
            .chain(MARMOT_RELAYS.iter())
            .collect::<Vec<_>>(),
    );
    SettingsData {
        relays,
        ui_scale: UI_SCALE_DEFAULT,
        stay_connected: false,
        tor_proxy_enabled: false,
        mesh_test_target: false,
        blossom_server: String::new(),
        default_mode: PermissionMode::Plan,
        default_effort: String::new(),
        default_model: String::new(),
        notifications_enabled: true,
        show_usage_badge: true,
        show_commit_badge: true,
    }
}

fn is_valid_effort(s: &str) -> bool {
    s.is_empty() || serde_json::from_value::<EffortLevel>(serde_json::Value::String(s.to_string())).is_ok()
}

/// Tolerant per-field hydrate + the CDX-021/042 legacy-relay migration.
pub fn hydrate_settings(raw: Option<&str>) -> SettingsData {
    let defaults = default_settings();
    let Some(raw) = raw else {
        return defaults;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return defaults;
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return defaults,
    };
    let b = |key: &str, d: bool| obj.get(key).and_then(serde_json::Value::as_bool).unwrap_or(d);
    let s = |key: &str, d: &str| {
        obj.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| d.to_string())
    };

    let persisted_relays: Vec<String> = obj
        .get("relays")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            without_dead_relays(
                &a.iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_default();
    let relays = if persisted_relays.is_empty() || is_untouched_legacy_default(&persisted_relays) {
        defaults.relays.clone()
    } else {
        persisted_relays
    };

    let ui_scale = obj
        .get("uiScale")
        .and_then(serde_json::Value::as_f64)
        .map(clamp_ui_scale)
        .unwrap_or(defaults.ui_scale);

    let default_mode = obj
        .get("defaultMode")
        .and_then(|m| serde_json::from_value::<PermissionMode>(m.clone()).ok())
        .unwrap_or(defaults.default_mode);

    let default_effort = {
        let raw = s("defaultEffort", "");
        if is_valid_effort(&raw) {
            raw
        } else {
            defaults.default_effort.clone()
        }
    };

    SettingsData {
        relays,
        ui_scale,
        stay_connected: b("stayConnected", defaults.stay_connected),
        tor_proxy_enabled: b("torProxyEnabled", defaults.tor_proxy_enabled),
        mesh_test_target: b("meshTestTarget", defaults.mesh_test_target),
        blossom_server: s("blossomServer", &defaults.blossom_server),
        default_mode,
        default_effort,
        default_model: s("defaultModel", &defaults.default_model),
        notifications_enabled: b("notificationsEnabled", defaults.notifications_enabled),
        show_usage_badge: b("showUsageBadge", defaults.show_usage_badge),
        show_commit_badge: b("showCommitBadge", defaults.show_commit_badge),
    }
}

pub fn serialize_settings(data: &SettingsData) -> String {
    serde_json::to_string(data).expect("SettingsData serializes")
}

/// What a settings change asks the runtime to do beyond persisting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsEffect {
    /// The relay list changed — reconfigure the transport / resubscribe.
    RelaysChanged(Vec<String>),
}

/// The settings store as pure state. Every mutator changes `data`; the runtime
/// persists `serialize_settings` after any call and carries out the effects.
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsState {
    pub data: SettingsData,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            data: default_settings(),
        }
    }
}

impl SettingsState {
    pub fn new(data: SettingsData) -> Self {
        Self { data }
    }

    fn set_relays(&mut self, relays: Vec<String>) -> Vec<SettingsEffect> {
        self.data.relays = relays.clone();
        vec![SettingsEffect::RelaysChanged(relays)]
    }

    pub fn add_relay(&mut self, url: &str) -> Vec<SettingsEffect> {
        if self.data.relays.iter().any(|r| r == url) {
            return vec![];
        }
        let mut next = self.data.relays.clone();
        next.push(url.to_string());
        self.set_relays(next)
    }

    pub fn remove_relay(&mut self, url: &str) -> Vec<SettingsEffect> {
        if !self.data.relays.iter().any(|r| r == url) {
            return vec![];
        }
        let next: Vec<String> = self.data.relays.iter().filter(|r| *r != url).cloned().collect();
        self.set_relays(next)
    }

    /// Merge relays learned from a pairing URL (deduped, dead-relay-scrubbed).
    pub fn add_relays<S: AsRef<str>>(&mut self, urls: &[S]) -> Vec<SettingsEffect> {
        let incoming = without_dead_relays(urls);
        let mut merged = self.data.relays.clone();
        for u in incoming {
            if !merged.contains(&u) {
                merged.push(u);
            }
        }
        if merged.len() == self.data.relays.len() {
            return vec![];
        }
        self.set_relays(merged)
    }

    pub fn set_ui_scale(&mut self, scale: f64) {
        self.data.ui_scale = clamp_ui_scale(scale);
    }
    pub fn set_stay_connected(&mut self, on: bool) {
        self.data.stay_connected = on;
    }
    pub fn set_tor_proxy_enabled(&mut self, on: bool) {
        self.data.tor_proxy_enabled = on;
    }
    pub fn set_mesh_test_target(&mut self, on: bool) {
        self.data.mesh_test_target = on;
    }
    pub fn set_blossom_server(&mut self, url: &str) {
        self.data.blossom_server = url.trim().to_string();
    }
    pub fn set_default_mode(&mut self, mode: PermissionMode) {
        self.data.default_mode = mode;
    }
    /// `""` clears it (the SDK default); any other value must be a valid
    /// `EffortLevel` string (the caller validated it).
    pub fn set_default_effort(&mut self, level: &str) {
        self.data.default_effort = level.to_string();
    }
    pub fn set_default_model(&mut self, model: &str) {
        self.data.default_model = model.trim().to_string();
    }
    pub fn set_notifications_enabled(&mut self, on: bool) {
        self.data.notifications_enabled = on;
    }
    pub fn set_show_usage_badge(&mut self, on: bool) {
        self.data.show_usage_badge = on;
    }
    pub fn set_show_commit_badge(&mut self, on: bool) {
        self.data.show_commit_badge = on;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_carry_the_transport_relays_plus_the_marmot_island() {
        let d = default_settings();
        assert!(d.relays.contains(&"wss://relay2.descendant.io".to_string()));
        assert!(d.relays.contains(&"wss://relay.us.whitenoise.chat".to_string()));
        assert_eq!(d.relays.len(), 5);
        assert_eq!(d.default_mode, PermissionMode::Plan);
    }

    #[test]
    fn ui_scale_clamps_and_round_trips() {
        assert_eq!(clamp_ui_scale(2.0), UI_SCALE_MAX);
        assert_eq!(clamp_ui_scale(0.1), UI_SCALE_MIN);
        assert_eq!(clamp_ui_scale(f64::NAN), UI_SCALE_DEFAULT);
        let mut st = SettingsState::default();
        st.set_ui_scale(1.2);
        assert_eq!(st.data.ui_scale, 1.2);
        let back = hydrate_settings(Some(&serialize_settings(&st.data)));
        assert_eq!(back.ui_scale, 1.2);
        assert!(!back.relays.is_empty());
    }

    #[test]
    fn add_remove_relay_dedups_and_signals_relays_changed() {
        let mut st = SettingsState::default();
        let n0 = st.data.relays.len();
        assert_eq!(
            st.add_relay("wss://new.example"),
            vec![SettingsEffect::RelaysChanged(st.data.relays.clone())]
        );
        assert_eq!(st.data.relays.len(), n0 + 1);
        assert!(st.add_relay("wss://new.example").is_empty()); // dup, no signal
        assert_eq!(
            st.remove_relay("wss://new.example"),
            vec![SettingsEffect::RelaysChanged(st.data.relays.clone())]
        );
        assert_eq!(st.data.relays.len(), n0);
        assert!(st.remove_relay("wss://not-there").is_empty());
    }

    #[test]
    fn add_relays_merges_deduped_url_order_first() {
        let mut st = SettingsState::new(SettingsData {
            relays: vec!["wss://a".into(), "wss://b".into()],
            ..default_settings()
        });
        let eff = st.add_relays(&["wss://b", "wss://c"]);
        assert_eq!(st.data.relays, vec!["wss://a", "wss://b", "wss://c"]);
        assert_eq!(eff, vec![SettingsEffect::RelaysChanged(st.data.relays.clone())]);
        assert!(st.add_relays(&["wss://a"]).is_empty()); // no change
    }

    #[test]
    fn hydrate_lifts_every_untouched_legacy_default_to_the_current_one() {
        let current = default_settings().relays;
        for legacy in LEGACY_DEFAULT_RELAY_SETS {
            let raw = serde_json::json!({ "relays": legacy }).to_string();
            assert_eq!(
                hydrate_settings(Some(&raw)).relays,
                current,
                "legacy {legacy:?} should upgrade"
            );
        }
    }

    #[test]
    fn hydrate_keeps_a_customised_relay_list_verbatim() {
        let custom = vec!["wss://my.relay".to_string(), "wss://relay.primal.net".to_string()];
        let raw = serde_json::json!({ "relays": custom }).to_string();
        assert_eq!(hydrate_settings(Some(&raw)).relays, custom);
    }

    #[test]
    fn hydrate_is_total_on_garbage_and_validates_enums() {
        assert_eq!(hydrate_settings(None), default_settings());
        assert_eq!(hydrate_settings(Some("not json")), default_settings());
        assert_eq!(hydrate_settings(Some("[1,2,3]")), default_settings());

        let raw = serde_json::json!({
            "relays": ["wss://x", "wss://y"],
            "uiScale": 99.0,
            "defaultMode": "bogus",
            "defaultEffort": "ultra",
            "stayConnected": "yes",
        })
        .to_string();
        let h = hydrate_settings(Some(&raw));
        assert_eq!(h.ui_scale, UI_SCALE_MAX); // clamped
        assert_eq!(h.default_mode, PermissionMode::Plan); // invalid -> default
        assert_eq!(h.default_effort, ""); // invalid -> default ""
        assert!(!h.stay_connected); // non-bool -> default
        assert_eq!(h.relays, vec!["wss://x", "wss://y"]); // custom list kept

        // a valid effort survives
        let raw2 = serde_json::json!({ "relays": ["wss://x"], "defaultEffort": "high" }).to_string();
        assert_eq!(hydrate_settings(Some(&raw2)).default_effort, "high");
    }

    #[test]
    fn setters_trim_and_write() {
        let mut st = SettingsState::default();
        st.set_blossom_server("  https://blossom.example  ");
        assert_eq!(st.data.blossom_server, "https://blossom.example");
        st.set_default_model("  opus  ");
        assert_eq!(st.data.default_model, "opus");
        st.set_default_mode(PermissionMode::AcceptEdits);
        assert_eq!(st.data.default_mode, PermissionMode::AcceptEdits);
    }
}
