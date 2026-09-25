//! The pairing window: a time-boxed subscription with no author filter (the
//! only way an unpaired phone can reach the bridge), a QR with a one-time
//! token, and the pair-request that echoes it.

use protocol::commands::PairRequestMsg;
use protocol::crypto::npub_from_hex;
use protocol::events::{BridgeToPhone, PairAckMsg, PairAckReason};

use super::{Engine, PairingWindow};
use crate::io::{store_keys, Effect, MeshJoin, NotifyLevel, PairedPhone, PairingCloseReason, PairingWindowInfo};
use crate::out::TimerKind;
use crate::pairing::{pairing_url, PairingUrlParts};
use crate::time::iso;

impl Engine {
    /// Open a window (replacing any open one).
    pub(super) fn open_pairing(&mut self, duration_ms: Option<u64>, mesh: Option<MeshJoin>) {
        self.close_pairing(PairingCloseReason::Closed, None);
        let token = self.system.new_token();
        let duration = duration_ms.unwrap_or(self.config.pairing_window_ms);
        let url = pairing_url(&PairingUrlParts {
            npub: &self.config.keys.npub,
            relays: &self.config.relays,
            machine: &self.config.machine,
            token: &token,
            mesh: mesh.as_ref().map(|m| (m.admin_device_id.as_str(), m.netid.as_str())),
        });
        let now = self.now();
        self.pairing_epoch += 1;
        let epoch = self.pairing_epoch;
        let timer = self.out.set_timer(duration, TimerKind::PairingExpiry { epoch });
        // `since` is the window's start and stays fixed: a re-subscribe after
        // a relay drop then replays whatever a phone sent during the gap.
        self.out.push(Effect::OpenPairingSubscription { since: (now / 1000).saturating_sub(5) });
        self.out.push(Effect::PresentPairing(PairingWindowInfo {
            display_url: url.clone(),
            url,
            token: token.clone(),
            expires_at_ms: now + duration,
        }));
        self.pairing = Some(PairingWindow { token, epoch, timer });
        log::info!("[Engine] Pairing window opened for {}s", duration / 1000);
    }

    pub(super) fn close_pairing(&mut self, reason: PairingCloseReason, phone: Option<PairedPhone>) {
        let Some(window) = self.pairing.take() else { return };
        self.out.cancel_timer(window.timer);
        self.out.push(Effect::ClosePairingSubscription);
        self.out.push(Effect::PairingClosed { reason, phone });
    }

    /// Accept a pair-request that echoes the open window's token. The paired
    /// identity is the event's author, never what the payload claims.
    pub(super) fn on_pair_request(&mut self, m: PairRequestMsg, from: &str) {
        let short = from.get(..8).unwrap_or(from);
        let rejection = match &self.pairing {
            None => Some(PairAckReason::WindowClosed),
            Some(window) if window.token != m.token => Some(PairAckReason::BadToken),
            Some(_) => None,
        };
        if let Some(reason) = rejection {
            log::info!("[Engine] Rejecting pair-request from {short}...: {reason:?}");
            if self.nacks.allow(self.now()) {
                self.publish_to(
                    from,
                    BridgeToPhone::PairAck(PairAckMsg {
                        machine: self.config.machine.clone(),
                        ok: false,
                        reason: Some(reason),
                        relays: None,
                        host: None,
                    }),
                );
            } else {
                log::info!("[Engine] Negative pair-ack budget spent — not answering");
            }
            return;
        }
        let Ok(npub) = npub_from_hex(from) else {
            log::warn!("[Engine] pair-request from an invalid pubkey {short}... — dropped");
            return;
        };
        let label = if m.label.is_empty() { "Phone".to_string() } else { m.label };
        let phone = PairedPhone { npub, pubkey_hex: from.to_string(), label: label.clone(), paired_at: iso(self.now()) };
        log::info!("[Engine] Pairing phone \"{label}\" ({short}...)");
        self.close_pairing(PairingCloseReason::Paired, Some(phone.clone()));
        if !self.paired.iter().any(|p| p.pubkey_hex == phone.pubkey_hex) {
            self.paired.push(phone);
            let json = serde_json::to_string(&self.paired).expect("phones serialize");
            if let Err(err) = self.store.set(store_keys::PAIRED_PHONES, &json) {
                log::error!("[Engine] Could not store the paired phones: {err}");
            }
        }
        self.out.push(Effect::Resubscribe);
        self.list_dirty = true;
        // The relays and host ride along, so a phone that paired from a bare
        // npub (no relay list in its URL) learns where this bridge lives.
        self.publish_to(
            from,
            BridgeToPhone::PairAck(PairAckMsg {
                machine: self.config.machine.clone(),
                ok: true,
                reason: None,
                relays: Some(self.config.relays.clone()),
                host: self.config.host_kind,
            }),
        );
        self.out.push(Effect::Notify { level: NotifyLevel::Info, text: format!("Phone \"{label}\" paired") });
        self.out.push(Effect::RegisterPhone { pubkey_hex: from.to_string(), label });
    }
}
