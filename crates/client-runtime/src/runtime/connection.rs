//! The connection side of the loop: connectivity signals through the
//! connection FSM, its effects carried out, and the watchdogs and
//! deadlines that feed it.

use client_core::connection::{
    connection_reducer, heartbeats_all_stale, ConnectionEffect, ConnectionEvent, ConnectionStatus,
};
use protocol::commands::{PhoneToBridge, PresenceMsg};
use tokio::sync::oneshot;

use super::{abort, connect_attempt_expired, stale_watchdog_needed, Loop, Msg, SliceId, AWAY_WAIT, STALE_WATCHDOG_EVERY};
use crate::dispatch::sync_effect_to_cmd;
use crate::signer::Cipher;

impl Loop {
    pub(super) fn dispatch(&mut self, event: ConnectionEvent) {
        let before = (self.conn.status, self.conn.needs_pairing_check);
        let result = connection_reducer(&self.conn, &event, &self.reconnect);
        self.conn = result.state;
        self.track_connecting_since(before.0);
        for effect in result.effects {
            self.apply(effect);
        }
        let after = (self.conn.status, self.conn.needs_pairing_check);
        if after != before {
            let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
            self.last_connected_relays = connected.clone();
            self.observer
                .connection_changed(self.conn.status, self.conn.needs_pairing_check, &connected);
            self.state_changed(SliceId::Connection);
        }
        if after.0 != before.0 {
            self.sync_stale_watchdog();
        }
    }

    /// Start (or keep) the connect-attempt clock only while `Connecting`.
    fn track_connecting_since(&mut self, was: ConnectionStatus) {
        match (was, self.conn.status) {
            (ConnectionStatus::Connecting, ConnectionStatus::Connecting) => {}
            (_, ConnectionStatus::Connecting) => {
                self.connecting_since = Some(self.clock.now_ms());
            }
            _ => self.connecting_since = None,
        }
    }

    /// An attempt that never reached EOSE within the config's connect
    /// deadline: the socket may be open while AUTH or the initial REQs never
    /// complete, and nothing else watches `Connecting`. Report it as a lost
    /// socket so the FSM's normal backoff and retry path runs.
    pub(super) fn check_connect_deadline(&mut self) {
        // A hidden, dozing app is not a slow connect: no time passes against
        // the attempt while it is paused. The resume that brings it back
        // re-dials (OpenSocket), which restarts the clock for the new attempt.
        if !self.conn.visible {
            return;
        }
        let deadline_ms = self.reconnect.connect_deadline_ms;
        if !connect_attempt_expired(self.conn.status, self.connecting_since, self.clock.now_ms(), deadline_ms) {
            return;
        }
        self.connecting_since = None;
        log::warn!("connection: no EOSE within {deadline_ms}ms — abandoning the attempt");
        let random = Some(self.entropy.unit());
        self.dispatch(ConnectionEvent::SocketClose { random });
    }

    /// Re-request sessions whose sync cycle has gone silent. A lost
    /// `sync-request` or `sync-end` would otherwise leave the gap unfilled
    /// until the next reconnect; the stall sweep bounds that by the cycle's
    /// own attempt count.
    pub(super) fn check_sync_stalls(&mut self) {
        // A cycle can only be served over a live socket, and this runs after
        // the same tick may just have failed the connection into
        // WaitingRetry: publishing there would burn an attempt on a dead
        // socket. Reconnects reset in-flight cycles anyway.
        if self.conn.status != ConnectionStatus::Connected {
            return;
        }
        let now = self.clock.now_ms();
        for (machine, effect) in self.stores.transcript.stall_sweep(now) {
            self.on_send(machine, sync_effect_to_cmd(effect), None);
        }
    }

    /// CDX-020: every paired machine's heartbeat went stale while
    /// "connected" — the subscriptions died without a socket close. Force
    /// the normal backoff/reconnect path.
    pub(super) fn check_stale_heartbeats(&mut self) {
        let now = self.clock.now_ms();
        if heartbeats_all_stale(&self.conn, now, self.reconnect.heartbeat_stale_after_ms) {
            let random = Some(self.entropy.unit());
            self.dispatch(ConnectionEvent::SocketClose { random });
        }
    }

    /// Notice a per-relay connect/disconnect the status-transition gate in
    /// `dispatch` above cannot see on its own (see `last_connected_relays`'s
    /// own doc comment). `Router::connected` is a `BTreeSet`, so two reads
    /// collected into a `Vec` compare equal iff the same relays are up —
    /// order is never the source of a false difference here.
    pub(super) fn check_connected_relays_changed(&mut self) {
        let connected: Vec<String> = self.ws.connected_relays().into_iter().collect();
        if connected == self.last_connected_relays {
            return;
        }
        self.last_connected_relays = connected.clone();
        self.observer
            .connection_changed(self.conn.status, self.conn.needs_pairing_check, &connected);
        self.state_changed(SliceId::Connection);
    }

    fn apply(&mut self, effect: ConnectionEffect) {
        match effect {
            ConnectionEffect::OpenSocket => {
                // Every OpenSocket is a real dial — including the FSM's
                // re-dial when a resume lands in `Connecting` — so the
                // deadline runs from now, not from when the status first
                // became `Connecting`.
                self.connecting_since = Some(self.clock.now_ms());
                log::info!(
                    "connection: OpenSocket — dialing {} configured relay(s), proxy={:?}",
                    self.ws.relay_count(),
                    self.ws.current_proxy(),
                );
                self.ws.ensure_connected();
                self.nostr.connect();
            }
            ConnectionEffect::CloseSocket => {
                log::info!("connection: CloseSocket");
                self.nostr.disconnect();
                self.ws.shutdown();
            }
            ConnectionEffect::ScheduleRetry { delay_ms } => {
                abort(&mut self.retry_timer);
                self.retry_timer = Some(self.arm(delay_ms, Msg::RetryDue));
            }
            ConnectionEffect::CancelRetry => abort(&mut self.retry_timer),
            ConnectionEffect::ScheduleVisibilityCheck { delay_ms } => {
                abort(&mut self.vis_timer);
                self.vis_timer = Some(self.arm(delay_ms, Msg::VisibilitySettled));
            }
            ConnectionEffect::CancelVisibilityCheck => abort(&mut self.vis_timer),
            // A (re)connect: reset stuck sync cycles, ask every machine for a
            // fresh list, reconcile from what we know. Deferred to a message so
            // this sync `apply` can stay non-blocking.
            ConnectionEffect::RefreshAndReconcile => {
                // A fresh connection: the bridge may have restarted and
                // forgotten what this client watches, so say it again.
                self.watch_sent.clear();
                self.watch_changed();
                let _ = self.self_tx.send(Msg::RefreshReconcile { reconnected: true });
            }
            ConnectionEffect::ResumeReconcile => {
                let _ = self.self_tx.send(Msg::RefreshReconcile { reconnected: false });
            }
        }
    }

    /// Tell each bridge that knows this client by its session key that it
    /// is going away, so they stop sending it the shared updates now rather
    /// than when its lease runs out; then stop, once those went out or after
    /// [`AWAY_WAIT`]. Best effort: a stop that cannot wait (the process
    /// killed) leaves the leases to run out.
    pub(super) fn say_away(&mut self) {
        self.stop_epoch += 1;
        let epoch = self.stop_epoch;
        let mut sent = Vec::new();
        if self.conn.status == ConnectionStatus::Connected {
            for machine in self.stores.machines.machine_pubkeys() {
                if matches!(self.cipher_for(&machine), Cipher::SessionKey(_)) {
                    let (tx, rx) = oneshot::channel();
                    let away = PhoneToBridge::Presence(PresenceMsg { away: true, watching: None, watching_terminal: None });
                    self.sign_and_publish(machine, away, Some(tx), None, true);
                    sent.push(rx);
                }
            }
        }
        let tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let settled = async {
                for reply in sent {
                    let _ = reply.await;
                }
            };
            let _ = tokio::time::timeout(AWAY_WAIT, settled).await;
            let _ = tx.send(Msg::Stopped { epoch });
        });
    }

    pub(super) async fn stop_now(&mut self) {
        self.dispatch(ConnectionEvent::DisconnectRequested);
        abort(&mut self.stale_timer);
        self.links_on = false;
        self.sync_direct_links();
        // A change not saved yet is saved after the next start's merge.
        abort(&mut self.backup_timer);
        self.sync_backup_sub();
        self.flush_acks();
        self.flush_writes().await;
    }

    /// Keep the watchdog armed exactly where it has work to do: expire a
    /// connect attempt, check a live socket's heartbeats and relays, renew
    /// presence, re-drive silent sync cycles. A hidden app ("paused") is
    /// still `Connected` — its foreground service keeps the socket — so
    /// pausing must NOT disarm it: a dead subscription detected while the
    /// user is not looking is what keeps notifications arriving. Offline,
    /// WaitingRetry, Idle and Stopped have no socket and no cycle in flight;
    /// their own online/retry/start events re-arm it. A direct link that is
    /// up keeps it armed whatever the relays do: presence renews over the
    /// link, and every other check is gated on the relay status itself.
    pub(super) fn sync_stale_watchdog(&mut self) {
        if stale_watchdog_needed(self.conn.status) || !self.links_up.is_empty() {
            self.arm_stale_watchdog();
        } else {
            abort(&mut self.stale_timer);
        }
    }

    fn arm_stale_watchdog(&mut self) {
        abort(&mut self.stale_timer);
        let tx = self.self_tx.clone();
        self.stale_timer = Some(
            tokio::task::spawn_local(async move {
                tokio::time::sleep(STALE_WATCHDOG_EVERY).await;
                let _ = tx.send(Msg::StaleWatchdog);
            })
            .abort_handle(),
        );
    }

    /// Point the "did the machine answer?" timer at the earliest change still
    /// waiting, arming or disarming it as that changes. A change answered
    /// before its deadline leaves a timer that fires into a no-op, which is
    /// cheaper than tracking every answer to disarm it.
    pub(super) fn rearm_unanswered_timer(&mut self) {
        abort(&mut self.unanswered_timer);
        let Some(deadline) = self.stores.machines.next_unanswered_deadline() else { return };
        let delay = deadline.saturating_sub(self.clock.now_ms());
        self.unanswered_timer = Some(self.arm(delay, Msg::UnansweredDeadline));
    }
}
