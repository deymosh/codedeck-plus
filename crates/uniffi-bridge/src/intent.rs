//! `UniffiIntent` — a hand-mapped, deliberately partial mirror of
//! `client_runtime::intent::Intent` for the surface F3's first vertical slice
//! actually drives (send input, interrupt, close/refresh/create a session,
//! respond to a permission/question/keypress card, change mode).
//!
//! This is a disclosed narrowing, not an oversight: `uniffi::Enum` is
//! all-or-nothing for the whole enum it's derived on, and the real `Intent`
//! has 49 variants, several carrying `protocol` wire payloads (e.g.
//! `SendSessionImage(SessionImageSend)`, `SetProviderProfile`'s tristate
//! writes) that would need their own UniFFI derive rollout disproportionate
//! to what F3 needs today. Every other boundary type this crate touches
//! (`CoreEvent`, `ConnectionView`) is the REAL `client_runtime` type — see
//! that crate's `uniffi` feature — so this file is the one place with
//! parallel DTOs, and it grows (never shrinks) as later F3/F4 milestones
//! wire more of the app.
//!
//! `mode`/`modifier`/`context` cross as plain strings (Kotlin has no reason
//! to see a Rust enum type here) and are parsed via the SAME `Deserialize`
//! impl the wire protocol itself uses (`protocol::common::PermissionMode` et
//! al.) rather than a hand-duplicated match — a typo lands as a clear
//! `UniffiIntentError`, not a silent wrong mapping.

use client_runtime::intent::Intent;
use protocol::commands::{KeypressContext, PermissionModifier, ProviderProfileWrite};
use protocol::common::{EffortLevel, PermissionMode, ProviderModel, SessionBackend};
use protocol::tristate::Tristate;

/// A UniFFI-crossable mirror of [`protocol::tristate::Tristate`] — see that
/// type's own doc comment for the keep/clear/set semantics this preserves.
/// `uniffi::Enum` needs a concrete Rust type (no generics), hence the `String`
/// payload rather than reusing `Tristate<T>` directly; every current use
/// (`SetCredentials`, `SetProviderProfile`'s `auth_token`) is string-valued on
/// the wire.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum UniffiTristate {
    Keep,
    Clear,
    Set { value: String },
}

impl From<UniffiTristate> for Tristate<String> {
    fn from(t: UniffiTristate) -> Self {
        match t {
            UniffiTristate::Keep => Tristate::Keep,
            UniffiTristate::Clear => Tristate::Clear,
            UniffiTristate::Set { value } => Tristate::Set(value),
        }
    }
}

/// UniFFI-crossable mirror of [`protocol::common::ProviderModel`] — a plain
/// data record, so this is a straight field-for-field copy rather than a
/// narrowing.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderModelWrite {
    pub id: String,
    pub label: Option<String>,
}

/// UniFFI-crossable mirror of [`protocol::commands::ProviderProfileWrite`].
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderProfileWrite {
    pub label: String,
    pub base_url: String,
    pub auth_token: UniffiTristate,
    pub models: Vec<UniffiProviderModelWrite>,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum UniffiIntent {
    SendInput {
        machine: String,
        session_id: String,
        text: String,
        input_id: String,
    },
    Interrupt {
        machine: String,
        session_id: String,
    },
    CloseSession {
        machine: String,
        session_id: String,
    },
    RefreshSessions {
        machine: String,
    },
    /// `backend`: `"claude-code"` / `"opencode"` / absent (defaults to Claude
    /// Code) — see this module's doc comment for why wire enums cross as
    /// plain strings. Send `"opencode"` only when the machine's
    /// `capabilities` includes `"opencode"`.
    CreateSession {
        machine: String,
        cwd: Option<String>,
        create_cwd: Option<bool>,
        model: Option<String>,
        /// `"low"` / `"medium"` / `"high"` / `"xhigh"` / `"max"` — the wire's
        /// own spelling, same convention as `mode`.
        default_effort: Option<String>,
        provider_id: Option<String>,
        backend: Option<String>,
    },
    /// Ask the bridge for a backend's live supported-model list; the answer
    /// lands in the matching `UniffiMachineSummary` field (`models` /
    /// `open_code_models`).
    RequestModels {
        machine: String,
        backend: Option<String>,
    },
    /// Ask the bridge for this session's usage snapshot (5h/7d limits, cost);
    /// the answer lands in `UniffiSessionSummary.usage`.
    RequestUsage {
        machine: String,
        session_id: String,
    },
    /// Ask the bridge for this session's GSD workflow state; the answer
    /// lands in `UniffiSessionSummary.gsd`.
    RequestGsd {
        machine: String,
        session_id: String,
    },
    RequestProviderProfiles {
        machine: String,
    },
    /// Store credentials on the bridge host (CDX-011). Secrets: never logged.
    SetCredentials {
        machine: String,
        anthropic_api_key: UniffiTristate,
        github_pat: UniffiTristate,
    },
    /// Upsert (`profile: Some`) or delete (`profile: None`) one custom
    /// provider profile stored bridge-side (CDX-062).
    SetProviderProfile {
        machine: String,
        profile_id: String,
        profile: Option<UniffiProviderProfileWrite>,
    },
    RespondPermission {
        machine: String,
        session_id: String,
        request_id: String,
        allow: bool,
        /// `"always"` / `"never"` / absent — see this module's doc comment.
        modifier: Option<String>,
    },
    AnswerQuestion {
        machine: String,
        session_id: String,
        text: String,
        option_count: u64,
    },
    Keypress {
        machine: String,
        session_id: String,
        key: String,
        /// `"plan-approval"` / `"question"` / absent.
        context: Option<String>,
    },
    SetMode {
        machine: String,
        session_id: String,
        /// `"default"` / `"acceptEdits"` / `"plan"` — the wire's own spelling.
        mode: String,
    },
    /// Session-level effort change — distinct from the global-settings
    /// `SetDefaultEffort` below. `level`: `"low"` / `"medium"` / `"high"` /
    /// `"xhigh"` / `"max"` / `"auto"` — the wire's own spelling, same
    /// convention as `mode`.
    SetEffort {
        machine: String,
        session_id: String,
        level: String,
    },
    /// F3.3: selects (or, with `session_id: None`, deselects) a session in
    /// the shared `UiView` — the sidebar's tap-to-open and the shell's
    /// "no selection" empty state both read `UiView::selected_session` back.
    SelectSession {
        machine: String,
        session_id: Option<String>,
    },
    /// F3.3: records which plan-approval option the user tapped so the
    /// resolved `PlanApprovalCard` can label itself. Sent ALONGSIDE the
    /// actual answer (`Keypress` with `context: "plan-approval"`), not
    /// instead of it — same contract the TS `PlanApprovalCard.tsx` had.
    SetPlanApprovalChoice {
        card_id: String,
        key: String,
    },
    /// F3.3.5: `OutboxRow`'s Retry button — re-publishes the same signed
    /// event (idempotent; the bridge dedupes by id), not a fresh send.
    RetryOutboxItem {
        machine: String,
        id: String,
    },
    /// Optimistic delete: the session leaves the sidebar immediately and a
    /// 4 s undo toast opens (read it back from `UniffiUiView.undo_toast`).
    /// The actual close-session only reaches the bridge once the window
    /// expires. `label` is the toast text; it falls back to the session
    /// title / slug when absent.
    DeleteSession {
        machine: String,
        session_id: String,
        label: Option<String>,
    },
    /// Cancel a still-open delete window: the deleted session is restored,
    /// the toast hides, and no close-session is ever sent.
    UndoDelete,
    AddRelay {
        url: String,
    },
    RemoveRelay {
        url: String,
    },
    SetTorEnabled {
        enabled: bool,
    },
    SetStayConnected {
        enabled: bool,
    },
    SetBlossomServer {
        url: String,
    },
    SetNotificationsEnabled {
        enabled: bool,
    },
    /// `"default"` / `"acceptEdits"` / `"plan"` — same wire spelling as `SetMode`.
    SetDefaultMode {
        mode: String,
    },
    SetDefaultEffort {
        level: String,
    },
    SetDefaultModel {
        model: String,
    },
    SetUiScale {
        scale: f64,
    },
    SetShowUsageBadge {
        enabled: bool,
    },
    SetShowCommitBadge {
        enabled: bool,
    },
    AddQuickPrompt {
        id: String,
        label: String,
        text: String,
    },
    UpdateQuickPrompt {
        id: String,
        label: String,
        text: String,
    },
    RemoveQuickPrompt {
        id: String,
    },
    /// User dismisses a failed pending-session card. A failed placeholder
    /// stays visible until dismissed (see `UniffiPendingSessionsView`).
    DismissPendingSession {
        pending_id: String,
    },
    RemoveMachine {
        pubkey_hex: String,
    },
    /// Send a `pair-request` for a scanned/pasted `codedeck://pair` URL.
    BeginPairing {
        url: String,
        label: String,
    },
    /// Manual npub + token fallback.
    BeginManualPairing {
        npub: String,
        token: String,
        label: String,
    },
    /// CDX-013: stage a deep-link URL for explicit confirmation before
    /// dispatching the actual pair request.
    StagePairing {
        url: String,
    },
    ConfirmStagedPairing {
        label: String,
    },
    DismissStagedPairing,
    ResetPairing,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UniffiIntentError {
    #[error("not a recognized value for this field: {detail}")]
    BadEnumValue { detail: String },
}

fn parse_enum<T: serde::de::DeserializeOwned>(field: &str, s: &str) -> Result<T, UniffiIntentError> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).map_err(|_| UniffiIntentError::BadEnumValue {
        detail: format!("{field}: {s:?}"),
    })
}

impl TryFrom<UniffiIntent> for Intent {
    type Error = UniffiIntentError;

    fn try_from(i: UniffiIntent) -> Result<Self, Self::Error> {
        Ok(match i {
            UniffiIntent::SendInput { machine, session_id, text, input_id } => {
                Intent::SendInput { machine, session_id, text, input_id }
            }
            UniffiIntent::Interrupt { machine, session_id } => Intent::Interrupt { machine, session_id },
            UniffiIntent::CloseSession { machine, session_id } => Intent::CloseSession { machine, session_id },
            UniffiIntent::RefreshSessions { machine } => Intent::RefreshSessions { machine },
            UniffiIntent::CreateSession {
                machine,
                cwd,
                create_cwd,
                model,
                default_effort,
                provider_id,
                backend,
            } => Intent::CreateSession {
                machine,
                cwd,
                create_cwd,
                model,
                default_effort: default_effort.map(|e| parse_enum::<EffortLevel>("default_effort", &e)).transpose()?,
                provider_id,
                test_session: None,
                backend: backend.map(|b| parse_enum::<SessionBackend>("backend", &b)).transpose()?,
            },
            UniffiIntent::RequestModels { machine, backend } => Intent::RequestModels {
                machine,
                backend: backend.map(|b| parse_enum::<SessionBackend>("backend", &b)).transpose()?,
            },
            UniffiIntent::RequestUsage { machine, session_id } => {
                Intent::RequestUsage { machine, session_id }
            }
            UniffiIntent::RequestGsd { machine, session_id } => {
                Intent::RequestGsd { machine, session_id }
            }
            UniffiIntent::RequestProviderProfiles { machine } => Intent::RequestProviderProfiles { machine },
            UniffiIntent::SetCredentials { machine, anthropic_api_key, github_pat } => Intent::SetCredentials {
                machine,
                anthropic_api_key: anthropic_api_key.into(),
                github_pat: github_pat.into(),
            },
            UniffiIntent::SetProviderProfile { machine, profile_id, profile } => Intent::SetProviderProfile {
                machine,
                profile_id,
                profile: profile.map(|p| ProviderProfileWrite {
                    label: p.label,
                    base_url: p.base_url,
                    auth_token: p.auth_token.into(),
                    models: p.models.into_iter().map(|m| ProviderModel { id: m.id, label: m.label }).collect(),
                    default_model: p.default_model,
                }),
            },
            UniffiIntent::RespondPermission { machine, session_id, request_id, allow, modifier } => {
                Intent::RespondPermission {
                    machine,
                    session_id,
                    request_id,
                    allow,
                    modifier: modifier.map(|m| parse_enum::<PermissionModifier>("modifier", &m)).transpose()?,
                }
            }
            UniffiIntent::AnswerQuestion { machine, session_id, text, option_count } => Intent::AnswerQuestion {
                machine,
                session_id,
                text,
                option_count,
            },
            UniffiIntent::Keypress { machine, session_id, key, context } => Intent::Keypress {
                machine,
                session_id,
                key,
                context: context.map(|c| parse_enum::<KeypressContext>("context", &c)).transpose()?,
            },
            UniffiIntent::SetMode { machine, session_id, mode } => Intent::SetMode {
                machine,
                session_id,
                mode: parse_enum::<PermissionMode>("mode", &mode)?,
            },
            UniffiIntent::SetEffort { machine, session_id, level } => Intent::SetEffort {
                machine,
                session_id,
                level: parse_enum::<EffortLevel>("level", &level)?,
            },
            UniffiIntent::SelectSession { machine, session_id } => {
                Intent::SelectSession { machine, session_id }
            }
            UniffiIntent::SetPlanApprovalChoice { card_id, key } => {
                Intent::SetPlanApprovalChoice { card_id, key }
            }
            UniffiIntent::RetryOutboxItem { machine, id } => Intent::RetryOutboxItem { machine, id },
            UniffiIntent::DeleteSession { machine, session_id, label } => {
                Intent::DeleteSession { machine, session_id, label }
            }
            UniffiIntent::UndoDelete => Intent::UndoDelete,
            UniffiIntent::AddRelay { url } => Intent::AddRelay { url },
            UniffiIntent::RemoveRelay { url } => Intent::RemoveRelay { url },
            UniffiIntent::SetTorEnabled { enabled } => Intent::SetTorEnabled(enabled),
            UniffiIntent::SetStayConnected { enabled } => Intent::SetStayConnected(enabled),
            UniffiIntent::SetBlossomServer { url } => Intent::SetBlossomServer(url),
            UniffiIntent::SetNotificationsEnabled { enabled } => Intent::SetNotificationsEnabled(enabled),
            UniffiIntent::SetDefaultMode { mode } => {
                Intent::SetDefaultMode(parse_enum::<PermissionMode>("mode", &mode)?)
            }
            UniffiIntent::SetDefaultEffort { level } => Intent::SetDefaultEffort(level),
            UniffiIntent::SetDefaultModel { model } => Intent::SetDefaultModel(model),
            UniffiIntent::SetUiScale { scale } => Intent::SetUiScale(scale),
            UniffiIntent::SetShowUsageBadge { enabled } => Intent::SetShowUsageBadge(enabled),
            UniffiIntent::SetShowCommitBadge { enabled } => Intent::SetShowCommitBadge(enabled),
            UniffiIntent::AddQuickPrompt { id, label, text } => Intent::AddQuickPrompt { id, label, text },
            UniffiIntent::UpdateQuickPrompt { id, label, text } => Intent::UpdateQuickPrompt { id, label, text },
            UniffiIntent::RemoveQuickPrompt { id } => Intent::RemoveQuickPrompt { id },
            UniffiIntent::DismissPendingSession { pending_id } => {
                Intent::DismissPendingSession { pending_id }
            }
            UniffiIntent::RemoveMachine { pubkey_hex } => Intent::RemoveMachine { pubkey_hex },
            UniffiIntent::BeginPairing { url, label } => Intent::BeginPairing { url, label },
            UniffiIntent::BeginManualPairing { npub, token, label } => {
                Intent::BeginManualPairing { npub, token, label }
            }
            UniffiIntent::StagePairing { url } => Intent::StagePairing { url },
            UniffiIntent::ConfirmStagedPairing { label } => Intent::ConfirmStagedPairing { label },
            UniffiIntent::DismissStagedPairing => Intent::DismissStagedPairing,
            UniffiIntent::ResetPairing => Intent::ResetPairing,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_input_maps_field_for_field() {
        let intent = UniffiIntent::SendInput {
            machine: "m".into(),
            session_id: "s".into(),
            text: "hi".into(),
            input_id: "i1".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SendInput {
                machine: "m".into(),
                session_id: "s".into(),
                text: "hi".into(),
                input_id: "i1".into(),
            }
        );
    }

    #[test]
    fn set_mode_parses_the_same_wire_spelling_the_protocol_uses() {
        let intent = UniffiIntent::SetMode {
            machine: "m".into(),
            session_id: "s".into(),
            mode: "acceptEdits".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetMode {
                machine: "m".into(),
                session_id: "s".into(),
                mode: PermissionMode::AcceptEdits,
            }
        );
    }

    #[test]
    fn an_unrecognized_mode_string_is_a_clear_error_not_a_panic_or_silent_default() {
        let intent = UniffiIntent::SetMode {
            machine: "m".into(),
            session_id: "s".into(),
            mode: "not-a-real-mode".into(),
        };
        let err = Intent::try_from(intent).unwrap_err();
        assert!(matches!(err, UniffiIntentError::BadEnumValue { .. }));
    }

    #[test]
    fn set_credentials_keep_clear_set_round_trip() {
        let intent = UniffiIntent::SetCredentials {
            machine: "m".into(),
            anthropic_api_key: UniffiTristate::Set { value: "sk-ant-1".into() },
            github_pat: UniffiTristate::Clear,
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetCredentials {
                machine: "m".into(),
                anthropic_api_key: Tristate::Set("sk-ant-1".into()),
                github_pat: Tristate::Clear,
            }
        );

        let kept: Intent = UniffiIntent::SetCredentials {
            machine: "m".into(),
            anthropic_api_key: UniffiTristate::Keep,
            github_pat: UniffiTristate::Keep,
        }
        .try_into()
        .unwrap();
        assert_eq!(
            kept,
            Intent::SetCredentials {
                machine: "m".into(),
                anthropic_api_key: Tristate::Keep,
                github_pat: Tristate::Keep,
            }
        );
    }

    #[test]
    fn set_provider_profile_upsert_maps_field_for_field() {
        let intent = UniffiIntent::SetProviderProfile {
            machine: "m".into(),
            profile_id: "kimi-k3".into(),
            profile: Some(UniffiProviderProfileWrite {
                label: "Kimi K3".into(),
                base_url: "https://api.moonshot.ai/anthropic".into(),
                auth_token: UniffiTristate::Set { value: "sk-1".into() },
                models: vec![UniffiProviderModelWrite { id: "kimi-k3".into(), label: Some("Kimi K3".into()) }],
                default_model: Some("kimi-k3".into()),
            }),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetProviderProfile {
                machine: "m".into(),
                profile_id: "kimi-k3".into(),
                profile: Some(ProviderProfileWrite {
                    label: "Kimi K3".into(),
                    base_url: "https://api.moonshot.ai/anthropic".into(),
                    auth_token: Tristate::Set("sk-1".into()),
                    models: vec![ProviderModel { id: "kimi-k3".into(), label: Some("Kimi K3".into()) }],
                    default_model: Some("kimi-k3".into()),
                }),
            }
        );
    }

    #[test]
    fn set_provider_profile_none_maps_to_delete() {
        let intent = UniffiIntent::SetProviderProfile {
            machine: "m".into(),
            profile_id: "kimi-k3".into(),
            profile: None,
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(mapped, Intent::SetProviderProfile { machine: "m".into(), profile_id: "kimi-k3".into(), profile: None });
    }

    #[test]
    fn delete_session_maps_field_for_field() {
        let intent = UniffiIntent::DeleteSession {
            machine: "m".into(),
            session_id: "s".into(),
            label: Some("Deleted the-slug".into()),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::DeleteSession {
                machine: "m".into(),
                session_id: "s".into(),
                label: Some("Deleted the-slug".into()),
            }
        );
    }

    #[test]
    fn undo_delete_maps_to_the_unit_variant() {
        let mapped: Intent = UniffiIntent::UndoDelete.try_into().unwrap();
        assert_eq!(mapped, Intent::UndoDelete);
    }

    #[test]
    fn dismiss_pending_session_maps_field_for_field() {
        let intent = UniffiIntent::DismissPendingSession { pending_id: "p1".into() };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(mapped, Intent::DismissPendingSession { pending_id: "p1".into() });
    }

    #[test]
    fn set_effort_parses_the_same_wire_spelling_the_protocol_uses() {
        let intent = UniffiIntent::SetEffort {
            machine: "m".into(),
            session_id: "s".into(),
            level: "xhigh".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetEffort {
                machine: "m".into(),
                session_id: "s".into(),
                level: EffortLevel::Xhigh,
            }
        );
    }

    #[test]
    fn an_unrecognized_effort_level_is_a_clear_error_not_a_panic_or_silent_default() {
        let intent = UniffiIntent::SetEffort {
            machine: "m".into(),
            session_id: "s".into(),
            level: "not-a-real-level".into(),
        };
        let err = Intent::try_from(intent).unwrap_err();
        assert!(matches!(err, UniffiIntentError::BadEnumValue { .. }));
    }

    #[test]
    fn request_usage_maps_field_for_field() {
        let intent = UniffiIntent::RequestUsage {
            machine: "m".into(),
            session_id: "s".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(mapped, Intent::RequestUsage { machine: "m".into(), session_id: "s".into() });
    }

    #[test]
    fn request_gsd_maps_field_for_field() {
        let intent = UniffiIntent::RequestGsd {
            machine: "m".into(),
            session_id: "s".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(mapped, Intent::RequestGsd { machine: "m".into(), session_id: "s".into() });
    }
}
