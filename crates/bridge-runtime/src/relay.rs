//! The relays: the command and pairing subscriptions, and publishing.
//!
//! Publishing turns one bridge→phone message into one signed, NIP-44
//! encrypted event per copy (one per client of each phone, see
//! `bridge_core::Addressee`), tagged with the copy's recipient tag (`c`,
//! `protocol::recipients`), of the kind its type calls for:
//! - `sessions` → the replaceable heartbeat (`d` = the recipient tag, so
//!   each client keeps its own; each fragment of a split one its own `d`),
//!   expiring after a day;
//! - `output`, `usage` → ephemeral live events (loss is
//!   recovered by sync or a re-request);
//! - everything else → stored responses expiring after an hour, so a phone
//!   that was briefly away still gets them.
//!
//! A message too big for one event is split into `chunk` fragments below the
//! message layer; every fragment carries the copy's recipient tag. Publishes go out one at a time, in the order the engine
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
use protocol::kinds::{
    COMMAND_KIND, LIVE_KIND, RESPONSE_EXPIRY_SECONDS, RESPONSE_KIND, SESSION_LIST_EXPIRY_SECONDS, SESSION_LIST_KIND,
};
use protocol::recipients::{self, fragment_d};
use protocol::nostr_event::SignedEvent;
use protocol::events::{OutputMsg, PartialMsg, TerminalOutputMsg};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use futures_util::future::LocalBoxFuture;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::VecDeque;
use tokio::sync::{mpsc, oneshot};

/// Which kind a message rides, and whether it expires.
pub fn kind_for(message: &BridgeToPhone) -> (u16, Option<u64>) {
    match message {
        BridgeToPhone::Sessions(_) => (SESSION_LIST_KIND, Some(SESSION_LIST_EXPIRY_SECONDS)),
        // A partial is the one that must never be stored: it is only text on
        // its way to the entry that completes it.
        // Terminal output rides the live kind too: it is the other half of
        // the terminal's byte stream, and a relay must never store it — the
        // bytes a shell printed can hold a secret, and a stored frame would
        // outlive the terminal itself. Loss is fine: every frame carries the
        // terminal's byte offset, and a phone that sees a gap replays from
        // the ring.
        BridgeToPhone::Output(_)
        | BridgeToPhone::Usage(_)
        | BridgeToPhone::Partial(_)
        | BridgeToPhone::TerminalOutput(_) => (LIVE_KIND, None),
        _ => (RESPONSE_KIND, Some(RESPONSE_EXPIRY_SECONDS)),
    }
}

/// The tags of fragment `index` of a copy for `recipient` (its recipient
/// tag), besides `p`, `c` and the expiry.
fn tags_for(message: &BridgeToPhone, recipient: &str, fragment: Option<usize>) -> Vec<(&'static str, String)> {
    if let BridgeToPhone::Sessions(_) = message {
        // Addressable per client, and per fragment when split.
        return vec![("d", fragment.map_or_else(|| recipient.to_string(), |i| fragment_d(recipient, i)))];
    }
    if fragment.is_some() {
        // A fragment has no seq of its own; the reassembled message has it.
        return Vec::new();
    }
    match message {
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
    /// Strictly increasing `created_at`, so a replaceable heartbeat published
    /// twice in one second is never refused as older.
    last_created_at: u64,
}

impl EventFactory {
    pub fn new(keys: Keypair) -> Self {
        Self { keys, last_created_at: 0 }
    }

    fn next_created_at(&mut self, now_secs: u64) -> u64 {
        self.last_created_at = now_secs.max(self.last_created_at + 1);
        self.last_created_at
    }

    /// The signed events carrying `message` to `to`, in order: `p`-tagged to
    /// the phone's identity and `c`-tagged with the copy's recipient tag, the
    /// payload encrypted to `to.key`.
    pub fn events(&mut self, message: &BridgeToPhone, to: &Addressee, now_secs: u64) -> Result<Vec<SignedEvent>, String> {
        let json = protocol::packing::pack(protocol::encode_bridge_to_phone(message));
        let (kind, expiry) = kind_for(message);
        let frames = frame_encoded_message(&json, || hex::encode(rand::random::<[u8; 16]>()));
        let chunked = frames.len() > 1;
        let created_at = self.next_created_at(now_secs);
        let recipient = PublicKey::from_hex(&to.phone).map_err(|e| format!("bad phone key: {e}"))?;
        let signer = Keys::new(self.keys.secret_key.clone());
        let recipient_tag = recipients::recipient_tag(&self.keys.pubkey_hex, &to.key);
        frames
            .iter()
            .enumerate()
            .map(|(i, frame)| {
                let content = encrypt_to(&self.keys.secret_key, &to.key, frame).map_err(|e| e.to_string())?;
                let mut tags = vec![
                    Tag::public_key(recipient),
                    Tag::custom(TagKind::custom(recipients::RECIPIENT_TAG), [recipient_tag.clone()]),
                ];
                for (name, value) in tags_for(message, &recipient_tag, chunked.then_some(i)) {
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

/// Take the pieces of the same part queued right behind `run` into it, while
/// they continue it, so a relay slower than the agent writes costs one event
/// per round trip, not one per piece. Only the front of `backlog` is looked
/// at, so what goes out keeps its order.
fn absorb_partial(run: &mut PartialMsg, to: &[Addressee], backlog: &mut VecDeque<Job>) {
    while let Some(Job::Publish { to: next_to, message }) = backlog.front() {
        let BridgeToPhone::Partial(next) = message.as_ref() else { break };
        let end = run.offset + run.text.encode_utf16().count() as u64;
        let continues = next_to.as_slice() == to && next.session_id == run.session_id && next.key == run.key && next.offset == end;
        if !continues || run.text.len() + next.text.len() > RUN_MAX_BYTES / 2 {
            break;
        }
        let Some(Job::Publish { message, .. }) = backlog.pop_front() else { break };
        let BridgeToPhone::Partial(next) = *message else { break };
        run.text.push_str(&next.text);
    }
}

/// Whether the entry that completes `partial`'s part is already queued for
/// `to`: it carries the whole text, so the piece need not take a round trip.
fn completed(partial: &PartialMsg, to: &[Addressee], backlog: &VecDeque<Job>) -> bool {
    backlog.iter().any(|job| {
        matches!(job, Job::Publish { to: next_to, message }
            if next_to.as_slice() == to
                && matches!(message.as_ref(), BridgeToPhone::Output(o)
                    if o.session_id == partial.session_id
                        && o.entries.iter().any(|e| e.part.as_deref() == Some(partial.key.as_str()))))
    })
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
        // In its session's lane, so it never lands after the entry that
        // completes its part, and never holds up anything else.
        BridgeToPhone::Partial(p) => Some(format!("output {}", p.session_id)),
        // A terminal's output in a lane of its own: one terminal's burst
        // never delays another's, and neither delays a session's.
        BridgeToPhone::TerminalOutput(t) => Some(format!("terminal {}", t.term)),
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

/// Terminal output over the relays is paced, not passed through. A shell
/// writes as fast as it likes, and the runtime hands the bridge one frame at
/// most every 16 ms; a relay must see far less, or a terminal spends the
/// bridge's rate limit and gets its commands throttled with it. Frames for
/// one terminal are merged while they wait — they are contiguous byte ranges,
/// so merging is appending the bytes and keeping the first offset — and one
/// merged frame goes out per window, at most ten a second whatever the shell
/// does. This is the bridge's lowest-priority traffic.
const TERMINAL_FLUSH: std::time::Duration = std::time::Duration::from_millis(100);
/// The most merged bytes held for one terminal before the oldest are dropped.
/// The phone then sees a gap in the terminal's byte offsets and asks for a
/// replay from the ring — the recovery the design already has — so the bridge
/// holds a bounded amount for a terminal that outruns the relays.
const TERMINAL_PENDING_MAX_BYTES: usize = 256 * 1024;

/// Terminal output waiting for its flush window, one entry per (terminal,
/// clients) pair.
#[derive(Default)]
struct TerminalPace {
    pending: Vec<PendingTerminal>,
}

struct PendingTerminal {
    to: Vec<Addressee>,
    term: String,
    /// The first byte of the merged range.
    offset: u64,
    /// The merged bytes, contiguous from `offset`.
    data: Vec<u8>,
    /// Whether this range is the answer to a `terminal-replay`, and so may
    /// start past what the phone asked for; kept through the merge so the
    /// paced frame still says so.
    replay: Option<bool>,
    /// When this terminal's window is up.
    due: tokio::time::Instant,
}

impl PendingTerminal {
    /// Whether `msg` continues this range: the same terminal, the same
    /// clients, the same replay marking, and the byte straight after what is
    /// held. A replay answer never folds into live output, or the other way
    /// round: the marking describes where the range starts.
    fn continues(&self, to: &[Addressee], msg: &TerminalOutputMsg) -> bool {
        self.term == msg.term
            && self.to.as_slice() == to
            && self.replay == msg.replay
            && self.offset + self.data.len() as u64 == msg.offset
    }
}

impl TerminalPace {
    /// Fold one frame in: append it to the terminal's pending range, or start
    /// one. Only a frame that continues a range is appended; one that does not
    /// starts an entry of its own — the design makes frames contiguous, so
    /// this is the safe fallback, not the common case.
    fn merge(&mut self, to: Vec<Addressee>, msg: &TerminalOutputMsg, now: tokio::time::Instant) {
        let bytes = STANDARD.decode(&msg.data).unwrap_or_default();
        if let Some(p) = self.pending.iter_mut().find(|p| p.continues(&to, msg)) {
            p.data.extend_from_slice(&bytes);
            // Past the cap, drop the oldest: a gap the phone replays from the
            // ring.
            if p.data.len() > TERMINAL_PENDING_MAX_BYTES {
                let drop = p.data.len() - TERMINAL_PENDING_MAX_BYTES;
                p.data.drain(..drop);
                p.offset += drop as u64;
            }
            return;
        }
        self.pending.push(PendingTerminal {
            to,
            term: msg.term.clone(),
            offset: msg.offset,
            data: bytes,
            replay: msg.replay,
            due: now + TERMINAL_FLUSH,
        });
    }

    /// Take the terminal-output jobs queued right behind the front into the
    /// range they continue, so they cost one event rather than one each.
    fn absorb(&mut self, backlog: &mut VecDeque<Job>, now: tokio::time::Instant) {
        while let Some(Job::Publish { to, message }) = backlog.front() {
            let BridgeToPhone::TerminalOutput(msg) = message.as_ref() else { break };
            if !self.pending.iter().any(|p| p.continues(to, msg)) {
                break;
            }
            let Some(Job::Publish { to, message }) = backlog.pop_front() else { break };
            let BridgeToPhone::TerminalOutput(msg) = *message else { break };
            self.merge(to, &msg, now);
        }
    }

    fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// The pending entries whose window is up, removed.
    fn take_due(&mut self, now: tokio::time::Instant) -> Vec<PendingTerminal> {
        let mut ready = Vec::new();
        let mut wait = Vec::new();
        for p in self.pending.drain(..) {
            if p.due <= now {
                ready.push(p);
            } else {
                wait.push(p);
            }
        }
        self.pending = wait;
        ready
    }

    /// Every pending entry, for a flush.
    fn take_all(&mut self) -> Vec<PendingTerminal> {
        std::mem::take(&mut self.pending)
    }

    /// Resolves when the earliest pending window is up (never, with none).
    async fn wait_due(&self) {
        if let Some(due) = self.pending.iter().map(|p| p.due).min() {
            tokio::time::sleep_until(due).await;
        }
    }
}

/// Send what a terminal has merged whose window is up (`all` for a flush).
/// Each goes on its terminal's own lane, so a terminal never waits on a
/// session's publish.
async fn flush_terminals(
    terminal: &mut TerminalPace,
    factory: &mut EventFactory,
    flight: &mut Flight,
    publisher: &WsTransport,
    direct: Option<&Rc<crate::direct::Hub>>,
    all: bool,
) {
    let ready = if all { terminal.take_all() } else { terminal.take_due(tokio::time::Instant::now()) };
    for p in ready {
        let message = BridgeToPhone::TerminalOutput(TerminalOutputMsg {
            term: p.term,
            offset: p.offset,
            data: STANDARD.encode(&p.data),
            replay: p.replay,
        });
        let lane = lane_of(&message);
        match &lane {
            Some(lane) => flight.room_in(lane).await,
            None => flight.land_all().await,
        }
        send_message(factory, flight, publisher, direct, lane, p.to, &message).await;
    }
}

/// Build the events for one message to `to`, hand each copy to the direct link
/// and start its relay publish. The caller has already waited for the lane to
/// be free.
async fn send_message(
    factory: &mut EventFactory,
    flight: &mut Flight,
    publisher: &WsTransport,
    direct: Option<&Rc<crate::direct::Hub>>,
    lane: Option<String>,
    to: Vec<Addressee>,
    message: &BridgeToPhone,
) {
    let beat = matches!(message, BridgeToPhone::Sessions(_));
    // Terminal output rides the direct link's low-priority lane; every other
    // copy rides its normal one.
    let is_terminal = matches!(message, BridgeToPhone::TerminalOutput(_));
    for addressee in to {
        let events = match factory.events(message, &addressee, now_secs()) {
            Ok(events) => events,
            Err(err) => {
                let phone = &addressee.phone;
                log::error!("[Relays] Could not build an event for {}...: {err}", &phone[..8.min(phone.len())]);
                continue;
            }
        };
        if let Some(direct) = direct {
            for event in &events {
                direct.deliver(&addressee.phone, event, is_terminal);
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

enum Job {
    Publish { to: Vec<Addressee>, message: Box<BridgeToPhone> },
    /// Resolves once every job queued before it is done.
    Flush(oneshot::Sender<()>),
    /// A relay's socket came up or went down.
    RelaysChanged,
}/// The relay connections, the bridge's subscriptions on them, and the
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
            let mut factory = EventFactory::new(keys);
            let mut flight = Flight::default();
            // Jobs taken off the queue but not yet done: the outputs queued
            // behind a publish go out together with it.
            let mut backlog: VecDeque<Job> = VecDeque::new();
            // Terminal output waiting for its flush window (see TerminalPace).
            let mut terminal = TerminalPace::default();
            loop {
                // A terminal whose window is up goes out before anything else
                // this turn. Doing it here, not only when the queue is idle,
                // is what keeps a busy backlog from starving a terminal: the
                // send is on the terminal's own lane, so it waits on nothing.
                flush_terminals(&mut terminal, &mut factory, &mut flight, &publisher, direct.as_ref(), false).await;
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
                        // A terminal's window is up: wake the loop, which
                        // sends it above.
                        _ = terminal.wait_due(), if terminal.has_pending() => continue,
                    },
                };
                match job {
                    Job::Flush(done) => {
                        // What a terminal merged is part of what a flush
                        // promises has gone out.
                        flush_terminals(&mut terminal, &mut factory, &mut flight, &publisher, direct.as_ref(), true).await;
                        flight.land_all().await;
                        let _ = done.send(());
                    }
                    Job::Publish { to, mut message } => {
                        if matches!(message.as_ref(), BridgeToPhone::TerminalOutput(_)) {
                            // Paced, not passed through: merge it into the
                            // terminal's pending range and let its window
                            // carry it out.
                            while let Ok(next) = queue.try_recv() {
                                backlog.push_back(next);
                            }
                            let now = tokio::time::Instant::now();
                            if let BridgeToPhone::TerminalOutput(msg) = message.as_ref() {
                                terminal.merge(to, msg, now);
                            }
                            terminal.absorb(&mut backlog, now);
                            continue;
                        }
                        let lane = lane_of(&message);
                        match &lane {
                            Some(lane) => flight.room_in(lane).await,
                            None => flight.land_all().await,
                        }
                        while let Ok(next) = queue.try_recv() {
                            backlog.push_back(next);
                        }
                        match message.as_mut() {
                            BridgeToPhone::Output(run) => absorb_run(run, &to, &mut backlog),
                            BridgeToPhone::Partial(part) => {
                                if completed(part, &to, &backlog) {
                                    continue;
                                }
                                absorb_partial(part, &to, &mut backlog);
                            }
                            _ => {}
                        }
                        let beat = matches!(*message, BridgeToPhone::Sessions(_));
                        if beat && superseded(&to, &backlog) {
                            continue;
                        }
                        send_message(&mut factory, &mut flight, &publisher, direct.as_ref(), lane, to, &message).await;
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

    /// Start with the routing the config produced
    /// ([`NostrTransports`](crate::work::NostrTransports)): the same relays
    /// and the same proxy the Blossom client uses. Taking both from one value
    /// is what keeps a configured Tor proxy on every relay dial as well as
    /// every Blossom request.
    pub fn start_with(
        nostr: &crate::work::NostrTransports,
        keys: Keypair,
        inputs: mpsc::UnboundedSender<Input>,
        direct: Option<Rc<crate::direct::Hub>>,
    ) -> Self {
        Self::start(nostr.relays.clone(), keys, nostr.proxy.clone(), inputs, direct)
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
            // Both command paths log the same way; an onion endpoint is a
            // direct link with Tor in front of it, and neither is subscribed
            // here.
            Via::Relay | Via::Direct | Via::Onion => "command",
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
                        kind: event.kind,
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

    /// Replace the command subscription (no paired phone = none). `live` also
    /// subscribes to the live kind, so a paired phone's terminal input reaches
    /// the bridge over a relay as its commands do. Only when the owner allows
    /// a terminal over relays: off, the bridge keeps the plain command
    /// subscription and a relay never sees a keystroke.
    pub fn subscribe_commands(&mut self, authors: Vec<String>, since: u64, live: bool) {
        if let Some(old) = self.commands.take() {
            old.close();
        }
        if authors.is_empty() {
            return;
        }
        let mut kinds = vec![COMMAND_KIND];
        if live {
            kinds.push(LIVE_KIND);
        }
        let filter = Filter {
            kinds,
            authors,
            p_tags: vec![self.bridge_pubkey.clone()],
            d_tags: vec![],
            c_tags: vec![],
            since: Some(since as i64),
        };
        self.commands = Some(self.subscribe(filter, Via::Relay));
    }

    /// The pairing window's subscription: no author filter.
    pub fn open_pairing(&mut self, since: u64) {
        self.close_pairing();
        let filter = Filter {
            kinds: vec![COMMAND_KIND],
            authors: vec![],
            p_tags: vec![self.bridge_pubkey.clone()],
            d_tags: vec![],
            c_tags: vec![],
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
            capabilities: None,
            folders: None,
            roots: None,
            removed_sessions: None,
            machine_offline: None,
            direct: None,
            terminals: None,
            rev: None,
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
                let relays = Relays::start(vec![url], bridge, None, inputs, None);
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
        let mut f = EventFactory::new(bridge.clone());
        let hb = f.events(&heartbeat(), &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        let recipient = recipients::recipient_tag(&bridge.pubkey_hex, &phone.pubkey_hex);
        assert_eq!(
            (hb.kind, tag(&hb, "d"), tag(&hb, "c"), tag(&hb, "p")),
            (SESSION_LIST_KIND, Some(recipient.as_str()), Some(recipient.as_str()), Some(phone.pubkey_hex.as_str()))
        );
        assert_eq!(tag(&hb, "expiration").unwrap().parse::<u64>().unwrap(), hb.created_at + SESSION_LIST_EXPIRY_SECONDS);

        let out = BridgeToPhone::Output(OutputMsg { session_id: "s".into(), seq: 7, entries: vec![OutputEntry::new("t", EntryBody::Status { text: "x".into() })] });
        let ev = f.events(&out, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!((ev.kind, tag(&ev, "s"), tag(&ev, "seq")), (LIVE_KIND, Some("s"), Some("7")));
        assert_eq!((tag(&ev, "c"), tag(&ev, "d")), (Some(recipient.as_str()), None));
        let plain = decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &ev.content).unwrap();
        assert_eq!(protocol::decode_bridge_to_phone(&plain).unwrap(), out);

        let partial = BridgeToPhone::Partial(protocol::events::PartialMsg {
            session_id: "s".into(),
            key: "k".into(),
            entry_type: protocol::common::PartialKind::Text,
            subagent: None,
            offset: 0,
            text: "x".into(),
        });
        let ev = f.events(&partial, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!((ev.kind, tag(&ev, "s"), tag(&ev, "expiration")), (LIVE_KIND, None, None));

        let ack = BridgeToPhone::InputAck(protocol::events::InputAckMsg { session_id: "s".into(), input_id: "i".into() });
        let ev = f.events(&ack, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!(ev.kind, RESPONSE_KIND);
        assert_eq!(tag(&ev, "expiration").unwrap().parse::<u64>().unwrap(), ev.created_at + 3600);

        // Terminal output rides the live kind and is never stored: the bytes
        // a shell printed may hold a secret, and a stored frame would outlive
        // the terminal.
        let out = BridgeToPhone::TerminalOutput(TerminalOutputMsg {
            term: "t".into(),
            offset: 0,
            data: "aGk=".into(),
            replay: None,
        });
        let ev = f.events(&out, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!((ev.kind, tag(&ev, "expiration")), (LIVE_KIND, None));
        // The small, state-like terminal messages are stored responses: a
        // phone that was briefly away still learns a terminal opened or ended.
        let opened = BridgeToPhone::TerminalOpened(protocol::events::TerminalOpenedMsg {
            open_id: "o".into(),
            term: "t".into(),
            shell: "/bin/sh".into(),
        });
        let ev = f.events(&opened, &to(&phone.pubkey_hex), 1000).unwrap().remove(0);
        assert_eq!(ev.kind, RESPONSE_KIND);
    }

    fn to(phone: &str) -> Addressee {
        Addressee { phone: phone.to_string(), key: phone.to_string() }
    }

    #[test]
    fn a_session_key_encrypts_the_payload_and_the_identity_stays_the_recipient() {
        let bridge = generate_keypair();
        let (phone, session) = (generate_keypair(), generate_keypair());
        let mut f = EventFactory::new(bridge.clone());
        let addressee = Addressee { phone: phone.pubkey_hex.clone(), key: session.pubkey_hex.clone() };
        let ev = f.events(&heartbeat(), &addressee, 1000).unwrap().remove(0);
        assert_eq!(tag(&ev, "p"), Some(phone.pubkey_hex.as_str()));
        // The copy is the session key's: its tag and `d` are the key's.
        let recipient = recipients::recipient_tag(&bridge.pubkey_hex, &session.pubkey_hex);
        assert_eq!((tag(&ev, "c"), tag(&ev, "d")), (Some(recipient.as_str()), Some(recipient.as_str())));
        assert!(decrypt_from(&session.secret_key, &bridge.pubkey_hex, &ev.content).is_ok());
        assert!(decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &ev.content).is_err());
    }

    #[test]
    fn created_at_strictly_increases_within_a_second() {
        let phone = generate_keypair();
        let mut f = EventFactory::new(generate_keypair());
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

    fn piece(key: &str, offset: u64, text: &str) -> PartialMsg {
        PartialMsg {
            session_id: "s".into(),
            key: key.into(),
            entry_type: protocol::common::PartialKind::Text,
            subagent: None,
            offset,
            text: text.into(),
        }
    }

    fn piece_job(to: &[Addressee], m: PartialMsg) -> Job {
        Job::Publish { to: to.to_vec(), message: Box::new(BridgeToPhone::Partial(m)) }
    }

    #[test]
    fn queued_pieces_of_a_part_go_out_as_one() {
        let phone = [to("p")];
        let mut run = piece("k", 0, "ab");
        let mut backlog = VecDeque::from([
            piece_job(&phone, piece("k", 2, "c🎉")),
            piece_job(&phone, piece("k", 5, "d")),
            // Another part, and a piece that does not continue: both stay.
            piece_job(&phone, piece("j", 0, "x")),
            piece_job(&phone, piece("k", 9, "e")),
        ]);
        absorb_partial(&mut run, &phone, &mut backlog);
        assert_eq!((run.offset, run.text.as_str(), backlog.len()), (0, "abc🎉d", 2));
    }

    #[test]
    fn a_piece_whose_part_is_already_completed_in_the_queue_is_not_sent() {
        let phone = [to("p")];
        let mut done = output("s", 1, &["abc"]);
        done.entries[0].part = Some("k".into());
        let backlog = VecDeque::from([job(&phone, done)]);
        assert!(completed(&piece("k", 0, "ab"), &phone, &backlog));
        assert!(!completed(&piece("j", 0, "ab"), &phone, &backlog));
        assert!(!completed(&piece("k", 0, "ab"), &[to("q")], &backlog));
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
        let mut f = EventFactory::new(bridge.clone());
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
        // Each terminal's output overlaps another's, and never a session's.
        let a = lane_of(&BridgeToPhone::TerminalOutput(output_msg("t", 0, b"a")));
        let b = lane_of(&BridgeToPhone::TerminalOutput(output_msg("u", 0, b"a")));
        assert!(a.is_some() && b.is_some() && a != b);
        assert_ne!(a, lane_of(&BridgeToPhone::Output(output("s", 1, &["a"]))));
    }

    fn output_msg(term: &str, offset: u64, data: &[u8]) -> TerminalOutputMsg {
        TerminalOutputMsg { term: term.into(), offset, data: STANDARD.encode(data), replay: None }
    }

    fn term_job(to: &[Addressee], msg: TerminalOutputMsg) -> Job {
        Job::Publish { to: to.to_vec(), message: Box::new(BridgeToPhone::TerminalOutput(msg)) }
    }

    #[test]
    fn terminal_output_merges_into_one_range_and_goes_once_a_window() {
        let phone = [to("p")];
        let t0 = tokio::time::Instant::now();
        let mut pace = TerminalPace::default();
        pace.merge(phone.to_vec(), &output_msg("t", 0, b"ab"), t0);
        pace.merge(phone.to_vec(), &output_msg("t", 2, b"cd"), t0);
        // Contiguous frames merge, and the window starts with the first.
        assert_eq!(pace.pending.len(), 1);
        assert_eq!((pace.pending[0].offset, pace.pending[0].data.as_slice()), (0, &b"abcd"[..]));
        assert!(pace.take_due(t0).is_empty(), "not due yet");
        let ready = pace.take_due(t0 + TERMINAL_FLUSH);
        assert_eq!((ready.len(), ready[0].offset, ready[0].data.as_slice()), (1, 0, &b"abcd"[..]));
        assert!(!pace.has_pending());
    }

    #[test]
    fn a_terminal_frame_that_does_not_continue_the_range_starts_its_own() {
        let phone = [to("p")];
        let t0 = tokio::time::Instant::now();
        let mut pace = TerminalPace::default();
        pace.merge(phone.to_vec(), &output_msg("t", 0, b"ab"), t0);
        // A gap (a dropped frame) must not be papered over by appending.
        pace.merge(phone.to_vec(), &output_msg("t", 5, b"cd"), t0);
        assert_eq!(pace.pending.len(), 2);
        assert_eq!(pace.pending[1].offset, 5);
    }

    #[test]
    fn terminal_output_past_the_cap_drops_the_oldest_bytes() {
        let phone = [to("p")];
        let t0 = tokio::time::Instant::now();
        let mut pace = TerminalPace::default();
        let half = TERMINAL_PENDING_MAX_BYTES / 2;
        pace.merge(phone.to_vec(), &output_msg("t", 0, &vec![b'a'; half]), t0);
        pace.merge(phone.to_vec(), &output_msg("t", half as u64, &vec![b'b'; half]), t0);
        pace.merge(phone.to_vec(), &output_msg("t", (half * 2) as u64, &vec![b'c'; half]), t0);
        assert_eq!(pace.pending[0].data.len(), TERMINAL_PENDING_MAX_BYTES);
        // The oldest bytes are gone, so the offset the phone is told to draw
        // from has moved: it sees a gap and replays from the ring.
        assert_eq!(pace.pending[0].offset, half as u64);
        assert_eq!(pace.pending[0].data[0], b'b');
    }

    #[test]
    fn terminal_jobs_queued_behind_a_frame_join_it() {
        let phone = [to("p")];
        let t0 = tokio::time::Instant::now();
        let mut pace = TerminalPace::default();
        pace.merge(phone.to_vec(), &output_msg("t", 0, b"a"), t0);
        let mut backlog = VecDeque::from([
            term_job(&phone, output_msg("t", 1, b"b")),
            // Another terminal, then a gap: both stay.
            term_job(&phone, output_msg("u", 0, b"x")),
            term_job(&phone, output_msg("t", 9, b"c")),
        ]);
        pace.absorb(&mut backlog, t0);
        assert_eq!((pace.pending.len(), pace.pending[0].data.as_slice(), backlog.len()), (1, &b"ab"[..], 2));
    }

    #[tokio::test]
    async fn a_terminal_window_that_is_not_due_does_not_block() {
        // `wait_due` resolves only once the window is up; with nothing
        // pending it is never awaited (the select guards on `has_pending`).
        let t0 = tokio::time::Instant::now();
        let mut pace = TerminalPace::default();
        pace.merge(vec![to("p")], &output_msg("t", 0, b"a"), t0);
        let waited = tokio::time::timeout(TERMINAL_FLUSH / 2, pace.wait_due()).await;
        assert!(waited.is_err(), "the window is not up yet");
        tokio::time::sleep(TERMINAL_FLUSH).await;
        tokio::time::timeout(std::time::Duration::from_millis(50), pace.wait_due()).await.expect("the window is up");
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

    /// Text that does not compress: it stays past what one event holds.
    fn noise() -> String {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        (0..100_000)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                char::from(b'a' + (x % 26) as u8)
            })
            .collect()
    }

    #[test]
    fn an_oversize_message_is_split_into_fragments_tagged_only_with_their_recipient() {
        let (bridge, phone) = (generate_keypair(), generate_keypair());
        let mut f = EventFactory::new(bridge.clone());
        let events = f.events(&status(noise()), &to(&phone.pubkey_hex), 1000).unwrap();
        assert!(events.len() >= 3);
        assert!(events.iter().all(|e| tag(e, "seq").is_none() && tag(e, "d").is_none() && e.content.len() <= 65_535));
        assert!(events.iter().all(|e| e.created_at == events[0].created_at));
        let recipient = recipients::recipient_tag(&bridge.pubkey_hex, &phone.pubkey_hex);
        assert!(events.iter().all(|e| tag(e, "c") == Some(recipient.as_str())));
    }

    #[test]
    fn each_fragment_of_a_split_heartbeat_has_its_own_d() {
        let (bridge, phone) = (generate_keypair(), generate_keypair());
        let mut f = EventFactory::new(bridge.clone());
        let BridgeToPhone::Sessions(mut list) = heartbeat() else { unreachable!() };
        list.machine = noise();
        let events = f.events(&BridgeToPhone::Sessions(list), &to(&phone.pubkey_hex), 1000).unwrap();
        assert!(events.len() >= 3);
        let recipient = recipients::recipient_tag(&bridge.pubkey_hex, &phone.pubkey_hex);
        for (i, e) in events.iter().enumerate() {
            assert_eq!(e.kind, SESSION_LIST_KIND);
            assert_eq!(tag(e, "d"), Some(fragment_d(&recipient, i).as_str()));
            assert_eq!(tag(e, "c"), Some(recipient.as_str()));
            assert_eq!(tag(e, "expiration").unwrap().parse::<u64>().unwrap(), e.created_at + SESSION_LIST_EXPIRY_SECONDS);
        }
    }
}
