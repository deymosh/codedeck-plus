//! Narrowed, hand-mapped view DTOs for the Android FFI surface — the same
//! disclosed-narrowing precedent `intent.rs`'s `UniffiIntent` already set.
//! UniFFI's `Record` derive needs concrete, homogeneously-typed fields, but
//! several real view types either carry arbitrary JSON
//! (`TranscriptRowView.entry` is `serde_json::Value` — `OutputEntry.metadata`
//! is genuinely untyped bridge-supplied JSON) or fields the first Android
//! slice has no screen for yet (`UiView`'s credentials/device-config/
//! provider-profile/undo-toast bookkeeping is Settings/Credentials/Pairing
//! territory, F4). (`SettingsData`'s `mesh_test_target` is likewise left
//! out — Mesh is F6, off by default, out of this slice's scope.) Rather
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
use client_runtime::{MachinesView, OutboxView, PairingView, QuickPromptsView, SettingsView, TranscriptRowsView, UiView};

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
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMachineSummary {
    pub pubkey_hex: String,
    pub name: String,
    pub host: Option<String>,
    pub sessions: Vec<UniffiSessionSummary>,
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
                        }
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

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUiView {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    /// `sessionKey (machine + " " + sessionId)` -> responded card ids.
    pub responded_cards: HashMap<String, Vec<String>>,
    pub plan_approval_choices: HashMap<String, String>,
}

pub fn build_uniffi_ui_view(v: &UiView) -> UniffiUiView {
    UniffiUiView {
        selected_machine: v.selected_machine.clone(),
        selected_session: v.selected_session.clone(),
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
    /// A deep-link URL awaiting explicit user confirmation (CDX-013).
    pub has_staged: bool,
    pub candidate: Option<UniffiPairingCandidateView>,
}

pub fn build_uniffi_pairing_view(v: &PairingView) -> UniffiPairingView {
    UniffiPairingView {
        phase: v.phase.to_string(),
        error: v.error.clone(),
        timed_out: v.timed_out,
        has_staged: v.has_staged,
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
