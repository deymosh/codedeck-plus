//! Credentials and custom provider profiles, set from a phone.
//!
//! Values are secrets: stored, handed to the agent host when a session
//! starts, never logged and never sent back — a phone learns only whether a
//! value is set and whether its provider accepted it.

use agent_protocol::{AgentInfo, BridgeMessage, ProviderBinding, Secret};
use protocol::commands::{SetCredentialsMsg, SetProviderProfileMsg};
use protocol::common::{is_valid_provider_base_url, CredentialStatus, PROVIDER_BASE_URL_ERROR};
use protocol::events::{BridgeToPhone, CredentialsAckMsg, ProviderProfileAckMsg, ProviderProfilesMsg};
use protocol::tristate::Tristate;

use super::{Engine, HostCall};
use crate::io::{store_keys, Effect};
use crate::settings::{ProviderProfile, StoredProfiles, GITHUB_PAT, GITHUB_PAT_LABEL};

/// A `credentials-ack` waiting on credential checks.
pub(crate) struct CredentialAck {
    phone: String,
    scope: Option<String>,
    outstanding: usize,
}

impl Engine {
    /// The status of an agent's credentials. One the operator set in the
    /// bridge's environment wins over a stored one.
    pub(super) fn agent_credentials(&self, agent: &AgentInfo) -> Vec<CredentialStatus> {
        agent
            .credentials
            .iter()
            .map(|spec| {
                let from_env = spec.env_var.as_deref().is_some_and(|var| self.system.env_is_set(var));
                CredentialStatus {
                    id: spec.id.clone(),
                    label: spec.label.clone(),
                    present: from_env || self.credentials.get(Some(&agent.id), &spec.id).is_some(),
                    from_env,
                    valid: self.credential_valid.get(&(Some(agent.id.clone()), spec.id.clone())).copied(),
                }
            })
            .collect()
    }

    /// The bridge's own credentials.
    pub(super) fn bridge_credentials(&self) -> Vec<CredentialStatus> {
        vec![CredentialStatus {
            id: GITHUB_PAT.into(),
            label: GITHUB_PAT_LABEL.into(),
            present: self.credentials.get(None, GITHUB_PAT).is_some(),
            from_env: false,
            valid: None,
        }]
    }

    fn scope_credentials(&self, scope: Option<&str>) -> Vec<CredentialStatus> {
        match scope {
            None => self.bridge_credentials(),
            Some(agent) => self.catalog.get(agent).map(|a| self.agent_credentials(a)).unwrap_or_default(),
        }
    }

    /// Store or clear credentials of one scope (an agent's, or the bridge's
    /// own when `agent` is absent), then check each new agent credential with
    /// its provider before acking. An id outside the scope refuses the whole
    /// write.
    pub(super) fn on_set_credentials(&mut self, m: SetCredentialsMsg, phone: &str) {
        let scope = m.agent;
        log::info!("[Engine] set-credentials ({}) from {}...", scope.as_deref().unwrap_or("bridge"), phone.get(..8).unwrap_or(phone));
        let allowed: Vec<(String, Option<String>)> = match scope.as_deref() {
            None => vec![(GITHUB_PAT.to_string(), None)],
            Some(agent) => match self.catalog.usable(agent) {
                Ok(info) => info.credentials.iter().map(|c| (c.id.clone(), c.env_var.clone())).collect(),
                Err(reason) => return self.refuse_credentials(phone, scope.as_deref(), reason),
            },
        };
        // Credential ids are names, not secrets — safe to name.
        let unknown: Vec<&str> =
            m.values.keys().filter(|id| !allowed.iter().any(|(a, _)| a == *id)).map(String::as_str).collect();
        if !unknown.is_empty() {
            let reason = format!("Unknown credential: {}", unknown.join(", "));
            return self.refuse_credentials(phone, scope.as_deref(), reason);
        }

        let mut next = self.credentials.clone();
        let mut checks = Vec::new();
        for (id, value) in m.values {
            let map = next.scope_mut(scope.as_deref());
            match value {
                Some(value) => {
                    let secret = Secret::new(value);
                    map.insert(id.clone(), secret.clone());
                    // Only the value in force is checked: one the operator
                    // set in the environment wins over the stored one.
                    let env_var = allowed.iter().find(|(a, _)| *a == id).and_then(|(_, env)| env.as_deref());
                    if scope.is_some() && !env_var.is_some_and(|var| self.system.env_is_set(var)) {
                        checks.push((id.clone(), secret));
                    }
                }
                None => {
                    map.remove(&id);
                }
            }
            self.credential_valid.remove(&(scope.clone(), id));
        }
        next.updated_at = Some(self.now_iso());
        let json = serde_json::to_string(&next).expect("credentials serialize");
        if let Err(err) = self.store.set(store_keys::CREDENTIALS, &json) {
            log::error!("[Engine] Could not store credentials: {err}");
            return self.send_credentials_ack(phone, scope.as_deref(), Some(err));
        }
        // Sessions pick these up at their next start; running agents keep the
        // environment they started with.
        self.credentials = next;
        log::info!("[Engine] Credentials saved ({})", scope.as_deref().unwrap_or("bridge"));

        self.next_ticket += 1;
        let ticket = self.next_ticket;
        let mut outstanding = 0;
        if let Some(agent) = &scope {
            for (credential, value) in checks {
                let call = HostCall::CheckCredential {
                    ticket,
                    agent: agent.clone(),
                    credential: credential.clone(),
                    value: value.clone(),
                };
                let message = BridgeMessage::CheckCredential { agent: agent.clone(), credential, value };
                outstanding += usize::from(self.call(call, message).is_some());
            }
        }
        if outstanding == 0 {
            self.send_credentials_ack(phone, scope.as_deref(), None);
        } else {
            self.credential_acks.insert(ticket, CredentialAck { phone: phone.to_string(), scope, outstanding });
        }
    }

    /// A credential check came back. It counts only if the value is still the
    /// one stored — a newer write may have replaced it meanwhile.
    pub(super) fn on_credential_checked(&mut self, ticket: u64, agent: &str, credential: &str, value: &Secret, valid: Option<bool>) {
        if self.credentials.get(Some(agent), credential) == Some(value) {
            log::info!("[Engine] Credential {credential} of {agent} checked: {valid:?}");
            let key = (Some(agent.to_string()), credential.to_string());
            match valid {
                Some(valid) => self.credential_valid.insert(key, valid),
                None => self.credential_valid.remove(&key),
            };
        }
        let Some(ack) = self.credential_acks.get_mut(&ticket) else { return };
        ack.outstanding -= 1;
        if ack.outstanding == 0 {
            let ack = self.credential_acks.remove(&ticket).expect("present");
            self.send_credentials_ack(&ack.phone, ack.scope.as_deref(), None);
        }
    }

    fn send_credentials_ack(&mut self, phone: &str, scope: Option<&str>, error: Option<String>) {
        let credentials = self.scope_credentials(scope);
        self.publish_to(
            phone,
            BridgeToPhone::CredentialsAck(CredentialsAckMsg {
                machine: self.config.machine.clone(),
                agent: scope.map(str::to_string),
                success: error.is_none(),
                credentials,
                error,
            }),
        );
        // Every phone shows credential status from the heartbeat.
        self.list_dirty = true;
    }

    fn refuse_credentials(&mut self, phone: &str, scope: Option<&str>, reason: String) {
        log::info!("[Engine] set-credentials refused: {reason}");
        self.publish_to(
            phone,
            BridgeToPhone::CredentialsAck(CredentialsAckMsg {
                machine: self.config.machine.clone(),
                agent: scope.map(str::to_string),
                success: false,
                credentials: vec![],
                error: Some(reason),
            }),
        );
    }

    // --- provider profiles ---

    /// What a session bound to profile `id` starts with. Refuses a deleted
    /// profile, an insecure base URL and a missing token: each would
    /// otherwise start the session on the wrong account or put the token on
    /// a cleartext connection.
    pub(super) fn provider_binding(&self, id: &str) -> Result<ProviderBinding, String> {
        let profile = self.profiles.get(id).ok_or_else(|| format!("provider profile '{id}' was deleted"))?;
        if !is_valid_provider_base_url(&profile.base_url) {
            return Err(format!(
                "provider profile '{id}' has an insecure base URL ({}) — {PROVIDER_BASE_URL_ERROR}. Its API token would travel in cleartext, so the session is refused.",
                profile.base_url
            ));
        }
        let auth_token = profile.auth_token.clone().ok_or_else(|| format!("provider profile '{id}' has no stored auth token"))?;
        Ok(ProviderBinding {
            id: id.to_string(),
            base_url: profile.base_url.clone(),
            auth_token,
            models: profile.models.clone(),
            default_model: profile.default_model.clone(),
        })
    }

    pub(super) fn provider_profiles_msg(&self) -> BridgeToPhone {
        BridgeToPhone::ProviderProfiles(ProviderProfilesMsg {
            machine: self.config.machine.clone(),
            profiles: self.profiles.values().map(ProviderProfile::redacted).collect(),
        })
    }

    /// Create, update or delete one profile. An upsert with a token checks it
    /// against the profile's own endpoint before acking; every phone then
    /// gets the new (redacted) list.
    pub(super) fn on_set_provider_profile(&mut self, m: SetProviderProfileMsg, phone: &str) {
        let id = m.profile_id;
        log::info!("[Engine] set-provider-profile '{id}' from {}...", phone.get(..8).unwrap_or(phone));
        let mut next = self.profiles.clone();
        let Some(write) = m.profile else {
            // Deleting is never refused, whatever the stored URL: a profile
            // that needs fixing must stay removable. Sessions bound to it
            // fail at their next start rather than fall back to another
            // account.
            let existed = next.remove(&id).is_some();
            if let Err(err) = self.store_profiles(next) {
                return self.send_profile_ack(phone, &id, Err(err));
            }
            log::info!("[Engine] Provider profile '{id}' deleted (existed={existed})");
            self.send_profile_ack(phone, &id, Ok(None));
            return;
        };
        // The store never holds an insecure profile: the token check below
        // sends the token to this URL.
        if !is_valid_provider_base_url(&write.base_url) {
            log::info!("[Engine] Provider profile '{id}' refused: insecure base URL ({})", write.base_url);
            return self.send_profile_ack(phone, &id, Err(PROVIDER_BASE_URL_ERROR.into()));
        }
        if write.models.is_empty() {
            return self.send_profile_ack(phone, &id, Err("A provider profile needs at least one model.".into()));
        }
        let auth_token = match write.auth_token {
            Tristate::Keep => self.profiles.get(&id).and_then(|p| p.auth_token.clone()),
            Tristate::Clear => None,
            Tristate::Set(token) => Some(Secret::new(token)),
        };
        let profile = ProviderProfile {
            id: id.clone(),
            label: write.label,
            base_url: write.base_url,
            auth_token,
            models: write.models,
            default_model: write.default_model,
            updated_at: Some(self.now_iso()),
        };
        next.insert(id.clone(), profile.clone());
        if let Err(err) = self.store_profiles(next) {
            return self.send_profile_ack(phone, &id, Err(err));
        }
        log::info!(
            "[Engine] Provider profile saved: '{id}' (\"{}\", {}, {} model(s), hasToken={})",
            profile.label,
            profile.base_url,
            profile.models.len(),
            profile.auth_token.is_some()
        );
        let model = profile.fallback_model().map(str::to_string);
        match (profile.auth_token, model) {
            (Some(token), Some(model)) => {
                self.next_ticket += 1;
                let ticket = self.next_ticket;
                self.profile_acks.insert(ticket, (phone.to_string(), id));
                self.out.push(Effect::CheckProviderToken { ticket, base_url: profile.base_url, token, model });
            }
            _ => self.send_profile_ack(phone, &id, Ok(None)),
        }
    }

    pub(super) fn on_provider_token_checked(&mut self, ticket: u64, valid: Option<bool>) {
        let Some((phone, id)) = self.profile_acks.remove(&ticket) else { return };
        log::info!("[Engine] Provider token of '{id}' checked: {valid:?}");
        self.send_profile_ack(&phone, &id, Ok(valid));
    }

    fn store_profiles(&mut self, next: std::collections::BTreeMap<String, ProviderProfile>) -> Result<(), String> {
        let doc = StoredProfiles { profiles: next.values().cloned().collect() };
        let json = serde_json::to_string(&doc).expect("profiles serialize");
        self.store.set(store_keys::PROVIDER_PROFILES, &json).inspect_err(|err| {
            log::error!("[Engine] Could not store provider profiles: {err}");
        })?;
        self.profiles = next;
        Ok(())
    }

    /// Ack the sender; on success every phone also gets the new list.
    fn send_profile_ack(&mut self, phone: &str, id: &str, result: Result<Option<bool>, String>) {
        let (success, token_valid, error) = match result {
            Ok(valid) => (true, valid, None),
            Err(err) => (false, None, Some(err)),
        };
        self.publish_to(
            phone,
            BridgeToPhone::ProviderProfileAck(ProviderProfileAckMsg {
                machine: self.config.machine.clone(),
                profile_id: id.to_string(),
                success,
                token_valid,
                error,
            }),
        );
        if success {
            let list = self.provider_profiles_msg();
            self.publish_all(list);
        }
    }
}
