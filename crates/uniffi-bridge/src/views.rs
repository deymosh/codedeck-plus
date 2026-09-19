//! Narrowed, hand-mapped view DTOs for the Android FFI surface — the same
//! disclosed-narrowing precedent `intent.rs`'s `UniffiIntent` already set.
//! UniFFI's `Record` derive needs concrete, homogeneously-typed fields, but
//! several real view types either carry arbitrary JSON
//! (`TranscriptRowView.entry` is `serde_json::Value` — `OutputEntry.metadata`
//! is genuinely untyped bridge-supplied JSON) or fields no Android screen has
//! a use for yet (`UiView`'s device-config map is Mesh territory — the
//! `SetDeviceConfig` test loop — deferred with the rest of it;
//! `SettingsData`'s `mesh_test_target` likewise — Mesh is F6, off by default,
//! out of this crate's scope). The rest of `UiView` this surface needs IS
//! projected: the credentials/provider-profile status maps — see
//! `UniffiCredentialsAck`/`UniffiProviderProfileAck` below — and the undo
//! toast + unread set — see `UniffiUndoToast`/`UniffiUiView.unread_sessions`
//! (the undo toast is the delete-controller's, nothing to do with Mesh).
//! Rather
//! than deriving `uniffi::Record` on those real types
//! — which would drag every transitive field into the FFI surface whether a
//! screen exists for it or not — this module hand-builds a small,
//! Android-specific projection of each, grown as later milestones need more
//! of it, never widened "just in case" the way `UniffiIntent`'s own doc
//! comment already commits to for the intent side.
//!
//! `TranscriptRowsView`'s crossing goes one step further: `client_core`'s
//! `presentation::display_entries` module (already a complete, already-tested
//! port of `apps/mobile/src/ui/transcript/displayEntries.ts` — grouping,
//! answered-state detection, the pending-permission finder — but unwired
//! into any view until now) computes the *grouped* rows here, once, so
//! Android never re-implements that algorithm. The grouped list and the
//! pending-permission summary cross as JSON strings (`serde_json::to_string`)
//! for the same untyped-metadata reason individual rows already needed to;
//! Kotlin's `DisplayEntries.kt` is a `kotlinx.serialization` sealed-class
//! mirror + a `Json.decodeFromString` call, not a second implementation of
//! the grouping logic.

use std::collections::{BTreeSet, HashMap};

use client_runtime::client_core::notifications::session_key_of;
use client_runtime::client_core::presentation::display_entries::{
    build_display_entries, find_pending_permission, SeqEntry,
};
use client_runtime::{
    MachinesView, OutboxView, PairingView, PendingSessionsView, QuickPromptsView, SettingsView,
    TranscriptRowsView, UiView,
};
use protocol::common::{GsdAction, GsdExecution, GsdPhase, GsdState, UsageData, UsageWindow};

/// Renders any `Copy` wire enum (all `#[serde(rename_all = ...)]`, no data)
/// to its exact wire spelling by reusing the real `Serialize` impl, the same
/// way `intent.rs`'s `parse_enum` reuses the real `Deserialize` impl instead
/// of hand-duplicating a match per enum.
fn wire_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_string))
        .unwrap_or_default()
}

// --- machines / sessions -------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub slug: String,
    pub cwd: String,
    pub project: String,
    /// `idle` / `running` / `waiting_permission` / `waiting_question` /
    /// `offline` (`SessionState`'s own `snake_case` wire spelling), absent if
    /// the bridge never reported one.
    pub state: Option<String>,
    /// `live` / `stale` / `offline` — the machines store's own listing presence.
    pub presence: String,
    pub last_activity: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort_level: Option<String>,
    pub context_percentage: Option<f64>,
    pub context_window: Option<u64>,
    pub committed: Option<bool>,
    pub seq_high: Option<u64>,
    /// Usage snapshot (5h/7d limits, cost) — requested via
    /// `UniffiIntent::RequestUsage`, absent until the bridge answers.
    pub usage: Option<UniffiUsageData>,
    /// GSD workflow state — requested via `UniffiIntent::RequestGsd`,
    /// absent until the bridge answers.
    pub gsd: Option<UniffiGsdState>,
}

/// One usage-limit window (5h / 7d / …) — mirrors
/// `protocol::common::UsageWindow` field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUsageWindow {
    /// 0.0..=1.0; `None` when the bridge has no number.
    pub utilization: Option<f64>,
    /// When the window resets (the wire's own timestamp spelling).
    pub resets_at: Option<String>,
}

/// A session's usage snapshot — mirrors `protocol::common::UsageData` field
/// for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUsageData {
    pub available: bool,
    pub subscription_type: Option<String>,
    pub five_hour: Option<UniffiUsageWindow>,
    pub seven_day: Option<UniffiUsageWindow>,
    pub seven_day_opus: Option<UniffiUsageWindow>,
    pub seven_day_sonnet: Option<UniffiUsageWindow>,
    pub session_cost_usd: Option<f64>,
    pub fetched_at: String,
}

/// One GSD workflow phase — mirrors `protocol::common::GsdPhase` field for
/// field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdPhase {
    pub number: String,
    pub name: String,
    pub disk_status: String,
    pub plans: u64,
    pub summaries: u64,
    pub recently_touched: bool,
    pub action: Option<String>,
    pub command: Option<String>,
    pub plan_count: Option<i64>,
    pub needs_you: Option<i64>,
}

/// GSD's in-flight execution line — mirrors `protocol::common::GsdExecution`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdExecution {
    pub phase: String,
    pub plans_total: u64,
    pub plans_done: u64,
    pub current_plan: Option<String>,
    pub tasks_done: u64,
    pub tasks_total: Option<i64>,
    pub last_task: Option<String>,
}

/// One GSD recovery/action chip — mirrors `protocol::common::GsdAction`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdAction {
    pub id: String,
    pub label: String,
    pub command: String,
    pub recommended: bool,
}

/// A session's GSD workflow state — mirrors `protocol::common::GsdState`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdState {
    pub installed: bool,
    pub available: bool,
    pub has_git: bool,
    pub situation: String,
    pub summary: String,
    pub milestone: Option<String>,
    pub current_phase: Option<String>,
    pub total_phases: Option<i64>,
    pub percent: f64,
    pub phases: Vec<UniffiGsdPhase>,
    pub actions: Vec<UniffiGsdAction>,
    pub recommended: Option<String>,
    pub paused: bool,
    pub blockers: Vec<String>,
    pub verify_failed: bool,
    pub execution: Option<UniffiGsdExecution>,
}

fn to_uniffi_usage_window(w: &UsageWindow) -> UniffiUsageWindow {
    UniffiUsageWindow {
        utilization: w.utilization,
        resets_at: w.resets_at.clone(),
    }
}

fn to_uniffi_usage_data(u: &UsageData) -> UniffiUsageData {
    UniffiUsageData {
        available: u.available,
        subscription_type: u.subscription_type.clone(),
        five_hour: u.five_hour.as_ref().map(to_uniffi_usage_window),
        seven_day: u.seven_day.as_ref().map(to_uniffi_usage_window),
        seven_day_opus: u.seven_day_opus.as_ref().map(to_uniffi_usage_window),
        seven_day_sonnet: u.seven_day_sonnet.as_ref().map(to_uniffi_usage_window),
        session_cost_usd: u.session_cost_usd,
        fetched_at: u.fetched_at.clone(),
    }
}

fn to_uniffi_gsd_phase(p: &GsdPhase) -> UniffiGsdPhase {
    UniffiGsdPhase {
        number: p.number.clone(),
        name: p.name.clone(),
        disk_status: p.disk_status.clone(),
        plans: p.plans,
        summaries: p.summaries,
        recently_touched: p.recently_touched,
        action: p.action.clone(),
        command: p.command.clone(),
        plan_count: p.plan_count,
        needs_you: p.needs_you,
    }
}

fn to_uniffi_gsd_execution(e: &GsdExecution) -> UniffiGsdExecution {
    UniffiGsdExecution {
        phase: e.phase.clone(),
        plans_total: e.plans_total,
        plans_done: e.plans_done,
        current_plan: e.current_plan.clone(),
        tasks_done: e.tasks_done,
        tasks_total: e.tasks_total,
        last_task: e.last_task.clone(),
    }
}

fn to_uniffi_gsd_action(a: &GsdAction) -> UniffiGsdAction {
    UniffiGsdAction {
        id: a.id.clone(),
        label: a.label.clone(),
        command: a.command.clone(),
        recommended: a.recommended,
    }
}

fn to_uniffi_gsd_state(g: &GsdState) -> UniffiGsdState {
    UniffiGsdState {
        installed: g.installed,
        available: g.available,
        has_git: g.has_git,
        situation: g.situation.clone(),
        summary: g.summary.clone(),
        milestone: g.milestone.clone(),
        current_phase: g.current_phase.clone(),
        total_phases: g.total_phases,
        percent: g.percent,
        phases: g.phases.iter().map(to_uniffi_gsd_phase).collect(),
        actions: g.actions.iter().map(to_uniffi_gsd_action).collect(),
        recommended: g.recommended.clone(),
        paused: g.paused,
        blockers: g.blockers.clone(),
        verify_failed: g.verify_failed,
        execution: g.execution.as_ref().map(to_uniffi_gsd_execution),
    }
}

/// One selectable model, as reported by either backend's live SDK
/// (`MachineView.models`/`open_code_models`) or a custom provider profile's
/// own list (`ProviderProfileInfo.models`) — the same shape in every case,
/// so one record covers all three.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiModelEntry {
    pub id: String,
    pub label: Option<String>,
}

fn to_uniffi_model_entries(models: &[protocol::events::ModelEntry]) -> Vec<UniffiModelEntry> {
    models.iter().map(|m| UniffiModelEntry { id: m.id.clone(), label: m.label.clone() }).collect()
}

/// A custom AI provider profile the bridge has stored — gated on the
/// `custom-providers` capability, same as the TS `NewSessionModal.tsx`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderProfileInfo {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<UniffiModelEntry>,
    pub default_model: Option<String>,
    pub has_token: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMachineSummary {
    pub pubkey_hex: String,
    pub name: String,
    pub host: Option<String>,
    pub sessions: Vec<UniffiSessionSummary>,
    /// Bridge heartbeat capability strings, e.g. `"opencode"` /
    /// `"custom-providers"` — the new-session screen gates its backend and
    /// provider pickers on these, the same wire strings the reference
    /// `NewSessionModal.tsx` gates on.
    pub capabilities: Vec<String>,
    pub folders: Vec<String>,
    pub roots: Vec<String>,
    /// Claude Code's live model list, requested via `RequestModels`.
    pub models: Vec<UniffiModelEntry>,
    pub default_model: Option<String>,
    pub models_error: Option<String>,
    /// OpenCode's live model list — tracked separately (see `MachineView`'s
    /// own doc comment) since the two backends can support different models.
    pub open_code_models: Vec<UniffiModelEntry>,
    pub open_code_models_error: Option<String>,
    pub provider_profiles: Vec<UniffiProviderProfileInfo>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMachinesView {
    pub machines: Vec<UniffiMachineSummary>,
}

pub fn build_uniffi_machines_view(v: &MachinesView) -> UniffiMachinesView {
    UniffiMachinesView {
        machines: v
            .machines
            .values()
            .map(|m| UniffiMachineSummary {
                pubkey_hex: m.pubkey_hex.clone(),
                name: m.name.clone(),
                host: m.host.map(|h| wire_str(&h)),
                sessions: m
                    .sessions
                    .values()
                    .map(|s| {
                        let info = &s.info;
                        UniffiSessionSummary {
                            id: info.id.clone(),
                            title: info.title.clone(),
                            slug: info.slug.clone(),
                            cwd: info.cwd.clone(),
                            project: info.project.clone(),
                            state: info.state.map(|st| wire_str(&st)),
                            presence: wire_str(&s.presence),
                            last_activity: info.last_activity.clone(),
                            model: info.model.clone(),
                            permission_mode: info.permission_mode.map(|pm| wire_str(&pm)),
                            effort_level: info.effort_level.map(|e| wire_str(&e)),
                            context_percentage: info.context_percentage,
                            context_window: info.context_window,
                            committed: info.committed,
                            seq_high: info.seq_high,
                            usage: s.usage.as_ref().map(to_uniffi_usage_data),
                            gsd: s.gsd.as_ref().map(to_uniffi_gsd_state),
                        }
                    })
                    .collect(),
                capabilities: m.capabilities.clone(),
                folders: m.folders.clone(),
                roots: m.roots.clone(),
                models: m.models.as_deref().map(to_uniffi_model_entries).unwrap_or_default(),
                default_model: m.default_model.clone(),
                models_error: m.models_error.clone(),
                open_code_models: m.open_code_models.as_deref().map(to_uniffi_model_entries).unwrap_or_default(),
                open_code_models_error: m.open_code_models_error.clone(),
                provider_profiles: m
                    .provider_profiles
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|p| UniffiProviderProfileInfo {
                        id: p.id.clone(),
                        label: p.label.clone(),
                        base_url: p.base_url.clone(),
                        models: p
                            .models
                            .iter()
                            .map(|m| UniffiModelEntry { id: m.id.clone(), label: m.label.clone() })
                            .collect(),
                        default_model: p.default_model.clone(),
                        has_token: p.has_token,
                    })
                    .collect(),
            })
            .collect(),
    }
}

// --- outbox ----------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiOutboxItem {
    pub id: String,
    pub machine: String,
    pub session_id: String,
    pub text: String,
    /// `pending` / `published` / `confirmed` / `failed`.
    pub state: String,
    pub created_at: u64,
    pub error: Option<String>,
    pub attempts: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiOutboxView {
    pub items: Vec<UniffiOutboxItem>,
}

pub fn build_uniffi_outbox_view(v: &OutboxView) -> UniffiOutboxView {
    UniffiOutboxView {
        items: v
            .items
            .iter()
            .map(|i| UniffiOutboxItem {
                id: i.id.clone(),
                machine: i.machine.clone(),
                session_id: i.session_id.clone(),
                text: i.text.clone(),
                state: wire_str(&i.state),
                created_at: i.created_at,
                error: i.error.clone(),
                attempts: i.attempts,
            })
            .collect(),
    }
}

// --- ui (selection + optimistic card bookkeeping this slice needs) ---------

/// Fire-and-answer round-trip ack for `SetCredentials` (CDX-011) — mirrors
/// `client_core::stores::ui::CredentialsAck` field for field. `state` is
/// `"saving"` / `"saved"` / `"failed"`, the same wire spelling `wire_str`
/// gives every other status enum crossing this boundary.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiCredentialsAck {
    pub state: String,
    pub at: u64,
    pub has_anthropic_key: Option<bool>,
    pub has_github_pat: Option<bool>,
    pub key_valid: Option<bool>,
    pub error: Option<String>,
}

/// Fire-and-answer round-trip ack for `SetProviderProfile` (CDX-062) —
/// mirrors `client_core::stores::ui::ProviderProfileAck` field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderProfileAck {
    pub state: String,
    pub at: u64,
    pub profile_id: Option<String>,
    pub token_valid: Option<bool>,
    pub error: Option<String>,
}

/// The bottom "Deleted X — Undo" toast after an optimistic session delete —
/// mirrors `client_core::stores::ui::UndoToast` field for field. Present
/// only while the 4 s undo window is open; the hide lands as the next
/// `UniffiUiView` re-fetch (the countdown itself belongs to the runtime's
/// delete controller, not to this projection).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUndoToast {
    pub machine: String,
    pub session_id: String,
    pub label: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUiView {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    /// Session keys with an unread dot — same `machine + " " + sessionId`
    /// format `session_key_of` produces.
    pub unread_sessions: Vec<String>,
    /// `sessionKey (machine + " " + sessionId)` -> responded card ids.
    pub responded_cards: HashMap<String, Vec<String>>,
    pub plan_approval_choices: HashMap<String, String>,
    /// Keyed by machine pubkey.
    pub credentials_status: HashMap<String, UniffiCredentialsAck>,
    /// Keyed by machine pubkey.
    pub provider_profile_status: HashMap<String, UniffiProviderProfileAck>,
    /// Present while a delete's undo window is open.
    pub undo_toast: Option<UniffiUndoToast>,
}

pub fn build_uniffi_ui_view(v: &UiView) -> UniffiUiView {
    UniffiUiView {
        selected_machine: v.selected_machine.clone(),
        selected_session: v.selected_session.clone(),
        unread_sessions: v.unread_sessions.iter().cloned().collect(),
        responded_cards: v
            .responded_cards
            .iter()
            .map(|(k, set)| (k.clone(), set.iter().cloned().collect()))
            .collect(),
        plan_approval_choices: v
            .plan_approval_choices
            .iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect(),
        credentials_status: v
            .credentials_status
            .iter()
            .map(|(k, a)| {
                (
                    k.clone(),
                    UniffiCredentialsAck {
                        state: wire_str(&a.state),
                        at: a.at,
                        has_anthropic_key: a.has_anthropic_key,
                        has_github_pat: a.has_github_pat,
                        key_valid: a.key_valid,
                        error: a.error.clone(),
                    },
                )
            })
            .collect(),
        provider_profile_status: v
            .provider_profile_status
            .iter()
            .map(|(k, a)| {
                (
                    k.clone(),
                    UniffiProviderProfileAck {
                        state: wire_str(&a.state),
                        at: a.at,
                        profile_id: a.profile_id.clone(),
                        token_valid: a.token_valid,
                        error: a.error.clone(),
                    },
                )
            })
            .collect(),
        undo_toast: v.undo_toast.clone().map(|t| UniffiUndoToast {
            machine: t.machine,
            session_id: t.session_id,
            label: t.label,
        }),
    }
}

// --- settings --------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSettingsView {
    pub relays: Vec<String>,
    pub ui_scale: f64,
    pub stay_connected: bool,
    pub tor_proxy_enabled: bool,
    pub blossom_server: String,
    /// `default` / `acceptEdits` / `plan` — `PermissionMode`'s own wire spelling.
    pub default_mode: String,
    pub default_effort: String,
    pub default_model: String,
    pub notifications_enabled: bool,
    pub show_usage_badge: bool,
    pub show_commit_badge: bool,
}

pub fn build_uniffi_settings_view(v: &SettingsView) -> UniffiSettingsView {
    let d = &v.0;
    UniffiSettingsView {
        relays: d.relays.clone(),
        ui_scale: d.ui_scale,
        stay_connected: d.stay_connected,
        tor_proxy_enabled: d.tor_proxy_enabled,
        blossom_server: d.blossom_server.clone(),
        default_mode: wire_str(&d.default_mode),
        default_effort: d.default_effort.clone(),
        default_model: d.default_model.clone(),
        notifications_enabled: d.notifications_enabled,
        show_usage_badge: d.show_usage_badge,
        show_commit_badge: d.show_commit_badge,
    }
}

// --- quick prompts -----------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiQuickPrompt {
    pub id: String,
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiQuickPromptsView {
    pub prompts: Vec<UniffiQuickPrompt>,
}

pub fn build_uniffi_quick_prompts_view(v: &QuickPromptsView) -> UniffiQuickPromptsView {
    UniffiQuickPromptsView {
        prompts: v
            .prompts
            .iter()
            .map(|p| UniffiQuickPrompt { id: p.id.clone(), label: p.label.clone(), text: p.text.clone() })
            .collect(),
    }
}

// --- pending sessions -------------------------------------------------------

/// One optimistic new-session placeholder — mirrors
/// `client_core::stores::pending_sessions::PendingSessionView` field for
/// field. The bridge publishes `session-pending` on create and resolves the
/// placeholder with `session-ready`; a `session-failed` flips it to a
/// visible error card that stays until the user dismisses it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPendingSession {
    pub pending_id: String,
    /// Machine pubkey hex (`""` for a failure we saw no `session-pending` for).
    pub machine: String,
    /// Machine display name from the message (not the pubkey).
    pub machine_name: String,
    pub created_at: String,
    /// `pending` / `failed`.
    pub state: String,
    /// Set once `state == "failed"`.
    pub reason: Option<String>,
    /// ms timestamp the placeholder appeared (sweep bookkeeping).
    pub seen_at: u64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPendingSessionsView {
    /// Every held placeholder, in the real view's `pending_id`-keyed
    /// `BTreeMap` order. Not persisted (a placeholder that never resolves is
    /// meaningless after a restart) — a state-changed notification for this
    /// slice is the only signal a consumer gets that it changed.
    pub pending: Vec<UniffiPendingSession>,
}

pub fn build_uniffi_pending_sessions_view(v: &PendingSessionsView) -> UniffiPendingSessionsView {
    UniffiPendingSessionsView {
        pending: v
            .pending
            .values()
            .map(|p| UniffiPendingSession {
                pending_id: p.pending_id.clone(),
                machine: p.machine.clone(),
                machine_name: p.machine_name.clone(),
                created_at: p.created_at.clone(),
                state: wire_str(&p.state),
                reason: p.reason.clone(),
                seen_at: p.seen_at,
            })
            .collect(),
    }
}

// --- pairing -----------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPairingCandidateView {
    pub pubkey_hex: String,
    pub npub: String,
    pub machine: String,
    pub relays: Vec<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPairingView {
    /// `idle` / `awaiting-ack` / `paired` / `failed` — `PairingView.phase`'s
    /// own wire spelling (a `&'static str` on the real type; UniFFI's
    /// `Record` derive needs an owned `String` to synthesize an
    /// `FfiConverter` for it, same reason `ConnectionView`'s own doc comment
    /// gives for not deriving directly on the real struct).
    pub phase: String,
    pub error: Option<String>,
    /// CDX-040: the `failed` phase came from the phone's own deadline, not a nack.
    pub timed_out: bool,
    /// A deep-link URL awaiting explicit user confirmation (CDX-013), with
    /// enough of its parsed content to show what it wants to pair with.
    pub staged: Option<UniffiPairingCandidateView>,
    pub candidate: Option<UniffiPairingCandidateView>,
}

pub fn build_uniffi_pairing_view(v: &PairingView) -> UniffiPairingView {
    UniffiPairingView {
        phase: v.phase.to_string(),
        error: v.error.clone(),
        timed_out: v.timed_out,
        staged: v.staged.as_ref().map(|s| UniffiPairingCandidateView {
            pubkey_hex: s.pubkey_hex.clone(),
            npub: s.npub.clone(),
            machine: s.machine.clone(),
            relays: s.relays.clone(),
        }),
        candidate: v.candidate.as_ref().map(|c| UniffiPairingCandidateView {
            pubkey_hex: c.pubkey_hex.clone(),
            npub: c.npub.clone(),
            machine: c.machine.clone(),
            relays: c.relays.clone(),
        }),
    }
}

// --- transcript (grouped, via the now-wired presentation module) -----------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiTranscriptRowsView {
    /// `serde_json::to_string` of
    /// `Vec<client_core::presentation::display_entries::DisplayEntry>` —
    /// see this module's doc comment for why a JSON blob, not a `Record`.
    pub display_entries_json: String,
    /// `serde_json::to_string` of a `PendingPermissionSummary`, present iff a
    /// permission request is still unanswered and unresolved.
    pub pending_permission_json: Option<String>,
    /// `idle` / `requested` / `syncing` / `complete` / `failed`.
    pub sync_state: String,
    pub contiguous: bool,
}

/// This session's optimistically-responded card-id set, keyed the same way
/// `stores::ui::mark_card_responded` keys it — the one place that key format
/// (`"{machine} {session_id}"`) is spelled out, via the real `session_key_of`
/// rather than a hand-duplicated format string.
pub fn responded_cards_for<'a>(
    ui: &'a UiView,
    machine: &str,
    session_id: &str,
) -> Option<&'a BTreeSet<String>> {
    ui.responded_cards.get(&session_key_of(machine, session_id))
}

pub fn build_uniffi_transcript_view(
    view: &TranscriptRowsView,
    responded_cards: Option<&BTreeSet<String>>,
) -> UniffiTranscriptRowsView {
    let seq_entries: Vec<SeqEntry> = view
        .rows
        .iter()
        .filter_map(|r| {
            serde_json::from_value::<protocol::common::OutputEntry>(r.entry.clone())
                .ok()
                .map(|entry| SeqEntry { seq: r.seq, entry })
        })
        .collect();
    let display = build_display_entries(&seq_entries);
    let pending = find_pending_permission(&seq_entries, responded_cards);
    UniffiTranscriptRowsView {
        display_entries_json: serde_json::to_string(&display).unwrap_or_else(|_| "[]".to_string()),
        pending_permission_json: pending.and_then(|p| serde_json::to_string(&p).ok()),
        sync_state: wire_str(&view.sync.state),
        contiguous: view.sync.contiguous,
    }
}
