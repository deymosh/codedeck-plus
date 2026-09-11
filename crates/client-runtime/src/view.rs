//! Views — the read-only, per-capability projections the bindings serialize
//! and hand to the UI (migration plan §2.1). Plain serde data, sliced so a
//! consumer subscribes only to what it paints.
//!
//! The store `*State` structs were designed as the serde wire shape, so the
//! machines / outbox / settings views are thin newtypes over their public
//! sub-state. `connection` is FSM-backed (the loop passes it in); `pairing`
//! has no `Serialize` and is projected by hand. Transcript rows and the
//! interaction-card view are row-backed and land with the loop integration.

use std::collections::BTreeMap;

use client_core::connection::ConnectionStatus;
use client_core::stores::dm::{DmConversation, DmMessage};
use client_core::stores::machines::MachineView;
use client_core::stores::outbox::OutboxItem;
use client_core::stores::pairing::{PairingPhase, PairingState};
use client_core::stores::settings::SettingsData;
use client_core::stores::transcript::{SyncState, TranscriptState};
use serde::Serialize;

use crate::stores::CoreStores;

// --- connection ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SettingsView(pub SettingsData);

impl SettingsView {
    pub fn from_stores(s: &CoreStores) -> Self {
        Self(s.settings.data.clone())
    }
}

// --- pairing ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmView {
    /// Conversations newest-first (by `last_message_at`).
    pub conversations: Vec<DmConversation>,
    /// `peer` → messages ascending by `at`.
    pub messages: BTreeMap<String, Vec<DmMessage>>,
    pub active_peer: Option<String>,
    /// 1059 events seen / unwrap failures / non-DM rumors (CD-001 diagnostics).
    pub events_received: u64,
    pub unwrap_failures: u64,
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

// --- transcript sync status (the non-row half) -------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSyncView {
    pub state: SyncState,
    pub attempts: u32,
    pub next_retry_at: Option<u64>,
    /// Highest locally-stored seq.
    pub local_high: u64,
    /// seqHigh the current cycle is trying to cover.
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
