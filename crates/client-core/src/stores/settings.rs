//! `settings` store — the phone's own preferences. Persistence is the
//! runtime's. What depends on a machine (its relays, the defaults for its
//! new sessions) is kept on that machine instead: see `stores::machines`.

use serde::{Deserialize, Serialize};

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
    /// UI-scale user multiplier.
    pub ui_scale: f64,
    pub stay_connected: bool,
    /// Route relay traffic through Orbot's SOCKS5 proxy.
    pub tor_proxy_enabled: bool,
    /// Blossom server for session image attachments (`""` = built-in default).
    pub blossom_server: String,
    /// Master toggle for OS notifications AND the in-app ping (CDX-048).
    pub notifications_enabled: bool,
    pub show_usage_badge: bool,
    pub show_commit_badge: bool,
}

pub fn default_settings() -> SettingsData {
    SettingsData {
        ui_scale: UI_SCALE_DEFAULT,
        // On: a phone that drives agents must keep hearing from its bridges
        // while in the background, which on Android takes the foreground
        // service this setting holds.
        stay_connected: true,
        tor_proxy_enabled: false,
        blossom_server: String::new(),
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

    let ui_scale = obj
        .get("uiScale")
        .and_then(serde_json::Value::as_f64)
        .map(clamp_ui_scale)
        .unwrap_or(defaults.ui_scale);

    SettingsData {
        ui_scale,
        stay_connected: b("stayConnected", defaults.stay_connected),
        tor_proxy_enabled: b("torProxyEnabled", defaults.tor_proxy_enabled),
        blossom_server: s("blossomServer", &defaults.blossom_server),
        notifications_enabled: b("notificationsEnabled", defaults.notifications_enabled),
        show_usage_badge: b("showUsageBadge", defaults.show_usage_badge),
        show_commit_badge: b("showCommitBadge", defaults.show_commit_badge),
    }
}

pub fn serialize_settings(data: &SettingsData) -> String {
    serde_json::to_string(data).expect("SettingsData serializes")
}

/// The settings store as pure state. Every mutator changes `data`; the runtime
/// persists `serialize_settings` after any call.
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
    fn ui_scale_clamps_and_round_trips() {
        assert_eq!(clamp_ui_scale(2.0), UI_SCALE_MAX);
        assert_eq!(clamp_ui_scale(0.1), UI_SCALE_MIN);
        assert_eq!(clamp_ui_scale(f64::NAN), UI_SCALE_DEFAULT);
        let mut st = SettingsState::default();
        st.set_ui_scale(1.2);
        assert_eq!(st.data.ui_scale, 1.2);
        let back = hydrate_settings(Some(&serialize_settings(&st.data)));
        assert_eq!(back.ui_scale, 1.2);
    }

    #[test]
    fn hydrate_is_total_on_garbage_and_type_checks_fields() {
        assert_eq!(hydrate_settings(None), default_settings());
        assert_eq!(hydrate_settings(Some("not json")), default_settings());
        assert_eq!(hydrate_settings(Some("[1,2,3]")), default_settings());

        let raw = serde_json::json!({
            "uiScale": 99.0,
            "blossomServer": 7,
            "stayConnected": "yes",
        })
        .to_string();
        let h = hydrate_settings(Some(&raw));
        assert_eq!(h.ui_scale, UI_SCALE_MAX); // clamped
        assert_eq!(h.blossom_server, ""); // non-string -> default
        assert_eq!(h.stay_connected, default_settings().stay_connected); // non-bool -> default
    }

    #[test]
    fn setters_trim_and_write() {
        let mut st = SettingsState::default();
        st.set_blossom_server("  https://blossom.example  ");
        assert_eq!(st.data.blossom_server, "https://blossom.example");
    }
}
