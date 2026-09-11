//! Views — the read-only, per-capability projections the bindings serialize
//! and hand to the UI (migration plan §2.1). Plain serde data, sliced so a
//! consumer subscribes only to what it paints.
//!
//! The store `*State` structs were designed as the serde wire shape, so the
//! machines / outbox / settings views are thin newtypes over their public
//! sub-state. `connection` is FSM-backed (the loop passes it in); `pairing`
//! has no `Serialize` and is projected by hand. `TranscriptRowsView` is the
//! one view backed by a port (`TranscriptStore`, SQLite on device) rather
//! than a synchronous in-memory snapshot, so it alone needs I/O to build.
//! The interaction-card *content* view (plan §2.1's `CardsView`, distinct
//! from `UiView`'s optimistic bookkeeping) still has no home yet.

use std::collections::{BTreeMap, BTreeSet};

use client_core::connection::ConnectionStatus;
use client_core::stores::dm::{DmConversation, DmMessage};
use client_core::stores::machines::MachineView;
use client_core::stores::marmot::{MarmotConversation, MarmotMessage, MarmotWelcomeInfo};
use client_core::stores::outbox::OutboxItem;
use client_core::stores::pairing::{PairingPhase, PairingState};
use client_core::stores::pending_sessions::PendingSessionView;
use client_core::stores::quick_prompts::QuickPrompt;
use client_core::stores::settings::SettingsData;
use client_core::stores::transcript::{SyncState, TranscriptState};
use client_core::stores::ui::{CredentialsAck, DeviceConfigAck, PanelMode, ProviderProfileAck, UndoToast};
use serde::Serialize;

use crate::ports::TranscriptStore;

use crate::stores::CoreStores;

// --- connection ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    /// `idle` | `connecting` | `connected` | `waiting-retry` | `offline` | `stopped`.
    pub status: &'static str,
    /// The FSM wants a pairing re-check (CDX heartbeat-vs-pairing race).
    pub needs_pairing_check: bool,
}

impl ConnectionView {
    pub fn new(status: ConnectionStatus, needs_pairing_check: bool) -> Self {
        Self {
            status: match status {
                ConnectionStatus::Idle => "idle",
                ConnectionStatus::Connecting => "connecting",
                ConnectionStatus::Connected => "connected",
                ConnectionStatus::WaitingRetry => "waiting-retry",
                ConnectionStatus::Offline => "offline",
                ConnectionStatus::Stopped => "stopped",
            },
            needs_pairing_check,
        }
    }
}

// --- machines ----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MachinesView {
    pub machines: BTreeMap<String, MachineView>,
}

impl MachinesView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            machines: s.machines.machines.clone(),
        }
    }
}

// --- outbox ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutboxView {
    /// Every queued item, oldest first.
    pub items: Vec<OutboxItem>,
}

impl OutboxView {
    pub fn from_stores(s: &CoreStores) -> Self {
        let mut items: Vec<OutboxItem> = s.outbox.items.values().cloned().collect();
        items.sort_by_key(|i| i.created_at);
        Self { items }
    }
}

// --- settings ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(transparent)]
pub struct SettingsView(pub SettingsData);

impl SettingsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self(s.settings.data.clone())
    }
}

// --- pending sessions ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionsView {
    /// `pending_id` → placeholder. Not persisted (client-core's own
    /// invariant) — a `stateChanged` for this slice is the only signal a
    /// consumer gets that it changed.
    pub pending: BTreeMap<String, PendingSessionView>,
}

impl PendingSessionsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            pending: s.pending_sessions.all().clone(),
        }
    }
}

// --- quick prompts -------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuickPromptsView {
    pub prompts: Vec<QuickPrompt>,
}

impl QuickPromptsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            prompts: s.quick_prompts.prompts.clone(),
        }
    }
}

// --- ui (selection + optimistic interaction-card bookkeeping) --------------
//
// This is `UiState` verbatim, NOT the plan §2.1 `CardsView` (that one is a
// per-session, row-backed projection of actual card CONTENT that lands with
// the transcript-view work — a different, larger thing). `UiState` only
// holds the optimistic bookkeeping around cards (selection, unread dots,
// responded-card ids, plan-approval labels, ack round-trip status, the undo
// toast) — small, flat, and already fully ported in F2a, so it gets a thin
// view now rather than waiting on that bigger design.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UiView {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    pub panel_mode: PanelMode,
    pub active_dm_peer: Option<String>,
    pub active_marmot_group: Option<String>,
    pub unread_sessions: BTreeSet<String>,
    pub responded_cards: BTreeMap<String, BTreeSet<String>>,
    pub plan_approval_choices: BTreeMap<String, String>,
    pub credentials_status: BTreeMap<String, CredentialsAck>,
    pub device_config_status: BTreeMap<String, DeviceConfigAck>,
    pub provider_profile_status: BTreeMap<String, ProviderProfileAck>,
    pub undo_toast: Option<UndoToast>,
}

impl UiView {
    pub fn from_stores(s: &CoreStores) -> Self {
        let ui = &s.ui;
        Self {
            selected_machine: ui.selected_machine.clone(),
            selected_session: ui.selected_session.clone(),
            panel_mode: ui.panel_mode,
            active_dm_peer: ui.active_dm_peer.clone(),
            active_marmot_group: ui.active_marmot_group.clone(),
            unread_sessions: ui.unread_sessions.clone(),
            responded_cards: ui.responded_cards.clone(),
            plan_approval_choices: ui.plan_approval_choices.clone(),
            credentials_status: ui.credentials_status.clone(),
            device_config_status: ui.device_config_status.clone(),
            provider_profile_status: ui.provider_profile_status.clone(),
            undo_toast: ui.undo_toast.clone(),
        }
    }
}

// --- pairing ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// `idle` | `awaiting-ack` | `paired` | `failed`.
    pub phase: &'static str,
    pub error: Option<String>,
    /// CDX-040: the `Failed` came from the phone's own deadline, not a nack.
    pub timed_out: bool,
    /// A deep-link URL awaiting explicit user confirmation (CDX-013).
    pub has_staged: bool,
    /// The candidate under negotiation, if any.
    pub candidate: Option<PairingCandidateView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PairingCandidateView {
    pub pubkey_hex: String,
    pub npub: String,
    pub machine: String,
    pub relays: Vec<String>,
}

impl PairingView {
    pub fn from_state(p: &PairingState) -> Self {
        Self {
            phase: match p.phase {
                PairingPhase::Idle => "idle",
                PairingPhase::AwaitingAck => "awaiting-ack",
                PairingPhase::Paired => "paired",
                PairingPhase::Failed => "failed",
            },
            error: p.error.clone(),
            timed_out: p.timed_out,
            has_staged: p.staged.is_some(),
            candidate: p.candidate.as_ref().map(|c| PairingCandidateView {
                pubkey_hex: c.pubkey_hex.clone(),
                npub: c.npub.clone(),
                machine: c.machine.clone(),
                relays: c.relays.clone(),
            }),
        }
    }

    pub fn from_stores(s: &CoreStores) -> Self {
        Self::from_state(&s.pairing)
    }
}

// --- dm ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DmView {
    /// Conversations newest-first (by `last_message_at`).
    pub conversations: Vec<DmConversation>,
    /// `peer` → messages ascending by `at`.
    pub messages: BTreeMap<String, Vec<DmMessage>>,
    pub active_peer: Option<String>,
    /// 1059 events seen / unwrap failures / non-DM rumors (CD-001 diagnostics).
    #[specta(type = specta_typescript::Number)]
    pub events_received: u64,
    #[specta(type = specta_typescript::Number)]
    pub unwrap_failures: u64,
    #[specta(type = specta_typescript::Number)]
    pub invalid_rumors: u64,
}

impl DmView {
    pub fn from_stores(s: &CoreStores) -> Self {
        let mut conversations: Vec<DmConversation> = s.dm.conversations.values().cloned().collect();
        conversations.sort_by_key(|c| std::cmp::Reverse(c.last_message_at));
        Self {
            conversations,
            messages: s.dm.messages.clone(),
            active_peer: s.dm.active_peer.clone(),
            events_received: s.dm.diagnostics.events_received,
            unwrap_failures: s.dm.diagnostics.unwrap_failures,
            invalid_rumors: s.dm.diagnostics.invalid_rumors,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MarmotView {
    /// The MDK engine seam exists AND init succeeded — gates whether the UI
    /// offers starting a Marmot chat at all.
    pub available: bool,
    /// Conversations newest-first (by `last_message_at`).
    pub conversations: Vec<MarmotConversation>,
    /// `group_id` → messages ascending by `at`.
    pub messages: BTreeMap<String, Vec<MarmotMessage>>,
    pub active_group: Option<String>,
    /// kind-445 events seen / `Ignored` verdicts / engine-call failures
    /// (CD-001 diagnostics — never silent).
    #[specta(type = specta_typescript::Number)]
    pub events_received: u64,
    #[specta(type = specta_typescript::Number)]
    pub ignored: u64,
    #[specta(type = specta_typescript::Number)]
    pub errors: u64,
    /// 445s held for not-yet-joined groups (VEIL-029 buffer).
    #[specta(type = specta_typescript::Number)]
    pub buffered: usize,
    /// Welcomes awaiting `Intent::AcceptMarmotWelcome`, keyed by `welcomeId`.
    /// Without this the accept-welcome UI has nothing to render — a chat
    /// invite would sit accepted engine-side-only and invisible forever.
    pub pending_welcomes: BTreeMap<String, MarmotWelcomeInfo>,
}

impl MarmotView {
    pub fn from_stores(s: &CoreStores) -> Self {
        let mut conversations: Vec<MarmotConversation> =
            s.marmot.conversations.values().cloned().collect();
        conversations.sort_by_key(|c| std::cmp::Reverse(c.last_message_at));
        Self {
            available: s.marmot.available,
            conversations,
            messages: s.marmot.messages.clone(),
            active_group: s.marmot.active_group.clone(),
            events_received: s.marmot.diagnostics.events_received,
            ignored: s.marmot.diagnostics.ignored,
            errors: s.marmot.diagnostics.errors,
            buffered: s.marmot.buffered_len(),
            pending_welcomes: s.marmot.pending_welcomes.clone(),
        }
    }
}

// --- transcript sync status (the non-row half) -------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSyncView {
    pub state: SyncState,
    pub attempts: u32,
    #[specta(type = Option<specta_typescript::Number>)]
    pub next_retry_at: Option<u64>,
    /// Highest locally-stored seq.
    #[specta(type = specta_typescript::Number)]
    pub local_high: u64,
    /// seqHigh the current cycle is trying to cover.
    #[specta(type = specta_typescript::Number)]
    pub target: u64,
    /// Contiguous `1..=local_high` with no gaps.
    pub contiguous: bool,
}

impl TranscriptSyncView {
    pub fn for_session(t: &TranscriptState, machine: &str, session_id: &str) -> Option<Self> {
        let s = t.session(machine, session_id)?;
        Some(Self {
            state: s.sync.state,
            attempts: s.sync.attempts,
            next_retry_at: s.sync.next_retry_at,
            local_high: s.local_high,
            target: s.sync.target,
            contiguous: t.has_contiguous(machine, session_id, None),
        })
    }

    /// A session `TranscriptState` has never heard of yet (no `Output`/
    /// `SyncBegin` has landed) — the honest "nothing here yet" reading,
    /// contiguous vacuously.
    fn empty() -> Self {
        Self {
            state: SyncState::Idle,
            attempts: 0,
            next_retry_at: None,
            local_high: 0,
            target: 0,
            contiguous: true,
        }
    }
}

// --- transcript rows (the row half — read-only, `TranscriptStore`-backed) --

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRowView {
    #[specta(type = specta_typescript::Number)]
    pub seq: u64,
    /// The Rust port carries no protocol dependency in its own field type
    /// (`serde_json::Value`, since the row store is generic), but it always
    /// holds a valid `OutputEntry` — this is what the bridge sends. Typed as
    /// such for TS's benefit (`serde_json::Value` is structurally recursive
    /// and would overflow the exporter if expanded as-is).
    #[specta(type = protocol::common::OutputEntry)]
    pub entry: serde_json::Value,
}

/// Everything a phone needs to render one session's transcript: the rows
/// (`1..=local_high`, the same "give me everything, the UI virtualizes"
/// contract `TranscriptStoreState.entriesOf` has today — no pagination yet,
/// see plan §2.1's future `transcript_view(id, from, to)`), the sync status,
/// and the coverage `have_ranges` a sync-request would carry.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRowsView {
    pub rows: Vec<TranscriptRowView>,
    #[specta(type = Vec<(specta_typescript::Number, specta_typescript::Number)>)]
    pub have_ranges: Vec<(u64, u64)>,
    pub sync: TranscriptSyncView,
}

impl TranscriptRowsView {
    pub fn empty() -> Self {
        Self {
            rows: Vec::new(),
            have_ranges: Vec::new(),
            sync: TranscriptSyncView::empty(),
        }
    }

    /// Reads `1..=local_high` from `transcript_store` (the row content) and
    /// combines it with the in-memory sync/coverage state. `transcript_store`
    /// is a port (SQLite on device), so this is the one view that needs I/O —
    /// every other `*View::from_stores` is a synchronous, in-memory snapshot.
    pub async fn load(
        transcript: &TranscriptState,
        transcript_store: &dyn TranscriptStore,
        machine: &str,
        session_id: &str,
    ) -> Self {
        let sync = TranscriptSyncView::for_session(transcript, machine, session_id)
            .unwrap_or_else(TranscriptSyncView::empty);
        if sync.local_high == 0 {
            return Self {
                rows: Vec::new(),
                have_ranges: transcript.have_ranges_of(machine, session_id),
                sync,
            };
        }
        let rows = transcript_store
            .read_range(machine, session_id, 1, sync.local_high)
            .await
            .into_iter()
            .map(|r| TranscriptRowView { seq: r.seq, entry: r.entry })
            .collect();
        Self {
            rows,
            have_ranges: transcript.have_ranges_of(machine, session_id),
            sync,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{MemoryKv, MemoryTranscriptStore};
    use crate::stores::{hydrate, StoresConfig};

    async fn stores() -> CoreStores {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        hydrate(&kv, &ts, &StoresConfig::default()).await.stores
    }

    #[test]
    fn connection_view_maps_the_status_string() {
        assert_eq!(
            ConnectionView::new(ConnectionStatus::WaitingRetry, true).status,
            "waiting-retry"
        );
        let json = serde_json::to_string(&ConnectionView::new(ConnectionStatus::Connected, false))
            .unwrap();
        assert_eq!(json, r#"{"status":"connected","needsPairingCheck":false}"#);
    }

    #[tokio::test]
    async fn settings_and_machines_views_are_thin_over_the_store() {
        let mut s = stores().await;
        s.machines.register_machine("m", "laptop", None, None);
        s.settings.add_relay("wss://extra.example");

        let mv = MachinesView::from_stores(&s);
        assert!(mv.machines.contains_key("m"));
        let sv = SettingsView::from_stores(&s);
        assert!(sv.0.relays.iter().any(|r| r == "wss://extra.example"));
        // transparent — serializes as the bare SettingsData
        assert!(serde_json::to_string(&sv).unwrap().starts_with('{'));
    }

    #[tokio::test]
    async fn pairing_view_projects_phase_and_candidate() {
        use client_core::stores::pairing::{PairingCandidate, PairingPhase, PairingState};
        let mut s = stores().await;
        s.pairing = PairingState {
            phase: PairingPhase::AwaitingAck,
            candidate: Some(PairingCandidate {
                pubkey_hex: "abc".into(),
                npub: "npub1x".into(),
                machine: "(manual)".into(),
                relays: vec!["wss://r".into()],
                token: "t".into(),
                netid: None,
                mesh_admin: None,
            }),
            error: None,
            timed_out: false,
            staged: None,
        };
        let pv = PairingView::from_stores(&s);
        assert_eq!(pv.phase, "awaiting-ack");
        assert_eq!(pv.candidate.unwrap().machine, "(manual)");
    }

    #[tokio::test]
    async fn marmot_view_carries_pending_welcomes_camel_case() {
        let mut s = stores().await;
        s.marmot.pending_welcomes.insert(
            "w1".into(),
            MarmotWelcomeInfo {
                welcome_id: "w1".into(),
                wrapper_id: "wrap1".into(),
                group_id: "g1".into(),
                h_tag: "h1".into(),
                name: "".into(),
                welcomer: "peer-pubkey".into(),
                member_count: 2,
            },
        );
        let mv = MarmotView::from_stores(&s);
        let welcome = mv.pending_welcomes.get("w1").expect("welcome present in the view");
        assert_eq!(welcome.welcomer, "peer-pubkey");
        assert!(!mv.available); // engine never initialized in this test
        let json = serde_json::to_string(&mv).unwrap();
        assert!(json.contains(r#""available":false"#));
        assert!(json.contains(r#""pendingWelcomes":{"w1":{"welcomeId":"w1""#));
    }

    #[tokio::test]
    async fn quick_prompts_view_is_thin_over_the_store() {
        let mut s = stores().await;
        s.quick_prompts.add_prompt("qp-1", "Go", "continue");
        let qpv = QuickPromptsView::from_stores(&s);
        assert_eq!(qpv.prompts.len(), 1);
        assert_eq!(qpv.prompts[0].label, "Go");
        let json = serde_json::to_string(&qpv).unwrap();
        assert!(json.contains(r#""prompts":[{"id":"qp-1","label":"Go","text":"continue"}]"#));
    }

    #[tokio::test]
    async fn ui_view_is_thin_over_the_store() {
        let mut s = stores().await;
        s.ui.select_machine(Some("m1"));
        s.ui.mark_session_unread("m1", "s1");
        s.ui.set_plan_approval_choice("card1", "2");

        let uv = UiView::from_stores(&s);
        assert_eq!(uv.selected_machine.as_deref(), Some("m1"));
        assert!(uv.unread_sessions.contains(&client_core::notifications::session_key_of("m1", "s1")));
        assert_eq!(uv.plan_approval_choices.get("card1").map(String::as_str), Some("2"));
        let json = serde_json::to_string(&uv).unwrap();
        assert!(json.contains(r#""selectedMachine":"m1""#));
        assert!(json.contains(r#""panelMode":"session""#));
    }

    #[tokio::test]
    async fn outbox_view_is_ordered_oldest_first() {
        use client_core::stores::outbox::OutboxState;
        let mut s = stores().await;
        s.outbox.begin_publish(OutboxState::new_input("b", "m", "s", "2", 200));
        s.outbox.begin_publish(OutboxState::new_input("a", "m", "s", "1", 100));
        let ov = OutboxView::from_stores(&s);
        assert_eq!(
            ov.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }
}
