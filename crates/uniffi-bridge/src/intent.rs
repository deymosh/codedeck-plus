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
use protocol::commands::{KeypressContext, PermissionModifier};
use protocol::common::PermissionMode;

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
    CreateSession {
        machine: String,
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
            UniffiIntent::CreateSession { machine } => Intent::CreateSession {
                machine,
                cwd: None,
                create_cwd: None,
                model: None,
                default_effort: None,
                provider_id: None,
                test_session: None,
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
            UniffiIntent::SelectSession { machine, session_id } => {
                Intent::SelectSession { machine, session_id }
            }
            UniffiIntent::SetPlanApprovalChoice { card_id, key } => {
                Intent::SetPlanApprovalChoice { card_id, key }
            }
            UniffiIntent::RetryOutboxItem { machine, id } => Intent::RetryOutboxItem { machine, id },
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
}
