//! What the bridges say, into the stores: each relay or direct-link event
//! ingested, its route result carried out, and the catch-up after a
//! (re)connect.

use client_core::bridge_api::Ingested;
use client_core::connection::ConnectionEvent;
use client_core::notifications::NotifyEffect;
use client_core::stores::machines::Incompatible;
use client_core::stores::session_key::Recipient;
use protocol::capabilities::PROTOCOL_VERSION;
use protocol::commands::PhoneToBridge;
use protocol::events::BridgeToPhone;
use protocol::kinds::SESSION_LIST_KIND;
use protocol::recipients::RECIPIENT_TAG;

use super::{abort, incoming_of, slice_of, ActionFailedKind, CoreEvent, Loop, Msg, SliceId, RESUME_HEARD_WITHIN_MS};
use crate::dispatch::{PairDeadline, RouteResult, Router, Send as RouteSend, StoreId};
use crate::nostr_client::NostrEvent;

impl Loop {
    pub(super) async fn on_relay_event(&mut self, event: NostrEvent) {
        let known = self.machines.iter().any(|m| m == &event.pubkey);
        // Only this client's copies: another client's of the identity is
        // encrypted to a key this one does not hold, so it would only cost
        // the signer a decrypt in vain. The subscription already asks relays
        // for these only; this holds whatever path the event took.
        let identity = &self.keys.identity_pubkey_hex;
        let ours = event.tag(RECIPIENT_TAG).is_some_and(|tag| {
            self.session.recipient_tags(&event.pubkey, identity, self.clock.now_ms()).iter().any(|t| t == tag)
        });
        if !ours {
            return;
        }

        // A 30515 from a PAIRED machine IS a heartbeat — feed the FSM for
        // presence + CDX-020 whether or not the payload decodes (a chunked
        // list is `Buffered`, not `Message`, yet the machine is alive). Gate on
        // `known`: the subscription filter already scopes authors, but a
        // misbehaving relay must not be able to seed a stranger's heartbeat.
        if known && event.kind == SESSION_LIST_KIND {
            let at = self.clock.now_ms();
            self.dispatch(ConnectionEvent::HeartbeatReceived {
                machine: event.pubkey.clone(),
                at,
            });
        }

        if !known {
            return;
        }
        // The recipient tag, signed by the bridge, says which key a copy is
        // for. One to a session key is read here; only one to the identity
        // may cost the identity's signer anything (`on_identity_copy`).
        let identity_tag = protocol::recipients::recipient_tag(&event.pubkey, &self.keys.identity_pubkey_hex);
        if event.tag(RECIPIENT_TAG) == Some(identity_tag.as_str()) {
            self.on_identity_copy(event).await;
            return;
        }
        let now = self.clock.now_ms();
        let opened = self.session.keys(now).find_map(|key| {
            protocol::crypto::decrypt_from(&key.keypair.secret_key, &event.pubkey, &event.content)
                .ok()
                .map(|plaintext| (plaintext, Recipient::SessionKey(key.pubkey_hex().to_string())))
        });
        let incoming = incoming_of(&event);
        match opened {
            Some((plaintext, via)) => {
                let ingested = self.api.ingest_plaintext(&incoming, plaintext, now);
                self.on_ingested(&event, ingested, &via).await;
            }
            None => {
                let ingested = self.api.decrypt_failed(&incoming, "not readable with the session key".into());
                self.on_ingested(&event, ingested, &Recipient::Identity).await;
            }
        }
    }

    /// Carry on with an event `ingest` has decided about; `via` is the key it
    /// was encrypted to.
    pub(super) async fn on_ingested(&mut self, event: &NostrEvent, ingested: Ingested, via: &Recipient) {
        match ingested {
            Ingested::Message(msg) => {
                // Fold the decoded message into the store layer, then carry
                // out its effects. The raw `bridge_message` observer callback
                // below is kept for hosts that want the decoded message too.
                let machine = event.pubkey.clone();
                let written = u64::try_from(event.created_at).unwrap_or(0);
                // It reads: a version mismatch no newer than this is over.
                if self.stores.machines.note_read(&machine, written) {
                    self.persist_store(StoreId::Machines).await;
                }
                let now = self.clock.now_ms();
                // A bridge that took the grant a pair-request carries sends
                // the ack to the key: one to the identity means it did not,
                // and that grant counts as the attempt the next one waits on.
                if *via == Recipient::Identity && matches!(*msg, BridgeToPhone::PairAck(_)) {
                    self.grant_attempts.insert(machine.clone(), now);
                }
                let visible = self.conn.visible;
                let notify_enabled = self.stores.settings.data.notifications_enabled;
                let mut router = Router::new(
                    &mut self.stores,
                    self.transcript_store.as_ref(),
                    &self.keys,
                    now,
                );
                router.visible = visible;
                router.notify_enabled = notify_enabled;
                // `CoreEvent::Ping` is the host's cue to play its chime, so
                // the router may decide one (`Router::new` defaults to not).
                router.ping_available = true;
                let result = router.route(&machine, &msg).await;
                // Ahead of the route's sends: a pair-ack encrypted to the
                // session key confirms the grant the pairing carried, so the
                // refresh it provokes already goes out under the key.
                let created_at = u64::try_from(event.created_at).unwrap_or(0);
                if self.stores.machines.note_heard_via(&machine, via, created_at) {
                    self.persist_store(StoreId::Machines).await;
                    if self.session.drop_unused_previous(&self.stores.machines, now) {
                        log::info!("session key: every bridge moved to the new key; the previous one is gone");
                        self.session_ring_changed().await;
                    }
                }
                if matches!(via, Recipient::SessionKey(_)) {
                    self.end_grant_wait(&machine, true);
                }
                self.interpret_route(result).await;
                self.grant_session_key_if_due(&machine).await;
                self.observer.bridge_message(machine, *msg);
            }
            Ingested::DecryptFailed => {
                self.dispatch(ConnectionEvent::DecryptFailure);
                self.observer.action_failed(ActionFailedKind::DecryptFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailedKind::DecryptFailed,
                });
            }
            Ingested::DecodeFailed => {
                // Why, so a device log can tell an old or foreign payload from
                // a wire mismatch. The error is the decoder's (field names,
                // at most a short quoted value), cut short; never the payload.
                if let Some(record) = self.api.diagnostics().invalid.last() {
                    let error: String = record.error.chars().take(160).collect();
                    log::warn!(
                        "undecodable message from {} (kind {}, event {}): {error}",
                        record.machine.get(..8).unwrap_or(&record.machine),
                        record.kind,
                        record.event_id.get(..8).unwrap_or(&record.event_id),
                    );
                }
                self.observer.action_failed(ActionFailedKind::DecodeFailed);
                self.emit(CoreEvent::ActionFailed {
                    kind: ActionFailedKind::DecodeFailed,
                });
            }
            Ingested::VersionMismatch { theirs } => {
                let machine = &event.pubkey;
                let written = u64::try_from(event.created_at).unwrap_or(0);
                if self.stores.machines.note_unreadable(machine, theirs, written) {
                    let app_is_older = Incompatible { theirs, at: written }.app_is_older();
                    log::warn!(
                        "{} speaks protocol {}, this app {PROTOCOL_VERSION}: update {}",
                        machine.get(..8).unwrap_or(machine),
                        theirs.map_or_else(|| "without a version".to_string(), |v| format!("v{v}")),
                        if app_is_older { "the app" } else { "the bridge" },
                    );
                    // Persisting is how the machines view is told; the mark
                    // itself is stripped from what is written.
                    self.persist_store(StoreId::Machines).await;
                }
            }
            Ingested::Buffered | Ingested::UnknownMachine => {}
        }
    }

    /// Carry out the side effects a [`Router`] / intent produced.
    async fn interpret_route(&mut self, r: RouteResult) {
        for &id in &r.persist {
            self.persist_store(id).await;
            self.state_changed(slice_of(id));
        }
        // Ahead of the sends below — same reasoning as `interpret_intent`.
        self.sync_relays();
        // Also ahead of the sends: a send can provoke an immediate reply from
        // a machine this route just added (the refresh after a pair-ack), and
        // the subscription must already cover that machine when it arrives.
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if !r.notifies.is_empty() {
            self.state_changed(SliceId::Cards);
        }
        for effect in r.notifies {
            match effect {
                NotifyEffect::Notify { content, tag, kind } => {
                    self.notifier.notify(&content.title, &content.body, Some(&tag), &kind);
                }
                NotifyEffect::Ping => self.emit(CoreEvent::Ping),
            }
        }
        if !r.transcript_removed.is_empty() {
            self.state_changed(SliceId::Transcript);
        }
        for (machine, session) in r.transcript_removed {
            self.transcript_store.remove(&machine, &session).await;
        }
        self.apply_ui_effects(r.ui_effects);
        for (id, delivered) in r.outbox_settled {
            self.emit(CoreEvent::OutboxSettled { id, delivered });
        }
        for answer in r.files_settled {
            if let Some(answered) = self.file_sends.borrow().get(&answer.id) {
                answered.set(true);
            }
            self.emit(CoreEvent::FileSettled { id: answer.id, reason: answer.reason, detail: answer.detail });
        }
        if let Some(paired) = r.pairing_settled {
            self.emit(CoreEvent::PairingSettled { paired });
            self.state_changed(SliceId::Pairing);
        }
        if r.pending_sessions_changed {
            self.state_changed(SliceId::PendingSessions);
        }
        if r.ui_changed {
            self.state_changed(SliceId::Ui);
        }
        if let Some((machine, session_id)) = r.transcript_appended {
            self.emit(CoreEvent::TranscriptAppended { machine, session_id });
        }
        // Raw bytes on their own event: a terminal's output never goes
        // through a view, so a busy shell costs the UI nothing it is not
        // drawing.
        for frame in r.terminal_output {
            self.emit(CoreEvent::TerminalOutput {
                machine: frame.machine,
                term: frame.term,
                offset: frame.offset,
                bytes: frame.data,
            });
        }
        if let Some(flush) = r.terminal_flush {
            self.apply_terminal_flush(flush);
        }
        // After the transcript event, so a completed row's entry is there to
        // take its place when the row goes.
        for (machine, session_id, change) in r.live_text {
            self.emit(CoreEvent::LiveText { machine, session_id, key: change.key, text: change.text });
        }
        if let Some(m) = r.folder_ack {
            self.emit(CoreEvent::FolderAck {
                request_id: m.request_id,
                success: m.success,
                path: m.path,
                error: m.error,
            });
        }
        match r.pair_deadline {
            Some(PairDeadline::Arm { ms }) => {
                abort(&mut self.pair_timer);
                self.pair_timer = Some(self.arm(ms, Msg::PairDeadline));
            }
            Some(PairDeadline::Clear) => abort(&mut self.pair_timer),
            None => {}
        }
        // `r.heartbeat` is already covered by the pre-decode path above;
        // a heartbeat may have changed where a bridge can be reached.
        self.sync_direct_links();
    }

    /// Post-(re)connect reconcile. Port of `createPhoneCore`'s
    /// `refreshAndReconcile` handler. On a resume (`reconnected: false`) a
    /// machine heard from within [`RESUME_HEARD_WITHIN_MS`] is not asked for
    /// its list again, and the answers held for the connection stay good.
    pub(super) async fn on_refresh_reconcile(&mut self, reconnected: bool) {
        // Reset any sync cycle a prior failure left stuck.
        self.stores.transcript.on_reconnect(None);
        if reconnected {
            // A push (provider profiles, say) may have been missed.
            self.stores.machines.fetches.forget_all();
        }

        let now = self.clock.now_ms();
        let machines = self.stores.machines.machine_pubkeys();
        for machine in &machines {
            let heard_lately = self
                .stores
                .machines
                .machine(machine)
                .and_then(|m| m.last_heartbeat_at)
                .is_some_and(|at| now.saturating_sub(at) < RESUME_HEARD_WITHIN_MS);
            if reconnected || !heard_lately {
                // Ask for a fresh session list (the stored 30515's seqHigh
                // goes stale — CDX-008).
                self.on_send(
                    machine.clone(),
                    PhoneToBridge::RefreshSessions(protocol::commands::BareMsg {}),
                    None,
                );
            }
            // Reconcile from what we already know while the answers travel.
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
                if target == 0 {
                    continue;
                }
                let effects = self.stores.transcript.ensure_synced(
                    machine,
                    &session_id,
                    target,
                    self.clock.now_ms(),
                );
                for e in effects {
                    self.on_send(machine.clone(), crate::dispatch::sync_effect_to_cmd(e), None);
                }
            }
        }

        self.stores.outbox.sweep(self.clock.now_ms());
        self.persist_store(StoreId::Outbox).await;
        self.state_changed(SliceId::Outbox);
    }
}
