//! Terminals through the engine: the gates that decide who may have one, the
//! writer, `seq`, who is told what, and how a terminal ends.
//!
//! Everything runs against in-memory ports and a manual clock: a terminal is
//! a state machine the runtime drives, and the tests drive it the same way.

mod support;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use bridge_core::{
    Addressee, Effect, Input, TerminalAllowlist, TerminalAuditRecord, TerminalAuditWhat, TerminalConfig, Via,
};
use protocol::common::{TerminalEndReason, TerminalEventKind, TerminalVia};
use protocol::crypto::{generate_keypair, Keypair};
use protocol::events::{
    BridgeToPhone, TerminalEventMsg, TerminalExitedMsg, TerminalInfo, TerminalOpenedMsg, TerminalOutputMsg,
};
use protocol::recipients::device_id;
use serde_json::{json, Value};
use support::*;

const NOW_SECS: u64 = T0 / 1000;
const DAY: u64 = 24 * 3600;

/// A rig with terminals on, and the paired phone's client granted a session
/// key: the client is what a device is derived from, so nothing can be opened
/// until it has one.
struct World {
    rig: Rig,
    /// The session key the client granted: its commands are encrypted with it.
    key: Keypair,
    device: String,
}

impl World {
    fn new() -> Self {
        Self::with(TerminalConfig { enabled: true, ..Default::default() })
    }

    /// A world whose owner decided `terminal`.
    fn with(terminal: TerminalConfig) -> Self {
        let rig = Rig::with(RigOptions { terminal, ..Default::default() });
        let key = generate_keypair();
        let device = device_id(&key.pubkey_hex);
        let mut world = Self { rig, key, device };
        world.grant(&world.key.clone(), "Pixel 8");
        let device = world.device.clone();
        world.allow(&[&device]);
        world.rig.take();
        world
    }

    /// The identity grants `key` to this bridge: from then on its commands are
    /// encrypted with it, and the device it is, is what a terminal needs
    /// approved. The grant itself is encrypted with the identity, which is all
    /// the bridge knows yet.
    fn grant(&mut self, key: &Keypair, label: &str) {
        let bridge = self.rig.bridge.pubkey_hex.clone();
        let phone = self.rig.phone.clone();
        self.rig.phone_event(
            &phone,
            json!({"v":12,"type":"session-key","sessionKey":{
                "pubkeyHex": key.pubkey_hex, "bridgePubkeyHex": bridge,
                "expiresAt": NOW_SECS + 90 * DAY, "label": label}}),
            Via::Direct,
        );
        self.rig.take();
    }

    /// The owner's allowlist, as `codedeck-bridge terminal allow|disallow`
    /// writes it.
    fn allow(&mut self, devices: &[&str]) {
        self.rig.input(Input::TerminalAllowlist(TerminalAllowlist {
            devices: devices.iter().map(|d| d.to_string()).collect(),
            ..Default::default()
        }));
    }

    /// Another device of the same identity: its own session key (and so its
    /// own device), approved like the first.
    fn other_device(&mut self) -> (Keypair, String) {
        let key = generate_keypair();
        let device = device_id(&key.pubkey_hex);
        self.grant(&key, "Tablet");
        let mut devices = vec![self.device.clone()];
        devices.push(device.clone());
        let refs: Vec<&str> = devices.iter().map(String::as_str).collect();
        self.allow(&refs);
        self.rig.take();
        (key, device)
    }

    /// A whole second identity pairs with this bridge, its client's key
    /// granted in the pair-request. Returns that client's device.
    fn pair_identity(&mut self, phone: &Keypair, key: &Keypair, label: &str) -> String {
        self.rig.input(Input::OpenPairing { duration_ms: None });
        let token = self
            .rig
            .take()
            .into_iter()
            .find_map(|e| match e {
                Effect::PresentPairing(info) => Some(info.token),
                _ => None,
            })
            .expect("the pairing window is presented");
        let bridge = self.rig.bridge.pubkey_hex.clone();
        self.rig.phone_event(
            phone,
            json!({"v":12,"type":"pair-request","npub": phone.npub, "pubkeyHex": phone.pubkey_hex,
                "label": label, "token": token,
                "sessionKey": {"pubkeyHex": key.pubkey_hex, "bridgePubkeyHex": bridge,
                    "expiresAt": NOW_SECS + 90 * DAY, "label": label}}),
            Via::Pairing,
        );
        self.rig.take();
        device_id(&key.pubkey_hex)
    }

    /// A command from the client, over the bridge's own link.
    fn command(&mut self, msg: Value) {
        let phone = self.rig.phone.clone();
        self.rig.phone_event_via_key(&phone, &self.key, msg, Via::Direct);
    }

    /// The same, from another device.
    fn command_from(&mut self, key: &Keypair, msg: Value) {
        let phone = self.rig.phone.clone();
        self.rig.phone_event_via_key(&phone, key, msg, Via::Direct);
    }

    /// The same, from another paired identity's client.
    fn command_as(&mut self, phone: &Keypair, key: &Keypair, msg: Value) {
        self.rig.phone_event_via_key(phone, key, msg, Via::Direct);
    }

    /// The same, over a relay.
    fn command_via_relay(&mut self, msg: Value) {
        let phone = self.rig.phone.clone();
        let key = self.key.clone();
        self.rig.phone_event_via_key(&phone, &key, msg, Via::Relay);
    }

    /// A keystroke event, on the live kind terminal input rides.
    fn input(&mut self, term: &str, seq: u64, text: &str) {
        let key = self.key.clone();
        self.input_from(&key, term, seq, text);
    }

    /// The same, from another device.
    fn input_from(&mut self, key: &Keypair, term: &str, seq: u64, text: &str) {
        let phone = self.rig.phone.clone();
        self.rig.live_event(
            &phone,
            key,
            json!({"v":12,"type":"terminal-input","term":term,"seq":seq,"data":STANDARD.encode(text)}),
            Via::Direct,
        );
    }

    /// What the client shows: which terminal, or none.
    fn presence(&mut self, watching_terminal: Option<&str>) {
        self.command(json!({"v":12,"type":"presence","watchingTerminal":watching_terminal}));
    }

    /// Open a terminal and take it through to running. Returns its id.
    fn open(&mut self) -> String {
        let key = self.key.clone();
        self.open_from(&key)
    }

    /// The same, from another device.
    fn open_from(&mut self, key: &Keypair) -> String {
        self.command_from(key, json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
        let (term, _cwd) = self.spawned().expect("the runtime was asked to start a shell");
        self.rig.input(Input::TerminalSpawned { term: term.clone(), shell: "/bin/bash".into() });
        self.rig.take();
        term
    }

    /// The first spawn the runtime has been asked for, if any: (term, cwd).
    fn spawned(&mut self) -> Option<(String, String)> {
        self.acts().into_iter().find_map(|e| match e {
            Effect::TerminalSpawn { term, cwd, .. } => Some((term, cwd)),
            _ => None,
        })
    }

    /// The runtime's output for a terminal.
    fn say(&mut self, term: &str, offset: u64, text: &str) {
        self.rig.input(Input::TerminalOutput { term: term.to_string(), offset, data: STANDARD.encode(text) });
    }

    /// What the engine decided since the last look, and what it published,
    /// kept apart. Also remembers the addressees, which a publish's copies
    /// are keyed by.
    fn take(&mut self) -> (Vec<Effect>, Vec<Published>) {
        let mut acts = Vec::new();
        let mut msgs = Vec::new();
        for effect in self.rig.take() {
            match effect {
                Effect::Publish { to, message } => msgs.push((to, message)),
                other => acts.push(other),
            }
        }
        (acts, msgs)
    }

    fn acts(&mut self) -> Vec<Effect> {
        self.take().0
    }

    fn messages(&mut self) -> Vec<Published> {
        self.take().1
    }
}

// --- reading what the engine decided ---

/// One publish: the copies it was addressed to, and the message.
type Published = (Vec<Addressee>, BridgeToPhone);

fn exits(msgs: &[Published]) -> Vec<TerminalExitedMsg> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::TerminalExited(e) => Some(e.clone()),
            _ => None,
        })
        .collect()
}

fn opened(msgs: &[Published]) -> Vec<TerminalOpenedMsg> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::TerminalOpened(o) => Some(o.clone()),
            _ => None,
        })
        .collect()
}

/// Every `terminal-event`, as `(what, device)`.
fn events(msgs: &[Published]) -> Vec<(TerminalEventKind, String)> {
    events_full(msgs).into_iter().map(|e| (e.what, e.device)).collect()
}

fn events_full(msgs: &[Published]) -> Vec<TerminalEventMsg> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::TerminalEvent(e) => Some(e.clone()),
            _ => None,
        })
        .collect()
}

/// What the bridge told a phone to resend from: (term, seq).
fn input_from(msgs: &[Published]) -> Vec<(String, u64)> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::TerminalInputFrom(f) => Some((f.term.clone(), f.seq)),
            _ => None,
        })
        .collect()
}

fn output(msgs: &[Published]) -> Vec<TerminalOutputMsg> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::TerminalOutput(o) => Some(o.clone()),
            _ => None,
        })
        .collect()
}

/// What the runtime was asked to type: (term, bytes).
fn typed(acts: &[Effect]) -> Vec<(String, String)> {
    acts.iter()
        .filter_map(|e| match e {
            Effect::TerminalWrite { term, bytes } => Some((term.clone(), String::from_utf8_lossy(bytes).to_string())),
            _ => None,
        })
        .collect()
}

fn closed(acts: &[Effect]) -> Vec<String> {
    acts.iter()
        .filter_map(|e| match e {
            Effect::TerminalClose { term } => Some(term.clone()),
            _ => None,
        })
        .collect()
}

fn audits(acts: &[Effect]) -> Vec<TerminalAuditRecord> {
    acts.iter()
        .filter_map(|e| match e {
            Effect::Audit(record) => Some(record.clone()),
            _ => None,
        })
        .collect()
}

fn audits_of(acts: &[Effect], what: TerminalAuditWhat) -> Vec<TerminalAuditRecord> {
    audits(acts).into_iter().filter(|r| r.what == what).collect()
}

fn pending(acts: &[Effect]) -> Vec<Vec<bridge_core::PendingDevice>> {
    acts.iter()
        .filter_map(|e| match e {
            Effect::TerminalDevices(d) => Some(d.pending.clone()),
            _ => None,
        })
        .collect()
}

/// Just the messages of a take, for the checks whose addressees do not
/// matter.
fn only(msgs: &[Published]) -> Vec<BridgeToPhone> {
    msgs.iter().map(|(_, m)| m.clone()).collect()
}

/// The terminals a heartbeat lists, if it lists any.
fn heartbeat_terminals(msgs: &[Published]) -> Vec<TerminalInfo> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::Sessions(s) => s.terminals.clone(),
            _ => None,
        })
        .flatten()
        .collect()
}

fn heartbeat_capabilities(msgs: &[Published]) -> Vec<String> {
    msgs.iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::Sessions(s) => s.capabilities.clone(),
            _ => None,
        })
        .flatten()
        .collect()
}

/// What each heartbeat listed, as `(identity it went to, its terminals)`: one
/// entry per addressed identity, since several clients of one identity share
/// a copy.
fn heartbeat_terminals_by_identity(msgs: &[Published]) -> Vec<(String, Vec<TerminalInfo>)> {
    let mut out = Vec::new();
    for (to, m) in msgs {
        let BridgeToPhone::Sessions(s) = m else { continue };
        let terms = s.terminals.clone().unwrap_or_default();
        for addressee in to {
            out.push((addressee.phone.clone(), terms.clone()));
        }
    }
    out
}

// --- the gates ---

#[test]
fn a_bridge_with_terminals_off_refuses_every_open_and_advertises_nothing() {
    let mut world = World::with(TerminalConfig { enabled: false, ..Default::default() });
    world.rig.take();
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));

    let (acts, msgs) = world.take();
    let refusal = exits(&msgs);
    assert_eq!(refusal.len(), 1);
    assert_eq!(refusal[0].open_id.as_deref(), Some("o1"));
    assert_eq!(refusal[0].reason, TerminalEndReason::Disabled);
    assert!(refusal[0].term.is_none(), "no terminal came of it");
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalSpawn { .. })), "no shell is started");
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Refused)[0].reason, Some(TerminalEndReason::Disabled));

    // The heartbeat says nothing about terminals, so a phone shows none.
    world.rig.input(Input::WorkspaceChanged);
    let capabilities = heartbeat_capabilities(&world.messages());
    assert!(!capabilities.contains(&"terminal".to_string()), "capabilities: {capabilities:?}");
    assert!(capabilities.contains(&"files".to_string()));
}

#[test]
fn the_heartbeat_advertises_terminals_and_lists_what_runs() {
    let mut world = World::new();
    let term = world.open();

    world.rig.input(Input::WorkspaceChanged);
    let msgs = world.messages();
    assert!(heartbeat_capabilities(&msgs).contains(&"terminal".to_string()));
    let listed = heartbeat_terminals(&msgs);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].term, term);
    assert_eq!(listed[0].shell, "/bin/bash");
    assert_eq!(listed[0].device, world.device);
    assert_eq!(listed[0].name.as_deref(), Some("Pixel 8"));
    assert_eq!(listed[0].writer, world.device);
    assert_eq!((listed[0].cols, listed[0].rows), (80, 24));

    // A heartbeat with no terminal open omits the list entirely.
    world.command(json!({"v":12,"type":"terminal-close","term": term}));
    world.rig.input(Input::WorkspaceChanged);
    let msgs = world.messages();
    assert!(heartbeat_terminals(&msgs).is_empty());
    assert!(only(&msgs).iter().any(|m| matches!(m, BridgeToPhone::Sessions(s) if s.terminals.is_none())));
}

#[test]
fn a_heartbeat_names_only_the_identity_that_opened_the_terminal() {
    let mut world = World::new();
    let other_phone = generate_keypair();
    let other_client = generate_keypair();
    world.pair_identity(&other_phone, &other_client, "Other's phone");

    // With no terminal open anywhere, a heartbeat is still one publish to
    // every identity: the second identity costs nothing while it has none.
    world.rig.input(Input::WorkspaceChanged);
    let msgs = world.messages();
    assert_eq!(msgs.len(), 1, "one publish, as before");
    assert_eq!(msgs[0].0.len(), 2, "addressed to both identities");
    assert!(matches!(&msgs[0].1, BridgeToPhone::Sessions(s) if s.terminals.is_none()));

    // A opens one. A's heartbeat names it; the other identity's names
    // neither it nor the device running it.
    let term = world.open();
    world.rig.input(Input::WorkspaceChanged);
    let msgs = world.messages();
    let listed = heartbeat_terminals_by_identity(&msgs);
    let mine = listed.iter().find(|(phone, _)| phone == &world.rig.phone.pubkey_hex).expect("A is sent a heartbeat");
    assert_eq!(mine.1.len(), 1);
    assert_eq!(mine.1[0].term, term);
    assert_eq!(mine.1[0].shell, "/bin/bash");
    assert_eq!(mine.1[0].device, world.device);
    let theirs = listed.iter().find(|(phone, _)| phone == &other_phone.pubkey_hex).expect("B is sent a heartbeat");
    assert!(theirs.1.is_empty(), "B is told nothing of A's terminal");
    assert!(
        only(&msgs).iter().any(|m| matches!(m, BridgeToPhone::Sessions(s) if s.terminals.is_none())),
        "B's copy omits the field rather than carrying an empty list"
    );
    // Two heartbeats now — A's own copy, and the one shared by the identities
    // owning none — and both carry the same revision: it is one list.
    assert_eq!(msgs.len(), 2);
    let revs: Vec<u64> = msgs
        .iter()
        .filter_map(|(_, m)| match m {
            BridgeToPhone::Sessions(s) => s.rev,
            _ => None,
        })
        .collect();
    assert_eq!(revs.len(), 2);
    assert_eq!(revs[0], revs[1]);
}

#[test]
fn an_identity_asking_for_a_list_is_answered_with_its_own_terminals_only() {
    let mut world = World::new();
    let term = world.open();

    let other_phone = generate_keypair();
    let other_client = generate_keypair();
    world.pair_identity(&other_phone, &other_client, "Other's phone");
    world.rig.take();

    // The identity with no terminal asks for a list of its own: it is answered
    // alone, and the answer names no terminal.
    world.command_as(&other_phone, &other_client, json!({"v":12,"type":"refresh-sessions"}));
    let (_, msgs) = world.take();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].0.len(), 1, "the asking client alone");
    assert_eq!(msgs[0].0[0].phone, other_phone.pubkey_hex);
    let BridgeToPhone::Sessions(answer) = &msgs[0].1 else { panic!("a heartbeat") };
    assert!(answer.terminals.is_none(), "B is told nothing of A's terminal");

    // The identity that opened it asks: its copy names its own terminal.
    world.command(json!({"v":12,"type":"refresh-sessions"}));
    let (_, msgs) = world.take();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].0[0].phone, world.rig.phone.pubkey_hex);
    let BridgeToPhone::Sessions(answer) = &msgs[0].1 else { panic!("a heartbeat") };
    let own = answer.terminals.clone().expect("A's own terminal is listed");
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].term, term);
}

#[test]
fn a_relay_may_not_carry_a_terminal_unless_the_owner_allows_it() {
    let mut world = World::new();
    world.command_via_relay(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (acts, msgs) = world.take();
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Transport);
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalSpawn { .. })));
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Refused)[0].via, Some(TerminalVia::Relay));

    // With relays allowed, the same open starts a shell — and the audit says
    // over what it came.
    let mut world = World::with(TerminalConfig { enabled: true, relays_allowed: true, ..Default::default() });
    world.command_via_relay(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (acts, _) = world.take();
    assert!(acts.iter().any(|e| matches!(e, Effect::TerminalSpawn { .. })));
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Refused).len(), 0);
}

#[test]
fn a_device_off_the_allowlist_is_refused_and_the_owner_is_given_what_to_approve() {
    let mut world = World::new();
    // A device nobody approved: the identity key is the same, the session key
    // it granted is new — which is what a stolen key on a new phone looks
    // like, and what the allowlist is for.
    let stolen = generate_keypair();
    let device = device_id(&stolen.pubkey_hex);
    world.grant(&stolen, "Stolen phone");
    world.allow(&[]);
    world.command_from(&stolen, json!({"v":12,"type":"terminal-open","openId":"o7","cols":80,"rows":24}));

    let (acts, msgs) = world.take();
    let refusal = exits(&msgs);
    assert_eq!(refusal[0].reason, TerminalEndReason::NotAllowed);
    assert_eq!(refusal[0].open_id.as_deref(), Some("o7"));
    assert_eq!(refusal[0].device.as_deref(), Some(device.as_str()), "the phone is told which device to approve");
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalSpawn { .. })));

    let waiting = pending(&acts);
    assert_eq!(waiting.len(), 1, "the owner is handed what to approve");
    assert_eq!(waiting[0][0].device, device);
    assert_eq!(waiting[0][0].label.as_deref(), Some("Stolen phone"));
    assert_eq!(waiting[0][0].last_seen_ms, world.rig.system_now());
    // The refusal is audited with who it was for.
    let rec = &audits_of(&acts, TerminalAuditWhat::Refused)[0];
    assert_eq!(rec.device.as_deref(), Some(device.as_str()));
    assert_eq!(rec.label.as_deref(), Some("Stolen phone"));
    assert_eq!(rec.reason, Some(TerminalEndReason::NotAllowed));

    // Approved, the same device may open one.
    world.allow(&[&device]);
    world.command_from(&stolen, json!({"v":12,"type":"terminal-open","openId":"o8","cols":80,"rows":24}));
    let (acts, _) = world.take();
    assert!(acts.iter().any(|e| matches!(e, Effect::TerminalSpawn { .. })));

    // Refused again once the owner takes it away, and the list of waiting
    // devices keeps only the newest sighting of each.
    world.allow(&[]);
    world.command_from(&stolen, json!({"v":12,"type":"terminal-open","openId":"o9","cols":80,"rows":24}));
    let (acts, _) = world.take();
    let waiting = pending(&acts);
    assert_eq!(waiting[0].len(), 1);
    assert_eq!(waiting[0][0].label.as_deref(), Some("Stolen phone"));
}

#[test]
fn the_fifth_terminal_is_refused_and_an_unanswered_open_already_counts() {
    let mut world = World::new();
    let first = world.open();
    let _second = world.open();
    let _third = world.open();
    let _fourth = world.open();

    world.command(json!({"v":12,"type":"terminal-open","openId":"o5","cols":80,"rows":24}));
    let (acts, msgs) = world.take();
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Limit);
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Refused)[0].reason, Some(TerminalEndReason::Limit));

    // Opening is not free until a shell runs: the shell that is coming takes
    // a slot of its own.
    world.command(json!({"v":12,"type":"terminal-close","term": first}));
    world.rig.take();
    world.command(json!({"v":12,"type":"terminal-open","openId":"o6","cols":80,"rows":24}));
    world.command(json!({"v":12,"type":"terminal-open","openId":"o7","cols":80,"rows":24}));
    let (_, msgs) = world.take();
    assert_eq!(exits(&msgs).len(), 1, "the second open meets the limit while the first is still starting");
}

#[test]
fn an_open_without_a_client_is_refused_rather_than_ignored() {
    let mut world = World::new();
    // Encrypted with the identity's own key: no client, and so no device, so
    // a stolen identity key is not a way in.
    let phone = world.rig.phone.clone();
    world.rig.phone_event(&phone, json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}), Via::Direct);
    let (acts, msgs) = world.take();
    let refusal = exits(&msgs);
    assert_eq!(refusal[0].reason, TerminalEndReason::NotAllowed);
    assert!(refusal[0].device.is_none(), "there is no device to name");
    assert!(pending(&acts).is_empty(), "and none to record");
}

/// A device is its client's first key: once the client is gone, the phone
/// comes back as a new device, so the old approval is dropped from the file
/// rather than left there for good.
#[test]
fn an_approved_device_whose_client_lapsed_leaves_the_allowlist() {
    let mut world = World::new();
    let key = generate_keypair();
    let short_lived = device_id(&key.pubkey_hex);
    let bridge = world.rig.bridge.pubkey_hex.clone();
    let phone = world.rig.phone.clone();
    world.rig.phone_event(
        &phone,
        json!({"v":12,"type":"session-key","sessionKey":{
            "pubkeyHex": key.pubkey_hex, "bridgePubkeyHex": bridge, "expiresAt": NOW_SECS + 120, "label": "Tablet"}}),
        Via::Direct,
    );
    let first = world.device.clone();
    world.allow(&[&first, &short_lived]);
    world.rig.take();

    world.rig.advance(180_000);
    let written: Vec<_> = world
        .rig
        .take()
        .into_iter()
        .filter_map(|e| match e {
            Effect::TerminalDevices(d) => Some(d),
            _ => None,
        })
        .collect();
    assert_eq!(written.len(), 1, "the file is told once: {written:?}");
    assert_eq!(written[0].live.iter().collect::<Vec<_>>(), [&first], "only the device whose client remains is live");

    // The device that remains still opens a terminal.
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (_, msgs) = world.take();
    assert!(exits(&msgs).is_empty(), "the remaining device is still approved");
}

// --- input ---

#[test]
fn input_is_typed_in_seq_order_and_one_already_applied_types_nothing() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.input(&term, 1, "ls\n");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "ls\n".to_string())]);

    // The same, and anything older: a relay replaying a signed keystroke
    // event types nothing twice.
    world.input(&term, 1, "ls\n");
    world.input(&term, 0, "rm -rf /\n");
    assert!(typed(&world.acts()).is_empty());

    world.input(&term, 2, "pwd\n");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "pwd\n".to_string())]);
}

#[test]
fn a_gap_is_held_for_two_seconds_and_then_the_writer_resends_from_it() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    // Out of order: held, not typed.
    world.input(&term, 2, "two");
    assert!(typed(&world.acts()).is_empty());

    world.rig.advance(2_000);
    let (acts, msgs) = world.take();
    assert!(typed(&acts).is_empty(), "what was held is not typed out of order");
    assert_eq!(input_from(&msgs), vec![(term.clone(), 1)]);
    // The gap is what the audit records, not a terminal that ended.
    let rec = &audits_of(&acts, TerminalAuditWhat::Refused)[0];
    assert_eq!(rec.why.as_deref(), Some("seq 1 never arrived"));
    assert_eq!(rec.reason, None);

    // The writer resends from the gap: what was held behind it was dropped,
    // and the resend types in order.
    world.input(&term, 1, "one");
    world.input(&term, 2, "two");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "one".to_string()), (term.clone(), "two".to_string())]);
}

#[test]
fn a_gap_that_fills_in_time_types_the_held_input_in_order() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.input(&term, 1, "one");
    world.input(&term, 3, "three");
    world.input(&term, 4, "four");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "one".to_string())], "3 and 4 wait for 2");

    world.input(&term, 2, "two");
    let (acts, msgs) = world.take();
    assert_eq!(
        typed(&acts),
        vec![(term.clone(), "two".to_string()), (term.clone(), "three".to_string()), (term.clone(), "four".to_string())]
    );
    assert!(input_from(&msgs).is_empty(), "nothing is missing any more");
}

#[test]
fn input_that_is_not_base64_is_refused_and_audited() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    let phone = world.rig.phone.clone();
    let key = world.key.clone();
    world.rig.live_event(
        &phone,
        &key,
        json!({"v":12,"type":"terminal-input","term": term, "seq":1, "data":"not base64 !!!"}),
        Via::Direct,
    );
    let acts = world.acts();
    assert!(typed(&acts).is_empty());
    let rec = &audits(&acts)[0];
    assert_eq!(rec.what, TerminalAuditWhat::Refused);
    assert!(rec.why.as_deref().unwrap().contains("base64"), "{:?}", rec.why);
    assert_eq!(rec.device.as_deref(), Some(world.device.as_str()), "and who sent it");

    // The terminal is untouched by it: the next seq still types.
    world.input(&term, 1, "ls\n");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "ls\n".to_string())]);
}

#[test]
fn only_the_writer_types_and_only_its_window_counts() {
    let mut world = World::new();
    let (other, other_device) = world.other_device();
    let term = world.open();
    world.rig.take();

    let input = json!({"v":12,"type":"terminal-input","term": term, "seq":1, "data": STANDARD.encode("hi")});
    world.command_from(&other, input.clone());
    assert!(typed(&world.acts()).is_empty(), "a device that is not the writer does not type");

    world.command_from(&other, json!({"v":12,"type":"terminal-resize","term": term, "cols":132,"rows":43}));
    let acts = world.acts();
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalResize { .. })), "and does not resize it");

    world.command_from(&other, json!({"v":12,"type":"terminal-close","term": term}));
    let (acts, msgs) = world.take();
    assert!(closed(&acts).is_empty(), "and does not close it");
    assert!(exits(&msgs).is_empty());

    // The writer's own window counts, and is audited.
    world.command(json!({"v":12,"type":"terminal-resize","term": term, "cols":132,"rows":43}));
    let acts = world.acts();
    assert!(acts.iter().any(|e| matches!(e, Effect::TerminalResize { cols: 132, rows: 43, .. })));
    let resized = &audits_of(&acts, TerminalAuditWhat::Resized)[0];
    assert_eq!((resized.cols, resized.rows), (Some(132), Some(43)));
    assert_eq!(resized.device.as_deref(), Some(world.device.as_str()));
    let _ = other_device;
}

#[test]
fn a_takeover_moves_the_pen_and_starts_the_new_writer_at_one() {
    let mut world = World::new();
    let (other, other_device) = world.other_device();
    let term = world.open();
    world.input(&term, 1, "mine\n");
    world.rig.take();

    world.command_from(&other, json!({"v":12,"type":"terminal-takeover","term": term}));
    let (acts, msgs) = world.take();
    assert_eq!(events(&msgs), vec![(TerminalEventKind::Takeover, other_device.clone())]);
    let rec = &audits_of(&acts, TerminalAuditWhat::Takeover)[0];
    assert_eq!(rec.device.as_deref(), Some(other_device.as_str()));
    assert_eq!(rec.label.as_deref(), Some("Tablet"));
    // The new writer is told where its own numbering resumes, so its first
    // keystrokes are not dropped as ones already applied. This device has
    // never typed into this terminal, so it resumes at 1.
    assert_eq!(input_from(&msgs), vec![(term.clone(), 1)]);

    world.input_from(&other, &term, 1, "yours\n");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "yours\n".to_string())]);

    // The old writer's input no longer counts, and the heartbeat says who
    // writes now.
    let phone = world.rig.phone.clone();
    let key = world.key.clone();
    world.rig.live_event(
        &phone,
        &key,
        json!({"v":12,"type":"terminal-input","term": term, "seq":2, "data": STANDARD.encode("still mine")}),
        Via::Direct,
    );
    assert!(typed(&world.acts()).is_empty());
    world.rig.input(Input::WorkspaceChanged);
    let listed = heartbeat_terminals(&world.messages());
    assert_eq!(listed[0].writer, other_device);
    assert_eq!(listed[0].device, world.device, "the opener is still the opener");
}

#[test]
fn a_devices_seq_never_starts_over_so_its_earlier_keystrokes_cannot_be_replayed() {
    let mut world = World::new();
    let (other, _) = world.other_device();
    let term = world.open();

    // A types its run, 1 to 3.
    for (seq, text) in [(1, "one"), (2, "two"), (3, "three")] {
        world.input(&term, seq, text);
    }
    assert_eq!(typed(&world.acts()).len(), 3);
    world.rig.take();

    // B takes the pen and types a run of its own, from 1.
    world.command_from(&other, json!({"v":12,"type":"terminal-takeover","term": term}));
    let (_, msgs) = world.take();
    assert_eq!(input_from(&msgs), vec![(term.clone(), 1)], "B has typed nothing here yet");
    world.input_from(&other, &term, 1, "b-one");
    world.input_from(&other, &term, 2, "b-two");
    assert_eq!(typed(&world.acts()).len(), 2);
    world.rig.take();

    // A takes it back: its own count resumes where it left off, not at 1.
    world.command(json!({"v":12,"type":"terminal-takeover","term": term}));
    let (_, msgs) = world.take();
    assert_eq!(input_from(&msgs), vec![(term.clone(), 4)]);

    // A relay replaying A's earlier signed keystrokes now types nothing —
    // the seq it applies is A's own, so a device's run cannot be typed twice
    // whoever wrote in between...
    world.input(&term, 1, "one");
    world.input(&term, 2, "two");
    world.input(&term, 3, "three");
    assert!(typed(&world.acts()).is_empty(), "a device's seq never starts over");
    // ...and what A sends next does.
    world.input(&term, 4, "four");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "four".to_string())]);
}

#[test]
fn a_device_taking_the_pen_back_resumes_from_its_own_last_seq() {
    let mut world = World::new();
    let (other, _) = world.other_device();
    let term = world.open();

    // B's first takeover of a terminal it has never typed in: seq 1.
    world.command_from(&other, json!({"v":12,"type":"terminal-takeover","term": term}));
    assert_eq!(input_from(&world.messages()), vec![(term.clone(), 1)]);
    world.input_from(&other, &term, 1, "b1");
    world.input_from(&other, &term, 2, "b2");
    assert_eq!(typed(&world.acts()).len(), 2);

    // A takes the pen and types a run of its own, and B gets it back: B
    // resumes from its own 3, not from 1 again.
    world.command(json!({"v":12,"type":"terminal-takeover","term": term}));
    assert_eq!(input_from(&world.messages()), vec![(term.clone(), 1)], "A has typed nothing here yet");
    world.input(&term, 1, "a1");
    assert_eq!(typed(&world.acts()).len(), 1);
    world.command_from(&other, json!({"v":12,"type":"terminal-takeover","term": term}));
    assert_eq!(input_from(&world.messages()), vec![(term.clone(), 3)]);
    world.input_from(&other, &term, 3, "b3");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "b3".to_string())]);
}

#[test]
fn a_seq_too_far_ahead_to_be_a_gap_is_not_held() {
    let mut world = World::new();
    let term = world.open();
    world.input(&term, 1, "one");
    world.rig.take();

    // One behind a gap of one: held, and the wait armed.
    world.input(&term, 3, "three");
    assert!(typed(&world.acts()).is_empty(), "3 waits for 2");

    // A seq no run with a hole in it could reach: not held at all — holding
    // it, and everything a writer could pile up behind it, would only be a
    // way to spend the bridge's memory.
    world.input(&term, 1_000_000, "far ahead");
    let (acts, msgs) = world.take();
    assert!(typed(&acts).is_empty());
    assert_eq!(input_from(&msgs), vec![(term.clone(), 2)], "resend from the one it is missing");
    let rec = &audits_of(&acts, TerminalAuditWhat::Refused)[0];
    assert!(rec.why.as_deref().unwrap().contains("ahead"), "{:?}", rec.why);
    assert_eq!(rec.device.as_deref(), Some(world.device.as_str()), "and who sent it");
    assert_eq!(rec.reason, None, "the terminal is not over, only its input");

    // What was held went with it, and the wait is over: the timer that would
    // have asked for the gap sends nothing.
    world.rig.advance(2_000);
    let (acts, msgs) = world.take();
    assert!(input_from(&msgs).is_empty(), "the gap timer was cancelled with what was held");
    assert!(audits_of(&acts, TerminalAuditWhat::Refused).is_empty());

    // The writer resends what it was asked for, and typing goes on from there.
    world.input(&term, 2, "two");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "two".to_string())]);
}

#[test]
fn held_input_past_its_byte_cap_is_dropped_and_the_writer_is_asked_to_resend() {
    let mut world = World::new();
    let term = world.open();
    world.input(&term, 1, "one");
    world.rig.take();

    // Each of these is a valid input on its own — 40 KiB of typing in one
    // event, as large as the encrypted wire carries at all — and 25 of them
    // are just under the 1 MiB a terminal holds, which is still held.
    let big = "x".repeat(40 * 1024);
    for seq in 3..=27u64 {
        world.input(&term, seq, &big);
    }
    let acts = world.acts();
    assert!(typed(&acts).is_empty(), "none of it is typed out of order");
    assert!(audits_of(&acts, TerminalAuditWhat::Refused).is_empty(), "just under 1 MiB is still held");

    // The 26th is past it: nothing more is held, and the writer is asked for
    // the run it is missing.
    world.input(&term, 28, &big);
    let (acts, msgs) = world.take();
    assert!(typed(&acts).is_empty());
    assert_eq!(input_from(&msgs), vec![(term.clone(), 2)]);
    let rec = &audits_of(&acts, TerminalAuditWhat::Refused)[0];
    assert!(rec.why.as_deref().unwrap().contains("bytes"), "{:?}", rec.why);
    assert_eq!(rec.device.as_deref(), Some(world.device.as_str()));

    // Nothing is left held and no wait is running: the timer that would have
    // asked for the gap sends nothing.
    world.rig.advance(2_000);
    assert!(input_from(&world.messages()).is_empty());
    world.input(&term, 2, "two");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "two".to_string())]);
}

#[test]
fn a_full_window_of_held_input_is_kept_and_one_past_it_is_not() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    // Every seq the ahead-of rule lets in, and no more: 2..=256 is a window
    // of 256, so the count cap is never met before that rule is — it is the
    // backstop, not the limit.
    for seq in 2..=256u64 {
        world.input(&term, seq, &seq.to_string());
    }
    let acts = world.acts();
    assert!(typed(&acts).is_empty(), "they all wait for 1");
    assert!(audits_of(&acts, TerminalAuditWhat::Refused).is_empty(), "a full window is still held");

    // One past the window is refused like any other seq too far ahead.
    world.input(&term, 257, "past the window");
    let (acts, msgs) = world.take();
    assert!(typed(&acts).is_empty());
    assert_eq!(input_from(&msgs), vec![(term.clone(), 1)], "the terminal is still waiting on 1");
    assert!(audits_of(&acts, TerminalAuditWhat::Refused)[0].why.as_deref().unwrap().contains("ahead"));

    // And the window that was in flight went with the refusal: the writer is
    // asked for it again and types from where it was told to.
    world.input(&term, 1, "one");
    assert_eq!(typed(&world.acts()), vec![(term.clone(), "one".to_string())]);
}

// --- who is told what ---

#[test]
fn output_goes_only_to_the_clients_showing_that_terminal() {
    let mut world = World::new();
    let (other, _) = world.other_device();
    let term = world.open();
    world.presence(Some(&term));
    world.rig.input(Input::WorkspaceChanged);
    world.rig.take();

    world.say(&term, 0, "hello");
    let (_, msgs) = world.take();
    let out = output(&msgs);
    assert_eq!(out.len(), 1);
    assert_eq!((out[0].offset, out[0].data.as_str()), (0, STANDARD.encode("hello").as_str()));

    // A second device that does not show it gets nothing; one that does, gets
    // a copy of its own.
    let phone = world.rig.phone.clone();
    world.rig.phone_event_via_key(
        &phone,
        &other,
        json!({"v":12,"type":"presence","watchingTerminal": term}),
        Via::Direct,
    );
    world.rig.take();
    world.say(&term, 5, "there");
    let (_, msgs) = world.take();
    let copies: Vec<Vec<String>> = msgs
        .iter()
        .filter(|(_, m)| matches!(m, BridgeToPhone::TerminalOutput(_)))
        .map(|(to, _)| to.iter().map(|a| a.key.clone()).collect())
        .collect();
    assert_eq!(copies, vec![vec![world.key.pubkey_hex.clone(), other.pubkey_hex.clone()]]);

    // Away means nothing more, however it was watching: the client that went
    // away is not sent the next frame, and the one still showing it is.
    world.command(json!({"v":12,"type":"presence","away":true}));
    world.rig.take();
    world.say(&term, 10, "gone");
    let (_, msgs) = world.take();
    let copies: Vec<Vec<String>> = msgs
        .iter()
        .filter(|(_, m)| matches!(m, BridgeToPhone::TerminalOutput(_)))
        .map(|(to, _)| to.iter().map(|a| a.key.clone()).collect())
        .collect();
    assert_eq!(copies, vec![vec![other.pubkey_hex.clone()]]);
}

#[test]
fn every_present_client_of_the_identity_is_told_what_happened() {
    let mut world = World::new();
    let (other, other_device) = world.other_device();
    world.rig.take();

    // The open itself: the answer to the asker alone, the news to both.
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (term, _) = world.spawned().unwrap();
    world.rig.input(Input::TerminalSpawned { term: term.clone(), shell: "/bin/bash".into() });
    let (acts, msgs) = world.take();
    // The audit says who opened it, over what, and what it runs.
    let line = &audits_of(&acts, TerminalAuditWhat::Opened)[0];
    assert_eq!(line.term, term);
    assert_eq!(line.identity, world.rig.phone.npub);
    assert_eq!(line.device.as_deref(), Some(world.device.as_str()));
    assert_eq!(line.label.as_deref(), Some("Pixel 8"));
    assert_eq!(line.via, Some(TerminalVia::Direct));
    assert_eq!(line.cwd.as_deref(), Some("/w"));
    assert_eq!(line.shell.as_deref(), Some("/bin/bash"));
    assert_eq!((line.cols, line.rows), (Some(80), Some(24)));
    assert_eq!((line.reason, line.code, line.duration_ms), (None, None, None));
    let answer = msgs.iter().find(|(_, m)| matches!(m, BridgeToPhone::TerminalOpened(_))).unwrap();
    assert_eq!(answer.0, vec![Addressee { phone: world.rig.phone.pubkey_hex.clone(), key: world.key.pubkey_hex.clone() }]);
    assert_eq!(opened(&msgs)[0].shell, "/bin/bash");
    let news = msgs.iter().find(|(_, m)| matches!(m, BridgeToPhone::TerminalEvent(_))).unwrap();
    // Addressed to the identity, and copied to each present client of it, so
    // a phone that did not open it learns at once.
    let keys: Vec<String> = news.0.iter().map(|a| a.key.clone()).collect();
    assert_eq!(keys, vec![world.key.pubkey_hex.clone(), other.pubkey_hex.clone()]);
    assert_eq!(events(&msgs), vec![(TerminalEventKind::Opened, world.device.clone())]);
    let full = events_full(&msgs);
    assert_eq!(full[0].name.as_deref(), Some("Pixel 8"));
    assert_eq!(full[0].via, TerminalVia::Direct);
    assert_eq!(full[0].at, world.rig.system_now());

    // An attach from the other device is announced, with its name.
    world.command_from(&other, json!({"v":12,"type":"terminal-replay","term": term,"from":0}));
    let (acts, msgs) = world.take();
    assert_eq!(events(&msgs), vec![(TerminalEventKind::Attached, other_device.clone())]);
    assert_eq!(events_full(&msgs)[0].name.as_deref(), Some("Tablet"));
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Attached)[0].device.as_deref(), Some(other_device.as_str()));
    // The replay went to the client that asked, from the byte it named.
    let (from, client) = acts
        .iter()
        .find_map(|e| match e {
            Effect::TerminalReplay { from, client, .. } => Some((*from, client.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(from, 0);
    assert_eq!(client.key, other.pubkey_hex);
}

#[test]
fn a_replay_from_a_client_already_showing_the_terminal_is_not_news() {
    let mut world = World::new();
    let term = world.open();
    world.presence(Some(&term));
    world.rig.take();

    // Catching up after a gap is not an attach: the client said it shows it.
    world.command(json!({"v":12,"type":"terminal-replay","term": term,"from": 4096}));
    let (acts, msgs) = world.take();
    assert!(events(&msgs).is_empty(), "a client already showing it is not attaching");
    assert!(
        acts.iter().any(|e| matches!(e, Effect::TerminalReplay { from: 4096, .. })),
        "it still gets what it missed"
    );
}

#[test]
fn a_message_for_a_terminal_that_is_gone_is_answered_as_one_that_is_over() {
    let mut world = World::new();
    let term = world.open();
    world.command(json!({"v":12,"type":"terminal-close","term": term}));
    world.rig.take();

    world.command(json!({"v":12,"type":"terminal-replay","term": term,"from":0}));
    let (acts, msgs) = world.take();
    let answer = exits(&msgs);
    assert_eq!(answer[0].term.as_deref(), Some(term.as_str()));
    assert_eq!(answer[0].reason, TerminalEndReason::Closed);
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalReplay { .. })));
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Refused)[0].why.as_deref(), Some("the bridge has no such terminal"));
}

#[test]
fn another_identitys_terminal_is_not_one_this_client_can_see() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    // A whole second identity pairs with the same bridge, with a client of its
    // own — and its device is on the allowlist too, so what stops it is whose
    // terminal this is, not which device asked.
    let other_phone = generate_keypair();
    let other_client = generate_keypair();
    let other_device = world.pair_identity(&other_phone, &other_client, "Other's phone");
    world.allow(&[&world.device.clone(), &other_device]);
    world.rig.take();

    let input = json!({"v":12,"type":"terminal-input","term": term, "seq":1, "data": STANDARD.encode("mine")});
    world.rig.phone_event_via_key(&other_phone, &other_client, input, Via::Direct);
    world.rig.phone_event_via_key(&other_phone, &other_client, json!({"v":12,"type":"terminal-close","term": term}), Via::Direct);
    world.rig.phone_event_via_key(&other_phone, &other_client, json!({"v":12,"type":"terminal-replay","term": term, "from": 0}), Via::Direct);

    let (acts, msgs) = world.take();
    assert!(typed(&acts).is_empty(), "another identity does not type into this terminal");
    assert!(closed(&acts).is_empty(), "and does not close it");
    assert!(acts.iter().all(|e| !matches!(e, Effect::TerminalReplay { .. })), "and is not sent its output");
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Closed, "to it, the terminal is simply over");
    assert_eq!(
        audits_of(&acts, TerminalAuditWhat::Refused)[0].why.as_deref(),
        Some("it is another identity's terminal")
    );
}

// --- ends ---

#[test]
fn a_device_withdrawn_from_the_allowlist_loses_its_terminals_at_once() {
    let mut world = World::new();
    let (other, other_device) = world.other_device();
    let mine = world.open();
    let theirs = world.open_from(&other);
    // The other device also writes into this one's terminal.
    world.command_from(&other, json!({"v":12,"type":"terminal-takeover","term": mine}));
    world.rig.take();

    // Withdrawing the other device is the kill switch for a lost phone: the
    // terminal it opened ends at once.
    world.allow(&[&world.device.clone()]);
    let (acts, msgs) = world.take();
    assert_eq!(closed(&acts), vec![theirs.clone()]);
    let ended = exits(&msgs);
    assert_eq!(ended[0].term.as_deref(), Some(theirs.as_str()));
    assert_eq!(ended[0].reason, TerminalEndReason::Killed);
    let rec = &audits_of(&acts, TerminalAuditWhat::Exited)[0];
    assert_eq!(rec.reason, Some(TerminalEndReason::Killed));
    assert_eq!(rec.device.as_deref(), Some(other_device.as_str()));
    // The terminal it had only taken over is not the withdrawn device's: it
    // stays, with the pen back in the hands of the device that opened it.
    let takeover = &audits_of(&acts, TerminalAuditWhat::Takeover)[0];
    assert_eq!(takeover.term, mine);
    assert_eq!(takeover.device.as_deref(), Some(world.device.as_str()));
    assert!(takeover.why.as_deref().unwrap().contains("withdrawn"));
    let told = events(&msgs);
    assert_eq!(told.len(), 2);
    assert!(told.contains(&(TerminalEventKind::Exited, other_device)));
    assert!(told.contains(&(TerminalEventKind::Takeover, world.device.clone())));
    world.rig.input(Input::WorkspaceChanged);
    let listed = heartbeat_terminals(&world.messages());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].term, mine);
    assert_eq!(listed[0].writer, world.device);
    // And its input types again: the pen moved back, and this device has
    // never typed into that terminal, so its numbering starts at 1.
    world.input(&mine, 1, "back\n");
    assert_eq!(typed(&world.acts()), vec![(mine.clone(), "back\n".to_string())]);

    // Withdrawing this device too ends what is left.
    world.allow(&[]);
    let (acts, _) = world.take();
    assert_eq!(closed(&acts), vec![mine]);
}

#[test]
fn a_terminal_nobody_shows_is_closed_once_it_has_sat_idle() {
    let mut world = World::with(TerminalConfig { enabled: true, idle_secs: 60, ..Default::default() });
    let term = world.open();

    // Nobody is showing it (the client said so when it granted its key: it
    // shows nothing).
    world.rig.advance(60_000);
    let (acts, msgs) = world.take();
    assert_eq!(closed(&acts), vec![term.clone()]);
    let ended = exits(&msgs);
    assert_eq!(ended[0].reason, TerminalEndReason::Idle);
    let rec = &audits_of(&acts, TerminalAuditWhat::Exited)[0];
    assert_eq!(rec.reason, Some(TerminalEndReason::Idle));
    assert_eq!(rec.duration_ms, Some(60_000), "how long it lived is in the audit");
    assert_eq!(rec.cwd.as_deref(), Some("/w"), "and what it ran in");

    // One a client is showing outlives the limit, and ends once it stops.
    let mut world = World::with(TerminalConfig { enabled: true, idle_secs: 60, ..Default::default() });
    let term = world.open();
    world.presence(Some(&term));
    world.rig.take();
    world.rig.advance(60_000);
    let (acts, msgs) = world.take();
    assert!(closed(&acts).is_empty(), "a client is watching the output");
    assert!(exits(&msgs).is_empty());
    world.presence(None);
    world.rig.advance(60_000);
    let (acts, _) = world.take();
    assert_eq!(closed(&acts), vec![term], "and once it stops, the limit runs from here");
}

#[test]
fn a_shell_that_exits_before_its_spawn_is_handled_still_ends_the_terminal() {
    let mut world = World::new();
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (term, _) = world.spawned().expect("the runtime was asked to start a shell");
    // The runtime starts the shell on its own thread; this one died before
    // the bridge handled the spawn.
    world.rig.input(Input::TerminalExited { term: term.clone(), code: Some(127), reason: TerminalEndReason::Exit });
    world.rig.take();
    world.rig.input(Input::TerminalSpawned { term: term.clone(), shell: "/bin/bash".into() });
    let (acts, msgs) = world.take();
    assert_eq!(opened(&msgs).len(), 1, "the open is answered");
    let ended = exits(&msgs);
    assert_eq!((ended[0].term.as_deref(), ended[0].code), (Some(term.as_str()), Some(127)));
    assert_eq!(ended[0].reason, TerminalEndReason::Exit);
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Exited).len(), 1);
    assert!(heartbeat_terminals(&msgs).is_empty(), "no terminal with a dead shell is left listed");
}

#[test]
fn a_shell_that_ends_is_told_to_everyone_with_its_code() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.rig.input(Input::TerminalExited { term: term.clone(), code: Some(0), reason: TerminalEndReason::Exit });
    let (acts, msgs) = world.take();
    let ended = exits(&msgs);
    assert_eq!((ended[0].term.as_deref(), ended[0].code), (Some(term.as_str()), Some(0)));
    assert_eq!(ended[0].reason, TerminalEndReason::Exit);
    assert_eq!(events(&msgs), vec![(TerminalEventKind::Exited, world.device.clone())]);
    assert!(closed(&acts).is_empty(), "the shell is already gone: nothing to hang up");
    let rec = &audits_of(&acts, TerminalAuditWhat::Exited)[0];
    assert_eq!((rec.reason, rec.code), (Some(TerminalEndReason::Exit), Some(0)));
    assert_eq!(rec.shell.as_deref(), Some("/bin/bash"));
    assert_eq!(rec.duration_ms, Some(0));
}

#[test]
fn hanging_up_is_a_closed_terminal_and_the_runtime_is_told_to_hang_up() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.command(json!({"v":12,"type":"terminal-close","term": term}));
    let (acts, msgs) = world.take();
    assert_eq!(closed(&acts), vec![term.clone()]);
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Closed);
    assert_eq!(events(&msgs), vec![(TerminalEventKind::Closed, world.device.clone())]);
    assert_eq!(audits_of(&acts, TerminalAuditWhat::Closed)[0].reason, Some(TerminalEndReason::Closed));
}

#[test]
fn unpairing_an_identity_closes_what_its_devices_were_running() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.rig.input(Input::Unpaired { identity: world.rig.phone.pubkey_hex.clone() });
    let (acts, msgs) = world.take();
    assert_eq!(closed(&acts), vec![term.clone()]);
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Killed);
    assert!(world.rig.engine.paired_phones().is_empty(), "and it is heard from no more");
    assert!(acts.iter().any(|e| matches!(e, Effect::Resubscribe)));
}

#[test]
fn a_bridge_shutting_down_ends_its_terminals_and_audits_each() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    world.rig.input(Input::Shutdown);
    let (acts, msgs) = world.take();
    assert_eq!(exits(&msgs)[0].reason, TerminalEndReason::Restart);
    let rec = &audits_of(&acts, TerminalAuditWhat::Exited)[0];
    assert_eq!((rec.term.as_str(), rec.reason), (term.as_str(), Some(TerminalEndReason::Restart)));
    assert!(closed(&acts).is_empty(), "the ptys die with the bridge");
}

#[test]
fn the_runtime_failing_to_start_a_shell_answers_the_open_it_never_became() {
    let mut world = World::new();
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (term, cwd) = world.spawned().unwrap();
    assert_eq!(cwd, "/w");
    world.rig.input(Input::TerminalSpawnFailed { term: term.clone(), note: "no pty".into() });

    let (acts, msgs) = world.take();
    let refusal = exits(&msgs);
    assert_eq!(refusal[0].open_id.as_deref(), Some("o1"), "the phone's own open id comes back");
    assert_eq!(refusal[0].reason, TerminalEndReason::Transport);
    let rec = &audits_of(&acts, TerminalAuditWhat::Refused)[0];
    assert_eq!(rec.why.as_deref(), Some("no pty"));
    assert_eq!(rec.cwd.as_deref(), Some("/w"), "where it would have run is still recorded");
    // Nothing is left holding a slot.
    assert!(heartbeat_terminals(&{ world.rig.input(Input::WorkspaceChanged); world.messages() }).is_empty());
}

// --- devices ---

#[test]
fn a_device_survives_its_keys_rotation_but_a_new_client_is_a_new_device() {
    let mut world = World::new();
    let first = world.device.clone();
    let next = generate_keypair();
    let bridge = world.rig.bridge.pubkey_hex.clone();
    let phone = world.rig.phone.clone();
    world.rig.phone_event_via_key(
        &phone,
        &world.key,
        json!({"v":12,"type":"session-key","sessionKey":{
            "pubkeyHex": next.pubkey_hex, "bridgePubkeyHex": bridge,
            "expiresAt": NOW_SECS + 90 * DAY, "replaces": world.key.pubkey_hex, "label": "Pixel 8 Pro"}}),
        Via::Direct,
    );
    world.rig.take();

    let clients = &world.rig.engine.paired_phones()[0].clients;
    assert_eq!(clients.len(), 1, "a rotation is not a new client");
    assert_eq!(clients[0].device, first, "the device is the FIRST key this client granted");
    assert_eq!(clients[0].label.as_deref(), Some("Pixel 8 Pro"), "the name follows the latest grant");
    // The device is still the one on the allowlist, so its terminal still
    // works with the new key.
    let key = world.key.clone();
    world.key = next;
    world.command(json!({"v":12,"type":"terminal-open","openId":"o1","cols":80,"rows":24}));
    let (acts, _) = world.take();
    assert!(acts.iter().any(|e| matches!(e, Effect::TerminalSpawn { .. })), "the key rotated under the same device");
    let _ = key;

    // A second client of the same identity is a device of its own.
    let (_, other_device) = world.other_device();
    assert_ne!(other_device, world.device);
}

#[test]
fn a_state_file_from_before_devices_existed_still_hydrates() {
    let mut world = World::new();
    let term = world.open();
    world.rig.take();

    // What an older bridge stored: clients with keys and no device.
    let phones = json!([{"npub": world.rig.phone.npub, "pubkeyHex": world.rig.phone.pubkey_hex,
        "label":"Pixel", "pairedAt":"t",
        "clients":[{"key":{"pubkeyHex": world.key.pubkey_hex, "bridgePubkeyHex": world.rig.bridge.pubkey_hex,
            "expiresAt": NOW_SECS + 90 * DAY, "label":"Pixel 8"}}]}]);
    world.rig.store.put("pairedPhones", &phones.to_string());
    let mut restarted = world.rig.restart();
    restarted.take();
    let clients = &restarted.engine.paired_phones()[0].clients;
    assert_eq!(clients[0].device, device_id(&world.key.pubkey_hex), "derived from the key it holds");
    // Written back, so the name survives the next rotation.
    assert!(restarted.store.snapshot()["pairedPhones"].contains(&device_id(&world.key.pubkey_hex)));
    let _ = term;
}

// --- the command dedup set ---

#[test]
fn terminal_input_never_evicts_a_command_id_from_the_dedup_set() {
    let mut world = World::new();
    let term = world.open();
    let client_phone = world.rig.phone.clone();
    let key = world.key.clone();
    let phone = world.rig.phone.clone();
    world.rig.take();

    // A command the relay may well replay: its id is remembered so the replay
    // runs nothing. The heartbeat is how it shows: a refresh answers the
    // client that asked.
    let command = world.rig.phone_event_via_key(&phone, &key, json!({"v":12,"type":"refresh-sessions"}), Via::Direct);
    assert_eq!(world.messages().len(), 1, "the refresh is answered");
    let since = world.rig.engine.commands_filter().since;

    for i in 0..2000 {
        world.rig.live_event(
            &client_phone,
            &key,
            json!({"v":12,"type":"terminal-input","term": term, "seq": i + 1, "data": STANDARD.encode("x")}),
            Via::Direct,
        );
        world.rig.take();
    }

    // The keystrokes typed, and moved nothing else: the cursor the command
    // subscription resumes from is where the command left it.
    assert_eq!(world.rig.engine.commands_filter().since, since);
    // And the command's id is still remembered: the same event runs nothing a
    // second time.
    let via = Via::Direct;
    world.rig.input(Input::RelayEvent { event: command, via });
    assert!(world.messages().is_empty(), "a replayed command is still a no-op");
}
