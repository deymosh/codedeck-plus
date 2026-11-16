//! The user's actions: each `Intent` folded into the stores and its result
//! carried out, the terminal input flush, the undo timer and the pairing
//! deadline.

use client_core::connection::{DEFAULT_RECONNECT_CONFIG, TOR_RECONNECT_CONFIG};
use client_core::notifications::session_notify_tag;
use client_core::stores::terminals::InputTransport;
use client_core::stores::ui::UiEffect;
use protocol::commands::PhoneToBridge;
use tokio::sync::oneshot;

use super::{abort, slice_of, CoreEvent, Loop, Msg, SliceId, TerminalFlush};
use crate::dispatch::{PairDeadline, Send as RouteSend};
use crate::intent::{apply as apply_intent, Intent, IntentCtx, IntentResult, UndoTimer};

impl Loop {
    /// Fold a user action into the stores and carry out its effects. Returns
    /// `reply` unless an image send took it over (see [`Self::spawn_session_file`]).
    pub(super) async fn on_intent(
        &mut self,
        intent: Intent,
        reply: oneshot::Sender<()>,
    ) -> Option<oneshot::Sender<()>> {
        let mut reply = Some(reply);
        let Some(intent) = self.on_backup_intent(intent).await else { return reply };
        // A pairing grants the current key: never one about to be replaced.
        self.rotate_session_key_if_due().await;
        let ctx = IntentCtx {
            now: self.clock.now_ms(),
            visible: self.conn.visible,
            terminal_transport: self.transport_for_intent(&intent),
        };
        let result = apply_intent(&mut self.stores, intent, &self.keys, ctx);
        let session_file_send = result.session_file_send.clone();
        self.interpret_intent(result).await;
        // A machine-settings change just sent may need a "did the machine
        // answer?" deadline; re-arming here keeps that cheap and in one place.
        self.rearm_unanswered_timer();
        // An intent may have opened another session or left one: the bridge
        // hears about it once the choice has settled.
        self.watch_changed();
        if let Some(send) = session_file_send {
            self.spawn_session_file(send, reply.take());
        }
        reply
    }

    /// Where `machine` is reached right now: its direct link when one is up,
    /// else the relays. Terminal input is paced differently for each.
    fn terminal_transport(&self, machine: &str) -> InputTransport {
        if self.links_up.contains_key(machine) {
            InputTransport::Direct
        } else {
            InputTransport::Relay
        }
    }

    /// The transport an intent's terminal input would ride — the machine the
    /// intent names, for the two intents that carry typed bytes. Every other
    /// intent ignores it.
    fn transport_for_intent(&self, intent: &Intent) -> InputTransport {
        match intent {
            Intent::TerminalInput { machine, .. } | Intent::TerminalPaste { machine, .. } => {
                self.terminal_transport(machine)
            }
            _ => InputTransport::Direct,
        }
    }

    /// Arm, re-arm or clear the terminal input flush timer from what a store
    /// step asked for.
    pub(super) fn apply_terminal_flush(&mut self, flush: TerminalFlush) {
        match flush {
            TerminalFlush::Arm { at_ms } => {
                let delay = at_ms.saturating_sub(self.clock.now_ms());
                abort(&mut self.terminal_flush_timer);
                self.terminal_flush_timer = Some(self.arm(delay, Msg::TerminalFlush));
            }
            TerminalFlush::Clear => abort(&mut self.terminal_flush_timer),
        }
    }

    /// The batching window closed: send what the terminal still holds.
    pub(super) fn on_terminal_flush(&mut self) {
        self.terminal_flush_timer = None;
        let transport = self
            .stores
            .terminals
            .watching_machine()
            .map(|m| self.terminal_transport(m))
            .unwrap_or(InputTransport::Direct);
        let waiting = self.stores.terminals.waiting_input();
        let step = self.stores.terminals.flush_due(transport, self.clock.now_ms());
        // What was held back is sent: the app's predicted echo of it goes.
        if self.stores.terminals.waiting_input() != waiting {
            self.state_changed(SliceId::Ui);
        }
        let Some(machine) = step.machine.clone() else { return };
        for msg in step.sends {
            self.on_send(machine.clone(), PhoneToBridge::TerminalInput(msg), None);
        }
        if let Some(at_ms) = step.flush_at_ms {
            let delay = at_ms.saturating_sub(self.clock.now_ms());
            // A deadline the store says is already past, with nothing sent,
            // would arm a timer that fires at once and never advances.
            if delay > 0 {
                self.terminal_flush_timer = Some(self.arm(delay, Msg::TerminalFlush));
            }
        }
    }

    pub(super) async fn interpret_intent(&mut self, r: IntentResult) {
        for &id in &r.persist {
            self.persist_store(id).await;
            self.state_changed(slice_of(id));
        }
        // Relay/subscription reconfiguration runs BEFORE the sends below: a
        // pairing candidate's relays must reach the transport before its
        // `SendPairRequest` is dispatched, or a bridge reachable only over
        // one of them never sees the request.
        self.sync_relays();
        if r.resubscribe {
            self.refresh_authors();
            self.state_changed(SliceId::Machines);
        }
        for RouteSend { machine, msg } in r.sends {
            self.on_send(machine, msg, None);
        }
        if let Some(o) = r.outbox_send {
            self.on_send_tracked(o.id, o.machine, o.msg);
        }
        match r.pair_deadline {
            Some(PairDeadline::Arm { ms }) => {
                abort(&mut self.pair_timer);
                self.pair_timer = Some(self.arm(ms, Msg::PairDeadline));
            }
            Some(PairDeadline::Clear) => abort(&mut self.pair_timer),
            None => {}
        }
        match r.undo_timer {
            Some(UndoTimer::Arm { ms }) => {
                abort(&mut self.undo_timer);
                self.undo_timer = Some(self.arm(ms, Msg::UndoTimerFired));
            }
            Some(UndoTimer::Clear) => abort(&mut self.undo_timer),
            None => {}
        }
        if let Some(paired) = r.pairing_settled {
            self.emit(CoreEvent::PairingSettled { paired });
        }
        if r.pair_deadline.is_some() || r.pairing_settled.is_some() {
            self.state_changed(SliceId::Pairing);
        }
        if r.pending_sessions_changed {
            self.state_changed(SliceId::PendingSessions);
        }
        if r.ui_changed {
            self.state_changed(SliceId::Ui);
        }
        if let Some(flush) = r.terminal_flush {
            self.apply_terminal_flush(flush);
        }
        if !r.transcript_removed.is_empty() {
            self.state_changed(SliceId::Transcript);
        }
        for (machine, session) in r.transcript_removed {
            self.transcript_store.remove(&machine, &session).await;
        }
        self.apply_ui_effects(r.ui_effects);
        if let Some(on) = r.tor_changed {
            let proxy = if on { self.tor_proxy_address.clone() } else { None };
            self.nostr.set_proxy(proxy.clone());
            self.http.set_proxy(proxy.as_deref());
            // The timing must follow the transport in force, not only the one
            // this process booted with: a phone that starts on clearnet and
            // turns Orbot on later would otherwise keep the shorter clearnet
            // connect deadline, which abandons an attempt while the transport
            // is still allowed to finish a Tor dial.
            self.reconnect = if on { TOR_RECONNECT_CONFIG } else { DEFAULT_RECONNECT_CONFIG };
        }
        // Orbot toggled, a machine removed, or its endpoints edited.
        self.sync_direct_links();
    }

    /// The undo window elapsed — commit the delete (send `close-session`).
    /// A session viewed or deleted clears every notification filed under its
    /// (coarser-than-delivery) tag: what they said has been seen, or is gone.
    pub(super) fn apply_ui_effects(&self, effects: Vec<UiEffect>) {
        for effect in effects {
            match effect {
                UiEffect::SessionViewed { machine, session_id } | UiEffect::SessionDeleted { machine, session_id } => {
                    self.notifier.cancel(&session_notify_tag(&machine, &session_id));
                }
            }
        }
    }

    /// The undo window closed (or the app is going to the background): the
    /// pending delete commits, through the same interpreter as an intent.
    pub(super) async fn on_undo_timer(&mut self) {
        let effects = self.stores.delete_controller.timer_fired();
        let mut r = IntentResult::default();
        crate::intent::apply_delete_effects(&mut self.stores, effects, self.clock.now_ms(), &mut r);
        self.interpret_intent(r).await;
    }

    /// CDX-040: the pair-ack deadline elapsed.
    pub(super) fn on_pair_deadline(&mut self) {
        use client_core::stores::pairing::{
            pairing_reducer, PairingEvent, PairingPhase, PAIR_ACK_TIMEOUT_MS,
        };
        let result = pairing_reducer(
            &self.stores.pairing,
            PairingEvent::DeadlineFired,
            PAIR_ACK_TIMEOUT_MS,
        );
        let settled = matches!(result.state.phase, PairingPhase::Failed);
        self.stores.pairing = result.state;
        abort(&mut self.pair_timer);
        self.sync_relays();
        if settled {
            self.emit(CoreEvent::PairingSettled { paired: false });
            self.state_changed(SliceId::Pairing);
        }
    }
}
