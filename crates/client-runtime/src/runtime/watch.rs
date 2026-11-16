//! What this client watches on each machine (the session and terminal on
//! screen), told to the bridges as `presence` and renewed before it lapses.

use std::collections::BTreeMap;

use client_core::connection::ConnectionStatus;
use protocol::commands::{PhoneToBridge, PresenceMsg, PRESENCE_RENEW_SECS};

use super::{Loop, Msg, Watch, WATCH_SETTLE_MS};
use crate::signer::Cipher;

impl Loop {
    /// The bridges that know this client by its session key and have heard
    /// nothing from it for [`PRESENCE_RENEW_SECS`]: they get a `presence`,
    /// so they keep sending it the shared updates. Quiet: a renewal that
    /// does not get through is retried on the next check. A machine whose
    /// direct link is up is renewed over it even with every relay down: the
    /// link alone must keep the bridge sending.
    pub(super) fn renew_presence(&mut self) {
        let relays_up = self.conn.status == ConnectionStatus::Connected;
        let now = self.clock.now_ms();
        let due: Vec<String> = self
            .stores
            .machines
            .machine_pubkeys()
            .into_iter()
            .filter(|m| relays_up || self.links_up.contains_key(m))
            .filter(|m| matches!(self.cipher_for(m), Cipher::SessionKey(_)))
            .filter(|m| self.last_command_ms.get(m).is_none_or(|at| now.saturating_sub(*at) >= PRESENCE_RENEW_SECS * 1000))
            .collect();
        for machine in due {
            // The renewal also carries what this client watches now, so a
            // bridge that missed a change catches up within one period.
            let watch = self.watch_for(&machine);
            self.sign_and_publish(machine, PhoneToBridge::Presence(PresenceMsg { away: false, watching: watch.session, watching_terminal: watch.terminal }), None, None, true);
        }
    }

    /// What this client shows live text and terminal output for right now:
    /// the session on screen and the terminal on screen, while the app is in
    /// the foreground, nothing otherwise. A machine with neither is absent —
    /// it is told nothing is watched there, if it was ever told otherwise.
    fn watch_now(&self) -> BTreeMap<String, Watch> {
        let mut out: BTreeMap<String, Watch> = BTreeMap::new();
        if !self.conn.visible {
            return out;
        }
        if let (Some(machine), Some(session)) =
            (&self.stores.ui.selected_machine, &self.stores.ui.selected_session)
        {
            out.entry(machine.clone()).or_default().session = Some(session.clone());
        }
        if let Some(machine) = self.stores.terminals.watching_machine() {
            let term = self.stores.terminals.attached().and_then(|a| a.term.clone());
            if let Some(term) = term {
                out.entry(machine.to_string()).or_default().terminal = Some(term);
            }
        }
        out
    }

    /// What a `presence` to `machine` carries right now.
    fn watch_for(&self, machine: &str) -> Watch {
        self.watch_now().remove(machine).unwrap_or_default()
    }

    /// What this client watches may have changed — another session or
    /// terminal on screen, or the app hidden. Say it once the choice has
    /// settled.
    pub(super) fn watch_changed(&mut self) {
        if self.watch_timer.is_none() {
            self.watch_timer = Some(self.arm(WATCH_SETTLE_MS, Msg::WatchSettle));
        }
    }

    /// The settle window closed: tell each machine whose `watching` /
    /// `watching_terminal` differs from what it was last told. Leaving a
    /// machine for another also tells the one left behind that nothing is
    /// watched there any more.
    pub(super) fn settle_watch(&mut self) {
        let desired = self.watch_now();
        let previous = std::mem::take(&mut self.watch_sent);
        // Only what a machine was told counts as sent: one that could not be
        // (no session key to use right now) is tried again at the next
        // settle, instead of being taken for told and never retried.
        let mut told: BTreeMap<String, Watch> = BTreeMap::new();
        for (machine, watch) in &desired {
            if previous.get(machine) == Some(watch) || self.send_watching(machine, watch.clone()) {
                told.insert(machine.clone(), watch.clone());
            }
        }
        for (machine, watch) in previous {
            if desired.contains_key(&machine) || watch == Watch::default() {
                continue;
            }
            self.send_watching(&machine, Watch::default());
        }
        self.watch_sent = told;
    }

    /// One `presence` saying what this client watches, to one machine. Only
    /// a machine that knows this client by its session key is told: a copy
    /// addressed to the identity reaches no client, and so no live text.
    /// Returns whether it went out.
    fn send_watching(&mut self, machine: &str, watch: Watch) -> bool {
        if !matches!(self.cipher_for(machine), Cipher::SessionKey(_)) {
            return false;
        }
        self.sign_and_publish(machine.to_string(), PhoneToBridge::Presence(PresenceMsg { away: false, watching: watch.session, watching_terminal: watch.terminal }), None, None, true);
        true
    }
}
