//! `settings` store — user settings. Port of the pure half of
//! `apps/obile/src/core/stores/settings.ts`. Persistence is the runtime's; the
//! only cross-store signal is `RelaysChanged` (reconfigure the transport).

use serde::{Deserialize, Serialize};

use protocol::relays::DEFAULT_RELAYS;

/// UI-scale slider range.
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsData {
    pub relays: Vec<String>,
    /// UI-scale user multiplier.
    pub ui_scale: f64,
    pub stay_connected: bool,
    /// Route relay traffic through Orbot's SOCKS5 proxy.
    pub tor_proxy_enabled: bool,
    /// Blossom server for session image attachments (`""` = built-in default).
    pub blossom_server: String,
    /// Preferred mode / effort / model for NEW sessions, as agent-defined ids
    /// (`""` = the agent's own default). Applied to a new session only when
    /// its agent advertises the id, so one preference can serve several agents.
    pub default_mode: String,
    pub default_effort: String,
    pub default_model: String,
    /// Master toggle for OS notifications AND the in-app ping (CDX-048).
    pub notifications_enabled: bool,
    pub show_usage_badge: bool,
    pub show_commit_badge: bool,
}

pub fn default_settings() -> SettingsData {
    let relays = DEFAULT_RELAYS.map(str::to_string).to_vec();
    SettingsData {
        relays,
        ui_scale: UI_SCALE_DEFAULT,
        // On: a phone that drives agents must keep hearing from its bridges
        // while in the background, which on Android takes the foreground
        // service this setting holds.
        stay_connected: true,
        tor_proxy_enabled: false,
        blossom_server: String::new(),
        default_mode: String::new(),
        default_effort: String::new(),
        default_model: String::new(),
        notifications_enabled: true,
        show_usage_badge: true,
        show_commit_badge: true,
    }
}

/// Tolerant per-field hydrate: a missing or ill-typed field takes its default.
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
        .map(|a| a.iter().filter_map(serde_json::Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let relays = if persisted_relays.is_empty() { defaults.relays.clone() } else { persisted_relays };

    let ui_scale = obj
        .get("uiScale")
        .and_then(serde_json::Value::as_f64)
        .map(clamp_ui_scale)
        .unwrap_or(defaults.ui_scale);

    SettingsData {
        relays,
        ui_scale,
        stay_connected: b("stayConnected", defaults.stay_connected),
        tor_proxy_enabled: b("torProxyEnabled", defaults.tor_proxy_enabled),
        blossom_server: s("blossomServer", &defaults.blossom_server),
        default_mode: s("defaultMode", &defaults.default_mode),
        default_effort: s("defaultEffort", &defaults.default_effort),
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

    /// Merge relays learned from a pairing URL (deduped).
    pub fn add_relays<S: AsRef<str>>(&mut self, urls: &[S]) -> Vec<SettingsEffect> {
        let mut merged = self.data.relays.clone();
        for u in urls {
            let u = u.as_ref();
            if !merged.iter().any(|m| m == u) {
                merged.push(u.to_string());
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
    pub fn set_blossom_server(&mut self, url: &str) {
        self.data.blossom_server = url.trim().to_string();
    }
    /// `""` clears it (the agent's default).
    pub fn set_default_mode(&mut self, mode: &str) {
        self.data.default_mode = mode.trim().to_string();
    }
    /// `""` clears it (the agent's default).
    pub fn set_default_effort(&mut self, level: &str) {
        self.data.default_effort = level.trim().to_string();
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
    fn defaults_are_the_transport_relays() {
        let d = default_settings();
        assert_eq!(d.relays, DEFAULT_RELAYS.map(str::to_string));
        assert_eq!(d.default_mode, ""); // the agent's own default
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
    fn hydrate_keeps_a_customised_relay_list_verbatim() {
        let custom = vec!["wss://my.relay".to_string(), "wss://relay.primal.net".to_string()];
        let raw = serde_json::json!({ "relays": custom }).to_string();
        assert_eq!(hydrate_settings(Some(&raw)).relays, custom);
    }

    #[test]
    fn hydrate_is_total_on_garbage_and_type_checks_fields() {
        assert_eq!(hydrate_settings(None), default_settings());
        assert_eq!(hydrate_settings(Some("not json")), default_settings());
        assert_eq!(hydrate_settings(Some("[1,2,3]")), default_settings());

        let raw = serde_json::json!({
            "relays": ["wss://x", "wss://y"],
            "uiScale": 99.0,
            "defaultMode": 7,
            "defaultEffort": "high",
            "stayConnected": "yes",
        })
        .to_string();
        let h = hydrate_settings(Some(&raw));
        assert_eq!(h.ui_scale, UI_SCALE_MAX); // clamped
        assert_eq!(h.default_mode, ""); // non-string -> default
        assert_eq!(h.default_effort, "high"); // agent ids are kept as-is
        assert_eq!(h.stay_connected, default_settings().stay_connected); // non-bool -> default
        assert_eq!(h.relays, vec!["wss://x", "wss://y"]); // custom list kept
    }

    #[test]
    fn setters_trim_and_write() {
        let mut st = SettingsState::default();
        st.set_blossom_server("  https://blossom.example  ");
        assert_eq!(st.data.blossom_server, "https://blossom.example");
        st.set_default_model("  opus  ");
        assert_eq!(st.data.default_model, "opus");
        st.set_default_mode(" acceptEdits ");
        assert_eq!(st.data.default_mode, "acceptEdits");
    }
}
