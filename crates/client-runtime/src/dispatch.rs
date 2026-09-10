//! `Router` — decoded `BridgeToPhone` → the `CoreStores` state machines. The
//! Rust mirror of the `handlers` table in `apps/mobile/src/core/createPhoneCore.ts`.
//!
//! `route` applies a message to the stores and returns a [`RouteResult`]: the
//! stores the runtime must re-serialize to the `Kv`, and any phone→bridge
//! commands the message provoked (a `sync-ack` after a durable chunk write, a
//! `sync-request` when `sync-end` left a gap). The event loop turns the sends
//! into signed commands and persists the named stores.
//!
//! Built in slices by message family; unhandled variants are a no-op until
//! their slice lands.

use std::collections::{HashMap, HashSet};

use client_core::crypto::Keypair;
use client_core::notifications::{
    classify_output_entry, is_agent_activity_entry, NotifyEffect, NotifyEvent,
};
use client_core::stores::pairing::{
    pairing_reducer, PairingEffect, PairingEvent, PAIR_ACK_TIMEOUT_MS,
};
use client_core::stores::transcript::SyncEffect;
use client_core::stores::ui::{CredentialsAckInput, PanelMode, ProviderProfileAckInput};
use client_core::wire::commands::{
    ModeChangeMsg, PairRequestMsg, PhoneToBridge, SyncAckMsg, SyncRequestMsg, VersionFields,
};
use client_core::wire::common::SessionState;
use client_core::wire::events::BridgeToPhone;

use crate::ports::{TranscriptRow, TranscriptStore};
use crate::stores::CoreStores;

/// A `client_core` store the runtime must re-serialize to the `Kv` after a
/// route mutated it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreId {
    Machines,
    Outbox,
    Dm,
    Marmot,
    Settings,
    QuickPrompts,
}

/// A phone→bridge command the loop must sign and publish.
#[derive(Debug, Clone, PartialEq)]
pub struct Send {
    pub machine: String,
    pub msg: PhoneToBridge,
}

/// What the CDX-040 pair-ack deadline timer should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairDeadline {
    Arm { ms: u64 },
    Clear,
}

/// What a routed message asks the event loop to do beyond the in-memory store
/// mutation `route` already applied.
#[derive(Debug, Default, PartialEq)]
pub struct RouteResult {
    /// Stores to re-serialize to the `Kv`.
    pub persist: Vec<StoreId>,
    /// Commands to build + publish.
    pub sends: Vec<Send>,
    /// Notification effects (ping / OS notify) from the coordinator.
    pub notifies: Vec<NotifyEffect>,
    /// A heartbeat to feed the connection FSM: `(machine, at_ms)`.
    pub heartbeat: Option<(String, u64)>,
    /// `(machine, session)` rows to drop from the transcript row store.
    pub transcript_removed: Vec<(String, String)>,
    /// The relay subscription authors filter changed — resubscribe.
    pub resubscribe: bool,
    /// Arm / clear the pair-ack deadline timer.
    pub pair_deadline: Option<PairDeadline>,
    /// CDX-028 one-QR mesh join: `(admin_npub, network_id)`.
    pub mesh_join: Option<(String, String)>,
    /// Outbox items settled this route: `(id, delivered)`.
    pub outbox_settled: Vec<(String, bool)>,
    /// The pair flow ended: `Some(true)` paired, `Some(false)` nack / timeout.
    pub pairing_settled: Option<bool>,
}

impl RouteResult {
    fn persist(&mut self, id: StoreId) {
        if !self.persist.contains(&id) {
            self.persist.push(id);
        }
    }

    fn send(&mut self, machine: &str, msg: PhoneToBridge) {
        self.sends.push(Send {
            machine: machine.to_string(),
            msg,
        });
    }
}

pub struct Router<'a> {
    pub stores: &'a mut CoreStores,
    pub transcript_store: &'a dyn TranscriptStore,
    /// Phone identity — stamps the `pair-request`, decides self vs incoming.
    pub identity: &'a Keypair,
    pub now: u64,
    /// App visibility (debounced) — the unread/notify gate.
    pub visible: bool,
    /// CDX-048 master toggle.
    pub notify_enabled: bool,
    /// A build with an in-app chime seam.
    pub ping_available: bool,
}

impl<'a> Router<'a> {
    /// A minimal router: visible, notifications on, no ping seam. Callers that
    /// care set the fields directly.
    pub fn new(
        stores: &'a mut CoreStores,
        transcript_store: &'a dyn TranscriptStore,
        identity: &'a Keypair,
        now: u64,
    ) -> Self {
        Self {
            stores,
            transcript_store,
            identity,
            now,
            visible: true,
            notify_enabled: true,
            ping_available: false,
        }
    }

    /// The user is looking at exactly this session right now (visible app,
    /// session panel, this machine+session selected) — such a session never
    /// gets an unread mark or a notification.
    fn viewing_session(&self, machine: &str, session_id: &str) -> bool {
        self.visible
            && self.stores.ui.panel_mode == PanelMode::Session
            && self.stores.ui.selected_machine.as_deref() == Some(machine)
            && self.stores.ui.selected_session.as_deref() == Some(session_id)
    }

    /// `session_key_of(selected)` when a session panel is in view, else `None`.
    fn active_session_key(&self) -> Option<String> {
        let ui = &self.stores.ui;
        if ui.panel_mode == PanelMode::Session {
            if let (Some(m), Some(s)) = (&ui.selected_machine, &ui.selected_session) {
                return Some(client_core::notifications::session_key_of(m, s));
            }
        }
        None
    }

    fn emit_notify(&mut self, event: &NotifyEvent) -> Vec<NotifyEffect> {
        let key = self.active_session_key();
        self.stores.notifications.emit(
            event,
            self.visible,
            self.notify_enabled,
            self.ping_available,
            key.as_deref(),
            self.now,
        )
    }

    pub async fn route(&mut self, machine: &str, msg: &BridgeToPhone) -> RouteResult {
        let mut r = RouteResult::default();
        match msg {
            // --- slice B: the heartbeat + session lifecycle ---
            BridgeToPhone::Sessions(m) => self.on_sessions(machine, m, &mut r).await,
            BridgeToPhone::SessionPending(m) => {
                self.stores.pending_sessions.apply_pending(
                    machine,
                    &m.pending_id,
                    &m.machine,
                    &m.created_at,
                    self.now,
                );
            }
            BridgeToPhone::SessionFailed(m) => {
                self.stores
                    .pending_sessions
                    .apply_failed(&m.pending_id, &m.reason, self.now);
                let fx = self.emit_notify(&NotifyEvent::SessionFailed {
                    machine: machine.to_string(),
                    session_id: m.pending_id.clone(),
                    reason: Some(m.reason.clone()).filter(|s| !s.is_empty()),
                });
                r.notifies.extend(fx);
            }
            BridgeToPhone::SessionReady(m) => {
                self.stores.pending_sessions.resolve(&m.pending_id);
                self.stores
                    .machines
                    .apply_session_upsert(machine, &m.session, self.now);
                r.persist(StoreId::Machines);
                // CDX-047: apply the "default mode for new sessions" preference
                // once, only when it differs from the mode it came up in.
                let want = self.stores.settings.data.default_mode;
                if let Some(mode) = self.stores.default_mode.apply(
                    machine,
                    &m.session.id,
                    m.session.permission_mode,
                    want,
                ) {
                    r.send(
                        machine,
                        PhoneToBridge::Mode(ModeChangeMsg {
                            version: VersionFields::default(),
                            session_id: m.session.id.clone(),
                            mode,
                        }),
                    );
                }
            }
            BridgeToPhone::CloseSessionAck(m) => {
                self.stores.machines.user_remove_session(machine, &m.session_id);
                self.stores.transcript.remove_session(machine, &m.session_id);
                r.transcript_removed
                    .push((machine.to_string(), m.session_id.clone()));
                r.persist(StoreId::Machines);
            }

            // --- slice D: the pair-ack (CDX-040/041/028) ---
            BridgeToPhone::PairAck(m) => self.on_pair_ack(machine, m, &mut r),

            BridgeToPhone::Output(m) => {
                let entry = to_value(&m.entry);
                self.apply_rows(machine, &m.session_id, vec![(m.seq, entry)])
                    .await;
                // Unread + notify on LIVE entries only (sync catch-up takes the
                // SyncChunk path, so replayed history never marks dots or fires
                // a notification storm). A card / stream_end / failure marks the
                // session unless the user is watching it; a live entry showing
                // the agent actively WORKING clears the dot. CDX-053: the clear
                // is gated on is_agent_activity_entry so the trailing
                // system/result/usage entries after stream_end can't wipe a
                // just-set dot.
                match classify_output_entry(machine, &m.session_id, &m.entry) {
                    Some(event) => {
                        if !self.viewing_session(machine, &m.session_id) {
                            self.stores.ui.mark_session_unread(machine, &m.session_id);
                        }
                        let fx = self.emit_notify(&event);
                        r.notifies.extend(fx);
                    }
                    None if is_agent_activity_entry(&m.entry) => {
                        self.stores.ui.clear_session_unread(machine, &m.session_id);
                    }
                    None => {}
                }
            }
            BridgeToPhone::SyncBegin(m) => {
                self.stores.transcript.apply_sync_begin(
                    machine,
                    &m.session_id,
                    &m.sync_id,
                    m.seq_high,
                );
            }
            BridgeToPhone::SyncChunk(m) => {
                let rows = m
                    .entries
                    .iter()
                    .map(|e| (e.seq, to_value(&e.entry)))
                    .collect();
                self.apply_rows(machine, &m.session_id, rows).await;
                // Ack AFTER the entries are durably stored — an ack must never
                // claim data we could still lose.
                r.send(
                    machine,
                    PhoneToBridge::SyncAck(SyncAckMsg {
                        version: VersionFields::default(),
                        sync_id: m.sync_id.clone(),
                        range: m.range,
                    }),
                );
            }
            BridgeToPhone::SyncEnd(m) => {
                let effects = self
                    .stores
                    .transcript
                    .apply_sync_end(machine, &m.session_id, self.now);
                for e in effects {
                    r.send(machine, sync_effect_to_cmd(e));
                }
            }
            BridgeToPhone::InputAck(m) => {
                self.stores.outbox.confirm(&m.input_id, self.now);
                r.persist(StoreId::Outbox);
                r.outbox_settled.push((m.input_id.clone(), true));
            }
            BridgeToPhone::InputFailed(m) => {
                if let Some(id) = &m.input_id {
                    let reason = to_value(&m.reason)
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_default();
                    self.stores.outbox.fail(id, reason, self.now);
                    r.persist(StoreId::Outbox);
                    r.outbox_settled.push((id.clone(), false));
                }
            }

            // --- slice C: machines-slice updates + fire-and-answer acks ---
            BridgeToPhone::Models(m) => {
                self.stores.machines.apply_models(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::Usage(m) => {
                self.stores
                    .machines
                    .apply_usage(machine, &m.session_id, m.usage.clone());
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::GsdState(m) => {
                self.stores
                    .machines
                    .apply_gsd(machine, &m.session_id, m.gsd.clone());
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::SessionReplaced(m) => {
                self.stores.machines.apply_session_replaced(
                    machine,
                    &m.old_session_id,
                    &m.new_session,
                    self.now,
                );
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::ModeConfirmed(m) => {
                let mode = m.mode;
                self.stores
                    .machines
                    .update_session_info(machine, &m.session_id, |info| {
                        info.permission_mode = Some(mode);
                    });
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::EffortConfirmed(m) => {
                let level = m.level;
                self.stores
                    .machines
                    .update_session_info(machine, &m.session_id, |info| {
                        info.effort_level = Some(level);
                    });
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::ModelConfirmed(m) => {
                let model = m.model.clone();
                self.stores
                    .machines
                    .update_session_info(machine, &m.session_id, |info| {
                        info.model = Some(model.clone());
                    });
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::ProviderProfiles(m) => {
                self.stores.machines.apply_provider_profiles(machine, m);
                // CDX-062: provider profiles are never persisted.
            }
            BridgeToPhone::CredentialsAck(m) => {
                self.stores.ui.apply_credentials_ack(
                    machine,
                    CredentialsAckInput {
                        success: m.success,
                        has_anthropic_key: m.has_anthropic_key,
                        has_github_pat: m.has_github_pat,
                        key_valid: m.key_valid,
                        error: m.error.clone(),
                    },
                    self.now,
                );
            }
            BridgeToPhone::DeviceConfigAck(m) => {
                self.stores
                    .ui
                    .apply_device_config_ack(machine, m.success, m.error.clone(), self.now);
            }
            BridgeToPhone::ProviderProfileAck(m) => {
                self.stores.ui.apply_provider_profile_ack(
                    machine,
                    ProviderProfileAckInput {
                        profile_id: m.profile_id.clone(),
                        success: m.success,
                        token_valid: m.token_valid,
                        error: m.error.clone(),
                    },
                    self.now,
                );
            }

            // Remaining families land in later slices.
            _ => {}
        }
        r
    }

    /// Insert rows through the [`TranscriptStore`] port, then fold the inserted
    /// seqs (and any content conflicts on already-stored seqs) into the pure
    /// [`client_core::stores::transcript::TranscriptState`].
    async fn apply_rows(
        &mut self,
        machine: &str,
        session: &str,
        rows: Vec<(u64, serde_json::Value)>,
    ) {
        if rows.is_empty() {
            return;
        }
        let store_rows: Vec<TranscriptRow> = rows
            .iter()
            .map(|(seq, entry)| TranscriptRow {
                seq: *seq,
                entry: entry.clone(),
            })
            .collect();
        let inserted = self
            .transcript_store
            .insert_ignore(machine, session, &store_rows)
            .await;
        let inserted_set: HashSet<u64> = inserted.iter().copied().collect();

        // Already stored: same seq must mean same content — anything else is
        // renumbering, which we record and refuse to apply.
        let mut conflicts = Vec::new();
        let non_inserted: Vec<u64> = rows
            .iter()
            .map(|(seq, _)| *seq)
            .filter(|seq| !inserted_set.contains(seq))
            .collect();
        if !non_inserted.is_empty() {
            let lo = non_inserted.iter().copied().min().unwrap();
            let hi = non_inserted.iter().copied().max().unwrap();
            let stored: HashMap<u64, serde_json::Value> = self
                .transcript_store
                .read_range(machine, session, lo, hi)
                .await
                .into_iter()
                .map(|row| (row.seq, row.entry))
                .collect();
            for (seq, entry) in &rows {
                if inserted_set.contains(seq) {
                    continue;
                }
                if let Some(existing) = stored.get(seq) {
                    if existing != entry {
                        conflicts.push(*seq);
                    }
                }
            }
        }

        self.stores
            .transcript
            .integrate_rows(machine, session, &inserted, &conflicts);
    }

    /// The heartbeat. Port of `createPhoneCore`'s `onSessions` handler.
    async fn on_sessions(
        &mut self,
        machine: &str,
        m: &client_core::wire::events::SessionListMsg,
        r: &mut RouteResult,
    ) {
        // CDX-013: only a PAIRED machine may create/update its entry. The
        // pairing candidate is let through the ingest gate (its pair-ack must
        // arrive) but must not self-register by sending a session list.
        if self.stores.machines.machine(machine).is_none() {
            return;
        }

        // CDX-026b: capture the pre-merge session states — a backgrounded phone
        // catching up over sync never sees live cards, so the heartbeat
        // TRANSITION into a waiting state is the truthful attention signal.
        let prev: HashMap<String, Option<SessionState>> = self
            .stores
            .machines
            .machine(machine)
            .map(|mv| {
                mv.sessions
                    .iter()
                    .map(|(id, v)| (id.clone(), v.info.state))
                    .collect()
            })
            .unwrap_or_default();

        self.stores.machines.apply_session_list(machine, m, self.now);
        r.persist(StoreId::Machines);
        r.heartbeat = Some((machine.to_string(), self.now));

        let is_waiting = |s: Option<SessionState>| {
            matches!(
                s,
                Some(SessionState::WaitingPermission) | Some(SessionState::WaitingQuestion)
            )
        };
        for info in &m.sessions {
            if self.stores.machines.dismissed_sessions.contains_key(&info.id) {
                continue;
            }
            let prev_state = prev.get(&info.id).copied().flatten();
            let entered_waiting = is_waiting(info.state) && !is_waiting(prev_state);
            // running → idle is the truthful "Claude finished" signal for a
            // backgrounded phone (sync catch-up never replays live stream_end).
            let turn_finished =
                info.state == Some(SessionState::Idle) && prev_state == Some(SessionState::Running);
            if !entered_waiting && !turn_finished {
                continue;
            }
            if self.viewing_session(machine, &info.id) {
                continue;
            }
            self.stores.ui.mark_session_unread(machine, &info.id);
            let event = if turn_finished {
                NotifyEvent::SessionFinished {
                    machine: machine.to_string(),
                    session_id: info.id.clone(),
                }
            } else if info.state == Some(SessionState::WaitingPermission) {
                NotifyEvent::PermissionRequest {
                    machine: machine.to_string(),
                    session_id: info.id.clone(),
                    tool_name: None,
                }
            } else {
                NotifyEvent::Question {
                    machine: machine.to_string(),
                    session_id: info.id.clone(),
                }
            };
            let fx = self.emit_notify(&event);
            r.notifies.extend(fx);
        }

        for id in m.removed_sessions.iter().flatten() {
            self.stores.transcript.remove_session(machine, id);
            r.transcript_removed.push((machine.to_string(), id.clone()));
        }

        // A pending placeholder whose session shows up in the list is resolved
        // (the bridge reuses the sessionId as the pendingId).
        for info in &m.sessions {
            self.stores.pending_sessions.resolve(&info.id);
        }
        self.stores.pending_sessions.sweep(self.now);

        // Self-healing transcripts: any advertised seqHigh above local coverage
        // starts (or backoff-gates) a sync cycle.
        let targets: Vec<(String, u64)> = self
            .stores
            .machines
            .machine(machine)
            .map(|mv| {
                mv.sessions
                    .iter()
                    .filter_map(|(id, v)| v.info.seq_high.map(|h| (id.clone(), h)))
                    .collect()
            })
            .unwrap_or_default();
        for (session_id, target) in targets {
            if target > 0 {
                let fx =
                    self.stores
                        .transcript
                        .ensure_synced(machine, &session_id, target, self.now);
                for e in fx {
                    r.send(machine, sync_effect_to_cmd(e));
                }
            }
        }

        self.stores.outbox.sweep(self.now);
        r.persist(StoreId::Outbox);
    }

    /// The `pair-ack`. Runs the pairing reducer and interprets its effects:
    /// register the machine, learn its relays, disarm the CDX-040 deadline,
    /// refresh the subscription authors, and hand off a bundled mesh join.
    fn on_pair_ack(
        &mut self,
        machine: &str,
        m: &client_core::wire::events::PairAckMsg,
        r: &mut RouteResult,
    ) {
        let result = pairing_reducer(
            &self.stores.pairing,
            PairingEvent::PairAck {
                machine_pubkey: machine.to_string(),
                msg: m.clone(),
            },
            PAIR_ACK_TIMEOUT_MS,
        );
        self.stores.pairing = result.state;
        r.pairing_settled = match self.stores.pairing.phase {
            client_core::stores::pairing::PairingPhase::Paired => Some(true),
            client_core::stores::pairing::PairingPhase::Failed => Some(false),
            _ => None,
        };

        for effect in result.effects {
            match effect {
                PairingEffect::DisarmDeadline => r.pair_deadline = Some(PairDeadline::Clear),
                PairingEffect::ArmDeadline { ms } => {
                    r.pair_deadline = Some(PairDeadline::Arm { ms })
                }
                PairingEffect::NotifyCandidate(_) => r.resubscribe = true,
                PairingEffect::SendPairRequest { to, label, token } => {
                    r.send(
                        &to,
                        PhoneToBridge::PairRequest(PairRequestMsg {
                            version: VersionFields::default(),
                            npub: self.identity.npub.clone(),
                            pubkey_hex: self.identity.pubkey_hex.clone(),
                            label,
                            token,
                        }),
                    );
                }
                PairingEffect::OnPaired {
                    candidate,
                    machine_name,
                    host,
                } => {
                    self.stores.machines.register_machine(
                        &candidate.pubkey_hex,
                        &machine_name,
                        Some(candidate.machine.clone()),
                        host,
                    );
                    if !candidate.relays.is_empty() {
                        self.stores.settings.add_relays(&candidate.relays);
                        r.persist(StoreId::Settings);
                    }
                    if let (Some(admin), Some(netid)) =
                        (candidate.mesh_admin.clone(), candidate.netid.clone())
                    {
                        r.mesh_join = Some((admin, netid));
                    }
                    r.persist(StoreId::Machines);
                    r.resubscribe = true;
                }
            }
        }
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

fn sync_effect_to_cmd(effect: SyncEffect) -> PhoneToBridge {
    match effect {
        SyncEffect::SendSyncRequest {
            session_id,
            have_ranges,
        } => PhoneToBridge::SyncRequest(SyncRequestMsg {
            version: VersionFields::default(),
            session_id,
            have_ranges,
        }),
        SyncEffect::SendSyncAck { sync_id, range } => PhoneToBridge::SyncAck(SyncAckMsg {
            version: VersionFields::default(),
            sync_id,
            range,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::MemoryTranscriptStore;
    use crate::stores::{hydrate, StoresConfig};
    use crate::ports::MemoryKv;
    use client_core::stores::outbox::{OutboxItemState, OutboxState};
    use client_core::wire::events::{
        InputAckMsg, InputFailedMsg, OutputMsg, SessionListMsg, SessionReadyMsg, SyncChunkMsg,
        SyncEndMsg,
    };
    use client_core::wire::common::{
        OutputEntry, OutputEntryType, PermissionMode, RemoteSessionInfo, SessionState,
    };
    use serde_json::json;

    const MACHINE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn info(id: &str, state: Option<SessionState>, seq_high: Option<u64>) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: id.into(),
            slug: format!("slug-{id}"),
            cwd: "/w".into(),
            last_activity: "t".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
            permission_mode: None,
            effort_level: None,
            model: None,
            context_window: None,
            context_percentage: None,
            committed: None,
            state,
            seq_high,
            provider_id: None,
            provider_label: None,
        }
    }

    fn sessions_msg(sessions: Vec<RemoteSessionInfo>) -> SessionListMsg {
        SessionListMsg {
            machine: "laptop".into(),
            host: None,
            sessions,
            auth_status: None,
            protocol_version: 10,
            capabilities: None,
            folders: None,
            roots: None,
            removed_sessions: None,
            machine_offline: None,
        }
    }

    async fn stores() -> (CoreStores, MemoryTranscriptStore, Keypair) {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        (h.stores, ts, h.keypair)
    }

    fn text_entry(content: &str) -> OutputEntry {
        OutputEntry {
            entry_type: OutputEntryType::Text,
            content: content.to_string(),
            timestamp: "t".to_string(),
            metadata: None,
            diff: None,
        }
    }

    #[tokio::test]
    async fn output_stores_the_row_and_advances_coverage() {
        let (mut s, ts, kp) = stores().await;
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("hello"),
                }),
            )
            .await;
        assert_eq!(out, RouteResult::default());
        assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1]);
        assert!(s.transcript.has_contiguous(MACHINE, "s1", Some(1)));
    }

    #[tokio::test]
    async fn a_live_permission_card_marks_unread_and_notifies_then_agent_activity_clears_it() {
        let (mut s, ts, kp) = stores().await;
        let card = OutputEntry {
            entry_type: OutputEntryType::System,
            content: String::new(),
            timestamp: "t".into(),
            metadata: Some(json!({ "special": "permission_request", "tool_name": "Bash" })),
            diff: None,
        };
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.visible = false; // backgrounded → OS notify
            let out = r
                .route(
                    MACHINE,
                    &BridgeToPhone::Output(OutputMsg {
                        session_id: "s1".into(),
                        seq: 1,
                        entry: card,
                    }),
                )
                .await;
            assert!(matches!(out.notifies.as_slice(), [NotifyEffect::Notify { .. }]));
        }
        assert!(s.ui.is_session_unread(MACHINE, "s1"));

        // a plain assistant text entry = the agent working → clears the dot
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        r.route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 2,
                entry: text_entry("working on it"),
            }),
        )
        .await;
        assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    }

    #[tokio::test]
    async fn a_re_delivered_seq_with_different_content_is_a_recorded_conflict() {
        let (mut s, ts, kp) = stores().await;
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("first"),
                }),
            )
            .await;
        }
        {
            let mut r = Router::new(&mut s, &ts, &kp, 2_000);
            r.route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entry: text_entry("REWRITTEN"),
                }),
            )
            .await;
        }
        assert_eq!(s.transcript.seq_conflicts.len(), 1);
        assert_eq!(s.transcript.seq_conflicts[0].seq, 1);
        // the stored row is untouched — the first content wins
        let rows = ts.read_range(MACHINE, "s1", 1, 1).await;
        assert_eq!(rows[0].entry, json!({ "entryType": "text", "content": "first", "timestamp": "t" }));
    }

    #[tokio::test]
    async fn sync_chunk_stores_then_acks_after_the_write() {
        let (mut s, ts, kp) = stores().await;
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SyncChunk(SyncChunkMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    range: (1, 2),
                    entries: vec![
                        client_core::wire::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        client_core::wire::events::SyncEntry { seq: 2, entry: text_entry("b") },
                    ],
                }),
            )
            .await;
        assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1, 2]);
        assert_eq!(
            out.sends,
            vec![Send {
                machine: MACHINE.to_string(),
                msg: PhoneToBridge::SyncAck(SyncAckMsg {
                    version: VersionFields::default(),
                    sync_id: "sy1".into(),
                    range: (1, 2),
                }),
            }]
        );
    }

    #[tokio::test]
    async fn sync_end_with_a_gap_re_requests() {
        let (mut s, ts, kp) = stores().await;
        // seq 5 is advertised but only 1..=2 are covered
        s.transcript.apply_sync_begin(MACHINE, "s1", "sy1", 5);
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.route(
                MACHINE,
                &BridgeToPhone::SyncChunk(SyncChunkMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    range: (1, 2),
                    entries: vec![
                        client_core::wire::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        client_core::wire::events::SyncEntry { seq: 2, entry: text_entry("b") },
                    ],
                }),
            )
            .await;
        }
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SyncEnd(SyncEndMsg {
                    session_id: "s1".into(),
                    sync_id: "sy1".into(),
                    delivered_ranges: vec![(1, 2)],
                }),
            )
            .await;
        assert!(matches!(
            out.sends.as_slice(),
            [Send { msg: PhoneToBridge::SyncRequest(m), .. }] if m.session_id == "s1"
        ));
    }

    #[tokio::test]
    async fn input_ack_confirms_the_outbox_item_and_asks_for_a_persist() {
        let (mut s, ts, kp) = stores().await;
        let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
        s.outbox.begin_publish(item);
        s.outbox.settle_publish("in-1", true, None, 600);

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::InputAck(InputAckMsg {
                    session_id: "s1".into(),
                    input_id: "in-1".into(),
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Outbox]);
        assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Confirmed);
    }

    #[tokio::test]
    async fn a_session_list_from_an_unpaired_machine_is_dropped() {
        let (mut s, ts, kp) = stores().await;
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Sessions(sessions_msg(vec![info("s1", None, None)])),
            )
            .await;
        assert_eq!(out, RouteResult::default());
        assert!(s.machines.machine(MACHINE).is_none());
    }

    #[tokio::test]
    async fn a_heartbeat_transition_into_waiting_marks_unread_notifies_and_feeds_the_fsm() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        // first sight: running — no transition
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            let out = r
                .route(
                    MACHINE,
                    &BridgeToPhone::Sessions(sessions_msg(vec![info(
                        "s1",
                        Some(SessionState::Running),
                        None,
                    )])),
                )
                .await;
            assert!(out.notifies.is_empty());
            assert_eq!(out.heartbeat, Some((MACHINE.to_string(), 1_000)));
            assert!(!s.ui.is_session_unread(MACHINE, "s1"));
        }
        // now it enters waiting_permission while the phone is backgrounded →
        // mark + OS notify
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        r.visible = false;
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Sessions(sessions_msg(vec![info(
                    "s1",
                    Some(SessionState::WaitingPermission),
                    None,
                )])),
            )
            .await;
        assert!(s.ui.is_session_unread(MACHINE, "s1"));
        assert!(matches!(
            out.notifies.as_slice(),
            [NotifyEffect::Notify { .. }]
        ));
        assert!(out.persist.contains(&StoreId::Machines));
    }

    #[tokio::test]
    async fn the_foreground_watched_session_is_never_marked_or_notified() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        s.ui.select_session(MACHINE, Some("s1"), true);
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Sessions(sessions_msg(vec![info(
                    "s1",
                    Some(SessionState::WaitingPermission),
                    None,
                )])),
            )
            .await;
        assert!(!s.ui.is_session_unread(MACHINE, "s1"));
        assert!(out.notifies.is_empty());
    }

    #[tokio::test]
    async fn session_ready_upserts_the_session_and_applies_the_default_mode_once() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        s.settings.data.default_mode = PermissionMode::AcceptEdits;

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        // session came up in plan (bridge default) → a differing preference sends a mode
        let mut ready = info("s1", Some(SessionState::Idle), None);
        ready.permission_mode = Some(PermissionMode::Plan);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SessionReady(SessionReadyMsg {
                    pending_id: "s1".into(),
                    session: ready.clone(),
                }),
            )
            .await;
        assert!(s.machines.session(MACHINE, "s1").is_some());
        assert!(matches!(
            out.sends.as_slice(),
            [Send { msg: PhoneToBridge::Mode(m), .. }]
                if m.mode == PermissionMode::AcceptEdits && m.session_id == "s1"
        ));

        // a replayed session-ready never re-sends
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SessionReady(SessionReadyMsg {
                    pending_id: "s1".into(),
                    session: ready,
                }),
            )
            .await;
        assert!(out.sends.is_empty());
    }

    #[tokio::test]
    async fn close_session_ack_removes_the_session_locally() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        s.machines.apply_session_upsert(MACHINE, &info("s1", None, None), 0);
        ts.insert_ignore(
            MACHINE,
            "s1",
            &[TranscriptRow { seq: 1, entry: json!({}) }],
        )
        .await;

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::CloseSessionAck(client_core::wire::events::CloseSessionAckMsg {
                    session_id: "s1".into(),
                    success: true,
                }),
            )
            .await;
        assert!(s.machines.session(MACHINE, "s1").is_none());
        assert_eq!(
            out.transcript_removed,
            vec![(MACHINE.to_string(), "s1".to_string())]
        );
    }

    #[tokio::test]
    async fn a_pair_ack_registers_the_machine_learns_its_relays_and_disarms_the_deadline() {
        use client_core::stores::pairing::{PairingCandidate, PairingPhase, PairingState};
        use client_core::wire::capabilities::BridgeHostKind;
        use client_core::wire::events::PairAckMsg;

        let (mut s, ts, kp) = stores().await;
        s.pairing = PairingState {
            phase: PairingPhase::AwaitingAck,
            candidate: Some(PairingCandidate {
                pubkey_hex: MACHINE.into(),
                npub: "npub1candidate".into(),
                machine: "(manual)".into(),
                relays: vec!["wss://learned.example".into()],
                token: "tok".into(),
                netid: None,
                mesh_admin: None,
            }),
            error: None,
            timed_out: false,
            staged: None,
        };

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::PairAck(PairAckMsg {
                    machine: "laptop".into(),
                    ok: true,
                    reason: None,
                    relays: None,
                    host: Some(BridgeHostKind::Cli),
                }),
            )
            .await;

        assert_eq!(s.pairing.phase, PairingPhase::Paired);
        let mv = s.machines.machine(MACHINE).expect("registered");
        assert_eq!(mv.name, "laptop");
        assert!(s
            .settings
            .data
            .relays
            .iter()
            .any(|r| r == "wss://learned.example"));
        assert_eq!(out.pair_deadline, Some(PairDeadline::Clear));
        assert!(out.resubscribe);
        assert!(out.persist.contains(&StoreId::Machines));
        assert!(out.persist.contains(&StoreId::Settings));
    }

    #[tokio::test]
    async fn credentials_ack_lands_in_the_ui_slice_transiently() {
        let (mut s, ts, kp) = stores().await;
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::CredentialsAck(
                    client_core::wire::events::CredentialsAckMsg {
                        machine: "laptop".into(),
                        success: true,
                        has_anthropic_key: true,
                        has_github_pat: false,
                        key_valid: Some(true),
                        error: None,
                    },
                ),
            )
            .await;
        assert!(out.persist.is_empty()); // acks are transient
        let ack = &s.ui.credentials_status[MACHINE];
        assert_eq!(ack.state, client_core::stores::ui::AckState::Saved);
        assert_eq!(ack.key_valid, Some(true));
    }

    #[tokio::test]
    async fn models_updates_the_machine_and_asks_for_a_persist() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Models(client_core::wire::events::ModelsMsg {
                    models: vec![client_core::wire::events::ModelEntry {
                        id: "sonnet".into(),
                        label: Some("Sonnet".into()),
                    }],
                    default_model: Some("sonnet".into()),
                    error: None,
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Machines]);
        assert_eq!(
            s.machines.machine(MACHINE).unwrap().models.as_ref().unwrap()[0].id,
            "sonnet"
        );
    }

    #[tokio::test]
    async fn mode_confirmed_writes_through_to_the_session_info() {
        use client_core::wire::common::{PermissionMode, RemoteSessionInfo};
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None);
        s.machines.apply_session_upsert(
            MACHINE,
            &RemoteSessionInfo {
                id: "s1".into(),
                slug: "s".into(),
                cwd: "/w".into(),
                last_activity: "t".into(),
                line_count: 0,
                title: None,
                project: "p".into(),
                permission_mode: None,
                effort_level: None,
                model: None,
                context_window: None,
                context_percentage: None,
                committed: None,
                state: None,
                seq_high: None,
                provider_id: None,
                provider_label: None,
            },
            0,
        );
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.route(
            MACHINE,
            &BridgeToPhone::ModeConfirmed(client_core::wire::events::ModeConfirmedMsg {
                session_id: "s1".into(),
                mode: PermissionMode::AcceptEdits,
            }),
        )
        .await;
        assert_eq!(
            s.machines.session(MACHINE, "s1").unwrap().info.permission_mode,
            Some(PermissionMode::AcceptEdits)
        );
    }

    #[tokio::test]
    async fn input_failed_marks_the_item_failed_with_the_wire_reason() {
        let (mut s, ts, kp) = stores().await;
        let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
        s.outbox.begin_publish(item);
        s.outbox.settle_publish("in-1", true, None, 600);

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::InputFailed(InputFailedMsg {
                    session_id: "s1".into(),
                    reason: client_core::wire::events::InputFailedReason::Busy,
                    input_id: Some("in-1".into()),
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Outbox]);
        assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Failed);
        assert_eq!(s.outbox.items["in-1"].error.as_deref(), Some("busy"));
    }
}
