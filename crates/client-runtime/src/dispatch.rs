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

use client_core::notifications::{
    classify_output_entry, is_agent_activity_entry, EmitInputs, NotifyEffect,
    NotifyEvent,
};
use client_core::stores::pairing::{
    pairing_reducer, PairingEffect, PairingEvent, PAIR_ACK_TIMEOUT_MS,
};
use client_core::stores::fetches::Fetch;
use client_core::stores::transcript::SyncEffect;
use client_core::stores::ui::{CredentialsAckInput, ProviderProfileAckInput};
use protocol::commands::{
    BareMsg, PairRequestMsg, PhoneToBridge, SyncAckMsg, SyncRequestMsg, VersionFields,
};
use protocol::common::{SessionOption, SessionState};
use protocol::events::BridgeToPhone;

use crate::ports::{TranscriptRow, TranscriptStore};
use crate::signer::PhoneKeys;
use crate::stores::CoreStores;

/// A `client_core` store the runtime must re-serialize to the `Kv` after a
/// route mutated it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreId {
    Machines,
    Outbox,
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
    /// Outbox items settled this route: `(id, delivered)`.
    pub outbox_settled: Vec<(String, bool)>,
    /// The pair flow ended: `Some(true)` paired, `Some(false)` nack / timeout.
    pub pairing_settled: Option<bool>,
    /// `pending_sessions` changed — not persisted (a placeholder is meaningless
    /// after a restart), so this is the only signal a `PendingSessionsView`
    /// consumer gets that a re-fetch is worth doing.
    pub pending_sessions_changed: bool,
    /// `stores.ui` changed in a way worth a `UiView` re-fetch. Deliberately
    /// NOT set for the high-frequency per-output-chunk unread-clear path
    /// (`is_agent_activity_entry`) — that would fire on nearly every streamed
    /// token of an unfocused session. `mark_session_unread` (paired with an
    /// existing notify) and the ack handlers below are low-frequency enough
    /// to notify every time.
    pub ui_changed: bool,
    /// `(machine, session_id)` new transcript rows landed for — `Output` or
    /// `SyncChunk`. Unlike `ui_changed` this DOES fire on every live output
    /// chunk: a transcript view's whole purpose is to look live, so silence
    /// here would read as a frozen session, not a stale dot.
    pub transcript_appended: Option<(String, String)>,
    /// A `folder-ack` arrived — the correlated response to `Intent::CreateFolder`.
    /// Not store-backed (nothing to persist or re-fetch a view for): the
    /// caller matches it by `request_id` off the `CoreEvent` stream, same
    /// shape as `outbox_settled`/`pairing_settled` above.
    pub folder_ack: Option<protocol::events::FolderAckMsg>,
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
    /// The phone's keys — the `pair-request` names them.
    pub keys: &'a PhoneKeys,
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
        keys: &'a PhoneKeys,
        now: u64,
    ) -> Self {
        Self {
            stores,
            transcript_store,
            keys,
            now,
            visible: true,
            notify_enabled: true,
            ping_available: false,
        }
    }

    /// The user is looking at exactly this session right now (visible app,
    /// this machine+session selected) — such a session never gets an unread
    /// mark or a notification.
    fn viewing_session(&self, machine: &str, session_id: &str) -> bool {
        self.visible
            && self.stores.ui.selected_machine.as_deref() == Some(machine)
            && self.stores.ui.selected_session.as_deref() == Some(session_id)
    }

    /// `session_key_of(selected)` when a session is selected, else `None`.
    fn active_session_key(&self) -> Option<String> {
        let ui = &self.stores.ui;
        match (&ui.selected_machine, &ui.selected_session) {
            (Some(m), Some(s)) => Some(client_core::notifications::session_key_of(m, s)),
            _ => None,
        }
    }

    fn emit_notify(&mut self, event: &NotifyEvent) -> Vec<NotifyEffect> {
        let key = self.active_session_key();
        let (m, s) = event.session();
        let labels = self.stores.notification_labels(m, s);
        let context = labels.context();
        self.stores.notifications.emit(
            event,
            EmitInputs {
                visible: self.visible,
                enabled: self.notify_enabled,
                ping_available: self.ping_available,
                active_session_key: key.as_deref(),
                context,
                now: self.now,
            },
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
                r.pending_sessions_changed = true;
            }
            BridgeToPhone::SessionFailed(m) => {
                let news = self
                    .stores
                    .pending_sessions
                    .apply_failed(&m.pending_id, &m.reason, self.now);
                r.pending_sessions_changed = true;
                if news {
                    let fx = self.emit_notify(&NotifyEvent::SessionFailed {
                        machine: machine.to_string(),
                        session_id: m.pending_id.clone(),
                        reason: Some(m.reason.clone()).filter(|s| !s.is_empty()),
                    });
                    r.notifies.extend(fx);
                }
            }
            BridgeToPhone::SessionReady(m) => {
                if self.stores.pending_sessions.contains(&m.pending_id) {
                    self.stores.pending_sessions.resolve(&m.pending_id);
                    r.pending_sessions_changed = true;
                }
                self.stores
                    .machines
                    .apply_session_upsert(machine, &m.session, self.now);
                r.persist(StoreId::Machines);
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

            BridgeToPhone::FolderAck(m) => {
                r.folder_ack = Some(m.clone());
            }

            BridgeToPhone::Output(m) => {
                // A deleted session's output is a replay (a direct link
                // resuming re-sends the last hour), and its transcript is gone
                // with the close-session-ack: storing it would bring the rows
                // back and its final entry would notify as if new.
                if self.stores.machines.is_dismissed(&m.session_id, self.now) {
                    return r;
                }
                let rows = m.numbered().map(|(seq, e)| (seq, to_value(e))).collect();
                let inserted = self.apply_rows(machine, &m.session_id, rows).await;
                r.transcript_appended = Some((machine.to_string(), m.session_id.clone()));
                // An entry already in the transcript is a replay, not news: a
                // direct link resuming from an older cursor after the app was
                // killed re-sends output the phone stored (and notified about)
                // before, and a second copy over another path is the same
                // entry. Neither may notify or mark the session again.
                for (_, entry) in m.numbered().filter(|(seq, _)| inserted.contains(seq)) {
                    // Unread + notify on LIVE entries only (sync catch-up takes
                    // the SyncChunk path, so replayed history never marks dots
                    // or fires a notification storm). A card / stream_end /
                    // failure marks the session unless the user is watching
                    // it; a live entry showing the agent actively WORKING
                    // clears the dot. CDX-053: the clear is gated on
                    // is_agent_activity_entry so the trailing
                    // system/result/usage entries after stream_end can't wipe
                    // a just-set dot.
                    match classify_output_entry(machine, &m.session_id, entry) {
                        Some(event) => {
                            if !self.viewing_session(machine, &m.session_id) {
                                self.stores.ui.mark_session_unread(machine, &m.session_id);
                                r.ui_changed = true;
                            }
                            let fx = self.emit_notify(&event);
                            r.notifies.extend(fx);
                        }
                        None if is_agent_activity_entry(entry) => {
                            self.stores.ui.clear_session_unread(machine, &m.session_id);
                        }
                        None => {}
                    }
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
                r.transcript_appended = Some((machine.to_string(), m.session_id.clone()));
                // Ack AFTER the entries are durably stored — an ack must never
                // claim data we could still lose.
                r.send(
                    machine,
                    PhoneToBridge::SyncAck(SyncAckMsg {
                        version: VersionFields::default(),
                        sync_id: m.sync_id.clone(),
                        ranges: vec![m.range],
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
                // An empty list comes with the reason: ask again next time.
                let fetch = Fetch::Models(m.agent.clone());
                if m.models.is_empty() {
                    self.stores.machines.fetches.forget(machine, fetch);
                } else {
                    self.stores.machines.fetches.answered(machine, fetch, self.now);
                }
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::Usage(m) => {
                self.stores
                    .machines
                    .apply_usage(machine, &m.session_id, m.usage.clone());
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::Plugins(m) => {
                self.stores.machines.apply_plugins(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::PluginAck(m) => {
                self.stores.machines.apply_plugin_ack(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::McpServers(m) => {
                self.stores.machines.apply_mcp(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::McpAck(m) => {
                self.stores.machines.apply_mcp_ack(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::SessionMcp(m) => {
                self.stores.machines.apply_session_mcp(machine, m);
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::Commands(m) => {
                self.stores.machines.apply_commands(machine, m);
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
            BridgeToPhone::OptionConfirmed(m) => {
                let value = m.value.clone();
                let option = m.option;
                self.stores
                    .machines
                    .update_session_info(machine, &m.session_id, |info| match option {
                        SessionOption::Mode => info.mode = Some(value),
                        SessionOption::Effort => info.effort = Some(value),
                        SessionOption::Model => info.model = Some(value),
                    });
                r.persist(StoreId::Machines);
            }
            BridgeToPhone::ProviderProfiles(m) => {
                self.stores.machines.apply_provider_profiles(machine, m);
                self.stores.machines.fetches.answered(machine, Fetch::ProviderProfiles, self.now);
                // CDX-062: provider profiles are never persisted.
            }
            BridgeToPhone::CredentialsAck(m) => {
                self.stores.ui.apply_credentials_ack(
                    machine,
                    CredentialsAckInput {
                        success: m.success,
                        agent: m.agent.clone(),
                        error: m.error.clone(),
                    },
                    self.now,
                );
                r.ui_changed = true;
                if m.success {
                    self.stores.machines.apply_credential_statuses(
                        machine,
                        m.agent.as_deref(),
                        &m.credentials,
                    );
                    // New credentials can change what the agents list.
                    self.stores.machines.fetches.forget_models(machine);
                    r.persist(StoreId::Machines);
                }
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
                r.ui_changed = true;
            }
        }
        r
    }

    /// Insert rows through the [`TranscriptStore`] port, then fold the inserted
    /// seqs (and any content conflicts on already-stored seqs) into the pure
    /// [`client_core::stores::transcript::TranscriptState`]. Returns the seqs
    /// that were new to the store.
    async fn apply_rows(
        &mut self,
        machine: &str,
        session: &str,
        rows: Vec<(u64, serde_json::Value)>,
    ) -> Vec<u64> {
        if rows.is_empty() {
            return Vec::new();
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
        inserted
    }

    /// The heartbeat. Port of `createPhoneCore`'s `onSessions` handler.
    async fn on_sessions(
        &mut self,
        machine: &str,
        m: &protocol::events::SessionListMsg,
        r: &mut RouteResult,
    ) {
        // CDX-013: only a PAIRED machine may create/update its entry. The
        // pairing candidate is let through the ingest gate (its pair-ack must
        // arrive) but must not self-register by sending a session list.
        if self.stores.machines.machine(machine).is_none() {
            return;
        }
        // A list no newer than the one applied (late over another relay or
        // the direct link, re-published, or replayed after a restart) would
        // step every session back and re-announce transitions already told.
        if self.stores.machines.is_outdated_list(machine, m) {
            log::debug!("session list rev {:?} from {} is outdated; ignored", m.rev, machine.get(..8).unwrap_or(machine));
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
            r.ui_changed = true;
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
        let pending_before = self.stores.pending_sessions.len();
        for info in &m.sessions {
            self.stores.pending_sessions.resolve(&info.id);
        }
        self.stores.pending_sessions.sweep(self.now);
        if self.stores.pending_sessions.len() != pending_before {
            r.pending_sessions_changed = true;
        }

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
    /// register the machine with its relays, disarm the CDX-040 deadline,
    /// and refresh the subscription authors.
    fn on_pair_ack(
        &mut self,
        machine: &str,
        m: &protocol::events::PairAckMsg,
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
        let out = apply_pairing_effects(self.stores, self.keys, self.now, result);
        let paired = out.pairing_settled == Some(true);
        out.merge_into(r);
        // The bridge's greeting heartbeat (capabilities, folders, roots,
        // sessions) goes out before its pair-ack, i.e. while this phone did
        // not yet know the machine and dropped it. Ask for a fresh one right
        // away instead of leaving the new machine without folders or the
        // OpenCode backend until the next periodic heartbeat.
        if paired {
            r.sends.push(Send {
                machine: machine.to_string(),
                msg: PhoneToBridge::RefreshSessions(BareMsg { version: VersionFields::default() }),
            });
        }
    }
}

/// What interpreting a batch of [`PairingEffect`]s asked for beyond the store
/// mutations it already applied. Shared by the pair-ack route and the
/// pairing intents.
#[derive(Debug, Default, PartialEq)]
pub struct PairingEffectsOut {
    pub sends: Vec<Send>,
    pub persist: Vec<StoreId>,
    pub resubscribe: bool,
    pub pair_deadline: Option<PairDeadline>,
    /// `Some(true)` paired, `Some(false)` nack / timeout, `None` still pending.
    pub pairing_settled: Option<bool>,
}

impl PairingEffectsOut {
    fn merge_into(self, r: &mut RouteResult) {
        r.sends.extend(self.sends);
        for id in self.persist {
            r.persist(id);
        }
        r.resubscribe |= self.resubscribe;
        if self.pair_deadline.is_some() {
            r.pair_deadline = self.pair_deadline;
        }
        if self.pairing_settled.is_some() {
            r.pairing_settled = self.pairing_settled;
        }
    }
}

/// Run a [`client_core::stores::pairing::PairingResult`] against the stores:
/// commit the new state, register the machine with its relays on `OnPaired`,
/// and return the transport-affecting effects.
///
/// The `pair-request` grants the bridge the session key with the pairing, so
/// a phone whose identity lives in an external signer needs one signer round;
/// the new machine starts with that grant pending, confirmed by a pair-ack
/// encrypted to the key.
pub fn apply_pairing_effects(
    stores: &mut CoreStores,
    keys: &PhoneKeys,
    now: u64,
    result: client_core::stores::pairing::PairingResult,
) -> PairingEffectsOut {
    use client_core::stores::pairing::PairingPhase;

    stores.pairing = result.state;
    let mut out = PairingEffectsOut {
        pairing_settled: match stores.pairing.phase {
            PairingPhase::Paired => Some(true),
            PairingPhase::Failed => Some(false),
            _ => None,
        },
        ..Default::default()
    };

    for effect in result.effects {
        match effect {
            PairingEffect::DisarmDeadline => out.pair_deadline = Some(PairDeadline::Clear),
            PairingEffect::ArmDeadline { ms } => out.pair_deadline = Some(PairDeadline::Arm { ms }),
            // The candidate's relays join the transport's set (see
            // `CoreStores::relay_set`) as soon as it is the candidate, so
            // before `SendPairRequest` below goes out: a bridge reachable only
            // over a relay no paired machine uses would otherwise never see
            // the request.
            PairingEffect::NotifyCandidate(_) => out.resubscribe = true,
            PairingEffect::SendPairRequest { to, label, token } => {
                out.sends.push(Send {
                    machine: to.clone(),
                    msg: PhoneToBridge::PairRequest(PairRequestMsg {
                        version: VersionFields::default(),
                        npub: keys.identity_npub.clone(),
                        pubkey_hex: keys.identity_pubkey_hex.clone(),
                        label,
                        token,
                        session_key: Some(keys.grant_for(&to)),
                    }),
                });
            }
            PairingEffect::OnPaired {
                candidate,
                machine_name,
                host,
            } => {
                stores.machines.register_machine(
                    &candidate.pubkey_hex,
                    &machine_name,
                    Some(candidate.machine.clone()),
                    host,
                    &candidate.relays,
                );
                stores.machines.note_session_grant_sent(&candidate.pubkey_hex, keys.grant_sent(now));
                out.persist.push(StoreId::Machines);
                out.resubscribe = true;
            }
        }
    }
    out
}

fn to_value<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

pub(crate) fn sync_effect_to_cmd(effect: SyncEffect) -> PhoneToBridge {
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
            ranges: vec![range],
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
    use protocol::events::{
        InputAckMsg, InputFailedMsg, OutputMsg, SessionListMsg, SessionReadyMsg, SyncChunkMsg,
        SyncEndMsg,
    };
    use protocol::common::{EntryBody, OutputEntry, RemoteSessionInfo, SessionState};
    use serde_json::json;

    const MACHINE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn info(id: &str, state: Option<SessionState>, seq_high: Option<u64>) -> RemoteSessionInfo {
        RemoteSessionInfo {
            id: id.into(),
            agent: "claude-code".into(),
            slug: format!("slug-{id}"),
            cwd: "/w".into(),
            last_activity: "t".into(),
            line_count: 0,
            title: None,
            project: "p".into(),
            mode: None,
            effort: None,
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
            agents: Vec::new(),
            credentials: Vec::new(),
            protocol_version: protocol::capabilities::PROTOCOL_VERSION,
            capabilities: None,
            folders: None,
            roots: None,
            removed_sessions: None,
            machine_offline: None,
            direct: None,
            rev: None,
        }
    }

    async fn stores() -> (CoreStores, MemoryTranscriptStore, PhoneKeys) {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let h = hydrate(&kv, &ts, &StoresConfig::default()).await;
        let identity = protocol::crypto::generate_keypair();
        let (ring, _) = client_core::stores::session_key::SessionKeyRing::load(None, 1_000);
        (h.stores, ts, PhoneKeys::new(&identity.pubkey_hex, &ring.current))
    }

    fn text_entry(content: &str) -> OutputEntry {
        OutputEntry::new(
            "t",
            EntryBody::Text {
                role: protocol::common::Role::Agent,
                text: content.to_string(),
            },
        )
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
                    entries: vec![text_entry("hello")],
                }),
            )
            .await;
        assert_eq!(
            out,
            RouteResult {
                transcript_appended: Some((MACHINE.to_string(), "s1".to_string())),
                ..RouteResult::default()
            }
        );
        assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1]);
        assert!(s.transcript.has_contiguous(MACHINE, "s1", Some(1)));
    }

    #[tokio::test]
    async fn a_live_permission_card_marks_unread_and_notifies_then_agent_activity_clears_it() {
        let (mut s, ts, kp) = stores().await;
        let card: OutputEntry = serde_json::from_value(json!({
            "timestamp": "t", "entryType": "permission_request", "requestId": "r1",
            "toolName": "Bash", "kind": "execute", "title": "ls", "options": []
        }))
        .unwrap();
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.visible = false; // backgrounded → OS notify
            let out = r
                .route(
                    MACHINE,
                    &BridgeToPhone::Output(OutputMsg {
                        session_id: "s1".into(),
                        seq: 1,
                        entries: vec![card],
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
                entries: vec![text_entry("working on it")],
            }),
        )
        .await;
        assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    }

    #[tokio::test]
    async fn a_replayed_turn_end_the_transcript_already_holds_does_not_notify_again() {
        let (mut s, ts, kp) = stores().await;
        let turn_end = || BridgeToPhone::Output(OutputMsg {
            session_id: "s1".into(),
            seq: 7,
            entries: vec![serde_json::from_value(json!({ "timestamp": "t", "entryType": "turn_complete" })).unwrap()],
        });
        {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.visible = false;
            let out = r.route(MACHINE, &turn_end()).await;
            assert!(matches!(out.notifies.as_slice(), [NotifyEffect::Notify { .. }]));
        }
        s.ui.clear_session_unread(MACHINE, "s1");

        // The app was killed and restarted (a fresh notification cooldown), and
        // a direct link resuming from an older cursor sends the same entry.
        s.notifications = Default::default();
        let mut r = Router::new(&mut s, &ts, &kp, 60_000);
        r.visible = false;
        let out = r.route(MACHINE, &turn_end()).await;
        assert!(out.notifies.is_empty());
        assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    }

    #[tokio::test]
    async fn a_deleted_sessions_replayed_output_is_dropped_after_a_restart() {
        let kv = MemoryKv::new();
        let ts = MemoryTranscriptStore::new();
        let identity = protocol::crypto::generate_keypair();
        let (ring, _) = client_core::stores::session_key::SessionKeyRing::load(None, 1_000);
        let kp = PhoneKeys::new(&identity.pubkey_hex, &ring.current);

        // Deleted (and acked: no rows left), then the app was killed.
        let mut before = hydrate(&kv, &ts, &StoresConfig::default()).await.stores;
        before.machines.dismiss_session("s1", 1_000);
        crate::stores::Persister::new(&kv).save_machines(&before.machines).await;

        // A fresh start; the direct link resumes and re-sends the turn end.
        let mut s = hydrate(&kv, &ts, &StoresConfig::default()).await.stores;
        let mut r = Router::new(&mut s, &ts, &kp, 60_000);
        r.visible = false;
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 7,
                    entries: vec![serde_json::from_value(json!({ "timestamp": "t", "entryType": "turn_complete" })).unwrap()],
                }),
            )
            .await;
        assert_eq!(out, RouteResult::default());
        assert!(ts.seqs(MACHINE, "s1").await.is_empty());
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
                    entries: vec![text_entry("first")],
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
                    entries: vec![text_entry("REWRITTEN")],
                }),
            )
            .await;
        }
        assert_eq!(s.transcript.seq_conflicts.len(), 1);
        assert_eq!(s.transcript.seq_conflicts[0].seq, 1);
        // the stored row is untouched — the first content wins
        let rows = ts.read_range(MACHINE, "s1", 1, 1).await;
        assert_eq!(rows[0].entry, json!({ "timestamp": "t", "entryType": "text", "role": "agent", "text": "first" }));
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
                        protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
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
                    ranges: vec![(1, 2)],
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
                        protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                        protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
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
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
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
    async fn a_session_list_older_than_the_one_applied_changes_nothing_and_tells_nothing() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
        let list = |state, rev| {
            let mut m = sessions_msg(vec![info("s1", Some(state), None)]);
            m.rev = Some(rev);
            BridgeToPhone::Sessions(m)
        };
        let route = async |s: &mut CoreStores, msg: BridgeToPhone, now| {
            let mut r = Router::new(s, &ts, &kp, now);
            r.visible = false;
            r.route(MACHINE, &msg).await
        };
        assert!(route(&mut s, list(SessionState::Running, 10), 1_000).await.notifies.is_empty());
        let finished = route(&mut s, list(SessionState::Idle, 20), 2_000).await;
        assert_eq!(finished.notifies.len(), 1, "the turn's end is told once");

        // A Running list from before it, late over another relay or the
        // direct link, and the Idle one replayed after a restart: nothing.
        for (late, now) in [(list(SessionState::Running, 15), 3_000), (list(SessionState::Idle, 20), 4_000)] {
            let out = route(&mut s, late, now).await;
            assert_eq!(out, RouteResult::default());
        }
        assert_eq!(s.machines.session(MACHINE, "s1").unwrap().info.state, Some(SessionState::Idle));

        // The rev survives the store, so a restarted phone still ignores them.
        let stored = serde_json::to_string(&s.machines.machines).unwrap();
        let back: std::collections::BTreeMap<String, client_core::stores::machines::MachineView> =
            serde_json::from_str(&stored).unwrap();
        assert_eq!(back[MACHINE].list_rev, Some(20));

        // A newer turn is told again (past the notification cooldown).
        route(&mut s, list(SessionState::Running, 30), 15_000).await;
        assert_eq!(route(&mut s, list(SessionState::Idle, 40), 16_000).await.notifies.len(), 1);
    }

    #[tokio::test]
    async fn the_same_session_failure_is_told_once() {
        let (mut s, ts, kp) = stores().await;
        let failed = BridgeToPhone::SessionFailed(protocol::events::SessionFailedMsg {
            pending_id: "p1".into(),
            reason: "no such folder".into(),
        });
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.visible = false;
        assert_eq!(r.route(MACHINE, &failed).await.notifies.len(), 1);
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        r.visible = false;
        assert!(r.route(MACHINE, &failed).await.notifies.is_empty());
    }

    #[tokio::test]
    async fn the_foreground_watched_session_is_never_marked_or_notified() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
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
    async fn session_ready_upserts_the_session_and_sends_nothing() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);

        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::SessionReady(SessionReadyMsg {
                    pending_id: "s1".into(),
                    session: info("s1", Some(SessionState::Idle), None),
                }),
            )
            .await;
        assert!(s.machines.session(MACHINE, "s1").is_some());
        // The new session's mode rides create-session itself; nothing follows.
        assert!(out.sends.is_empty());
        assert_eq!(out.persist, vec![StoreId::Machines]);
    }

    #[tokio::test]
    async fn credentials_ack_updates_the_ui_ack_and_the_stored_statuses() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::CredentialsAck(protocol::events::CredentialsAckMsg {
                    machine: "laptop".into(),
                    agent: None,
                    success: true,
                    credentials: vec![protocol::common::CredentialStatus {
                        id: "github_pat".into(),
                        label: "GitHub token".into(),
                        present: true,
                        from_env: false,
                        valid: Some(true),
                    }],
                    error: None,
                }),
            )
            .await;
        assert!(out.ui_changed);
        assert_eq!(out.persist, vec![StoreId::Machines]);
        let ack = &s.ui.credentials_status[MACHINE];
        assert_eq!(ack.state, client_core::stores::ui::AckState::Saved);
        assert_eq!(s.machines.machine(MACHINE).unwrap().credentials[0].valid, Some(true));
    }

    #[tokio::test]
    async fn models_updates_the_agents_list_and_asks_for_a_persist() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Models(protocol::events::ModelsMsg {
                    agent: "claude-code".into(),
                    models: vec![protocol::events::ModelEntry {
                        id: "sonnet".into(),
                        label: Some("Sonnet".into()),
                        provider: None,
                    }],
                    default_model: Some("sonnet".into()),
                    error: None,
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Machines]);
        assert_eq!(
            s.machines.machine(MACHINE).unwrap().models["claude-code"].models.as_ref().unwrap()[0].id,
            "sonnet"
        );
    }

    #[tokio::test]
    async fn option_confirmed_writes_through_to_the_session_info() {
        let (mut s, ts, kp) = stores().await;
        s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
        s.machines.apply_session_upsert(MACHINE, &info("s1", None, None), 0);
        for (option, value) in [
            (protocol::common::SessionOption::Mode, "acceptEdits"),
            (protocol::common::SessionOption::Effort, "high"),
            (protocol::common::SessionOption::Model, "opus"),
        ] {
            let mut r = Router::new(&mut s, &ts, &kp, 1_000);
            r.route(
                MACHINE,
                &BridgeToPhone::OptionConfirmed(protocol::events::OptionConfirmedMsg {
                    session_id: "s1".into(),
                    option,
                    value: value.into(),
                }),
            )
            .await;
        }
        let info = &s.machines.session(MACHINE, "s1").unwrap().info;
        assert_eq!(info.mode.as_deref(), Some("acceptEdits"));
        assert_eq!(info.effort.as_deref(), Some("high"));
        assert_eq!(info.model.as_deref(), Some("opus"));
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
                    reason: protocol::events::InputFailedReason::Busy,
                    input_id: Some("in-1".into()),
                }),
            )
            .await;
        assert_eq!(out.persist, vec![StoreId::Outbox]);
        assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Failed);
        assert_eq!(s.outbox.items["in-1"].error.as_deref(), Some("busy"));
    }
}
