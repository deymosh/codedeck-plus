//! A test rig for the engine: in-memory ports, a manual clock with timers,
//! a fake phone that encrypts real commands, and a scriptable agent host.
//! Everything goes through the public API — `Input` in, `Effect` out.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_protocol::{
    AgentInfo, BridgeFrame, BridgeMessage, CredentialSpec, Frame, HostMessage, SessionEvent, StartSession,
};
use bridge_core::ports::memory::{MemoryStore, MemoryTranscripts, MemoryWorkspace, TestSystem};
use bridge_core::ports::Ports;
use bridge_core::{Config, Effect, Engine, InboundEvent, Input, PairedPhone, TimerId, Via};
use protocol::common::{AgentSupports, EntryBody, OptionChoice, OutputEntry, Role};
use protocol::crypto::{encrypt_to, generate_keypair, Keypair};
use protocol::events::BridgeToPhone;
use serde_json::{json, Value};

pub const T0: u64 = 1_800_000_000_000;

pub fn choice(id: &str) -> OptionChoice {
    OptionChoice { id: id.into(), label: id.to_uppercase(), description: None }
}

/// "alpha": modes / efforts / a credential / custom providers / usage.
pub fn alpha() -> AgentInfo {
    AgentInfo {
        id: "alpha".into(),
        display_name: "Alpha".into(),
        modes: vec![choice("ask"), choice("plan"), choice("yolo")],
        efforts: vec![choice("low"), choice("high")],
        default_mode: Some("ask".into()),
        default_effort: Some("high".into()),
        supports: AgentSupports { models: true, usage: true, providers: true, gsd: true, interrupt: true },
        credentials: vec![CredentialSpec { id: "alpha_key".into(), label: "Alpha key".into(), env_var: Some("ALPHA_KEY".into()) }],
        unavailable_reason: None,
    }
}

/// "beta": no efforts, no providers, no usage, no credentials.
pub fn beta() -> AgentInfo {
    AgentInfo {
        id: "beta".into(),
        display_name: "Beta".into(),
        modes: vec![choice("ask")],
        efforts: vec![],
        default_mode: Some("ask".into()),
        default_effort: None,
        supports: AgentSupports { models: true, ..Default::default() },
        credentials: vec![],
        unavailable_reason: None,
    }
}

/// "gamma": installed but not runnable here.
pub fn gamma() -> AgentInfo {
    AgentInfo {
        id: "gamma".into(),
        display_name: "Gamma".into(),
        unavailable_reason: Some("Gamma is not configured on this machine.".into()),
        ..beta()
    }
}

pub struct Rig {
    pub engine: Engine,
    pub system: TestSystem,
    pub store: MemoryStore,
    pub transcripts: MemoryTranscripts,
    pub workspace: MemoryWorkspace,
    pub bridge: Keypair,
    pub phone: Keypair,
    /// Every effect since the last `take()`.
    pub effects: Vec<Effect>,
    /// Armed timers: id → due time.
    timers: BTreeMap<TimerId, u64>,
    host_seq: u64,
}

pub struct RigOptions {
    pub paired: bool,
    pub store: MemoryStore,
    pub transcripts: MemoryTranscripts,
    pub configure: fn(&mut Config),
}

impl Default for RigOptions {
    fn default() -> Self {
        Self { paired: true, store: MemoryStore::default(), transcripts: MemoryTranscripts::default(), configure: |_| {} }
    }
}

impl Rig {
    /// Started, with a paired phone, no agent host yet.
    pub fn new() -> Self {
        Self::with(RigOptions::default())
    }

    pub fn with(options: RigOptions) -> Self {
        Self::build(options, generate_keypair(), generate_keypair())
    }

    fn build(options: RigOptions, bridge: Keypair, phone: Keypair) -> Self {
        let system = TestSystem::at(T0);
        let workspace = MemoryWorkspace::new(&["/w"], &["app", "lib"]);
        if options.paired && !options.store.snapshot().contains_key("pairedPhones") {
            let paired = vec![PairedPhone {
                npub: phone.npub.clone(),
                pubkey_hex: phone.pubkey_hex.clone(),
                label: "Pixel".into(),
                paired_at: "t".into(),
            }];
            options.store.put("pairedPhones", &serde_json::to_string(&paired).unwrap());
        }
        let mut config = Config::new(bridge.clone(), "laptop");
        config.relays = vec!["wss://relay.example".into()];
        config.bridge_version = "11.0.0-test".into();
        (options.configure)(&mut config);
        let ports = Ports {
            system: Box::new(system.clone()),
            store: Box::new(options.store.clone()),
            transcripts: Box::new(options.transcripts.clone()),
            workspace: Box::new(workspace.clone()),
        };
        let mut rig = Self {
            engine: Engine::new(config, ports),
            system,
            store: options.store,
            transcripts: options.transcripts,
            workspace,
            bridge,
            phone,
            effects: Vec::new(),
            timers: BTreeMap::new(),
            host_seq: 0,
        };
        rig.input(Input::Start);
        rig
    }

    /// A fresh engine over the same storage: a bridge restart.
    pub fn restart(self) -> Self {
        let options = RigOptions { paired: false, store: self.store.clone(), transcripts: self.transcripts.clone(), configure: |_| {} };
        let rig = Self::build(options, self.bridge.clone(), self.phone.clone());
        rig.system.set_now(self.system_now());
        rig
    }

    pub fn system_now(&self) -> u64 {
        use bridge_core::ports::System as _;
        self.system.now_ms()
    }

    pub fn input(&mut self, input: Input) {
        let effects = self.engine.handle(input);
        for effect in &effects {
            match effect {
                Effect::SetTimer { id, after_ms } => {
                    self.timers.insert(*id, self.system_now() + after_ms);
                }
                Effect::CancelTimer(id) => {
                    self.timers.remove(id);
                }
                _ => {}
            }
        }
        self.effects.extend(effects);
    }

    pub fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// Move the clock, firing due timers in order.
    pub fn advance(&mut self, ms: u64) {
        let target = self.system_now() + ms;
        loop {
            let next = self.timers.iter().filter(|(_, due)| **due <= target).min_by_key(|(id, due)| (**due, **id)).map(|(id, due)| (*id, *due));
            let Some((id, due)) = next else { break };
            self.timers.remove(&id);
            self.system.set_now(due.max(self.system_now()));
            self.input(Input::Timer(id));
        }
        self.system.set_now(target);
    }

    // --- the phone ---

    pub fn phone_event(&mut self, from: &Keypair, msg: Value, via: Via) -> InboundEvent {
        // Unique across rigs: a restarted engine remembers processed ids.
        static EVENTS: AtomicU64 = AtomicU64::new(0);
        let n = EVENTS.fetch_add(1, Ordering::Relaxed);
        let event = InboundEvent {
            id: format!("ev{n}"),
            pubkey: from.pubkey_hex.clone(),
            created_at: self.system_now() / 1000,
            content: encrypt_to(&from.secret_key, &self.bridge.pubkey_hex, &msg.to_string()).unwrap(),
        };
        self.input(Input::RelayEvent { event: event.clone(), via });
        event
    }

    /// Send a command from the paired phone.
    pub fn send(&mut self, msg: Value) {
        let phone = self.phone.clone();
        self.phone_event(&phone, msg, Via::Commands);
    }

    /// Messages published since the last take, with their recipients.
    pub fn published(&mut self) -> Vec<(Vec<String>, BridgeToPhone)> {
        let mut out = Vec::new();
        let mut rest = Vec::new();
        for effect in self.take() {
            match effect {
                Effect::Publish { to, message } => out.push((to, message)),
                other => rest.push(other),
            }
        }
        self.effects = rest;
        out
    }

    /// Just the messages published since the last take.
    pub fn messages(&mut self) -> Vec<BridgeToPhone> {
        self.published().into_iter().map(|(_, m)| m).collect()
    }

    // --- the agent host ---

    /// Bring the host up and answer `initialize` with these agents.
    pub fn host_up_with(&mut self, agents: Vec<AgentInfo>) {
        self.input(Input::HostUp);
        let (id, msg) = self.host_request(|m| matches!(m, BridgeMessage::Initialize { .. }));
        assert!(matches!(msg, BridgeMessage::Initialize { bridge_version } if bridge_version == "11.0.0-test"));
        self.host_reply(&id, HostMessage::Initialized { host_version: "host-1".into(), agents });
    }

    pub fn host_up(&mut self) {
        self.host_up_with(vec![alpha(), beta(), gamma()]);
    }

    /// Frames the engine wrote to the host since the last take (the rest of
    /// the effects stay).
    pub fn host_frames(&mut self) -> Vec<BridgeFrame> {
        let mut frames = Vec::new();
        let mut rest = Vec::new();
        for effect in self.take() {
            match effect {
                Effect::Host(frame) => frames.push(frame),
                other => rest.push(other),
            }
        }
        self.effects = rest;
        frames
    }

    /// The first pending frame to the host matching `pred`: (id, message).
    pub fn host_request(&mut self, pred: impl Fn(&BridgeMessage) -> bool) -> (String, BridgeMessage) {
        let i = self
            .effects
            .iter()
            .position(|e| matches!(e, Effect::Host(f) if pred(&f.message)))
            .unwrap_or_else(|| panic!("no such host frame in {:#?}", self.effects));
        let Effect::Host(frame) = self.effects.remove(i) else { unreachable!() };
        (frame.id.unwrap_or_default(), frame.message)
    }

    pub fn has_host_request(&self, pred: impl Fn(&BridgeMessage) -> bool) -> bool {
        self.effects.iter().any(|e| matches!(e, Effect::Host(f) if pred(&f.message)))
    }

    pub fn host_reply(&mut self, id: &str, message: HostMessage) {
        self.input(Input::HostFrame(Frame::request(id, message)));
    }

    pub fn host_event(&mut self, session_id: &str, event: SessionEvent) {
        self.input(Input::HostFrame(Frame::notification(HostMessage::SessionEvent { session_id: session_id.into(), event })));
    }

    /// The host asks the bridge something; returns the frame id.
    pub fn host_ask(&mut self, message: HostMessage) -> String {
        self.host_seq += 1;
        let id = format!("h{}", self.host_seq);
        self.input(Input::HostFrame(Frame::request(id.clone(), message)));
        id
    }

    /// The pending `start-session` frame: (id, params).
    pub fn start_request(&mut self) -> (String, StartSession) {
        let (id, msg) = self.host_request(|m| matches!(m, BridgeMessage::StartSession(_)));
        let BridgeMessage::StartSession(params) = msg else { unreachable!() };
        (id, *params)
    }

    /// Create a session on `agent` and take it through to ready. Returns its id.
    pub fn ready_session(&mut self, agent: &str) -> String {
        self.send(json!({"type":"create-session","agent":agent}));
        let (id, params) = self.start_request();
        self.host_reply(&id, HostMessage::Ack);
        self.host_event(&params.session_id, SessionEvent::Ready {});
        self.take();
        params.session_id
    }

    /// Agent text from a session.
    pub fn say(&mut self, session_id: &str, text: &str) {
        self.host_event(
            session_id,
            SessionEvent::Entries { entries: vec![OutputEntry::new("t", EntryBody::Text { role: Role::Agent, text: text.into(), collapsible: false })] },
        );
    }
}

impl Default for Rig {
    fn default() -> Self {
        Self::new()
    }
}

// --- reading what the phone got ---

pub fn outputs(msgs: &[BridgeToPhone]) -> Vec<(u64, OutputEntry)> {
    msgs.iter()
        .filter_map(|m| match m {
            BridgeToPhone::Output(o) => Some((o.seq, o.entry.clone())),
            _ => None,
        })
        .collect()
}

pub fn heartbeats(msgs: &[BridgeToPhone]) -> Vec<protocol::events::SessionListMsg> {
    msgs.iter()
        .filter_map(|m| match m {
            BridgeToPhone::Sessions(s) => Some(s.clone()),
            _ => None,
        })
        .collect()
}

pub fn last_heartbeat(msgs: &[BridgeToPhone]) -> protocol::events::SessionListMsg {
    heartbeats(msgs).pop().expect("a heartbeat was published")
}
