//! Views — the read-only, per-capability projections the bindings serialize
//! and hand to the UI. Plain serde data, sliced so a
//! consumer subscribes only to what it paints.
//!
//! The store `*State` structs were designed as the serde wire shape, so the
//! machines / outbox / settings views are thin newtypes over their public
//! sub-state. `connection` is FSM-backed (the loop passes it in); `pairing`
//! has no `Serialize` and is projected by hand. `TranscriptRowsView` is the
//! one view backed by a port (`TranscriptStore`, SQLite on device) rather
//! than a synchronous in-memory snapshot, so it alone needs I/O to build.
//! There is no separate interaction-card *content* view (distinct from
//! `UiView`'s optimistic bookkeeping): card content rides in the transcript
//! rows.

use std::collections::{BTreeMap, BTreeSet};

use client_core::connection::ConnectionStatus;
use client_core::stores::machines::MachineView;
use client_core::stores::outbox::OutboxItem;
use client_core::stores::pairing::{PairingPhase, PairingState};
use client_core::stores::pending_sessions::PendingSessionView;
use client_core::stores::quick_prompts::QuickPrompt;
use client_core::stores::settings::SettingsData;
use client_core::stores::transcript::{SyncState, TranscriptState};
use client_core::stores::ui::{CredentialsAck, ProviderProfileAck, UndoToast, WebSignIn};
use protocol::common::{AgentStyle, TerminalEndReason};
use protocol::events::{TerminalInfo, WebBrowserInfo};
use serde::Serialize;

use crate::ports::TranscriptStore;

use crate::stores::CoreStores;

// --- connection ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    /// `idle` | `connecting` | `connected` | `waiting-retry` | `offline` | `stopped`.
    ///
    /// Owned `String`, not `&'static str`: UniFFI's `uniffi::Record` derive
    /// has no `FfiConverter` for a borrowed, 'static-lifetime string —
    /// crossing the FFI boundary needs ownership. Same JSON wire shape either
    /// way (serde serializes both identically), so this costs one allocation
    /// per view read and changes no consumer-visible behavior.
    pub status: String,
    /// The FSM wants a pairing re-check (CDX heartbeat-vs-pairing race).
    pub needs_pairing_check: bool,
    /// URLs of relays with a live, EOSE'd subscription right now — the
    /// per-relay status dot Settings renders next to each relay's URL.
    /// A relay absent from this list isn't necessarily unreachable, just not
    /// currently subscribed (e.g. mid-reconnect).
    pub connected_relays: Vec<String>,
}

impl ConnectionView {
    pub fn new(status: ConnectionStatus, needs_pairing_check: bool, connected_relays: Vec<String>) -> Self {
        Self {
            status: match status {
                ConnectionStatus::Idle => "idle",
                ConnectionStatus::Connecting => "connecting",
                ConnectionStatus::Connected => "connected",
                ConnectionStatus::WaitingRetry => "waiting-retry",
                ConnectionStatus::Offline => "offline",
                ConnectionStatus::Stopped => "stopped",
            }
            .to_string(),
            needs_pairing_check,
            connected_relays,
        }
    }
}

// --- machines ----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MachinesView {
    pub machines: BTreeMap<String, MachineView>,
    /// The endpoint each machine's direct link is up on; a machine absent
    /// here is reached through the relays.
    pub direct_up: BTreeMap<String, String>,
    /// Agents' styles by the hash their catalogs name them with.
    pub agent_styles: BTreeMap<String, AgentStyle>,
}

impl MachinesView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            machines: s.machines.machines.clone(),
            direct_up: BTreeMap::new(),
            agent_styles: s.machines.agent_styles.iter().map(|(h, st)| (h.clone(), st.clone())).collect(),
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
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    pub data: SettingsData,
    pub backup: BackupView,
}

/// The config backup as the settings page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupView {
    /// `None`: backup is off.
    pub relay: Option<String>,
    /// When a backup last reached the relay (ms).
    #[specta(type = Option<specta_typescript::Number>)]
    pub saved_at: Option<u64>,
    /// How many machines the backup held when last seen or saved.
    pub machines: Option<u32>,
    pub status: crate::backup::BackupStatus,
}

impl SettingsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            data: s.settings.data.clone(),
            backup: BackupView {
                relay: s.backup.config.relay.clone(),
                saved_at: s.backup.config.saved_at,
                machines: s.backup.config.machines,
                status: s.backup.status.clone(),
            },
        }
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
// This is `UiState` verbatim, not card CONTENT (that rides in the transcript
// rows). `UiState` only holds the optimistic bookkeeping around cards
// (selection, unread dots, responded-card ids, plan-approval labels, ack
// round-trip status, the undo toast) — small and flat, so a thin view.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UiView {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    pub unread_sessions: BTreeSet<String>,
    pub responded_cards: BTreeMap<String, BTreeSet<String>>,
    pub plan_approval_choices: BTreeMap<String, String>,
    pub credentials_status: BTreeMap<String, CredentialsAck>,
    pub provider_profile_status: BTreeMap<String, ProviderProfileAck>,
    /// machine pubkey → the code the phone sent to sign a browser in to that
    /// machine's web page, and where the round trip stands.
    pub web_sign_in: BTreeMap<String, WebSignIn>,
    /// machine pubkey → the browsers signed in to its web page, as the last
    /// `web-browsers` listed them. Absent for a machine nobody has opened the
    /// screen for: the phone asks then, never on a timer.
    pub web_browsers: BTreeMap<String, Vec<WebBrowserInfo>>,
    pub undo_toast: Option<UndoToast>,
    /// The terminals, low-frequency state only: the frames themselves go to
    /// the host on `CoreEvent::TerminalOutput`, never through a view.
    pub terminals: TerminalsView,
}

/// The terminals each machine lists, and the one this phone has on screen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalsView {
    /// machine → the terminals its heartbeat lists, oldest opened first.
    pub by_machine: BTreeMap<String, Vec<TerminalInfo>>,
    pub attached: Option<AttachedTerminalView>,
}

/// The terminal on screen: what the bridge calls it, whether this device is
/// the writer, and how the last open or the end went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachedTerminalView {
    pub machine: String,
    /// The bridge's id, absent while the open is still pending.
    pub term: Option<String>,
    /// This phone's own id for a pending open, echoed by `terminal-opened`.
    pub open_id: Option<String>,
    pub shell: Option<String>,
    pub writer: bool,
    pub cols: u16,
    pub rows: u16,
    #[specta(type = specta_typescript::Number)]
    pub expected_offset: u64,
    /// Bytes typed and not yet sent — the app draws them dimmed at the cursor
    /// as the predicted echo until the real output arrives.
    pub waiting_input: Vec<u8>,
    pub refusal: Option<TerminalRefusalView>,
    pub ended: Option<TerminalEndedView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRefusalView {
    pub reason: TerminalEndReason,
    /// The device the open was refused for; its name when one was ever seen.
    pub device: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEndedView {
    pub reason: TerminalEndReason,
    pub code: Option<i32>,
}

impl TerminalsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self {
            by_machine: s.terminals.lists(),
            attached: s.terminals.attached().map(|a| AttachedTerminalView {
                machine: a.machine.clone(),
                term: a.term.clone(),
                open_id: a.open_id.clone(),
                shell: a.shell.clone(),
                writer: a.writer,
                cols: a.cols,
                rows: a.rows,
                expected_offset: a.expected,
                waiting_input: s.terminals.waiting_input(),
                refusal: a.refusal.as_ref().map(|r| TerminalRefusalView {
                    reason: r.reason,
                    device: r.device.clone(),
                    name: r.name.clone(),
                }),
                ended: a.ended.as_ref().map(|e| TerminalEndedView { reason: e.reason, code: e.code }),
            }),
        }
    }
}

impl UiView {
    pub fn from_stores(s: &CoreStores) -> Self {
        let ui = &s.ui;
        Self {
            selected_machine: ui.selected_machine.clone(),
            selected_session: ui.selected_session.clone(),
            unread_sessions: ui.unread_sessions.clone(),
            responded_cards: ui.responded_cards.clone(),
            plan_approval_choices: ui.plan_approval_choices.clone(),
            credentials_status: ui.credentials_status.clone(),
            provider_profile_status: ui.provider_profile_status.clone(),
            web_sign_in: ui.web_sign_in.clone(),
            web_browsers: ui.web_browsers.clone(),
            undo_toast: ui.undo_toast.clone(),
            terminals: TerminalsView::from_stores(s),
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
    /// A deep-link URL awaiting explicit user confirmation (CDX-013), with
    /// enough of its parsed content to show what it wants to pair with
    /// before the user confirms — the same narrow shape `candidate` uses,
    /// dropping the one-time token `ParsedPairingUrl` itself still carries.
    pub staged: Option<PairingCandidateView>,
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
            staged: p.staged.as_ref().map(|s| PairingCandidateView {
                pubkey_hex: s.pubkey_hex.clone(),
                npub: s.npub.clone(),
                machine: s.machine.clone(),
                relays: s.relays.clone(),
            }),
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
    pub fn empty() -> Self {
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
/// contract `TranscriptStoreState.entriesOf` has today — no pagination yet),
/// the sync status,
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

    /// Reads `after + 1..=local_high` from `transcript_store` (the row
    /// content; `after = 0` for all of it) and combines it with the in-memory
    /// sync/coverage state. A stored row never changes (rows are inserted
    /// once, ignoring seqs already present), so a caller holding the rows up
    /// to `after` reads only what came since — as long as the coverage up to
    /// `after` is still what it was. `transcript_store` is a port (SQLite on
    /// device), so this is the one view that needs I/O — every other
    /// `*View::from_stores` is a synchronous, in-memory snapshot.
    pub async fn load(
        transcript: &TranscriptState,
        transcript_store: &dyn TranscriptStore,
        machine: &str,
        session_id: &str,
        after: u64,
    ) -> Self {
        let sync = TranscriptSyncView::for_session(transcript, machine, session_id)
            .unwrap_or_else(TranscriptSyncView::empty);
        if sync.local_high <= after {
            return Self {
                rows: Vec::new(),
                have_ranges: transcript.have_ranges_of(machine, session_id),
                sync,
            };
        }
        let rows = transcript_store
            .read_range(machine, session_id, after + 1, sync.local_high)
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
    use crate::test_support::stores;

    #[test]
    fn connection_view_maps_the_status_string() {
        assert_eq!(
            ConnectionView::new(ConnectionStatus::WaitingRetry, true, vec![]).status,
            "waiting-retry"
        );
        let json = serde_json::to_string(&ConnectionView::new(ConnectionStatus::Connected, false, vec![]))
            .unwrap();
        assert_eq!(json, r#"{"status":"connected","needsPairingCheck":false,"connectedRelays":[]}"#);
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
