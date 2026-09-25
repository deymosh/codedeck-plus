//! Inbound commands: a relay event becomes a decoded phone message, or is
//! dropped (with a log line) — never an error for the caller.
//!
//! - Events older than [`MAX_EVENT_AGE_SECS`] are dropped: a relay that does
//!   not honour `since` must not replay old commands.
//! - On the standing subscription, only paired phones are heard, and the
//!   check comes before dedup bookkeeping so a flood from strangers cannot
//!   evict real ids from the dedup set and reopen a replay window.
//! - Event ids are remembered (the last [`MAX_PROCESSED_IDS`]) and persisted:
//!   a reconnect subscribes with `since` = last seen − 5 s, so the relay
//!   replays recent commands, and without the ids they would run twice
//!   (duplicate sessions, re-sent input).
//! - The pairing window's subscription has no author filter, so it attracts
//!   junk: anything that does not decrypt is dropped silently and only then
//!   takes a dedup slot, and only a `pair-request` gets through.

use std::collections::{HashSet, VecDeque};

use protocol::commands::{PairRequestMsg, PhoneToBridge};
use protocol::crypto::{decrypt_from, Keypair};

use crate::io::InboundEvent;

pub const MAX_PROCESSED_IDS: usize = 1000;
pub const MAX_EVENT_AGE_SECS: u64 = 300;

/// Where a (re)connect's command subscription starts: the last event seen
/// minus a 5 s grace for a crash gap, else the last five minutes.
pub fn since_for_connect(last_seen: u64, now_secs: u64) -> u64 {
    if last_seen > 0 {
        last_seen.saturating_sub(5)
    } else {
        now_secs.saturating_sub(300)
    }
}

/// The standing subscription: command events tagged to the bridge from
/// these authors, created at or after `since`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandsFilter {
    pub authors: Vec<String>,
    pub since: u64,
}

pub struct Ingest {
    order: VecDeque<String>,
    seen: HashSet<String>,
    last_seen: u64,
}

fn short(pubkey: &str) -> &str {
    pubkey.get(..8).unwrap_or(pubkey)
}

impl Ingest {
    /// Resume from a persisted cursor and dedup set (oldest id first).
    pub fn new(last_seen: u64, processed: Vec<String>) -> Self {
        let mut ingest = Self { order: VecDeque::new(), seen: HashSet::new(), last_seen };
        let skip = processed.len().saturating_sub(MAX_PROCESSED_IDS);
        for id in processed.into_iter().skip(skip) {
            ingest.mark(&id);
        }
        ingest
    }

    /// Created-at of the newest command handled (seconds).
    pub fn last_seen(&self) -> u64 {
        self.last_seen
    }

    /// The dedup ids, oldest first, for persisting beside the cursor.
    pub fn processed_ids(&self) -> Vec<String> {
        self.order.iter().cloned().collect()
    }

    /// An event from the standing subscription.
    pub fn accept(
        &mut self,
        event: &InboundEvent,
        keys: &Keypair,
        now_secs: u64,
        is_paired: impl Fn(&str) -> bool,
    ) -> Option<PhoneToBridge> {
        if event.created_at + MAX_EVENT_AGE_SECS < now_secs {
            log::info!("[Ingest] Ignoring stale event ({}s old)", now_secs - event.created_at);
            return None;
        }
        if !is_paired(&event.pubkey) {
            log::info!("[Ingest] Ignoring event from unknown pubkey: {}...", short(&event.pubkey));
            return None;
        }
        if !self.mark(&event.id) {
            return None;
        }
        let plaintext = match decrypt_from(&keys.secret_key, &event.pubkey, &event.content) {
            Ok(p) => p,
            Err(err) => {
                log::info!("[Ingest] Failed to decrypt event {}...: {err}", short(&event.id));
                return None;
            }
        };
        let msg = match protocol::decode_phone_to_bridge(&plaintext) {
            Ok(msg) => msg,
            Err(err) => {
                log::info!("[Ingest] Dropping invalid payload from {}...: {err}", short(&event.pubkey));
                return None;
            }
        };
        self.last_seen = self.last_seen.max(event.created_at);
        Some(msg)
    }

    /// An event from the pairing window's subscription.
    pub fn accept_pairing(&mut self, event: &InboundEvent, keys: &Keypair, now_secs: u64) -> Option<PairRequestMsg> {
        if event.created_at + MAX_EVENT_AGE_SECS < now_secs {
            return None;
        }
        let plaintext = decrypt_from(&keys.secret_key, &event.pubkey, &event.content).ok()?;
        if !self.mark(&event.id) {
            return None;
        }
        match protocol::decode_phone_to_bridge(&plaintext) {
            Ok(PhoneToBridge::PairRequest(msg)) => {
                // The label is unverified sender input (the token is checked
                // later): Debug-quoted, so it cannot inject log lines.
                log::info!("[Ingest] Valid pair-request from {:?} ({}...)", msg.label, short(&event.pubkey));
                Some(msg)
            }
            _ => None,
        }
    }

    /// Remember an id; false when it was already there.
    fn mark(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        if self.order.len() > MAX_PROCESSED_IDS {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::{encrypt_to, generate_keypair};

    struct Fixture {
        bridge: Keypair,
        phone: Keypair,
        ingest: Ingest,
        n: u32,
    }

    const NOW: u64 = 1_800_000_000;

    impl Fixture {
        fn new() -> Self {
            Self { bridge: generate_keypair(), phone: generate_keypair(), ingest: Ingest::new(0, vec![]), n: 0 }
        }
        fn event_from(&mut self, from: &Keypair, json: &str, created_at: u64) -> InboundEvent {
            self.n += 1;
            InboundEvent {
                id: format!("ev{}", self.n),
                pubkey: from.pubkey_hex.clone(),
                created_at,
                content: encrypt_to(&from.secret_key, &self.bridge.pubkey_hex, json).unwrap(),
            }
        }
        fn event(&mut self, json: &str) -> InboundEvent {
            let phone = self.phone.clone();
            self.event_from(&phone, json, NOW)
        }
        fn accept(&mut self, event: &InboundEvent) -> Option<PhoneToBridge> {
            let phone = self.phone.pubkey_hex.clone();
            self.ingest.accept(event, &self.bridge, NOW, |pk| pk == phone)
        }
    }

    const INPUT: &str = r#"{"type":"input","sessionId":"s","text":"hi"}"#;

    #[test]
    fn a_valid_command_decrypts_decodes_and_advances_the_cursor() {
        let mut f = Fixture::new();
        let ev = f.event(INPUT);
        assert!(matches!(f.accept(&ev), Some(PhoneToBridge::Input(m)) if m.text == "hi"));
        assert_eq!(f.ingest.last_seen(), NOW);
    }

    #[test]
    fn malformed_unknown_and_undecryptable_payloads_are_dropped() {
        let mut f = Fixture::new();
        let bad_json = f.event("{not json");
        let unknown = f.event(r#"{"type":"teleport"}"#);
        let mut garbage = f.event(INPUT);
        garbage.content = "AAAA".into();
        assert!(f.accept(&bad_json).is_none());
        assert!(f.accept(&unknown).is_none());
        assert!(f.accept(&garbage).is_none());
        assert_eq!(f.ingest.last_seen(), 0, "nothing handled, cursor unmoved");
    }

    #[test]
    fn events_older_than_five_minutes_are_dropped() {
        let mut f = Fixture::new();
        let phone = f.phone.clone();
        let old = f.event_from(&phone, INPUT, NOW - 301);
        let edge = f.event_from(&phone, INPUT, NOW - 300);
        assert!(f.accept(&old).is_none());
        assert!(f.accept(&edge).is_some());
    }

    #[test]
    fn a_replayed_event_id_runs_once() {
        let mut f = Fixture::new();
        let ev = f.event(INPUT);
        assert!(f.accept(&ev).is_some());
        assert!(f.accept(&ev).is_none());
    }

    #[test]
    fn the_dedup_set_is_an_lru_capped_at_1000() {
        let mut f = Fixture::new();
        let first = f.event(INPUT);
        assert!(f.accept(&first).is_some());
        for i in 0..MAX_PROCESSED_IDS {
            assert!(f.ingest.mark(&format!("filler{i}")));
        }
        assert!(f.accept(&first).is_some(), "the oldest id aged out");
        assert_eq!(f.ingest.processed_ids().len(), MAX_PROCESSED_IDS);
    }

    #[test]
    fn a_persisted_dedup_set_survives_a_restart() {
        let mut f = Fixture::new();
        let ev = f.event(INPUT);
        assert!(f.accept(&ev).is_some());
        f.ingest = Ingest::new(f.ingest.last_seen(), f.ingest.processed_ids());
        assert!(f.accept(&ev).is_none(), "the relay's grace-window replay is a no-op");
    }

    #[test]
    fn strangers_are_dropped_before_they_take_a_dedup_slot() {
        let mut f = Fixture::new();
        let stranger = generate_keypair();
        let ev = f.event_from(&stranger, INPUT, NOW);
        assert!(f.accept(&ev).is_none());
        assert!(f.ingest.processed_ids().is_empty());
    }

    #[test]
    fn the_pairing_path_hears_strangers_but_only_their_pair_requests() {
        let mut f = Fixture::new();
        let stranger = generate_keypair();
        let pair = r#"{"type":"pair-request","npub":"n","pubkeyHex":"aa","label":"Pixel","token":"t"}"#;
        let ev = f.event_from(&stranger, pair, NOW);
        let req = f.ingest.accept_pairing(&ev, &f.bridge, NOW).unwrap();
        assert_eq!(req.label, "Pixel");
        assert!(f.ingest.accept_pairing(&ev, &f.bridge, NOW).is_none(), "deduped");

        let input = f.event_from(&stranger, INPUT, NOW);
        assert!(f.ingest.accept_pairing(&input, &f.bridge, NOW).is_none());
        let stale = f.event_from(&stranger, pair, NOW - 301);
        assert!(f.ingest.accept_pairing(&stale, &f.bridge, NOW).is_none());
    }

    #[test]
    fn junk_on_the_pairing_window_takes_no_dedup_slot() {
        let mut f = Fixture::new();
        let stranger = generate_keypair();
        let mut junk = f.event_from(&stranger, INPUT, NOW);
        junk.content = "not ciphertext".into();
        assert!(f.ingest.accept_pairing(&junk, &f.bridge, NOW).is_none());
        assert!(f.ingest.processed_ids().is_empty());
    }

    #[test]
    fn since_for_connect_uses_the_cursor_with_a_grace_else_five_minutes() {
        assert_eq!(since_for_connect(1000, 5000), 995);
        assert_eq!(since_for_connect(0, 5000), 4700);
    }
}
