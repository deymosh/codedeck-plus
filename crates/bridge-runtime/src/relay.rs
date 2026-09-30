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
//! produced them. Each event also goes to the phone's direct link, if it has
//! one open (see `crate::direct`), ahead of the relays.

use std::collections::HashMap;
use std::rc::Rc;

use bridge_core::{Addressee, InboundEvent, Input, Via};
use nostr::{EventBuilder, Keys, Kind, PublicKey, Tag, TagKind, Timestamp};
use nostr_transport::{Filter, NostrEvent, SubCallbacks, Transport, TransportSub, WsConfig, WsTransport};
use protocol::chunking::frame_encoded_message;
use protocol::crypto::{encrypt_to, Keypair};
use protocol::events::BridgeToPhone;
use protocol::kinds::{COMMAND_KIND, LIVE_KIND, RESPONSE_EXPIRY_SECONDS, RESPONSE_KIND, SESSION_LIST_KIND};
use protocol::nostr_event::SignedEvent;
use protocol::events::OutputMsg;
use futures_util::future::LocalBoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::VecDeque;
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
    /// The signed events carrying `message` to `to`: `p`-tagged to the
    /// phone's identity, the payload encrypted to `to.key`.
    pub fn events(&mut self, message: &BridgeToPhone, to: &Addressee, now_secs: u64) -> Result<Vec<SignedEvent>, String> {
        let json = protocol::packing::pack(protocol::encode_bridge_to_phone(message));
        let (kind, expiry) = kind_for(message);
        let frames = frame_encoded_message(&json, || hex::encode(rand::random::<[u8; 16]>()));
        let chunked = frames.len() > 1;
        let created_at = self.next_created_at(now_secs);
        let recipient = PublicKey::from_hex(&to.phone).map_err(|e| format!("bad phone key: {e}"))?;
        let signer = Keys::new(self.keys.secret_key.clone());
        frames
            .iter()
            .map(|frame| {
                let content = encrypt_to(&self.keys.secret_key, &to.key, frame).map_err(|e| e.to_string())?;
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

/// The first wait after a relay says `rate-limited:`; it doubles each time
/// one says so again, up to [`RATE_LIMIT_MAX_WAIT`].
const RATE_LIMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
const RATE_LIMIT_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// How many times an event every relay refused as too many is sent again.
const RATE_LIMIT_RETRIES: u32 = 3;

/// Until when the relays asked the bridge to slow down. Shared by every
/// publish, whatever its lane: a relay that limits the rate limits this
/// bridge's connection, not one session's messages.
#[derive(Clone, Default)]
struct Quiet(Rc<std::cell::Cell<Option<tokio::time::Instant>>>);

impl Quiet {
    async fn wait(&self) {
        if let Some(until) = self.0.get() {
            if until > tokio::time::Instant::now() {
                tokio::time::sleep_until(until).await;
            }
        }
    }
}

/// Whether every relay refused because it gets too much from this bridge.
fn rate_limited(result: &nostr_transport::PublishResult) -> bool {
    result.verdict == nostr_transport::PublishVerdict::Rejected
        && result.detail.as_deref().is_some_and(|d| d.starts_with("rate-limited:"))
}

/// Publish `event` and wait for a relay's word; whether one took it. When
/// every relay refused it as too many, every publish holds off for a while
/// (longer each time) and this one is sent again after.
async fn publish(transport: &WsTransport, event: &SignedEvent, quiet: &Quiet) -> bool {
    let mut wait = RATE_LIMIT_WAIT;
    for attempt in 0..=RATE_LIMIT_RETRIES {
        quiet.wait().await;
        let result = transport
            .publish_confirmed(event, nostr_transport::ws::PUBLISH_CONFIRM_BUDGET, nostr_transport::ws::PUBLISH_CONFIRM_ATTEMPTS)
            .await;
        if !rate_limited(&result) || attempt == RATE_LIMIT_RETRIES {
            if !result.verdict.is_delivered() {
                log::warn!("[Relays] Publish of kind {} not delivered: {:?} {:?}", event.kind, result.verdict, result.detail);
            }
            return result.verdict.is_delivered();
        }
        log::warn!("[Relays] Rate-limited; holding publishes for {}s", wait.as_secs());
        quiet.0.set(Some(tokio::time::Instant::now() + wait));
        wait = (wait * 2).min(RATE_LIMIT_MAX_WAIT);
    }
    false
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The most a run of outputs grows to by taking in the ones queued after it:
/// what one event carries without being split into fragments.
const RUN_MAX_BYTES: usize = protocol::chunking::NIP44_SAFE_PLAINTEXT_BYTES;

/// Take the outputs queued right behind `run` into it, while they continue
/// it — the same session to the same phones, seqs straight on — and it still
/// fits one event. Only the front of `backlog` is looked at, so what goes out
/// keeps its order.
fn absorb_run(run: &mut OutputMsg, to: &[Addressee], backlog: &mut VecDeque<Job>) {
    let mut size = protocol::encode_bridge_to_phone(&BridgeToPhone::Output(run.clone())).len();
    while let Some(Job::Publish { to: next_to, message }) = backlog.front() {
        let BridgeToPhone::Output(next) = message.as_ref() else { break };
        let continues = next_to.as_slice() == to
            && next.session_id == run.session_id
            && next.seq == run.seq + run.entries.len() as u64;
        let adds: usize = next.entries.iter().map(|e| serde_json::to_string(e).map_or(0, |j| j.len() + 1)).sum();
        if !continues || size + adds > RUN_MAX_BYTES {
            break;
        }
        let Some(Job::Publish { message, .. }) = backlog.pop_front() else { break };
        let BridgeToPhone::Output(next) = *message else { break };
        run.entries.extend(next.entries);
        size += adds;
    }
}

/// Whether a heartbeat to `to` has a newer one queued behind it. A relay
/// keeps only a machine's latest heartbeat (it is replaceable), so the older
/// one need not take a relay's round trip: a turn starting, a card opening
/// and the context filling each mark the list, one right after another.
fn superseded(to: &[Addressee], backlog: &VecDeque<Job>) -> bool {
    backlog.iter().any(|job| {
        matches!(job, Job::Publish { to: next_to, message }
            if next_to.as_slice() == to && matches!(message.as_ref(), BridgeToPhone::Sessions(_)))
    })
}

/// How many publishes may wait on the relays at once. Kept low: public
/// relays limit how fast one connection may publish, and overlapping only
/// has to hide the round trips, not add to what is sent.
const IN_FLIGHT: usize = 3;

/// The lane a message travels in, if it may overlap others: a session's
/// outputs go one after another (the phone acts on each entry as it lands,
/// and a later one may undo what an earlier one did, so they must land in
/// order), heartbeats in a lane of their own; different lanes overlap. Every
/// other message — a sync's begin, chunks and end, acks, pairing — goes out
/// alone once everything before it has.
fn lane_of(message: &BridgeToPhone) -> Option<String> {
    match message {
        BridgeToPhone::Output(o) => Some(format!("output {}", o.session_id)),
        BridgeToPhone::Sessions(_) => Some("heartbeat".to_string()),
        _ => None,
    }
}

/// A publish that finished: its lane, and for a heartbeat, which one it was
/// for its phone and its events, to send again if no relay took it.
struct Sent {
    lane: Option<String>,
    phone: String,
    beat: Option<u64>,
    events: Vec<SignedEvent>,
    delivered: bool,
}

/// Publish `events` in order and report how it went.
fn send(
    transport: WsTransport,
    quiet: Quiet,
    lane: Option<String>,
    phone: String,
    beat: Option<u64>,
    events: Vec<SignedEvent>,
) -> LocalBoxFuture<'static, Sent> {
    Box::pin(async move {
        let mut delivered = true;
        for event in &events {
            delivered &= publish(&transport, event, &quiet).await;
        }
        Sent { lane, phone, beat, events, delivered }
    })
}

/// The publishes waiting on the relays, by lane.
#[derive(Default)]
struct Flight {
    running: FuturesUnordered<LocalBoxFuture<'static, Sent>>,
    lanes: HashMap<String, usize>,
    /// Per phone, the latest heartbeat no relay took (the first one goes out
    /// before any relay is up, over Tor by seconds): sent again once a relay
    /// is, instead of at the next beat a minute on.
    unsent_beats: HashMap<String, Vec<SignedEvent>>,
    /// Per phone, the number of its latest heartbeat: an older one finishing
    /// after a newer says nothing about what the phone has.
    beats: HashMap<String, u64>,
    quiet: Quiet,
}

impl Flight {
    fn next_beat(&mut self, phone: &str) -> u64 {
        let n = self.beats.entry(phone.to_string()).or_default();
        *n += 1;
        *n
    }

    fn start(&mut self, lane: &str, sending: LocalBoxFuture<'static, Sent>) {
        *self.lanes.entry(lane.to_string()).or_default() += 1;
        self.running.push(sending);
    }

    fn settle(&mut self, sent: Sent) {
        if let Some(lane) = &sent.lane {
            if let Some(n) = self.lanes.get_mut(lane) {
                *n -= 1;
                if *n == 0 {
                    self.lanes.remove(lane);
                }
            }
        }
        if sent.beat.is_some() && sent.beat == self.beats.get(&sent.phone).copied() {
            if sent.delivered {
                self.unsent_beats.remove(&sent.phone);
            } else {
                self.unsent_beats.insert(sent.phone, sent.events);
            }
        }
    }

    /// Wait until `lane` is free and there is room for one more.
    async fn room_in(&mut self, lane: &str) {
        while self.lanes.contains_key(lane) || self.running.len() >= IN_FLIGHT {
            let Some(sent) = self.running.next().await else { break };
            self.settle(sent);
        }
    }

    /// Wait until nothing is in flight.
    async fn land_all(&mut self) {
        while let Some(sent) = self.running.next().await {
            self.settle(sent);
        }
    }
}

enum Job {
    Publish { to: Vec<Addressee>, message: Box<BridgeToPhone> },
    /// Resolves once every job queued before it is done.
    Flush(oneshot::Sender<()>),
    /// A relay's socket came up or went down.
    RelaysChanged,
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
    /// Connect. From then on the transport redials each relay that fails on
    /// its own backoff, and replays every open subscription when it is back.
    pub fn start(
        relays: Vec<String>,
        keys: Keypair,
        machine: String,
        proxy: Option<String>,
        inputs: mpsc::UnboundedSender<Input>,
        direct: Option<Rc<crate::direct::Hub>>,
    ) -> Self {
        let bridge_pubkey = keys.pubkey_hex.clone();
        let transport = WsTransport::new(WsConfig { relays, auth: Rc::new(keys.clone()), proxy });

        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let relays_changed = jobs.clone();
        transport.on_relays_changed(Rc::new(move || {
            let _ = relays_changed.send(Job::RelaysChanged);
        }));
        transport.ensure_connected();
        let publisher = transport.clone();
        tokio::task::spawn_local(async move {
            let mut factory = EventFactory::new(keys, machine);
            let mut flight = Flight::default();
            // Jobs taken off the queue but not yet done: the outputs queued
            // behind a publish go out together with it.
            let mut backlog: VecDeque<Job> = VecDeque::new();
            loop {
                let job = match backlog.pop_front() {
                    Some(job) => job,
                    None => tokio::select! {
                        job = queue.recv() => match job {
                            Some(job) => job,
                            None => break,
                        },
                        Some(sent) = flight.running.next(), if !flight.running.is_empty() => {
                            flight.settle(sent);
                            continue;
                        }
                    },
                };
                match job {
                    Job::Flush(done) => {
                        flight.land_all().await;
                        let _ = done.send(());
                    }
                    Job::Publish { to, mut message } => {
                        let lane = lane_of(&message);
                        match &lane {
                            Some(lane) => flight.room_in(lane).await,
                            None => flight.land_all().await,
                        }
                        while let Ok(next) = queue.try_recv() {
                            backlog.push_back(next);
                        }
                        if let BridgeToPhone::Output(run) = message.as_mut() {
                            absorb_run(run, &to, &mut backlog);
                        }
                        let beat = matches!(*message, BridgeToPhone::Sessions(_));
                        if beat && superseded(&to, &backlog) {
                            continue;
                        }
                        for addressee in to {
                            let events = match factory.events(&message, &addressee, now_secs()) {
                                Ok(events) => events,
                                Err(err) => {
                                    let phone = &addressee.phone;
                                    log::error!("[Relays] Could not build an event for {}...: {err}", &phone[..8.min(phone.len())]);
                                    continue;
                                }
                            };
                            if let Some(direct) = &direct {
                                for event in &events {
                                    direct.deliver(&addressee.phone, event);
                                }
                            }
                            let beat = beat.then(|| flight.next_beat(&addressee.phone));
                            let sending = send(publisher.clone(), flight.quiet.clone(), lane.clone(), addressee.phone, beat, events);
                            match &lane {
                                Some(lane) => flight.start(lane, sending),
                                // Out of any lane: nothing overlaps it.
                                None => flight.settle(sending.await),
                            }
                        }
                    }
                    Job::RelaysChanged => {
                        flight.land_all().await;
                        if flight.unsent_beats.is_empty() || publisher.connected_relays().is_empty() {
                            continue;
                        }
                        for (phone, events) in std::mem::take(&mut flight.unsent_beats) {
                            let mut delivered = true;
                            for event in &events {
                                delivered &= publish(&publisher, event, &flight.quiet).await;
                            }
                            if !delivered {
                                flight.unsent_beats.insert(phone, events);
                            }
                        }
                    }
                }
            }
        });

        Self { transport, bridge_pubkey, inputs, commands: None, pairing: None, jobs }
    }

    pub fn publish(&self, to: Vec<Addressee>, message: BridgeToPhone) {
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
    use protocol::events::SessionListMsg;
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
            direct: None,
        })
    }

    /// A heartbeat published before any relay is up goes out as soon as one
    /// is, without waiting for the next beat.
    #[tokio::test]
    async fn a_heartbeat_no_relay_took_goes_out_when_one_comes_up() {
        use futures_util::StreamExt;
        tokio::task::LocalSet::new()
            .run_until(async {
                // Dialled but not answered: the relay stays down until accepted.
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("ws://{}", listener.local_addr().unwrap());
                let (inputs, _events) = mpsc::unbounded_channel();
                let bridge = generate_keypair();
                let phone = generate_keypair();
                let relays = Relays::start(vec![url], bridge, "laptop".into(), None, inputs, None);
                relays.publish(vec![to(&phone.pubkey_hex)], heartbeat());
                relays.flush().await;

                let (tcp, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let kind = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    loop {
                        let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) = ws.next().await else { continue };
                        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                        if frame[0] == "EVENT" {
                            break frame[1]["kind"].as_u64();
                        }
                    }
                })
                .await
                .expect("the heartbeat went out once the relay was up");
                assert_eq!(kind, Some(u64::from(SESSION_LIST_KIND)));
            })
            .await;
    }

    #[test]
    fn each_message_type_rides_its_kind_with_its_tags() {
        let bridge = generate_keypair();
        let phone = generate_keypair();
        let mut f = EventFactory::new(bridge.clone(), "laptop".into());
        let hb = f.events(&heartbeat(), &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!((hb.kind, tag(&hb, "d"), tag(&hb, "p")), (SESSION_LIST_KIND, Some("laptop"), Some(phone.pubkey_hex.as_str())));
        assert_eq!(tag(&hb, "expiration"), None);

        let out = BridgeToPhone::Output(OutputMsg { session_id: "s".into(), seq: 7, entries: vec![OutputEntry::new("t", EntryBody::Status { text: "x".into() })] });
        let ev = f.events(&out, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!((ev.kind, tag(&ev, "s"), tag(&ev, "seq")), (LIVE_KIND, Some("s"), Some("7")));
        let plain = decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &ev.content).unwrap();
        assert_eq!(protocol::decode_bridge_to_phone(&plain).unwrap(), out);

        let ack = BridgeToPhone::InputAck(protocol::events::InputAckMsg { session_id: "s".into(), input_id: "i".into() });
        let ev = f.events(&ack, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!(ev.kind, RESPONSE_KIND);
        assert_eq!(tag(&ev, "expiration").unwrap().parse::<u64>().unwrap(), ev.created_at + 3600);
    }

    fn to(phone: &str) -> Addressee {
        Addressee { phone: phone.to_string(), key: phone.to_string() }
    }

    #[test]
    fn a_session_key_encrypts_the_payload_and_the_identity_stays_the_recipient() {
        let bridge = generate_keypair();
        let (phone, session) = (generate_keypair(), generate_keypair());
        let mut f = EventFactory::new(bridge.clone(), "laptop".into());
        let addressee = Addressee { phone: phone.pubkey_hex.clone(), key: session.pubkey_hex.clone() };
        let ev = f.events(&heartbeat(), &addressee, 1000).unwrap().remove(0);
        assert_eq!(tag(&ev, "p"), Some(phone.pubkey_hex.as_str()));
        assert!(decrypt_from(&session.secret_key, &bridge.pubkey_hex, &ev.content).is_ok());
        assert!(decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &ev.content).is_err());
    }

    #[test]
    fn created_at_strictly_increases_within_a_second() {
        let phone = generate_keypair();
        let mut f = EventFactory::new(generate_keypair(), "m".into());
        let a = f.events(&heartbeat(), &to(&phone.pubkey_hex), 1000).unwrap()[0].created_at;
        let b = f.events(&heartbeat(), &to(&phone.pubkey_hex), 1000).unwrap()[0].created_at;
        assert!(b > a);
    }

    fn output(session: &str, seq: u64, texts: &[&str]) -> OutputMsg {
        OutputMsg {
            session_id: session.into(),
            seq,
            entries: texts.iter().map(|t| OutputEntry::new("t", EntryBody::Status { text: t.to_string() })).collect(),
        }
    }
    fn job(to: &[Addressee], m: OutputMsg) -> Job {
        Job::Publish { to: to.to_vec(), message: Box::new(BridgeToPhone::Output(m)) }
    }

    #[test]
    fn outputs_queued_behind_a_run_join_it_while_they_continue_it() {
        let phone = [to("p")];
        let mut run = output("s", 1, &["a"]);
        let mut backlog: VecDeque<Job> = VecDeque::from([
            job(&phone, output("s", 2, &["b", "c"])),
            job(&phone, output("s", 4, &["d"])),
            // Another session: it and everything after it wait their turn.
            job(&phone, output("other", 1, &["x"])),
            job(&phone, output("s", 5, &["e"])),
        ]);
        absorb_run(&mut run, &phone, &mut backlog);
        assert_eq!((run.seq, run.entries.len()), (1, 4));
        assert_eq!(backlog.len(), 2);
    }

    #[test]
    fn a_run_takes_in_nothing_that_does_not_continue_it_or_would_not_fit() {
        let phone = [to("p")];
        let mut run = output("s", 1, &["a"]);
        // Other phones, a gap in the seqs, a flush between.
        for next in [job(&[to("q")], output("s", 2, &["b"])), job(&phone, output("s", 3, &["b"])), Job::Flush(oneshot::channel().0)] {
            let mut backlog = VecDeque::from([next]);
            absorb_run(&mut run, &phone, &mut backlog);
            assert_eq!((run.entries.len(), backlog.len()), (1, 1));
        }
        // More than one event holds.
        let big = "x".repeat(RUN_MAX_BYTES / 2);
        let mut run = output("s", 1, &[&big]);
        let mut backlog = VecDeque::from([job(&phone, output("s", 2, &[&big])), job(&phone, output("s", 3, &["y"]))]);
        absorb_run(&mut run, &phone, &mut backlog);
        assert_eq!((run.entries.len(), backlog.len()), (1, 2));
    }

    fn beat(to: &[Addressee]) -> Job {
        Job::Publish { to: to.to_vec(), message: Box::new(heartbeat()) }
    }

    #[test]
    fn a_heartbeat_with_a_newer_one_queued_behind_it_is_superseded() {
        let phone = [to("p")];
        let backlog = VecDeque::from([job(&phone, output("s", 1, &["a"])), beat(&phone)]);
        assert!(superseded(&phone, &backlog));
        // Only by a heartbeat to the same phones.
        assert!(!superseded(&phone, &VecDeque::from([beat(&[to("q")])])));
        assert!(!superseded(&phone, &VecDeque::from([job(&phone, output("s", 1, &["a"]))])));
    }

    fn status(text: String) -> BridgeToPhone {
        BridgeToPhone::Output(OutputMsg { session_id: "s".into(), seq: 1, entries: vec![OutputEntry::new("t", EntryBody::Status { text })] })
    }

    #[test]
    fn a_long_message_that_packs_small_goes_whole() {
        let phone = generate_keypair();
        let bridge = generate_keypair();
        let mut f = EventFactory::new(bridge.clone(), "m".into());
        let message = status("x".repeat(100_000));
        let events = f.events(&message, &to(&phone.pubkey_hex), 1000).unwrap();
        assert_eq!(events.len(), 1);
        let plain = decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &events[0].content).unwrap();
        assert!(plain.starts_with(protocol::packing::PACKED_PREFIX));
        assert_eq!(protocol::decode_bridge_to_phone(&plain).unwrap(), message);
    }

    #[test]
    fn a_session_s_outputs_share_a_lane_and_only_they_and_heartbeats_overlap() {
        assert_eq!(lane_of(&BridgeToPhone::Output(output("s", 1, &["a"]))), lane_of(&BridgeToPhone::Output(output("s", 9, &["b"]))));
        assert_ne!(lane_of(&BridgeToPhone::Output(output("s", 1, &["a"]))), lane_of(&BridgeToPhone::Output(output("t", 1, &["a"]))));
        assert!(lane_of(&heartbeat()).is_some());
        let end = BridgeToPhone::SyncEnd(protocol::events::SyncEndMsg { session_id: "s".into(), sync_id: "y".into(), delivered_ranges: vec![] });
        assert_eq!(lane_of(&end), None);
    }

    fn sent(lane: &str, phone: &str, beat: Option<u64>, delivered: bool) -> Sent {
        Sent { lane: Some(lane.into()), phone: phone.into(), beat, events: Vec::new(), delivered }
    }

    #[test]
    fn only_the_latest_heartbeat_decides_whether_one_is_owed() {
        let mut f = Flight::default();
        let (older, newer) = (f.next_beat("p"), f.next_beat("p"));
        f.lanes.insert("heartbeat".into(), 2);
        // The newer one lands first; the older failing after says nothing.
        f.settle(sent("heartbeat", "p", Some(newer), true));
        f.settle(sent("heartbeat", "p", Some(older), false));
        assert!(f.unsent_beats.is_empty());
        assert!(f.lanes.is_empty());
        // The latest failing is owed.
        let latest = f.next_beat("p");
        f.lanes.insert("heartbeat".into(), 1);
        f.settle(sent("heartbeat", "p", Some(latest), false));
        assert!(f.unsent_beats.contains_key("p"));
    }

    #[test]
    fn only_a_refusal_for_too_many_holds_publishes_off() {
        use nostr_transport::{PublishResult, PublishVerdict};
        let refused = |detail: &str| PublishResult { verdict: PublishVerdict::Rejected, detail: Some(detail.into()) };
        assert!(rate_limited(&refused("rate-limited: slow down")));
        assert!(!rate_limited(&refused("blocked: not on the list")));
        assert!(!rate_limited(&PublishResult { verdict: PublishVerdict::Accepted, detail: None }));
    }

    #[test]
    fn an_oversize_message_is_split_into_untagged_fragments() {
        let phone = generate_keypair();
        let mut f = EventFactory::new(generate_keypair(), "m".into());
        // Text that does not compress: it stays past what one event holds.
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let noise: String = (0..100_000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                char::from(b'a' + (x % 26) as u8)
            })
            .collect();
        let events = f.events(&status(noise), &to(&phone.pubkey_hex), 1000).unwrap();
        assert!(events.len() >= 3);
        assert!(events.iter().all(|e| tag(e, "seq").is_none() && e.content.len() <= 65_535));
        assert!(events.iter().all(|e| e.created_at == events[0].created_at));
    }
}
