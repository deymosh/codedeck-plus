//! A session key is granted before anything else is said.
//!
//! Until a bridge holds a key of this client, everything between them is
//! encrypted with the identity: each command an encrypt and each message a
//! decrypt by the identity's signer, which may be another app asking the user
//! every time (NIP-55) and refusing past a rate. A restored device, a fresh
//! install or a bridge that lost the key would pay that for the refresh, the
//! heartbeat (each fragment of it) and every chunk of every session's sync.
//!
//! So a machine that wants a grant (`MachinesState::wants_session_grant`)
//! and holds no key of this client is granted first, and nothing else goes
//! to it, nor is read from it, with the identity until it confirms the grant
//! or [`GRANT_WAIT`] after the grant reached a relay:
//! - commands are held, and go out under the key once it is confirmed; a
//!   held `refresh-sessions` is dropped, as a bridge answers a grant with its
//!   heartbeat;
//! - a copy to the identity written before the grant was sent is skipped
//!   unread: it is for an earlier client of the identity, or answers nothing
//!   this one waits on, and what it could say (the heartbeat, session
//!   changes, cards, which are transcript entries) comes anew under the key;
//! - one written since is held, and dropped once the key is confirmed, for
//!   the same reason;
//! - a bridge that held a key of this client and writes to the identity has
//!   lost it: it is granted again at once, and the copy held.
//!
//! If the bridge does not confirm in time, or the grant could not be sent,
//! what was held goes on under the identity, as without session keys (of
//! the held copies, only those nothing newer replaces), and the next grant
//! waits [`REGRANT_EVERY_MS`]. A start or a restore thus
//! costs the signer one encrypt and one signature per machine, and no
//! decrypt.

use std::time::Duration;

use client_core::stores::session_key::{Recipient, REGRANT_EVERY_MS};
use nostr_transport::{PublishResult, PublishVerdict};
use protocol::commands::{PhoneToBridge, SessionKeyMsg};
use protocol::kinds::{LIVE_KIND, SESSION_LIST_KIND};
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use super::{abort, Loop, Msg, SignerJob};
use crate::dispatch::StoreId;
use crate::nostr_client::NostrEvent;
use crate::signer::Cipher;

/// How long a machine has to confirm a grant once it reached a relay. A
/// round trip through the relays, over Tor too, takes seconds.
pub(super) const GRANT_WAIT: Duration = Duration::from_secs(20);
/// The most copies to the identity held per machine; the oldest go first.
/// Each would be a signer decrypt should the grant not take.
const HELD_EVENTS_MAX: usize = 256;

/// A grant `machine` has to confirm, and what waits on it.
pub(super) struct GrantWait {
    seq: u64,
    /// Armed once the grant reached a relay.
    timer: Option<AbortHandle>,
    commands: Vec<HeldCommand>,
    events: Vec<NostrEvent>,
}

struct HeldCommand {
    msg: PhoneToBridge,
    reply: Option<oneshot::Sender<PublishResult>>,
    outbox_id: Option<String>,
    quiet: bool,
}

/// What [`Loop::hold_for_grant`] gives back to be sent now.
pub(super) type Unheld = (PhoneToBridge, Option<oneshot::Sender<PublishResult>>, Option<String>);

fn short(key: &str) -> &str {
    key.get(..8).unwrap_or(key)
}

impl Loop {
    /// Grant `machine` the current session key if it wants it, at most once
    /// per [`REGRANT_EVERY_MS`]. With no key of this client there yet, the
    /// machine waits on it.
    pub(super) fn grant_if_due(&mut self, machine: &str) {
        let now = self.clock.now_ms();
        if self.grant_waits.contains_key(machine)
            || !self.stores.machines.wants_session_grant(machine, &self.session.current, now)
            || self.grant_attempts.get(machine).is_some_and(|at| now.saturating_sub(*at) < REGRANT_EVERY_MS)
        {
            return;
        }
        self.grant_attempts.insert(machine.to_string(), now);
        self.stores.machines.note_session_grant_sent(machine, self.keys.grant_sent(now));
        self.machines_dirty = true;
        self.schedule_flush();
        log::info!("session key: granting it to {}...", short(machine));
        let grant = PhoneToBridge::SessionKey(SessionKeyMsg {
            session_key: self.keys.grant_for(machine, self.stores.machines.confirmed_session_key(machine)),
        });
        if !matches!(self.cipher_for(machine), Cipher::Identity) {
            // A rotation: the bridge goes on reading this client under the
            // key it holds until it confirms the new one.
            self.sign_and_publish(machine.to_string(), grant, None, None, false);
            return;
        }
        self.grant_seq += 1;
        let seq = self.grant_seq;
        self.grant_waits
            .insert(machine.to_string(), GrantWait { seq, timer: None, commands: Vec::new(), events: Vec::new() });
        let (reply, published) = oneshot::channel();
        let tx = self.self_tx.clone();
        let for_machine = machine.to_string();
        tokio::task::spawn_local(async move {
            let delivered = published
                .await
                .is_ok_and(|r: PublishResult| matches!(r.verdict, PublishVerdict::Accepted | PublishVerdict::Unconfirmed));
            let _ = tx.send(Msg::GrantPublished { machine: for_machine, seq, delivered });
        });
        self.sign_and_publish(machine.to_string(), grant, Some(reply), None, false);
    }

    /// A command about to go to `machine` under `cipher`: held while the
    /// machine waits on a grant (one is made if due), else given back.
    pub(super) fn hold_for_grant(
        &mut self,
        machine: &str,
        cipher: &Cipher,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
        quiet: bool,
    ) -> Option<Unheld> {
        if !matches!(cipher, Cipher::Identity) || matches!(msg, PhoneToBridge::PairRequest(_) | PhoneToBridge::SessionKey(_)) {
            return Some((msg, reply, outbox_id));
        }
        self.grant_if_due(machine);
        match self.grant_waits.get_mut(machine) {
            Some(wait) => {
                wait.commands.push(HeldCommand { msg, reply, outbox_id, quiet });
                None
            }
            None => Some((msg, reply, outbox_id)),
        }
    }

    /// A copy `machine` encrypted to the identity: skipped, held, or
    /// decrypted by the signer (see the module docs).
    pub(super) async fn on_identity_copy(&mut self, event: NostrEvent) {
        let machine = event.pubkey.clone();
        let written = u64::try_from(event.created_at).unwrap_or(0);
        if self.stores.machines.note_heard_via(&machine, &Recipient::Identity, written) {
            // It confirmed a grant once, so it is no bridge that never does:
            // no reason to wait out the throttle.
            log::info!("session key: {}... no longer holds it", short(&machine));
            self.grant_attempts.remove(&machine);
            self.persist_store(StoreId::Machines).await;
        }
        self.grant_if_due(&machine);
        if self.stores.machines.session_grant_sent_at(&machine).is_some_and(|sent| written < sent) {
            log::debug!("session key: skipped a message {}... wrote to the identity before the grant", short(&machine));
            return;
        }
        if let Some(wait) = self.grant_waits.get_mut(&machine) {
            if wait.events.len() >= HELD_EVENTS_MAX {
                wait.events.remove(0);
            }
            wait.events.push(event);
            return;
        }
        let _ = self.signer_jobs.send(SignerJob::Decrypt(event));
    }

    pub(super) fn on_grant_published(&mut self, machine: &str, seq: u64, delivered: bool) {
        if !self.grant_waits.get(machine).is_some_and(|w| w.seq == seq) {
            return;
        }
        if !delivered {
            log::warn!("session key: the grant to {}... did not go out; going on with the identity", short(machine));
            self.end_grant_wait(machine, false);
            return;
        }
        let timer = self.arm(GRANT_WAIT.as_millis() as u64, Msg::GrantWaitOver { machine: machine.to_string(), seq });
        if let Some(wait) = self.grant_waits.get_mut(machine) {
            wait.timer = Some(timer);
        }
    }

    pub(super) fn on_grant_wait_over(&mut self, machine: &str, seq: u64) {
        if self.grant_waits.get(machine).is_some_and(|w| w.seq == seq) {
            log::warn!("session key: {}... did not confirm the grant; going on with the identity", short(machine));
            self.end_grant_wait(machine, false);
        }
    }

    /// `machine` is no longer waiting on its grant: it `confirmed` it, or
    /// it ran out of time. What was held goes out, or is dropped.
    pub(super) fn end_grant_wait(&mut self, machine: &str, confirmed: bool) {
        let Some(mut wait) = self.grant_waits.remove(machine) else { return };
        abort(&mut wait.timer);
        if self.stores.machines.machine(machine).is_none() {
            return;
        }
        if confirmed && !wait.events.is_empty() {
            log::info!(
                "session key: {} message(s) {}... wrote to the identity dropped unread; the key brings them anew",
                wait.events.len(),
                short(machine)
            );
        }
        for held in wait.commands {
            let answered = confirmed
                && matches!(held.msg, PhoneToBridge::RefreshSessions(_))
                && held.reply.is_none()
                && held.outbox_id.is_none();
            if !answered {
                self.sign_and_publish(machine.to_string(), held.msg, held.reply, held.outbox_id, held.quiet);
            }
        }
        if !confirmed {
            // Only what nothing newer replaces: live output comes back by
            // sync, and a heartbeat is superseded by the newest one.
            let newest_list = wait.events.iter().filter(|e| e.kind == SESSION_LIST_KIND).map(|e| e.created_at).max();
            for event in wait.events {
                let superseded =
                    event.kind == LIVE_KIND || (event.kind == SESSION_LIST_KIND && Some(event.created_at) != newest_list);
                if !superseded {
                    let _ = self.signer_jobs.send(SignerJob::Decrypt(event));
                }
            }
        }
    }
}
