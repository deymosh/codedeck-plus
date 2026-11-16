//! Commands out: built, signed and published over a direct link or the
//! relays, sync acks batched, and the outcome reported.

use std::rc::Rc;

use client_core::bridge_api::EgressError;
use nostr_transport::{PublishResult, PublishVerdict};
use protocol::commands::{PhoneToBridge, SyncAckMsg};
use protocol::nostr_event::SignedEvent;
use tokio::sync::oneshot;

use super::{
    abort, egress_detail, ActionFailedKind, CoreEvent, Loop, Msg, SignerJob, SliceId, ACK_BATCH_WINDOW,
    DIRECT_PUBLISH_WAIT,
};
use crate::dispatch::StoreId;
use crate::signer::Cipher;
use crate::transport::ws::{PUBLISH_CONFIRM_ATTEMPTS, PUBLISH_CONFIRM_BUDGET};

impl Loop {
    pub(super) fn on_send(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
    ) {
        match (msg, reply) {
            (PhoneToBridge::SyncAck(ack), None) => self.hold_ack(machine, ack),
            (msg, reply) => self.publish_command(machine, msg, reply, None),
        }
    }

    /// Hold `ack` for [`ACK_BATCH_WINDOW`], merged with the other acks of
    /// its sync.
    fn hold_ack(&mut self, machine: String, ack: SyncAckMsg) {
        match self.pending_acks.iter_mut().find(|(m, id, _)| *m == machine && *id == ack.sync_id) {
            Some((_, _, ranges)) => ranges.extend(ack.ranges),
            None => self.pending_acks.push((machine, ack.sync_id, ack.ranges)),
        }
        if self.ack_timer.is_none() {
            self.ack_timer = Some(self.arm(ACK_BATCH_WINDOW.as_millis() as u64, Msg::FlushAcks));
        }
    }

    /// Send the held acks now, one command per sync.
    pub(super) fn flush_acks(&mut self) {
        abort(&mut self.ack_timer);
        for (machine, sync_id, ranges) in std::mem::take(&mut self.pending_acks) {
            let ack = SyncAckMsg { sync_id, ranges };
            self.publish_command(machine, PhoneToBridge::SyncAck(ack), None, None);
        }
    }

    /// Like [`Self::on_send`] but the publish outcome comes back as
    /// [`Msg::PublishSettled`] so the loop can settle an outbox item.
    pub(super) fn on_send_tracked(&mut self, id: String, machine: String, msg: PhoneToBridge) {
        self.publish_command(machine, msg, None, Some(id));
    }

    /// What encrypts payloads for `machine`: the session key it confirmed,
    /// while the phone still holds it, else the identity.
    pub(super) fn cipher_for(&self, machine: &str) -> Cipher {
        let now = self.clock.now_ms();
        match self.stores.machines.session_key_of(machine, now).and_then(|k| self.session.key(k, now)) {
            Some(key) => Cipher::SessionKey(key.keypair.clone()),
            None => Cipher::Identity,
        }
    }

    fn publish_command(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
    ) {
        self.sign_and_publish(machine, msg, reply, outbox_id, false);
    }

    pub(super) fn sign_and_publish(
        &mut self,
        machine: String,
        msg: PhoneToBridge,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
        quiet: bool,
    ) {
        // Every command is signed by the identity, in order, through the
        // signer; `publish_built` takes it from there.
        let now = self.clock.now_ms();
        let cipher = match msg {
            // A pairing candidate does not know the session key yet.
            PhoneToBridge::PairRequest(_) => Cipher::Identity,
            _ => self.cipher_for(&machine),
        };
        let (msg, reply, outbox_id) = match self.hold_for_grant(&machine, &cipher, msg, reply, outbox_id, quiet) {
            Some(unheld) => unheld,
            None => return,
        };
        // Any command keeps this client present at the bridge.
        self.last_command_ms.insert(machine.clone(), now);
        let job = SignerJob::Command { machine, msg: Box::new(msg), cipher, now, reply, outbox_id, quiet };
        let _ = self.signer_jobs.send(job);
    }

    /// Publish a built command, or report why it could not be built. It goes
    /// over `machine`'s direct link when that is up and the bridge answers,
    /// else to the relays.
    pub(super) fn publish_built(
        &mut self,
        machine: &str,
        event: Result<SignedEvent, EgressError>,
        reply: Option<oneshot::Sender<PublishResult>>,
        outbox_id: Option<String>,
        quiet: bool,
    ) {
        let event = match event {
            Ok(event) => event,
            Err(err) => {
                if !quiet {
                    self.observer.action_failed(ActionFailedKind::PublishRejected);
                }
                let result = PublishResult {
                    verdict: PublishVerdict::Rejected,
                    detail: Some(egress_detail(&err)),
                };
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                } else if let Some(id) = outbox_id {
                    let _ = self.self_tx.send(Msg::PublishSettled { id, result });
                }
                return;
            }
        };

        // Publish off the loop so a 12s confirmation budget never blocks
        // socket-close / lifecycle handling. Only to `machine`'s relays: the
        // other machines' relays have no use for it.
        let ws = self.ws.clone();
        let relays = self.stores.relays_for(machine);
        let link = self.links.get(machine).map(|(_, link)| link.clone());
        let observer = Rc::clone(&self.observer);
        let self_tx = self.self_tx.clone();
        tokio::task::spawn_local(async move {
            let direct = match &link {
                Some(link) => link.publish(&event, DIRECT_PUBLISH_WAIT).await,
                None => None,
            };
            let result = match direct {
                Some(result) => result,
                None => ws.publish_confirmed_to(&event, &relays, PUBLISH_CONFIRM_BUDGET, PUBLISH_CONFIRM_ATTEMPTS).await,
            };
            let failed = match result.verdict {
                _ if quiet => None,
                PublishVerdict::Rejected => Some(ActionFailedKind::PublishRejected),
                PublishVerdict::Unreachable => Some(ActionFailedKind::PublishUnreachable),
                PublishVerdict::Accepted | PublishVerdict::Unconfirmed => None,
            };
            if let Some(kind) = failed {
                observer.action_failed(kind);
                observer.on_event(CoreEvent::ActionFailed { kind });
            }
            if let Some(reply) = reply {
                let _ = reply.send(result);
            } else if let Some(id) = outbox_id {
                let _ = self_tx.send(Msg::PublishSettled { id, result });
            }
        });
    }

    /// The publish of an outbox item settled — record it and emit `OutboxSettled`.
    pub(super) async fn on_publish_settled(&mut self, id: String, result: PublishResult) {
        let accepted = matches!(
            result.verdict,
            PublishVerdict::Accepted | PublishVerdict::Unconfirmed
        );
        self.stores
            .outbox
            .settle_publish(&id, accepted, result.detail, self.clock.now_ms());
        self.persist_store(StoreId::Outbox).await;
        self.state_changed(SliceId::Outbox);
        // `delivered` here means "published" — the bridge `input-ack` is the
        // real confirmation and fires a second `OutboxSettled` via the router.
        self.emit(CoreEvent::OutboxSettled {
            id,
            delivered: accepted,
        });
    }
}
