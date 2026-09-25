//! `UniffiIntent` — a hand-mapped, deliberately partial mirror of
//! `client_runtime::intent::Intent` covering exactly the actions the Android
//! app drives.
//!
//! This is a disclosed narrowing, not an oversight: `uniffi::Enum` is
//! all-or-nothing for the whole enum it's derived on, and the real `Intent`
//! has 49 variants — the ones still excluded here (the DM/Marmot intents,
//! the DM-image path, a few settings intents) carry payloads that would need
//! their own UniFFI derive rollout, disproportionate while no Android screen
//! uses them. Every other boundary type this crate touches
//! (`CoreEvent`, `ConnectionView`) is the REAL `client_runtime` type — see
//! that crate's `uniffi` feature — so this file is the one place with
//! parallel DTOs, and it grows (never shrinks) as the app wires more of the
//! core.
//!
//! Wire enums (e.g. `SetOption`'s `option`) cross as plain strings (Kotlin
//! has no reason to see a Rust enum type here) and are parsed via the SAME
//! `Deserialize` impl the wire protocol itself uses rather than a
//! hand-duplicated match — a typo lands as a clear `UniffiIntentError`, not a
//! silent wrong mapping. Agent-defined values (modes, efforts, models) are
//! plain ids the bridge validates.

use client_runtime::intent::{Intent, SessionImageSend};
use protocol::commands::{ProviderProfileWrite, QuestionAnswer};
use protocol::common::{CredentialValues, ProviderModel, SessionOption};
use protocol::tristate::Tristate;

/// A UniFFI-crossable mirror of [`protocol::tristate::Tristate`] — see that
/// type's own doc comment for the keep/clear/set semantics this preserves.
/// `uniffi::Enum` needs a concrete Rust type (no generics), hence the `String`
/// payload rather than reusing `Tristate<T>` directly; every current use
/// (`SetCredentials`, `SetProviderProfile`'s `auth_token`) is string-valued on
/// the wire.
#[derive(Clone, uniffi::Enum)]
pub enum UniffiTristate {
    Keep,
    Clear,
    Set { value: String },
}

/// Redacted like `Tristate`'s own `Debug`: the value is always a secret.
impl std::fmt::Debug for UniffiTristate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UniffiTristate::Keep => f.write_str("Keep"),
            UniffiTristate::Clear => f.write_str("Clear"),
            UniffiTristate::Set { .. } => f.write_str("Set { value: <redacted> }"),
        }
    }
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

/// One credential write for `SetCredentials`: set (`Set`) or clear (`Clear`)
/// the credential `id`; `Keep` entries are dropped (an id not sent is kept).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiCredentialWrite {
    pub id: String,
    pub value: UniffiTristate,
}

/// The wire's `values` map: `Set` → the secret, `Clear` → `null`, `Keep` →
/// omitted.
fn credential_values(writes: Vec<UniffiCredentialWrite>) -> CredentialValues {
    writes
        .into_iter()
        .filter_map(|w| match w.value {
            UniffiTristate::Keep => None,
            UniffiTristate::Clear => Some((w.id, None)),
            UniffiTristate::Set { value } => Some((w.id, Some(value))),
        })
        .collect()
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
    /// Attach an image to `session_id`'s next input (CDX-029). The loop
    /// uploads it to the configured Blossom server through the `UniffiHttpFetch`
    /// port, falling back to relay chunks, then publishes the `upload-image`
    /// command — no outbox item, no local echo (the transcript shows it once
    /// the bridge injects it, like any other output).
    SendSessionImage {
        machine: String,
        session_id: String,
        /// Caption carried on the input the bridge runs after the upload.
        text: String,
        /// Raw image bytes (a Kotlin `ByteArray` across the FFI).
        image: Vec<u8>,
        filename: String,
        /// IANA media type of `image` (e.g. `"image/png"`), forwarded to the
        /// bridge verbatim — the attachment command carries it as-is.
        mime_type: String,
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
    /// Start a session on `agent` (a `UniffiAgent.id` the machine advertises).
    /// `mode` / `effort` are agent-defined ids; absent = the agent's default.
    CreateSession {
        machine: String,
        agent: String,
        cwd: Option<String>,
        create_cwd: Option<bool>,
        mode: Option<String>,
        effort: Option<String>,
        model: Option<String>,
        provider_id: Option<String>,
    },
    /// Ask the bridge for `agent`'s live model list; the answer lands in the
    /// machine's `models` entry for that agent.
    RequestModels {
        machine: String,
        agent: String,
    },
    /// Ask the bridge for this session's usage snapshot (limit windows, cost);
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
    /// Store credentials on the bridge host (CDX-011) for `agent`, or for the
    /// bridge itself when `None`. Ids not listed are kept. Secrets: never
    /// logged.
    SetCredentials {
        machine: String,
        agent: Option<String>,
        values: Vec<UniffiCredentialWrite>,
    },
    /// Upsert (`profile: Some`) or delete (`profile: None`) one custom
    /// provider profile stored bridge-side (CDX-062).
    SetProviderProfile {
        machine: String,
        profile_id: String,
        profile: Option<UniffiProviderProfileWrite>,
    },
    /// Answer a permission request with one of its options' ids.
    RespondPermission {
        machine: String,
        session_id: String,
        request_id: String,
        option_id: String,
    },
    /// Answer question `index` of the ask `request_id`: free `text` when
    /// present, otherwise the `selected` option indices.
    AnswerQuestion {
        machine: String,
        session_id: String,
        request_id: String,
        index: u32,
        selected: Vec<u32>,
        text: Option<String>,
    },
    /// Answer a plan approval with one of its options' ids.
    RespondPlan {
        machine: String,
        session_id: String,
        request_id: String,
        option_id: String,
    },
    /// Change a session option: `option` is `"mode"` / `"effort"` /
    /// `"model"`, `value` an id the session's agent advertises (or a model id).
    SetOption {
        machine: String,
        session_id: String,
        option: String,
        value: String,
    },
    /// Selects (or, with `session_id: None`, deselects) a session in
    /// the shared `UiView` — the sidebar's tap-to-open and the shell's
    /// "no selection" empty state both read `UiView::selected_session` back.
    SelectSession {
        machine: String,
        session_id: Option<String>,
    },
    /// Records which plan-approval option the user tapped so the
    /// resolved `PlanApprovalCard` can label itself. Sent ALONGSIDE the
    /// actual answer (`RespondPlan`), not
    /// instead of it — same contract the TS `PlanApprovalCard.tsx` had.
    SetPlanApprovalChoice {
        card_id: String,
        key: String,
    },
    /// `OutboxRow`'s Retry button — re-publishes the same signed
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
    /// Preferred mode for new sessions — an agent mode id; `""` = the agent's default.
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
            UniffiIntent::SendSessionImage { machine, session_id, text, image, filename, mime_type } => {
                Intent::SendSessionImage(SessionImageSend {
                    machine,
                    session_id,
                    text,
                    image,
                    filename,
                    mime_type,
                })
            }
            UniffiIntent::Interrupt { machine, session_id } => Intent::Interrupt { machine, session_id },
            UniffiIntent::CloseSession { machine, session_id } => Intent::CloseSession { machine, session_id },
            UniffiIntent::RefreshSessions { machine } => Intent::RefreshSessions { machine },
            UniffiIntent::CreateSession {
                machine,
                agent,
                cwd,
                create_cwd,
                mode,
                effort,
                model,
                provider_id,
            } => Intent::CreateSession {
                machine,
                agent,
                cwd,
                create_cwd,
                mode,
                effort,
                model,
                provider_id,
                test_session: None,
            },
            UniffiIntent::RequestModels { machine, agent } => Intent::RequestModels { machine, agent },
            UniffiIntent::RequestUsage { machine, session_id } => {
                Intent::RequestUsage { machine, session_id }
            }
            UniffiIntent::RequestGsd { machine, session_id } => {
                Intent::RequestGsd { machine, session_id }
            }
            UniffiIntent::RequestProviderProfiles { machine } => Intent::RequestProviderProfiles { machine },
            UniffiIntent::SetCredentials { machine, agent, values } => Intent::SetCredentials {
                machine,
                agent,
                values: credential_values(values),
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
            UniffiIntent::RespondPermission { machine, session_id, request_id, option_id } => {
                Intent::RespondPermission { machine, session_id, request_id, option_id }
            }
            UniffiIntent::AnswerQuestion { machine, session_id, request_id, index, selected, text } => {
                Intent::AnswerQuestion {
                    machine,
                    session_id,
                    request_id,
                    index,
                    answer: match text {
                        Some(text) => QuestionAnswer::Text { text },
                        None => QuestionAnswer::Options { selected },
                    },
                }
            }
            UniffiIntent::RespondPlan { machine, session_id, request_id, option_id } => {
                Intent::RespondPlan { machine, session_id, request_id, option_id }
            }
            UniffiIntent::SetOption { machine, session_id, option, value } => Intent::SetOption {
                machine,
                session_id,
                option: parse_enum::<SessionOption>("option", &option)?,
                value,
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
            UniffiIntent::SetDefaultMode { mode } => Intent::SetDefaultMode(mode),
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
    fn send_session_image_maps_field_for_field() {
        let intent = UniffiIntent::SendSessionImage {
            machine: "m".into(),
            session_id: "s".into(),
            text: "look at this".into(),
            image: vec![0x89, b'P', b'N', b'G'],
            filename: "cat.png".into(),
            mime_type: "image/png".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SendSessionImage(SessionImageSend {
                machine: "m".into(),
                session_id: "s".into(),
                text: "look at this".into(),
                image: vec![0x89, b'P', b'N', b'G'],
                filename: "cat.png".into(),
                mime_type: "image/png".into(),
            })
        );
    }

    #[test]
    fn set_option_parses_the_same_wire_spelling_the_protocol_uses() {
        let intent = UniffiIntent::SetOption {
            machine: "m".into(),
            session_id: "s".into(),
            option: "mode".into(),
            value: "acceptEdits".into(),
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetOption {
                machine: "m".into(),
                session_id: "s".into(),
                option: SessionOption::Mode,
                value: "acceptEdits".into(),
            }
        );
    }

    #[test]
    fn an_unrecognized_option_is_a_clear_error_not_a_panic_or_silent_default() {
        let intent = UniffiIntent::SetOption {
            machine: "m".into(),
            session_id: "s".into(),
            option: "temperature".into(),
            value: "1".into(),
        };
        let err = Intent::try_from(intent).unwrap_err();
        assert!(matches!(err, UniffiIntentError::BadEnumValue { .. }));
    }

    #[test]
    fn set_credentials_sends_set_and_clear_and_drops_keep() {
        let intent = UniffiIntent::SetCredentials {
            machine: "m".into(),
            agent: Some("claude-code".into()),
            values: vec![
                UniffiCredentialWrite { id: "anthropic_api_key".into(), value: UniffiTristate::Set { value: "sk-ant-1".into() } },
                UniffiCredentialWrite { id: "old".into(), value: UniffiTristate::Clear },
                UniffiCredentialWrite { id: "untouched".into(), value: UniffiTristate::Keep },
            ],
        };
        let mapped: Intent = intent.try_into().unwrap();
        assert_eq!(
            mapped,
            Intent::SetCredentials {
                machine: "m".into(),
                agent: Some("claude-code".into()),
                values: [
                    ("anthropic_api_key".to_string(), Some("sk-ant-1".to_string())),
                    ("old".to_string(), None),
                ]
                .into(),
            }
        );
    }

    #[test]
    fn answer_question_is_text_when_given_else_the_selected_options() {
        let text: Intent = UniffiIntent::AnswerQuestion {
            machine: "m".into(),
            session_id: "s".into(),
            request_id: "q".into(),
            index: 1,
            selected: vec![],
            text: Some("blue".into()),
        }
        .try_into()
        .unwrap();
        assert!(matches!(
            text,
            Intent::AnswerQuestion { index: 1, answer: QuestionAnswer::Text { ref text }, .. } if text == "blue"
        ));
        let picked: Intent = UniffiIntent::AnswerQuestion {
            machine: "m".into(),
            session_id: "s".into(),
            request_id: "q".into(),
            index: 0,
            selected: vec![0, 2],
            text: None,
        }
        .try_into()
        .unwrap();
        assert!(matches!(
            picked,
            Intent::AnswerQuestion { answer: QuestionAnswer::Options { ref selected }, .. } if *selected == vec![0, 2]
        ));
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
}
