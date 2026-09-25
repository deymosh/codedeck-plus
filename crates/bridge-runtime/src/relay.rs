//! The relays: the command and pairing subscriptions, and publishing.
//!
//! Publishing turns one bridge→phone message into one signed, NIP-44
//! encrypted event per phone, of the kind its type calls for:
//! - `sessions` → the replaceable heartbeat (`d` = machine name);
//! - `output`, `usage`, `gsd-state` → ephemeral live events (loss is
//!   recovered by sync or a re-request);
//! - everything else → stored responses expiring after an hour, so a phone
//!   that was briefly away still gets them.
//!
//! A message too big for one event is split into `chunk` fragments below the
//! message layer. Publishes go out one at a time, in the order the engine
//! produced them.

use std::rc::Rc;
use std::time::Duration;

use bridge_core::{InboundEvent, Input, Via};
use nostr::{EventBuilder, Keys, Kind, PublicKey, Tag, TagKind, Timestamp};
use nostr_transport::{Filter, NostrEvent, SubCallbacks, Transport, TransportSub, WsConfig, WsTransport};
use protocol::chunking::frame_encoded_message;
use protocol::crypto::{encrypt_to, Keypair};
use protocol::events::BridgeToPhone;
use protocol::kinds::{COMMAND_KIND, LIVE_KIND, RESPONSE_EXPIRY_SECONDS, RESPONSE_KIND, SESSION_LIST_KIND};
use protocol::nostr_event::SignedEvent;
use tokio::sync::{mpsc, oneshot};

/// Which kind a message rides, and whether it expires.
pub fn kind_for(message: &BridgeToPhone) -> (u16, Option<u64>) {
    match message {
        BridgeToPhone::Sessions(_) => (SESSION_LIST_KIND, None),
        BridgeToPhone::Output(_) | BridgeToPhone::Usage(_) | BridgeToPhone::GsdState(_) => (LIVE_KIND, None),
        _ => (RESPONSE_KIND, Some(RESPONSE_EXPIRY_SECONDS)),
    }
}

fn tags_for(message: &BridgeToPhone, machine: &str, chunked: bool) -> Vec<(&'static str, String)> {
    if chunked {
        // A fragment has no seq of its own; the reassembled message has it.
        return Vec::new();
    }
    match message {
        BridgeToPhone::Sessions(_) => vec![("d", machine.to_string())],
        BridgeToPhone::Output(o) => vec![("s", o.session_id.clone()), ("seq", o.seq.to_string())],
        BridgeToPhone::SyncBegin(m) => vec![("s", m.session_id.clone())],
        BridgeToPhone::SyncChunk(m) => vec![("s", m.session_id.clone())],
        BridgeToPhone::SyncEnd(m) => vec![("s", m.session_id.clone())],
        _ => Vec::new(),
    }
}

/// Builds the signed events for one message.
pub struct EventFactory {
    keys: Keypair,
    machine: String,
    /// Strictly increasing `created_at`, so a replaceable heartbeat published
    /// twice in one second is never refused as older.
    last_created_at: u64,
}

impl EventFactory {
    pub fn new(keys: Keypair, machine: String) -> Self {
        Self { keys, machine, last_created_at: 0 }
    }

    fn next_created_at(&mut self, now_secs: u64) -> u64 {
        self.last_created_at = now_secs.max(self.last_created_at + 1);
        self.last_created_at
    }

    /// Every event `message` becomes for `phone`, in order.
    pub fn events(&mut self, message: &BridgeToPhone, phone: &str, now_secs: u64) -> Result<Vec<SignedEvent>, String> {
        let json = protocol::encode_bridge_to_phone(message);
        let (kind, expiry) = kind_for(message);
        let frames = frame_encoded_message(&json, || hex::encode(rand::random::<[u8; 16]>()));
        let chunked = frames.len() > 1;
        let created_at = self.next_created_at(now_secs);
        let recipient = PublicKey::from_hex(phone).map_err(|e| format!("bad phone key: {e}"))?;
        let signer = Keys::new(self.keys.secret_key.clone());
        frames
            .iter()
            .map(|frame| {
                let content = encrypt_to(&self.keys.secret_key, phone, frame).map_err(|e| e.to_string())?;
                let mut tags = vec![Tag::public_key(recipient)];
                for (name, value) in tags_for(message, &self.machine, chunked) {
                    tags.push(Tag::custom(TagKind::custom(name), [value]));
                }
                if let Some(expiry) = expiry {
                    tags.push(Tag::expiration(Timestamp::from(created_at + expiry)));
                }
                EventBuilder::new(Kind::Custom(kind), content)
                    .tags(tags)
                    .custom_created_at(Timestamp::from(created_at))
                    .sign_with_keys(&signer)
                    .map(|e| SignedEvent::from_nostr(&e))
                    .map_err(|e| e.to_string())
            })
            .collect()
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

enum Job {
    Publish { to: Vec<String>, message: Box<BridgeToPhone> },
    /// Resolves once every job queued before it is done.
    Flush(oneshot::Sender<()>),
}

/// The relay connections, the bridge's subscriptions on them, and the
/// publish queue. Single-threaded (the transport is).
pub struct Relays {
    transport: WsTransport,
    bridge_pubkey: String,
    inputs: mpsc::UnboundedSender<Input>,
    commands: Option<Box<dyn TransportSub>>,
    pairing: Option<Box<dyn TransportSub>>,
    jobs: mpsc::UnboundedSender<Job>,
}

impl Relays {
    /// Connect, and keep reconnecting every `retry` for as long as the
    /// runtime runs (the transport itself never redials; it replays every
    /// open subscription when a relay comes back).
    pub fn start(
        relays: Vec<String>,
        keys: Keypair,
        machine: String,
        proxy: Option<String>,
        inputs: mpsc::UnboundedSender<Input>,
    ) -> Self {
        let retry = if proxy.is_some() { Duration::from_secs(10) } else { Duration::from_secs(3) };
        let bridge_pubkey = keys.pubkey_hex.clone();
        let transport = WsTransport::new(WsConfig { relays, identity: keys.clone(), proxy });
        transport.ensure_connected();
        let redial = transport.clone();
        tokio::task::spawn_local(async move {
            loop {
                tokio::time::sleep(retry).await;
                redial.ensure_connected();
            }
        });

        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let publisher = transport.clone();
        tokio::task::spawn_local(async move {
            let mut factory = EventFactory::new(keys, machine);
            while let Some(job) = queue.recv().await {
                match job {
                    Job::Flush(done) => {
                        let _ = done.send(());
                    }
                    Job::Publish { to, message } => {
                        for phone in to {
                            let events = match factory.events(&message, &phone, now_secs()) {
                                Ok(events) => events,
                                Err(err) => {
                                    log::error!("[Relays] Could not build an event for {}...: {err}", &phone[..8.min(phone.len())]);
                                    continue;
                                }
                            };
                            for event in events {
                                let result = publisher
                                    .publish_confirmed(&event, nostr_transport::ws::PUBLISH_CONFIRM_BUDGET, nostr_transport::ws::PUBLISH_CONFIRM_ATTEMPTS)
                                    .await;
                                if !result.verdict.is_delivered() {
                                    log::warn!("[Relays] Publish of kind {} not delivered: {:?} {:?}", event.kind, result.verdict, result.detail);
                                }
                            }
                        }
                    }
                }
            }
        });

        Self { transport, bridge_pubkey, inputs, commands: None, pairing: None, jobs }
    }

    pub fn publish(&self, to: Vec<String>, message: BridgeToPhone) {
        let _ = self.jobs.send(Job::Publish { to, message: Box::new(message) });
    }

    /// Wait until everything queued so far has been published (or given up on).
    pub async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.jobs.send(Job::Flush(done)).is_ok() {
            let _ = wait.await;
        }
    }

    fn subscribe(&self, filter: Filter, via: Via) -> Box<dyn TransportSub> {
        let inputs = self.inputs.clone();
        let label = match via {
            Via::Commands => "command",
            Via::Pairing => "pairing",
        };
        self.transport.subscribe(
            filter,
            SubCallbacks {
                on_event: Rc::new(move |event: &NostrEvent| {
                    let event = InboundEvent {
                        id: event.id.clone(),
                        pubkey: event.pubkey.clone(),
                        created_at: u64::try_from(event.created_at).unwrap_or(0),
                        content: event.content.clone(),
                    };
                    let _ = inputs.send(Input::RelayEvent { event, via });
                }),
                on_eose: Rc::new(|| {}),
                on_close: Rc::new(move |reason| {
                    // The transport replays the subscription when a relay
                    // comes back; until then, nothing arrives on it.
                    log::warn!("[Relays] The {label} subscription was dropped by a relay ({reason:?}); it is restored on reconnect");
                }),
            },
        )
    }

    /// Replace the command subscription (no paired phone = none).
    pub fn subscribe_commands(&mut self, authors: Vec<String>, since: u64) {
        if let Some(old) = self.commands.take() {
            old.close();
        }
        if authors.is_empty() {
            return;
        }
        let filter = Filter {
            kinds: vec![COMMAND_KIND],
            authors,
            p_tags: vec![self.bridge_pubkey.clone()],
            h_tags: vec![],
            since: Some(since as i64),
        };
        self.commands = Some(self.subscribe(filter, Via::Commands));
    }

    /// The pairing window's subscription: no author filter.
    pub fn open_pairing(&mut self, since: u64) {
        self.close_pairing();
        let filter = Filter {
            kinds: vec![COMMAND_KIND],
            authors: vec![],
            p_tags: vec![self.bridge_pubkey.clone()],
            h_tags: vec![],
            since: Some(since as i64),
        };
        self.pairing = Some(self.subscribe(filter, Via::Pairing));
    }

    pub fn close_pairing(&mut self) {
        if let Some(sub) = self.pairing.take() {
            sub.close();
        }
    }

    pub fn shutdown(&mut self) {
        self.close_pairing();
        if let Some(sub) = self.commands.take() {
            sub.close();
        }
        self.transport.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::crypto::{decrypt_from, generate_keypair};
    use protocol::events::{OutputMsg, SessionListMsg};
    use protocol::common::{EntryBody, OutputEntry};

    fn tag<'a>(e: &'a SignedEvent, name: &str) -> Option<&'a str> {
        e.tags.iter().find(|t| t[0] == name).map(|t| t[1].as_str())
    }

    fn heartbeat() -> BridgeToPhone {
        BridgeToPhone::Sessions(SessionListMsg {
            machine: "m".into(),
            host: None,
            sessions: vec![],
            agents: vec![],
            credentials: vec![],
            protocol_version: 11,
            capabilities: None,
            folders: None,
            roots: None,
            removed_sessions: None,
            machine_offline: None,
        })
    }

    #[test]
    fn each_message_type_rides_its_kind_with_its_tags() {
        let bridge = generate_keypair();
        let phone = generate_keypair();
        let mut f = EventFactory::new(bridge.clone(), "laptop".into());
        let hb = f.events(&heartbeat(), &phone.pubkey_hex, 1000).unwrap().remove(0);
        assert_eq!((hb.kind, tag(&hb, "d"), tag(&hb, "p")), (SESSION_LIST_KIND, Some("laptop"), Some(phone.pubkey_hex.as_str())));
        assert_eq!(tag(&hb, "expiration"), None);

        let out = BridgeToPhone::Output(OutputMsg { session_id: "s".into(), seq: 7, entry: OutputEntry::new("t", EntryBody::Status { text: "x".into() }) });
        let ev = f.events(&out, &phone.pubkey_hex, 1000).unwrap().remove(0);
        assert_eq!((ev.kind, tag(&ev, "s"), tag(&ev, "seq")), (LIVE_KIND, Some("s"), Some("7")));
        let plain = decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &ev.content).unwrap();
        assert_eq!(protocol::decode_bridge_to_phone(&plain).unwrap(), out);

        let ack = BridgeToPhone::InputAck(protocol::events::InputAckMsg { session_id: "s".into(), input_id: "i".into() });
        let ev = f.events(&ack, &phone.pubkey_hex, 1000).unwrap().remove(0);
        assert_eq!(ev.kind, RESPONSE_KIND);
        assert_eq!(tag(&ev, "expiration").unwrap().parse::<u64>().unwrap(), ev.created_at + 3600);
    }

    #[test]
    fn created_at_strictly_increases_within_a_second() {
        let phone = generate_keypair();
        let mut f = EventFactory::new(generate_keypair(), "m".into());
        let a = f.events(&heartbeat(), &phone.pubkey_hex, 1000).unwrap()[0].created_at;
        let b = f.events(&heartbeat(), &phone.pubkey_hex, 1000).unwrap()[0].created_at;
        assert!(b > a);
    }

    #[test]
    fn an_oversize_message_is_split_into_untagged_fragments() {
        let phone = generate_keypair();
        let mut f = EventFactory::new(generate_keypair(), "m".into());
        let big = BridgeToPhone::Output(OutputMsg {
            session_id: "s".into(),
            seq: 1,
            entry: OutputEntry::new("t", EntryBody::Status { text: "x".repeat(100_000) }),
        });
        let events = f.events(&big, &phone.pubkey_hex, 1000).unwrap();
        assert!(events.len() >= 3);
        assert!(events.iter().all(|e| tag(e, "seq").is_none() && e.content.len() <= 65_535));
        assert!(events.iter().all(|e| e.created_at == events[0].created_at));
    }
}
