//! Phone-managed settings the bridge stores: credentials and custom provider
//! profiles. Both hold secrets — they are stored under
//! [`SECRET_KEYS`](crate::store_keys::SECRET_KEYS), never logged (their
//! `Debug` redacts), and never sent back to a phone: a phone only learns
//! whether a value is set.

use std::collections::BTreeMap;

use agent_protocol::Secret;
use protocol::common::{ProviderModel, ProviderProfileInfo};
use serde::{Deserialize, Serialize};

/// The bridge's own credential: a GitHub token, handed to every session's
/// agent as `GITHUB_TOKEN`.
pub const GITHUB_PAT: &str = "github_pat";
pub const GITHUB_PAT_LABEL: &str = "GitHub token";
pub const GITHUB_PAT_ENV: &str = "GITHUB_TOKEN";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredentials {
    /// Per agent id, per credential id.
    #[serde(default)]
    pub agents: BTreeMap<String, BTreeMap<String, Secret>>,
    /// The bridge's own, per credential id.
    #[serde(default)]
    pub bridge: BTreeMap<String, Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl StoredCredentials {
    /// The credentials of `scope` (an agent id; None = the bridge's own).
    pub fn scope(&self, scope: Option<&str>) -> Option<&BTreeMap<String, Secret>> {
        match scope {
            None => Some(&self.bridge),
            Some(agent) => self.agents.get(agent),
        }
    }

    pub fn scope_mut(&mut self, scope: Option<&str>) -> &mut BTreeMap<String, Secret> {
        match scope {
            None => &mut self.bridge,
            Some(agent) => self.agents.entry(agent.to_string()).or_default(),
        }
    }

    pub fn get(&self, scope: Option<&str>, id: &str) -> Option<&Secret> {
        self.scope(scope).and_then(|m| m.get(id))
    }
}

/// A custom provider profile: an endpoint (a provider's own API, or a
/// gateway in front of several) for one agent — a session of it can be
/// bound to the profile, or the agent offers the profile's models beside
/// its own, as its catalog entry says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    /// The agent the profile is for. Empty in a profile stored before
    /// profiles had one: no agent uses it until the phone names one.
    #[serde(default)]
    pub agent: String,
    pub label: String,
    pub base_url: String,
    /// Absent = stored without a token; sessions cannot start on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<Secret>,
    pub models: Vec<ProviderModel>,
    /// `models` is the provider's own list, read again on every save.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub models_from_provider: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl ProviderProfile {
    /// The model a session on this profile uses when none is chosen.
    pub fn fallback_model(&self) -> Option<&str> {
        self.default_model.as_deref().or_else(|| self.models.first().map(|m| m.id.as_str()))
    }

    /// What a session or an agent is handed: the profile with its token.
    /// None without a token.
    pub fn binding(&self) -> Option<agent_protocol::ProviderBinding> {
        Some(agent_protocol::ProviderBinding {
            id: self.id.clone(),
            label: self.label.clone(),
            base_url: self.base_url.clone(),
            auth_token: self.auth_token.clone()?,
            models: self.models.clone(),
            default_model: self.default_model.clone(),
        })
    }

    /// The phone's view: whether a token is set, never the token.
    pub fn redacted(&self) -> ProviderProfileInfo {
        ProviderProfileInfo {
            id: self.id.clone(),
            agent: self.agent.clone(),
            label: self.label.clone(),
            base_url: self.base_url.clone(),
            models: self.models.clone(),
            models_from_provider: self.models_from_provider,
            default_model: self.default_model.clone(),
            has_token: self.auth_token.is_some(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StoredProfiles {
    #[serde(default)]
    pub profiles: Vec<ProviderProfile>,
}

/// Parse a stored document, starting empty (with a warning) when it is
/// unreadable: a corrupt settings file must not stop the bridge.
pub fn load_or_default<T: Default + for<'de> Deserialize<'de>>(raw: Option<String>, what: &str) -> T {
    match raw {
        None => T::default(),
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
            log::warn!("[Settings] Stored {what} are unreadable ({err}) — starting empty");
            T::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_shows_a_secret() {
        let mut creds = StoredCredentials::default();
        creds.scope_mut(Some("claude-code")).insert("anthropic_api_key".into(), Secret::new("sk-ant-secret"));
        creds.scope_mut(None).insert(GITHUB_PAT.into(), Secret::new("ghp_secret"));
        let profile = ProviderProfile {
            id: "p".into(),
            agent: "claude-code".into(),
            label: "P".into(),
            base_url: "https://x".into(),
            auth_token: Some(Secret::new("tok-secret")),
            models: vec![],
            models_from_provider: false,
            default_model: None,
            updated_at: None,
        };
        let debug = format!("{creds:?} {profile:?}");
        assert!(!debug.contains("secret"), "{debug}");
    }

    #[test]
    fn a_profile_redacts_to_has_token() {
        let profile = ProviderProfile {
            id: "p".into(),
            agent: "claude-code".into(),
            label: "P".into(),
            base_url: "https://x".into(),
            auth_token: Some(Secret::new("t")),
            models: vec![ProviderModel { id: "m1".into(), ..Default::default() }],
            models_from_provider: false,
            default_model: None,
            updated_at: None,
        };
        let info = profile.redacted();
        assert!(info.has_token);
        assert!(!serde_json::to_string(&info).unwrap().contains("\"t\""));
        assert_eq!(profile.fallback_model(), Some("m1"));
    }

    #[test]
    fn unreadable_settings_start_empty() {
        let creds: StoredCredentials = load_or_default(Some("{nope".into()), "credentials");
        assert!(creds.agents.is_empty());
        let none: StoredProfiles = load_or_default(None, "profiles");
        assert!(none.profiles.is_empty());
    }
}
