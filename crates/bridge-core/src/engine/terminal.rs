//! Terminals: real shells on the bridge's machine, driven from a phone.
//!
//! A terminal is a shell as the bridge's own user — strictly more than an
//! agent in its most permissive mode — so who may have one is settled before
//! convenience. Three gates, checked in this order for every terminal
//! message: the bridge's owner has terminals switched on; the way the command
//! travelled may carry one (not a relay, unless the owner allows that); the
//! device it came from is on the owner's allowlist. The identity key alone is
//! not enough: every client of an identity holds that key, so a stolen one
//! would otherwise open a shell from a phone nobody approved, which is why a
//! device is named by the first session key it granted (a name that survives
//! rotation) and approved on the machine.
//!
//! The engine decides and records; it runs no shell, holds no file and owns
//! no timer of its own. A spawn, a write, a resize, a replay and a hangup are
//! [`Effect`]s the runtime carries out, and what the runtime learns — the
//! shell started, output came, the shell ended — comes back as
//! [`Input`](crate::io::Input)s. Every decision leaves a
//! [`TerminalAuditRecord`], which the runtime chains and stores: what a
//! terminal did has to be reconstructible afterwards on the machine.
//!
//! Invariants the rest of the engine relies on:
//! - a terminal belongs to the identity that opened it: only that identity's
//!   clients may act on it, and everything told about it goes to them;
//! - one writer at a time, moved only by an explicit `terminal-takeover`
//!   (audited, and told to every present client) — a message naming a
//!   terminal that is gone, or is another identity's, is answered as one that
//!   is over, so no client can probe for terminals that are not its own;
//! - `seq` counts up by one within one writer's run: a takeover hands the pen
//!   over with the number the new writer starts at, and a seq already applied
//!   types nothing twice, which is what makes a replayed keystroke harmless;
//! - output goes only to the clients showing that terminal (`presence`
//!   `watching_terminal`), which is also what keeps it from sitting idle.

use std::collections::{BTreeMap, BTreeSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use protocol::commands::{TerminalIdMsg, TerminalInputMsg, TerminalOpenMsg, TerminalReplayMsg, TerminalResizeMsg};
use protocol::common::{TerminalEndReason, TerminalEventKind, TerminalVia};
use protocol::events::{
    BridgeToPhone, TerminalEventMsg, TerminalExitedMsg, TerminalInfo, TerminalInputFromMsg, TerminalOpenedMsg,
    TerminalOutputMsg,
};
use serde::{Deserialize, Serialize};

use super::Engine;
use crate::io::{Addressee, Effect, TimerId, Via, WatchState};
use crate::out::{Out, TimerKind};

/// The most terminals one bridge runs at once: a fifth `terminal-open` is
/// answered `terminal-exited {reason: limit}`.
pub const DEFAULT_MAX_TERMINALS: usize = 4;
/// How long a terminal with no client attached to it lives. A phone remote is
/// used from trains and tunnels, so it outlives a dropped connection.
pub const DEFAULT_IDLE_SECS: u64 = 60 * 60;
/// How long input that arrived ahead of the one before it is held waiting for
/// the missing one: past this the phone is asked to resend from the gap.
pub const INPUT_GAP_WAIT_MS: u64 = 2_000;
/// The most bytes one `terminal-input` may carry, decoded. A paste is one
/// event and a typed line is a few, so nothing typed comes near it: a larger
/// one is a payload, not keystrokes. The encryption already bounds a single
/// event well below this, so it is a backstop against a future way in (a
/// chunked or unencrypted path) rather than a limit typing can meet.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
/// How many devices are kept waiting for the owner's approval. The least
/// recently seen beyond this are dropped: a phone that keeps trying is not a
/// reason for the list to grow without end.
pub const MAX_PENDING_DEVICES: usize = 64;

/// What the bridge's owner decided about terminals, as the runtime reads it
/// out of the configuration. The engine reads it and adds nothing: terminals
/// are the owner's decision and are never switched on from a phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalConfig {
    /// Terminals are switched on. Off, the capability is not advertised, and
    /// every terminal message is refused.
    pub enabled: bool,
    /// A terminal may be opened over a relay as well as over the bridge's own
    /// link. Off — the default — a relay is refused: even encrypted, a relay
    /// sees each event's size and timing, and keystroke timing alone leaks
    /// what was typed.
    pub relays_allowed: bool,
    /// The most terminals one bridge runs at once.
    pub max_terminals: usize,
    /// How long a terminal with no client attached lives. 0 keeps an
    /// unattended shell alive indefinitely.
    pub idle_secs: u64,
    /// Who may have a terminal here, and who asked and was refused.
    pub allowlist: TerminalAllowlist,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            relays_allowed: false,
            max_terminals: DEFAULT_MAX_TERMINALS,
            idle_secs: DEFAULT_IDLE_SECS,
            allowlist: TerminalAllowlist::default(),
        }
    }
}

/// The devices approved on this machine, and the ones that asked and were
/// refused. The runtime owns the file and its permissions; the engine is
/// handed this on start and again whenever the owner changes it, and records
/// a refusal by telling the runtime to write it down.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAllowlist {
    /// The device ids the owner approved (`codedeck-bridge terminal allow`).
    /// Withdrawing one closes its terminals at once: the kill switch for a
    /// lost phone.
    #[serde(default)]
    pub devices: BTreeSet<String>,
    /// The devices refused a terminal, oldest last seen first.
    #[serde(default)]
    pub pending: Vec<PendingDevice>,
}

/// A device that asked for a terminal and was refused: what the owner reads
/// to decide whether to approve it. The label is the device's own, which a
/// person reads but the bridge never trusts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDevice {
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// When it was last refused, ms since the Unix epoch.
    pub last_seen_ms: u64,
}

/// One line for the terminal audit: what happened, to which terminal, by
/// which device, and how that device's command reached the bridge. The engine
/// holds no file: the runtime chains the line to the one before it and
/// stores it under the bridge's home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalAuditRecord {
    /// When it happened, ms since the Unix epoch.
    pub at_ms: u64,
    /// The terminal's id, or the phone's own open id for an open that never
    /// became a terminal.
    pub term: String,
    pub what: TerminalAuditWhat,
    /// The identity the terminal belongs to, as its npub.
    pub identity: String,
    /// The device that acted, when one did.
    pub device: Option<String>,
    /// That device's own name for itself, as its latest grant said.
    pub label: Option<String>,
    /// How its command arrived, when a command is what did it.
    pub via: Option<TerminalVia>,
    /// Where the shell started, for an open.
    pub cwd: Option<String>,
    /// What ran in it, once the runtime said.
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Why it ended, and what the shell returned.
    pub reason: Option<TerminalEndReason>,
    pub code: Option<i32>,
    /// How long it lived, for an end.
    pub duration_ms: Option<u64>,
    /// What a refusal refused (input that is not base64, input of a size no
    /// typing has, a seq that never arrived): the reason alone would not say.
    pub why: Option<String>,
}

/// What a terminal audit line records. `Refused` is the only one about
/// something that did not happen, and carries `why`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalAuditWhat {
    /// A shell started.
    Opened,
    /// A client attached to a terminal's output without becoming its writer.
    Attached,
    /// A client became the writer.
    Takeover,
    /// The writer's window changed.
    Resized,
    /// A client hung up.
    Closed,
    /// The shell ended, or the bridge ended it.
    Exited,
    /// A terminal message was refused.
    Refused,
}

impl TerminalAuditRecord {
    /// A line about `term`, belonging to the identity that signs as `identity`
    /// (its hex key, which is what everything else in the engine holds).
    fn new(now_ms: u64, term: String, what: TerminalAuditWhat, identity: String) -> Self {
        Self {
            at_ms: now_ms,
            term,
            what,
            identity: npub_of(&identity),
            device: None,
            label: None,
            via: None,
            cwd: None,
            shell: None,
            cols: None,
            rows: None,
            reason: None,
            code: None,
            duration_ms: None,
            why: None,
        }
    }
}

/// An identity as a person reads it: the npub of the hex key that signs every
/// command. A key that cannot be one is kept as it came, so the line still
/// says what happened rather than nothing.
fn npub_of(identity: &str) -> String {
    protocol::crypto::npub_from_hex(identity).unwrap_or_else(|_| identity.to_string())
}

/// How a terminal command arrived, as the audit and `terminal-event` name it.
pub(crate) fn via_of(via: Via) -> TerminalVia {
    match via {
        Via::Relay => TerminalVia::Relay,
        Via::Direct => TerminalVia::Direct,
        Via::Onion => TerminalVia::Onion,
        // The pairing window's subscription carries pair-requests and nothing
        // else, so no terminal message can have come that way.
        Via::Pairing => TerminalVia::Unknown,
    }
}

/// One terminal the bridge runs.
struct Terminal {
    /// The identity that opened it: only its clients may act on it, and
    /// everything told about it goes to them.
    identity: String,
    /// What runs in it, as the runtime reported it.
    shell: String,
    /// The device that opened it. Its label rides the heartbeat and the
    /// events; the id is what the allowlist and the audit trust.
    opener: String,
    /// The device whose input it takes now.
    writer: String,
    cols: u16,
    rows: u16,
    cwd: String,
    opened_ms: u64,
    /// How the opener's command arrived, for later audit lines about it.
    via: TerminalVia,
    /// The last `seq` applied: input at or below it types nothing twice.
    last_seq: u64,
    /// Input that arrived ahead of the one before it, by seq: held, not
    /// typed, until the gap fills or the wait runs out.
    pending: BTreeMap<u64, Vec<u8>>,
    /// The timer asking the writer to resend from a gap that did not fill.
    gap_timer: Option<TimerId>,
    /// The timer that closes it once no client is attached any more.
    idle_timer: Option<TimerId>,
}

/// A `terminal-open` the runtime has been asked to start and has yet to
/// answer. It counts against the limit (the shell is coming) and is listed
/// nowhere until it runs.
struct PendingOpen {
    identity: String,
    /// The client that asked, alone: `terminal-opened` is its answer.
    asker: Addressee,
    device: Option<String>,
    label: Option<String>,
    via: TerminalVia,
    cwd: String,
    cols: u16,
    rows: u16,
    /// The phone's own id for the request, echoed back in the answer.
    open_id: String,
}

/// Whether a terminal is there and whose it is.
enum Held {
    Mine,
    Other,
    Missing,
}

/// Why a terminal message was refused, in the order the gates are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// The bridge's owner has terminals switched off.
    Disabled,
    /// The way the command travelled may not carry a terminal.
    Transport,
    /// The device it came from is not on the owner's allowlist — or the
    /// command named no device at all (it was encrypted with the identity's
    /// own key, which every client of the identity shares).
    NotAllowed,
    /// The bridge's terminals are full.
    Limit,
}

impl Refusal {
    /// The reason the phone is given, and the audit records.
    fn reason(self) -> TerminalEndReason {
        match self {
            Refusal::Disabled => TerminalEndReason::Disabled,
            Refusal::Transport => TerminalEndReason::Transport,
            Refusal::NotAllowed => TerminalEndReason::NotAllowed,
            Refusal::Limit => TerminalEndReason::Limit,
        }
    }

    /// What a person reading the audit needs beyond the reason's name.
    fn note(self) -> &'static str {
        match self {
            Refusal::Disabled => "the bridge has terminals switched off",
            Refusal::Transport => "a terminal may not be opened over this way",
            Refusal::NotAllowed => "the device is not on the allowlist",
            Refusal::Limit => "the bridge's terminals are full",
        }
    }
}

/// The client whose command is being handled: who it is, and where to answer
/// it. A command encrypted with the identity's own key names no client, and so
/// no device — it can never pass the device gate.
struct Actor {
    identity: String,
    key: String,
    device: Option<String>,
    label: Option<String>,
    via: TerminalVia,
}

impl Actor {
    fn addressee(&self) -> Addressee {
        Addressee { phone: self.identity.clone(), key: self.key.clone() }
    }

    /// The part of an audit line that says who acted and how it arrived.
    fn fill(&self, rec: &mut TerminalAuditRecord) {
        rec.device = self.device.clone();
        rec.label = self.label.clone();
        rec.via = Some(self.via);
    }
}

/// Everything the engine knows about the bridge's terminals.
pub(crate) struct Terminals {
    config: TerminalConfig,
    /// The terminals running now, by the id the engine gave each.
    open: BTreeMap<String, Terminal>,
    /// Opens the runtime has yet to answer, by terminal id.
    spawning: BTreeMap<String, PendingOpen>,
}

impl Terminals {
    pub(crate) fn new(config: TerminalConfig) -> Self {
        Self { config, open: BTreeMap::new(), spawning: BTreeMap::new() }
    }

    fn enabled(&self) -> bool {
        self.config.enabled
    }

    /// Whether another terminal would be one too many, counting the opens the
    /// runtime is still starting.
    fn at_capacity(&self) -> bool {
        self.open.len() + self.spawning.len() >= self.config.max_terminals
    }

    fn held(&self, term: &str, identity: &str) -> Held {
        match self.open.get(term) {
            Some(t) if t.identity == identity => Held::Mine,
            Some(_) => Held::Other,
            None => Held::Missing,
        }
    }

    /// Type `bytes` as `seq`, the one after the last applied.
    fn apply(&mut self, term: &str, seq: u64, bytes: Vec<u8>, out: &mut Out) {
        let Some(t) = self.open.get_mut(term) else { return };
        t.last_seq = seq;
        out.push(Effect::TerminalWrite { term: term.to_string(), bytes });
    }

    /// Take input that arrived ahead of the one before it and hold it: the
    /// missing seq may still be in flight (a relay reordering two events, a
    /// phone's event arriving late), and typing the later one first would put
    /// its characters in the wrong order. The first hold arms the wait.
    fn hold(&mut self, term: &str, seq: u64, bytes: Vec<u8>, out: &mut Out) {
        let Some(t) = self.open.get_mut(term) else { return };
        t.pending.insert(seq, bytes);
        if t.gap_timer.is_none() {
            let id = out.set_timer(INPUT_GAP_WAIT_MS, TimerKind::TerminalGap { term: term.to_string() });
            t.gap_timer = Some(id);
        }
    }

    /// Type everything held behind the gap that just filled, in order, up to
    /// the first one still missing.
    fn flush_pending(&mut self, term: &str, out: &mut Out) {
        loop {
            let next = match self.open.get(term) {
                Some(t) if !t.pending.is_empty() => t.last_seq + 1,
                _ => return,
            };
            let Some(t) = self.open.get_mut(term) else { return };
            let Some(bytes) = t.pending.remove(&next) else { break };
            t.last_seq = next;
            out.push(Effect::TerminalWrite { term: term.to_string(), bytes });
        }
        let Some(t) = self.open.get_mut(term) else { return };
        if let Some(id) = t.gap_timer.take() {
            out.cancel_timer(id);
        }
        // A later gap is still open: it gets a wait of its own from here.
        if !t.pending.is_empty() {
            let id = out.set_timer(INPUT_GAP_WAIT_MS, TimerKind::TerminalGap { term: term.to_string() });
            t.gap_timer = Some(id);
        }
    }
}

impl Engine {
    /// Whether the heartbeat advertises the `terminal` capability. Only then
    /// does a phone show a terminal: one it sent to a bridge without it would
    /// wait on a terminal that never opens.
    pub(crate) fn terminals_enabled(&self) -> bool {
        self.terminals.enabled()
    }

    /// The terminals open now, as the heartbeat lists them, so a phone that
    /// comes back (or a second phone) sees what is running and can attach.
    pub(crate) fn terminal_infos(&self) -> Vec<TerminalInfo> {
        self.terminals
            .open
            .iter()
            .map(|(id, t)| TerminalInfo {
                term: id.clone(),
                shell: t.shell.clone(),
                opened: t.opened_ms,
                device: t.opener.clone(),
                name: self.terminal_label(&t.identity, &t.opener),
                writer: t.writer.clone(),
                cols: t.cols,
                rows: t.rows,
            })
            .collect()
    }

    /// The client whose command is being handled. None only when no command is
    /// being handled at all — a bug, since a terminal message reaches here from
    /// one. A command encrypted with the identity's own key names no client,
    /// and so no device, which is what keeps a stolen identity key out.
    fn terminal_actor(&self, via: TerminalVia) -> Option<Actor> {
        let requester = self.requester.clone()?;
        let phone = self.paired.iter().find(|p| p.pubkey_hex == requester.phone)?;
        let client = phone.clients.iter().find(|c| {
            c.key.pubkey_hex == requester.key || c.previous.as_ref().is_some_and(|k| k.pubkey_hex == requester.key)
        });
        Some(Actor {
            // Only a state file written before devices were stored can leave
            // this empty, and an empty device is on no allowlist.
            device: client.map(|c| c.device.clone()).filter(|d| !d.is_empty()),
            label: client.and_then(|c| c.label.clone()),
            identity: requester.phone,
            key: requester.key,
            via,
        })
    }

    /// The first gate `actor` fails, if any: terminals switched off, a way
    /// that may not carry one, a device the owner has not approved. The limit
    /// is checked by `terminal-open` alone — an open terminal is not affected
    /// by it.
    fn terminal_refusal(&self, actor: &Actor) -> Option<Refusal> {
        if !self.terminals.enabled() {
            return Some(Refusal::Disabled);
        }
        if actor.via == TerminalVia::Relay && !self.terminals.config.relays_allowed {
            return Some(Refusal::Transport);
        }
        match &actor.device {
            Some(device) if self.terminals.config.allowlist.devices.contains(device) => None,
            _ => Some(Refusal::NotAllowed),
        }
    }

    /// Record one line for the terminal audit; the runtime chains and stores
    /// it.
    fn audit(&mut self, rec: TerminalAuditRecord) {
        self.out.push(Effect::Audit(rec));
    }

    /// The name a device gave itself, from the latest grant of the client
    /// that device is.
    fn terminal_label(&self, identity: &str, device: &str) -> Option<String> {
        self.paired
            .iter()
            .find(|p| p.pubkey_hex == identity)?
            .clients
            .iter()
            .find(|c| c.device == device)?
            .label
            .clone()
    }

    /// The key to encrypt a message for the client that device is, or None
    /// once that client is gone.
    fn terminal_key_of(&self, identity: &str, device: &str) -> Option<String> {
        self.paired
            .iter()
            .find(|p| p.pubkey_hex == identity)?
            .clients
            .iter()
            .find(|c| c.device == device)
            .map(|c| c.key.pubkey_hex.clone())
    }

    /// Tell every present client of `identity` what happened to a terminal:
    /// who acted, under what name, and how its command arrived. A phone that
    /// did not act learns at once — the detection half of the allowlist.
    fn terminal_event(&mut self, term: &str, what: TerminalEventKind, device: &str, identity: &str, via: TerminalVia) {
        let at = self.now();
        let label = self.terminal_label(identity, device);
        self.out.publish(
            vec![identity.to_string()],
            BridgeToPhone::TerminalEvent(TerminalEventMsg {
                term: term.to_string(),
                what,
                device: device.to_string(),
                name: label,
                via,
                at,
            }),
        );
    }

    /// A `terminal-open` refused: the phone gets its own open id back, so it
    /// can show what the request that earned it was.
    fn refuse_open(&mut self, open_id: &str, actor: &Actor, why: Refusal, note: Option<String>) {
        log::info!("[Engine] terminal-open refused: {why:?}");
        self.out.publish_addressed(
            vec![actor.addressee()],
            BridgeToPhone::TerminalExited(TerminalExitedMsg {
                term: None,
                open_id: Some(open_id.to_string()),
                code: None,
                reason: why.reason(),
                device: matches!(why, Refusal::NotAllowed).then(|| actor.device.clone()).flatten(),
            }),
        );
        let mut rec = TerminalAuditRecord::new(self.now(), open_id.to_string(), TerminalAuditWhat::Refused, actor.identity.clone());
        actor.fill(&mut rec);
        rec.reason = Some(why.reason());
        rec.why = note;
        self.audit(rec);
        if why == Refusal::NotAllowed {
            self.note_pending(actor);
        }
    }

    /// A message about an open terminal refused at a gate: the phone is told
    /// the terminal is not usable by it, with the gate's own reason.
    fn refuse_term(&mut self, term: &str, actor: &Actor, why: Refusal) {
        log::info!("[Engine] a terminal message was refused: {}", why.note());
        self.out.publish_addressed(
            vec![actor.addressee()],
            BridgeToPhone::TerminalExited(TerminalExitedMsg {
                term: Some(term.to_string()),
                open_id: None,
                code: None,
                reason: why.reason(),
                device: matches!(why, Refusal::NotAllowed).then(|| actor.device.clone()).flatten(),
            }),
        );
        let mut rec = TerminalAuditRecord::new(self.now(), term.to_string(), TerminalAuditWhat::Refused, actor.identity.clone());
        actor.fill(&mut rec);
        rec.reason = Some(why.reason());
        rec.why = Some(why.note().to_string());
        self.audit(rec);
        if why == Refusal::NotAllowed {
            self.note_pending(actor);
        }
    }

    /// A message naming a terminal this client may not act on: gone, or
    /// another identity's. Both are answered the same way, so a client has no
    /// way to probe for terminals that are not its own.
    fn refuse_missing(&mut self, term: &str, actor: &Actor, why: &str) {
        log::info!("[Engine] a terminal message was refused: {why}");
        self.out.publish_addressed(
            vec![actor.addressee()],
            BridgeToPhone::TerminalExited(TerminalExitedMsg {
                term: Some(term.to_string()),
                open_id: None,
                code: None,
                // It is over, whoever asked: the reason that says so without
                // claiming how it ended.
                reason: TerminalEndReason::Closed,
                device: None,
            }),
        );
        let mut rec = TerminalAuditRecord::new(self.now(), term.to_string(), TerminalAuditWhat::Refused, actor.identity.clone());
        actor.fill(&mut rec);
        rec.why = Some(why.to_string());
        self.audit(rec);
    }

    /// Whether `term` is a terminal of `actor`'s identity, answering the
    /// actor when it is not.
    fn terminal_is_mine(&mut self, term: &str, actor: &Actor) -> bool {
        match self.terminals.held(term, &actor.identity) {
            Held::Mine => true,
            Held::Other => {
                self.refuse_missing(term, actor, "it is another identity's terminal");
                false
            }
            Held::Missing => {
                self.refuse_missing(term, actor, "the bridge has no such terminal");
                false
            }
        }
    }

    /// A device that is not on the allowlist asked: remember it, with what
    /// the owner needs to approve it, and tell the runtime to write it down.
    fn note_pending(&mut self, actor: &Actor) {
        let Some(device) = actor.device.clone() else { return };
        let now = self.now();
        let pending = &mut self.terminals.config.allowlist.pending;
        pending.retain(|p| p.device != device);
        pending.push(PendingDevice { device, label: actor.label.clone(), last_seen_ms: now });
        // Oldest last seen first, so the owner reads the fresh ones last and
        // a device that keeps trying cannot push them off the end.
        pending.sort_by_key(|p| p.last_seen_ms);
        if pending.len() > MAX_PENDING_DEVICES {
            let drop = pending.len() - MAX_PENDING_DEVICES;
            pending.drain(..drop);
        }
        let pending = pending.clone();
        self.out.push(Effect::TerminalPending(pending));
    }

    /// `terminal-open`: the gates, then a shell for the runtime to start. The
    /// answer (`terminal-opened`) comes back as an input once it runs.
    pub(super) fn on_terminal_open(&mut self, m: TerminalOpenMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_open(&m.open_id, &actor, why, None);
        }
        if self.terminals.at_capacity() {
            return self.refuse_open(&m.open_id, &actor, Refusal::Limit, None);
        }
        // A terminal starts in the workspace, or in the directory of the
        // session the phone named — never in a path it sent.
        let named = m.session.as_deref().and_then(|id| self.sessions.get(id)).map(|s| s.rec.cwd.clone());
        let cwd = match named {
            Some(cwd) => cwd,
            None => {
                if m.session.is_some() {
                    log::info!("[Engine] terminal-open named a session this bridge does not have — opening in the workspace root");
                }
                self.workspace.resolve_cwd(None, false)
            }
        };
        let term = self.system.new_id();
        log::info!("[Engine] Starting terminal {term} for {}", actor.identity.get(..8).unwrap_or(&actor.identity));
        self.terminals.spawning.insert(
            term.clone(),
            PendingOpen {
                identity: actor.identity.clone(),
                asker: actor.addressee(),
                device: actor.device.clone(),
                label: actor.label.clone(),
                via,
                cwd: cwd.clone(),
                cols: m.cols,
                rows: m.rows,
                open_id: m.open_id,
            },
        );
        self.out.push(Effect::TerminalSpawn { term, cwd, cols: m.cols, rows: m.rows });
    }

    /// The runtime started a terminal's shell: the answer to its open, and
    /// the news to every present client of the identity.
    pub(super) fn on_terminal_spawned(&mut self, term: String, shell: String) {
        let Some(open) = self.terminals.spawning.remove(&term) else { return };
        let now = self.now();
        self.out.publish_addressed(
            vec![open.asker],
            BridgeToPhone::TerminalOpened(TerminalOpenedMsg { open_id: open.open_id, term: term.clone(), shell: shell.clone() }),
        );
        let idle_ms = self.terminals.config.idle_secs * 1000;
        let idle_timer = (idle_ms > 0).then(|| self.out.set_timer(idle_ms, TimerKind::TerminalIdle { term: term.clone() }));
        let opener = open.device.clone().unwrap_or_default();
        self.terminals.open.insert(
            term.clone(),
            Terminal {
                identity: open.identity.clone(),
                shell: shell.clone(),
                writer: opener.clone(),
                opener,
                cols: open.cols,
                rows: open.rows,
                cwd: open.cwd.clone(),
                opened_ms: now,
                via: open.via,
                last_seq: 0,
                pending: BTreeMap::new(),
                gap_timer: None,
                idle_timer,
            },
        );
        self.list_dirty = true;
        if let Some(device) = &open.device {
            self.terminal_event(&term, TerminalEventKind::Opened, device, &open.identity, open.via);
        }
        let mut rec = TerminalAuditRecord::new(now, term, TerminalAuditWhat::Opened, open.identity.clone());
        rec.device = open.device;
        rec.label = open.label;
        rec.via = Some(open.via);
        rec.cwd = Some(open.cwd);
        rec.shell = Some(shell);
        rec.cols = Some(open.cols);
        rec.rows = Some(open.rows);
        self.audit(rec);
    }

    /// The runtime could not start the shell. The open never became a
    /// terminal, so the phone is answered the way a refused one is — its own
    /// open id and the reason — rather than left waiting on a terminal that
    /// will never appear.
    pub(super) fn on_terminal_spawn_failed(&mut self, term: String, note: String) {
        let Some(open) = self.terminals.spawning.remove(&term) else { return };
        log::warn!("[Engine] terminal {term} could not be started: {note}");
        self.out.publish_addressed(
            vec![open.asker],
            BridgeToPhone::TerminalExited(TerminalExitedMsg {
                term: None,
                open_id: Some(open.open_id.clone()),
                code: None,
                reason: TerminalEndReason::Transport,
                device: None,
            }),
        );
        let mut rec = TerminalAuditRecord::new(self.now(), open.open_id, TerminalAuditWhat::Refused, open.identity.clone());
        rec.device = open.device;
        rec.label = open.label;
        rec.via = Some(open.via);
        rec.cwd = Some(open.cwd);
        rec.reason = Some(TerminalEndReason::Transport);
        rec.why = Some(note);
        self.audit(rec);
    }

    /// Output a terminal wrote. It goes only to the clients showing that
    /// terminal, exactly as live session text goes only to those watching the
    /// session: the runtime coalesces it, and keeps the ring a client that
    /// asked for a replay reads from.
    pub(super) fn on_terminal_output(&mut self, term: String, offset: u64, data: String) {
        let Some(identity) = self.terminals.open.get(&term).map(|t| t.identity.clone()) else { return };
        self.out.publish(vec![identity], BridgeToPhone::TerminalOutput(TerminalOutputMsg { term, offset, data }));
    }

    /// The shell is gone. Whoever ended it — the shell itself, its pipe, the
    /// bridge going down — every present client of the identity is told, and
    /// the end is audited.
    pub(super) fn on_terminal_exited(&mut self, term: String, code: Option<i32>, reason: TerminalEndReason) {
        self.end_terminal(&term, reason, code, None);
    }

    /// `terminal-input`: the writer's keystrokes, in the order it sent them.
    pub(super) fn on_terminal_input(&mut self, m: TerminalInputMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_term(&m.term, &actor, why);
        }
        if !self.terminal_is_mine(&m.term, &actor) {
            return;
        }
        // Only one device types into a terminal; another device's input is
        // not a mistake to answer (it may be a phone that has not noticed a
        // takeover yet), so it does nothing.
        let Some(t) = self.terminals.open.get(&m.term) else { return };
        if actor.device.as_deref() != Some(t.writer.as_str()) {
            log::info!("[Engine] terminal-input for {} from a device that is not its writer — dropped", m.term);
            return;
        }
        // A seq already applied types nothing twice: a signed keystroke event
        // a relay replays must not re-type, and a phone resending what it was
        // asked for overlaps what did arrive.
        if m.seq <= t.last_seq {
            return;
        }
        let bytes = match STANDARD.decode(&m.data) {
            Ok(bytes) if bytes.len() <= MAX_INPUT_BYTES => bytes,
            Ok(bytes) => return self.refuse_input(&m.term, &actor, m.seq, &format!("input of {} bytes", bytes.len())),
            Err(_) => return self.refuse_input(&m.term, &actor, m.seq, "input that is not base64"),
        };
        let expected = self.terminals.open.get(&m.term).map(|t| t.last_seq + 1).unwrap_or(0);
        if m.seq == expected {
            self.terminals.apply(&m.term, m.seq, bytes, &mut self.out);
            self.terminals.flush_pending(&m.term, &mut self.out);
        } else {
            // Ahead of the one before it: held for the wait, then the phone is
            // asked for what is missing.
            self.terminals.hold(&m.term, m.seq, bytes, &mut self.out);
        }
    }

    /// Input the engine will not type: too large to be typing, or not the
    /// base64 the protocol carries it in.
    fn refuse_input(&mut self, term: &str, actor: &Actor, seq: u64, why: &str) {
        log::info!("[Engine] terminal-input for {term} at seq {seq} refused: {why}");
        let mut rec = TerminalAuditRecord::new(self.now(), term.to_string(), TerminalAuditWhat::Refused, actor.identity.clone());
        actor.fill(&mut rec);
        rec.why = Some(format!("seq {seq}: {why}"));
        self.audit(rec);
    }

    /// The wait for a missing seq is over: the writer is asked to resend from
    /// the gap, and what was held behind it is dropped — the phone resends
    /// everything from the gap, which covers every held seq.
    pub(super) fn on_terminal_gap(&mut self, term: &str) {
        let Some(t) = self.terminals.open.get_mut(term) else { return };
        t.gap_timer = None;
        if t.pending.is_empty() {
            return;
        }
        t.pending.clear();
        let seq = t.last_seq + 1;
        let (identity, writer) = (t.identity.clone(), t.writer.clone());
        log::info!("[Engine] terminal {term} is missing input from seq {seq}; asking its writer to resend");
        if let Some(key) = self.terminal_key_of(&identity, &writer) {
            self.out.publish_addressed(
                vec![Addressee { phone: identity.clone(), key }],
                BridgeToPhone::TerminalInputFrom(TerminalInputFromMsg { term: term.to_string(), seq }),
            );
        }
        let label = self.terminal_label(&identity, &writer);
        let mut rec = TerminalAuditRecord::new(self.now(), term.to_string(), TerminalAuditWhat::Refused, identity);
        rec.device = Some(writer);
        rec.label = label;
        rec.why = Some(format!("seq {seq} never arrived"));
        self.audit(rec);
    }

    /// `terminal-resize`: only the window of the device that types counts.
    pub(super) fn on_terminal_resize(&mut self, m: TerminalResizeMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_term(&m.term, &actor, why);
        }
        if !self.terminal_is_mine(&m.term, &actor) {
            return;
        }
        let Some(t) = self.terminals.open.get_mut(&m.term) else { return };
        if actor.device.as_deref() != Some(t.writer.as_str()) {
            log::info!("[Engine] terminal-resize for {} from a device that is not its writer — ignored", m.term);
            return;
        }
        t.cols = m.cols;
        t.rows = m.rows;
        self.out.push(Effect::TerminalResize { term: m.term.clone(), cols: m.cols, rows: m.rows });
        let mut rec = TerminalAuditRecord::new(self.now(), m.term, TerminalAuditWhat::Resized, actor.identity.clone());
        actor.fill(&mut rec);
        rec.cols = Some(m.cols);
        rec.rows = Some(m.rows);
        self.audit(rec);
    }

    /// `terminal-replay`: attach to a terminal's output from a byte offset,
    /// without becoming its writer. Any client of the identity may — this is
    /// how a second phone reads a terminal another one runs.
    pub(super) fn on_terminal_replay(&mut self, m: TerminalReplayMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_term(&m.term, &actor, why);
        }
        if !self.terminal_is_mine(&m.term, &actor) {
            return;
        }
        // What a client shows is what its `presence` says, so a client that is
        // already showing this terminal and is only catching up after a gap is
        // not news: the others are told when someone attaches.
        if !self.client_watches_terminal(&actor.identity, &actor.key, &m.term) {
            if let Some(device) = actor.device.clone() {
                self.terminal_event(&m.term, TerminalEventKind::Attached, &device, &actor.identity, via);
            }
        }
        self.out.push(Effect::TerminalReplay { term: m.term.clone(), from: m.from, client: actor.addressee() });
        let mut rec = TerminalAuditRecord::new(self.now(), m.term, TerminalAuditWhat::Attached, actor.identity.clone());
        actor.fill(&mut rec);
        rec.why = Some(format!("sent its output from byte {}", m.from));
        self.audit(rec);
    }

    /// `terminal-takeover`: become the terminal's writer. Audited, and told
    /// to every present client — a terminal that changes hands is exactly
    /// what a phone that did not act must learn about.
    pub(super) fn on_terminal_takeover(&mut self, m: TerminalIdMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_term(&m.term, &actor, why);
        }
        if !self.terminal_is_mine(&m.term, &actor) {
            return;
        }
        let Some(device) = actor.device.clone() else { return };
        if self.terminals.open.get(&m.term).is_some_and(|t| t.writer == device) {
            log::info!("[Engine] terminal-takeover for {} from the device that already writes it", m.term);
            return;
        }
        if !self.hand_writer(&m.term, &device) {
            return;
        }
        self.terminal_event(&m.term, TerminalEventKind::Takeover, &device, &actor.identity, via);
        let mut rec = TerminalAuditRecord::new(self.now(), m.term, TerminalAuditWhat::Takeover, actor.identity.clone());
        actor.fill(&mut rec);
        self.audit(rec);
    }

    /// `terminal-close`: the writer hangs up its own terminal.
    pub(super) fn on_terminal_close(&mut self, m: TerminalIdMsg, via: TerminalVia) {
        let Some(actor) = self.terminal_actor(via) else { return };
        if let Some(why) = self.terminal_refusal(&actor) {
            return self.refuse_term(&m.term, &actor, why);
        }
        if !self.terminal_is_mine(&m.term, &actor) {
            return;
        }
        let writer = self.terminals.open.get(&m.term).map(|t| t.writer.clone());
        if actor.device != writer {
            log::info!("[Engine] terminal-close for {} from a device that is not its writer — ignored", m.term);
            return;
        }
        self.end_terminal(&m.term, TerminalEndReason::Closed, None, Some(&actor));
    }

    /// Hand the pen to `device`: its `seq` starts over.
    ///
    /// A `seq` is one writer's own count of what it has typed, so a new writer
    /// must not have its first keystrokes dropped as ones already applied. It
    /// is told where its numbering starts (`terminal-input-from`), the same
    /// message a writer gets when the bridge is waiting on a gap.
    fn hand_writer(&mut self, term: &str, device: &str) -> bool {
        let Some(t) = self.terminals.open.get_mut(term) else { return false };
        t.writer = device.to_string();
        t.last_seq = 0;
        t.pending.clear();
        if let Some(id) = t.gap_timer.take() {
            self.out.cancel_timer(id);
        }
        let identity = t.identity.clone();
        if let Some(key) = self.terminal_key_of(&identity, device) {
            self.out.publish_addressed(
                vec![Addressee { phone: identity, key }],
                BridgeToPhone::TerminalInputFrom(TerminalInputFromMsg { term: term.to_string(), seq: 1 }),
            );
        }
        true
    }

    /// End a terminal and tell its identity's clients: one `terminal-exited`
    /// with the reason (and the shell's code, when it returned one), and one
    /// `terminal-event` so every present client learns it is over. `actor` is
    /// the client that ended it, when a client did.
    fn end_terminal(&mut self, term: &str, reason: TerminalEndReason, code: Option<i32>, actor: Option<&Actor>) {
        let Some(t) = self.terminals.open.remove(term) else { return };
        for timer in [t.gap_timer, t.idle_timer].into_iter().flatten() {
            self.out.cancel_timer(timer);
        }
        // A terminal the bridge decided to end is still running: hang it up.
        // One the runtime reported already ended (its shell returned, its pipe
        // broke) needs no effect — the runtime is the one that said so.
        if !matches!(reason, TerminalEndReason::Exit | TerminalEndReason::Transport | TerminalEndReason::Restart) {
            self.out.push(Effect::TerminalClose { term: term.to_string() });
        }
        log::info!("[Engine] Terminal {term} ended: {reason:?}");
        self.out.publish(
            vec![t.identity.clone()],
            BridgeToPhone::TerminalExited(TerminalExitedMsg {
                term: Some(term.to_string()),
                open_id: None,
                code,
                reason,
                device: None,
            }),
        );
        // Whoever acted, else the device whose terminal it was: an end nobody
        // asked for is named after the client that opened it.
        let device = match actor.and_then(|a| a.device.clone()) {
            Some(device) => device,
            None => t.opener.clone(),
        };
        let via = actor.map(|a| a.via).unwrap_or(t.via);
        if !device.is_empty() {
            let what = if reason == TerminalEndReason::Closed { TerminalEventKind::Closed } else { TerminalEventKind::Exited };
            self.terminal_event(term, what, &device, &t.identity, via);
        }
        // A terminal nobody can act on any more is not what a client shows:
        // the clients showing it are left showing none.
        for phone in self.paired.iter_mut().filter(|p| p.pubkey_hex == t.identity) {
            for client in &mut phone.clients {
                if matches!(&client.watch_terminal, WatchState::Watching(Some(watching)) if watching == term) {
                    client.watch_terminal = WatchState::Watching(None);
                }
            }
        }
        let mut rec = TerminalAuditRecord::new(
            self.now(),
            term.to_string(),
            if reason == TerminalEndReason::Closed { TerminalAuditWhat::Closed } else { TerminalAuditWhat::Exited },
            t.identity.clone(),
        );
        rec.label = self.terminal_label(&t.identity, &device);
        rec.device = (!device.is_empty()).then_some(device);
        rec.via = Some(via);
        rec.cwd = Some(t.cwd.clone());
        rec.shell = Some(t.shell.clone());
        rec.cols = Some(t.cols);
        rec.rows = Some(t.rows);
        rec.reason = Some(reason);
        rec.code = code;
        rec.duration_ms = Some(self.now().saturating_sub(t.opened_ms));
        self.audit(rec);
        self.list_dirty = true;
    }

    /// Close every terminal of `identity` — it is no longer paired, or the
    /// bridge is stopping — with one reason for all of them.
    pub(super) fn close_identity_terminals(&mut self, identity: &str, reason: TerminalEndReason) {
        let terms: Vec<String> = self
            .terminals
            .open
            .iter()
            .filter(|(_, t)| t.identity == identity)
            .map(|(id, _)| id.clone())
            .collect();
        for term in terms {
            self.end_terminal(&term, reason, None, None);
        }
    }

    /// The idle limit fired: a terminal no present client is attached to is
    /// closed. One that still is gets the limit again from here, so a shell an
    /// abandoned phone left running does not run for ever.
    pub(super) fn on_terminal_idle(&mut self, term: &str) {
        if let Some(t) = self.terminals.open.get_mut(term) {
            t.idle_timer = None;
        }
        let attached = self.client_attached(term);
        let idle_ms = self.terminals.config.idle_secs * 1000;
        if attached {
            if idle_ms > 0 {
                let id = self.out.set_timer(idle_ms, TimerKind::TerminalIdle { term: term.to_string() });
                if let Some(t) = self.terminals.open.get_mut(term) {
                    t.idle_timer = Some(id);
                }
            }
            return;
        }
        self.end_terminal(term, TerminalEndReason::Idle, None, None);
    }

    /// Whether any present client of the terminal's identity shows it. What a
    /// client shows is what its `presence` said, so a client that dropped off
    /// the network is not a reason to keep a shell alive.
    fn client_attached(&self, term: &str) -> bool {
        let Some(t) = self.terminals.open.get(term) else { return false };
        let now = self.now();
        self.paired
            .iter()
            .filter(|p| p.pubkey_hex == t.identity)
            .flat_map(|p| p.clients.iter())
            .any(|c| c.present_until_ms > now && c.watch_terminal.shows(term))
    }

    /// Whether the client holding `key` shows `term` now.
    fn client_watches_terminal(&self, identity: &str, key: &str, term: &str) -> bool {
        self.paired
            .iter()
            .find(|p| p.pubkey_hex == identity)
            .and_then(|p| {
                p.clients
                    .iter()
                    .find(|c| c.key.pubkey_hex == key || c.previous.as_ref().is_some_and(|k| k.pubkey_hex == key))
            })
            .is_some_and(|c| c.watch_terminal.shows(term))
    }

    /// The allowlist changed on the machine. A device withdrawn from it is the
    /// kill switch for a lost phone: the terminals it opened end at once, and
    /// one it only wrote into goes back to the device that opened it.
    pub(super) fn on_terminal_allowlist(&mut self, allowlist: TerminalAllowlist) {
        let mut merged = allowlist;
        // A re-read that raced a refusal this engine has just recorded would
        // otherwise forget it: both lists are merged, newest last seen wins.
        for old in std::mem::take(&mut self.terminals.config.allowlist.pending) {
            match merged.pending.iter_mut().find(|p| p.device == old.device) {
                Some(kept) if kept.last_seen_ms >= old.last_seen_ms => {}
                Some(kept) => *kept = old,
                None => merged.pending.push(old),
            }
        }
        merged.pending.sort_by_key(|p| p.last_seen_ms);
        if merged.pending.len() > MAX_PENDING_DEVICES {
            let drop = merged.pending.len() - MAX_PENDING_DEVICES;
            merged.pending.drain(..drop);
        }
        let allowed = merged.devices.clone();
        self.terminals.config.allowlist = merged;

        let open: Vec<(String, String, String, String, TerminalVia)> = self
            .terminals
            .open
            .iter()
            .map(|(id, t)| (id.clone(), t.identity.clone(), t.opener.clone(), t.writer.clone(), t.via))
            .collect();
        for (term, identity, opener, writer, via) in open {
            if !opener.is_empty() && !allowed.contains(&opener) {
                log::info!("[Engine] Terminal {term} ends: its device was withdrawn from the allowlist");
                self.end_terminal(&term, TerminalEndReason::Killed, None, None);
                continue;
            }
            if !writer.is_empty() && writer != opener && !allowed.contains(&writer) {
                // A device withdrawn while writing into another device's
                // terminal loses the pen rather than the terminal: it may not
                // type any more, and the device that opened it gets it back.
                log::info!("[Engine] Terminal {term} returns to its opener: its writer was withdrawn");
                if self.hand_writer(&term, &opener) {
                    self.terminal_event(&term, TerminalEventKind::Takeover, &opener, &identity, via);
                    let mut rec = TerminalAuditRecord::new(self.now(), term, TerminalAuditWhat::Takeover, identity.clone());
                    rec.label = self.terminal_label(&identity, &opener);
                    rec.device = Some(opener);
                    rec.via = Some(via);
                    rec.why = Some(format!("the writer {writer} was withdrawn from the allowlist"));
                    self.audit(rec);
                }
            }
        }
    }
}
