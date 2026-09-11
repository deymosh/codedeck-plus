//! `ui` store — UI selection + optimistic interaction-card state. Port of the
//! pure half of `apps/mobile/src/core/stores/ui.ts`. Deliberately tiny: no view
//! logic lives in the core.
//!
//! Transient by design — none of this is persisted. A fresh boot starts with no
//! stale unread dots, no stale "saved" credential claims, no undo toast.
//!
//! The two runtime seams (`onSessionViewed` / `onDmOpened`, CDX-026c: cancel a
//! surface's delivered OS notifications when the user opens it) are
//! [`UiEffect`]s here; `visible` (the debounced app-visibility the connection
//! FSM tracks) is passed in per call, like the notification engine.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

pub use crate::notifications::session_key_of;

/// Which conversation surface the main panel shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PanelMode {
    #[default]
    Session,
    Dm,
    Marmot,
}

/// Fire-and-answer round-trip state for the `set-credentials` /
/// `set-device-config` / `set-provider-profile` acks (CDX-011 / CDX-062).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AckState {
    Saving,
    Saved,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsAck {
    pub state: AckState,
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_anthropic_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_github_pat: Option<bool>,
    /// Bridge-side 1-token validation outcome; `None` = not validated (network).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConfigAck {
    pub state: AckState,
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileAck {
    pub state: AckState,
    #[specta(type = specta_typescript::Number)]
    pub at: u64,
    /// Which profile the latest round-trip was about (ack routing detail).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// Bridge-side 1-token probe verdict; `None` = probe could not run (network).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The bottom "Deleted X — Undo" toast for a pending session delete. The
/// [`crate::delete_controller`] owns its 4 s lifecycle; this is only what the UI
/// renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoToast {
    pub machine: String,
    pub session_id: String,
    pub label: String,
}

/// CDX-026c seam: the user opened a surface in view (same visible-app gate as
/// the unread clear) — cancel its delivered OS notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UiEffect {
    SessionViewed { machine: String, session_id: String },
    DmOpened { peer: String },
}

/// Inputs for `set-credentials` / `set-device-config` / `set-provider-profile`
/// acks — the decoded message fields the runtime hands in.
#[derive(Debug, Clone, Default)]
pub struct CredentialsAckInput {
    pub success: bool,
    pub has_anthropic_key: bool,
    pub has_github_pat: bool,
    pub key_valid: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderProfileAckInput {
    pub profile_id: String,
    pub success: bool,
    pub token_valid: Option<bool>,
    pub error: Option<String>,
}

fn ack_state(success: bool) -> AckState {
    if success {
        AckState::Saved
    } else {
        AckState::Failed
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UiState {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    pub panel_mode: PanelMode,
    pub active_dm_peer: Option<String>,
    pub active_marmot_group: Option<String>,
    /// `session_key_of(machine, session)` → has unread activity (the attention
    /// dot's `is_unread` input — see [`crate::session_needs_attention`]).
    pub unread_sessions: BTreeSet<String>,
    /// session key → optimistically-responded card ids (tool_use ids).
    pub responded_cards: BTreeMap<String, BTreeSet<String>>,
    /// card id → plan-approval key (`"1"`/`"2"`/`"3"`) the user tapped.
    pub plan_approval_choices: BTreeMap<String, String>,
    pub credentials_status: BTreeMap<String, CredentialsAck>,
    pub device_config_status: BTreeMap<String, DeviceConfigAck>,
    pub provider_profile_status: BTreeMap<String, ProviderProfileAck>,
    pub undo_toast: Option<UndoToast>,
}

impl UiState {
    fn clear_unread(&mut self, key: &str) {
        self.unread_sessions.remove(key);
    }

    pub fn select_machine(&mut self, pubkey_hex: Option<&str>) {
        self.selected_machine = pubkey_hex.map(str::to_string);
        self.selected_session = None;
        self.panel_mode = PanelMode::Session;
    }

    /// Opening/viewing a session clears its unread dot — but only when the app
    /// is actually visible (a hidden app keeps the dot). The same gate emits
    /// [`UiEffect::SessionViewed`] (CDX-026c).
    pub fn select_session(
        &mut self,
        machine_pubkey: &str,
        session_id: Option<&str>,
        visible: bool,
    ) -> Vec<UiEffect> {
        self.selected_machine = Some(machine_pubkey.to_string());
        self.selected_session = session_id.map(str::to_string);
        self.panel_mode = PanelMode::Session;

        let (Some(session_id), true) = (session_id, visible) else {
            return vec![];
        };
        self.clear_unread(&session_key_of(machine_pubkey, session_id));
        vec![UiEffect::SessionViewed {
            machine: machine_pubkey.to_string(),
            session_id: session_id.to_string(),
        }]
    }

    /// Open a DM conversation (or `None` = the DM list) — `panel_mode` follows.
    /// Opening a conversation reads it: [`UiEffect::DmOpened`] (CDX-026c).
    pub fn select_dm_peer(&mut self, peer_pubkey: Option<&str>) -> Vec<UiEffect> {
        self.active_dm_peer = peer_pubkey.map(str::to_string);
        self.panel_mode = PanelMode::Dm;
        match peer_pubkey {
            Some(peer) => vec![UiEffect::DmOpened {
                peer: peer.to_string(),
            }],
            None => vec![],
        }
    }

    /// Open a Marmot group (or `None` = the list) — `panel_mode` follows.
    pub fn select_marmot_group(&mut self, group_id: Option<&str>) {
        self.active_marmot_group = group_id.map(str::to_string);
        self.panel_mode = PanelMode::Marmot;
    }

    pub fn mark_session_unread(&mut self, machine: &str, session_id: &str) {
        self.unread_sessions.insert(session_key_of(machine, session_id));
    }

    pub fn clear_session_unread(&mut self, machine: &str, session_id: &str) {
        self.clear_unread(&session_key_of(machine, session_id));
    }

    pub fn is_session_unread(&self, machine: &str, session_id: &str) -> bool {
        self.unread_sessions
            .contains(&session_key_of(machine, session_id))
    }

    pub fn mark_card_responded(&mut self, machine: &str, session_id: &str, card_id: &str) {
        self.responded_cards
            .entry(session_key_of(machine, session_id))
            .or_default()
            .insert(card_id.to_string());
    }

    pub fn is_card_responded(&self, machine: &str, session_id: &str, card_id: &str) -> bool {
        self.responded_cards
            .get(&session_key_of(machine, session_id))
            .is_some_and(|set| set.contains(card_id))
    }

    pub fn set_plan_approval_choice(&mut self, card_id: &str, key: &str) {
        self.plan_approval_choices
            .insert(card_id.to_string(), key.to_string());
    }

    /// A `set-credentials` command left for this machine — show "saving…".
    pub fn note_credentials_sent(&mut self, machine_pubkey: &str, now: u64) {
        self.credentials_status.insert(
            machine_pubkey.to_string(),
            CredentialsAck {
                state: AckState::Saving,
                at: now,
                has_anthropic_key: None,
                has_github_pat: None,
                key_valid: None,
                error: None,
            },
        );
    }

    pub fn apply_credentials_ack(
        &mut self,
        machine_pubkey: &str,
        ack: CredentialsAckInput,
        now: u64,
    ) {
        self.credentials_status.insert(
            machine_pubkey.to_string(),
            CredentialsAck {
                state: ack_state(ack.success),
                at: now,
                has_anthropic_key: Some(ack.has_anthropic_key),
                has_github_pat: Some(ack.has_github_pat),
                key_valid: ack.key_valid,
                error: ack.error,
            },
        );
    }

    pub fn note_device_config_sent(&mut self, machine_pubkey: &str, now: u64) {
        self.device_config_status.insert(
            machine_pubkey.to_string(),
            DeviceConfigAck {
                state: AckState::Saving,
                at: now,
                error: None,
            },
        );
    }

    pub fn apply_device_config_ack(
        &mut self,
        machine_pubkey: &str,
        success: bool,
        error: Option<String>,
        now: u64,
    ) {
        self.device_config_status.insert(
            machine_pubkey.to_string(),
            DeviceConfigAck {
                state: ack_state(success),
                at: now,
                error,
            },
        );
    }

    pub fn note_provider_profile_sent(&mut self, machine_pubkey: &str, profile_id: &str, now: u64) {
        self.provider_profile_status.insert(
            machine_pubkey.to_string(),
            ProviderProfileAck {
                state: AckState::Saving,
                at: now,
                profile_id: Some(profile_id.to_string()),
                token_valid: None,
                error: None,
            },
        );
    }

    pub fn apply_provider_profile_ack(
        &mut self,
        machine_pubkey: &str,
        ack: ProviderProfileAckInput,
        now: u64,
    ) {
        self.provider_profile_status.insert(
            machine_pubkey.to_string(),
            ProviderProfileAck {
                state: ack_state(ack.success),
                at: now,
                profile_id: Some(ack.profile_id),
                token_valid: ack.token_valid,
                error: ack.error,
            },
        );
    }

    pub fn set_undo_toast(&mut self, toast: Option<UndoToast>) {
        self.undo_toast = toast;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_clear_is_session_unread_round_trip_keyed_per_machine_and_session() {
        let mut ui = UiState::default();
        ui.mark_session_unread("m1", "s1");
        assert!(ui.is_session_unread("m1", "s1"));
        assert!(!ui.is_session_unread("m1", "s2"));
        assert!(!ui.is_session_unread("m2", "s1"));
        assert!(ui.unread_sessions.contains(&session_key_of("m1", "s1")));
        ui.clear_session_unread("m1", "s1");
        assert!(!ui.is_session_unread("m1", "s1"));
    }

    #[test]
    fn mark_is_idempotent_and_clearing_an_unmarked_session_is_a_noop() {
        let mut ui = UiState::default();
        ui.mark_session_unread("m1", "s1");
        let after = ui.unread_sessions.clone();
        ui.mark_session_unread("m1", "s1");
        assert_eq!(ui.unread_sessions, after);
        ui.clear_session_unread("m1", "NEVER-MARKED");
        assert_eq!(ui.unread_sessions, after);
    }

    #[test]
    fn select_session_clears_unread_when_visible_keeps_it_when_hidden() {
        let mut ui = UiState::default();
        ui.mark_session_unread("m1", "s1");
        let fx = ui.select_session("m1", Some("s1"), true);
        assert!(!ui.is_session_unread("m1", "s1"));
        assert_eq!(
            fx,
            vec![UiEffect::SessionViewed {
                machine: "m1".into(),
                session_id: "s1".into()
            }]
        );

        ui.mark_session_unread("m1", "s2");
        let fx = ui.select_session("m1", Some("s2"), false);
        assert!(ui.is_session_unread("m1", "s2")); // hidden → dot survives
        assert!(fx.is_empty()); // and no CDX-026c cancel
    }

    #[test]
    fn panel_mode_follows_selection_session_dm_marmot() {
        let mut ui = UiState::default();
        assert_eq!(ui.panel_mode, PanelMode::Session);

        assert_eq!(
            ui.select_dm_peer(Some("peer1")),
            vec![UiEffect::DmOpened { peer: "peer1".into() }]
        );
        assert_eq!(ui.panel_mode, PanelMode::Dm);
        assert_eq!(ui.active_dm_peer.as_deref(), Some("peer1"));

        ui.select_marmot_group(Some("group1"));
        assert_eq!(ui.panel_mode, PanelMode::Marmot);
        assert_eq!(ui.active_marmot_group.as_deref(), Some("group1"));

        ui.select_session("m1", Some("s1"), true);
        assert_eq!(ui.panel_mode, PanelMode::Session);
        ui.select_machine(Some("m1"));
        assert_eq!(ui.panel_mode, PanelMode::Session);
        assert_eq!(ui.selected_session, None); // select_machine clears the session
    }

    #[test]
    fn select_dm_peer_none_opens_the_list_without_a_cancel_effect() {
        let mut ui = UiState::default();
        assert!(ui.select_dm_peer(None).is_empty());
        assert_eq!(ui.panel_mode, PanelMode::Dm);
        assert_eq!(ui.active_dm_peer, None);
    }

    #[test]
    fn responded_cards_and_plan_choice_are_keyed_per_session() {
        let mut ui = UiState::default();
        ui.mark_card_responded("m", "s1", "card-a");
        assert!(ui.is_card_responded("m", "s1", "card-a"));
        assert!(!ui.is_card_responded("m", "s1", "card-b"));
        assert!(!ui.is_card_responded("m", "s2", "card-a")); // no cross-talk

        ui.set_plan_approval_choice("card-a", "2");
        assert_eq!(ui.plan_approval_choices.get("card-a").map(String::as_str), Some("2"));
    }

    #[test]
    fn credentials_ack_moves_saving_to_saved_or_failed() {
        let mut ui = UiState::default();
        ui.note_credentials_sent("m", 100);
        assert_eq!(ui.credentials_status["m"].state, AckState::Saving);

        ui.apply_credentials_ack(
            "m",
            CredentialsAckInput {
                success: true,
                has_anthropic_key: true,
                has_github_pat: false,
                key_valid: Some(true),
                error: None,
            },
            200,
        );
        let ack = &ui.credentials_status["m"];
        assert_eq!(ack.state, AckState::Saved);
        assert_eq!(ack.at, 200);
        assert_eq!(ack.has_anthropic_key, Some(true));
        assert_eq!(ack.key_valid, Some(true));

        ui.apply_credentials_ack(
            "m",
            CredentialsAckInput {
                success: false,
                error: Some("bad key".into()),
                ..Default::default()
            },
            300,
        );
        assert_eq!(ui.credentials_status["m"].state, AckState::Failed);
        assert_eq!(ui.credentials_status["m"].error.as_deref(), Some("bad key"));
    }

    #[test]
    fn provider_profile_ack_carries_the_profile_id_of_the_round_trip() {
        let mut ui = UiState::default();
        ui.note_provider_profile_sent("m", "prof-1", 10);
        assert_eq!(
            ui.provider_profile_status["m"].profile_id.as_deref(),
            Some("prof-1")
        );
        ui.apply_provider_profile_ack(
            "m",
            ProviderProfileAckInput {
                profile_id: "prof-1".into(),
                success: true,
                token_valid: Some(false),
                error: None,
            },
            20,
        );
        let ack = &ui.provider_profile_status["m"];
        assert_eq!(ack.state, AckState::Saved);
        assert_eq!(ack.token_valid, Some(false));
    }

    #[test]
    fn undo_toast_is_a_plain_slot() {
        let mut ui = UiState::default();
        ui.set_undo_toast(Some(UndoToast {
            machine: "m".into(),
            session_id: "s1".into(),
            label: "One".into(),
        }));
        assert!(ui.undo_toast.is_some());
        ui.set_undo_toast(None);
        assert_eq!(ui.undo_toast, None);
    }
}
