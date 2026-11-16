//! How the loop reaches the machines: the relay set, the subscription's
//! authors and recipient tags, and each machine's direct link.

use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use client_core::connection::ConnectionStatus;
use nostr_transport::direct::{DirectConfig as LinkConfig, DirectHandlers, DirectLink};

use super::{recipients_of, DirectTarget, Loop, Msg};
use crate::signer::IdentityAuth;

impl Loop {
    /// Start, restart or stop each machine's direct link to match where it
    /// can be reached now (and the Orbot proxy, and whether the core runs).
    pub(super) fn sync_direct_links(&mut self) {
        let proxy = self.ws.current_proxy();
        let now = self.clock.now_ms();
        let wanted: HashMap<String, DirectTarget> = if self.links_on {
            self.machines
                .iter()
                .filter_map(|m| {
                    let (endpoints, pin) = self.stores.machines.direct_target(m)?;
                    let recipients = self.session.recipient_tags(m, &self.keys.identity_pubkey_hex, now);
                    Some((m.clone(), DirectTarget { endpoints, pin, proxy: proxy.clone(), recipients }))
                })
                .collect()
        } else {
            HashMap::new()
        };
        let stale: Vec<String> =
            self.links.iter().filter(|(m, (target, _))| wanted.get(*m) != Some(target)).map(|(m, _)| m.clone()).collect();
        for machine in stale {
            if let Some((_, link)) = self.links.remove(&machine) {
                link.stop();
            }
        }
        for (machine, target) in wanted {
            if self.links.contains_key(&machine) {
                continue;
            }
            let (events, states) = (self.self_tx.clone(), self.self_tx.clone());
            let name = machine.clone();
            let link = DirectLink::start(
                LinkConfig {
                    endpoints: target.endpoints.clone(),
                    cert_sha256: target.pin.clone(),
                    proxy: target.proxy.clone(),
                    recipients: target.recipients.clone(),
                    auth: Rc::new(IdentityAuth(Rc::clone(&self.signer))),
                },
                DirectHandlers {
                    on_event: Rc::new(move |event| {
                        let _ = events.send(Msg::DirectEvent(event));
                    }),
                    on_state: Rc::new(move |endpoint| {
                        let _ = states.send(Msg::DirectState { machine: name.clone(), endpoint });
                    }),
                },
            );
            link.set_ping_interval(self.link_ping);
            self.links.insert(machine, (target, link));
        }
    }

    pub(super) fn set_link_ping(&mut self, every: Duration) {
        self.link_ping = every;
        for (_, link) in self.links.values() {
            link.set_ping_interval(every);
        }
    }

    /// Point the transport at the stores' relay set when it changed: a
    /// pairing began or ended, a machine was added or removed, or its relays
    /// were edited.
    pub(super) fn sync_relays(&mut self) {
        *self.host.relays.borrow_mut() = self.stores.bridge_relays();
        let relays = self.stores.relay_set();
        if relays != self.relay_set {
            log::info!("relays: {relays:?}");
            self.nostr.set_relays(&relays);
            self.relay_set = relays;
        }
    }

    /// Subscription authors = registered machines + the pairing candidate (its
    /// pair-ack must pass the filter), and the recipient tags of this
    /// client's copies from them. Push them to the `LoopHost` and, if
    /// connected, re-REQ.
    pub(super) fn refresh_authors(&mut self) {
        let mut authors = self.stores.machines.machine_pubkeys();
        if let Some(candidate) = &self.stores.pairing.candidate {
            if !authors.contains(&candidate.pubkey_hex) {
                authors.push(candidate.pubkey_hex.clone());
            }
        }
        *self.host.recipients.borrow_mut() =
            recipients_of(&self.session, &self.keys.identity_pubkey_hex, &authors, self.clock.now_ms());
        *self.host.machines.borrow_mut() = authors.clone();
        *self.host.relays.borrow_mut() = self.stores.bridge_relays();
        self.machines = authors;
        if matches!(
            self.conn.status,
            ConnectionStatus::Connected | ConnectionStatus::Connecting
        ) {
            self.nostr.resubscribe();
        }
    }
}
