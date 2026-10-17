//! terminals — the shells a bridge lists and the one this phone has on
//! screen, with the input batching and the output offsets that keep a
//! keystroke stream out of the UI's snapshot path.
//!
//! Three things live here, all pure:
//!
//! - **The list.** Each heartbeat names the terminals open on that bridge for
//!   this identity ([`protocol::events::TerminalInfo`]). It is the only place
//!   a second phone, or this one after a restart, learns a terminal exists.
//!
//! - **The attached terminal** — at most one, the one on screen. It carries
//!   the bridge's `term` (absent while an open is still pending), whether this
//!   device is the writer, the next output byte offset expected, the last
//!   refusal and the reason it ended.
//!
//! - **Input.** Typing is not sent per keystroke: printable bytes wait on the
//!   phone and go in one event when a program could act on them, when typing
//!   pauses, or past a cap (see `docs/TERMINAL.md`, "Transport"). Every event
//!   carries a `seq` counting up by one per terminal, and what was sent is
//!   kept a while so a `terminal-input-from` can be answered by resending it.
//!
//! Output is not state: [`TerminalsState::output`] hands the bytes back for
//! the host to emit as its own event, so a terminal producing megabytes a
//! second never re-renders a view.

use std::collections::{BTreeMap, VecDeque};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use protocol::commands::{TerminalInputMsg, TerminalOpenMsg, TerminalReplayMsg};
use protocol::common::{TerminalEndReason, TerminalEventKind};
use protocol::events::{
    TerminalEventMsg, TerminalExitedMsg, TerminalInfo, TerminalInputFromMsg, TerminalOutputMsg,
};

/// How many sent input events are kept for a resend, oldest dropped first.
pub const INPUT_KEEP_EVENTS: usize = 256;
/// How many bytes of sent input are kept for a resend.
pub const INPUT_KEEP_BYTES: usize = 1 << 20;
/// Bytes of typed input that go in one event at most on the normal screen.
pub const INPUT_BATCH_BYTES: usize = 256;
/// How long printable input waits on the normal screen before it goes anyway
/// — a typing pause — over the direct link and over relays.
pub const PAUSE_DIRECT_MS: u64 = 150;
pub const PAUSE_RELAY_MS: u64 = 400;
/// How long a key waits on the alternate screen (every key is a command
/// there), over the direct link and over relays.
pub const ALT_PAUSE_DIRECT_MS: u64 = 20;
pub const ALT_PAUSE_RELAY_MS: u64 = 60;
/// Input events a terminal may send a second over relays; the rest is merged
/// into the next.
pub const RELAY_INPUTS_PER_SEC: u32 = 5;
/// The window [`RELAY_INPUTS_PER_SEC`] counts over.
pub const RELAY_WINDOW_MS: u64 = 1000;

/// Where a machine is reached right now — the pause and the rate cap differ
/// between the direct link and the relays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputTransport {
    Direct,
    Relay,
}

impl InputTransport {
    /// How long bytes wait before going anyway on this transport.
    fn pause_ms(self, alternate_screen: bool) -> u64 {
        match (self, alternate_screen) {
            (InputTransport::Direct, false) => PAUSE_DIRECT_MS,
            (InputTransport::Relay, false) => PAUSE_RELAY_MS,
            (InputTransport::Direct, true) => ALT_PAUSE_DIRECT_MS,
            (InputTransport::Relay, true) => ALT_PAUSE_RELAY_MS,
        }
    }

    /// Only the relays rate-limit their writers; the direct link has no cap.
    fn capped(self) -> bool {
        self == InputTransport::Relay
    }
}

/// Why a `terminal-open` was refused, as the phone shows it: the reason, and
/// for `not-allowed` the device the bridge refused — its id always, its name
/// when one was ever seen for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub reason: TerminalEndReason,
    pub device: Option<String>,
    pub name: Option<String>,
}

/// Why the terminal on screen ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ended {
    pub reason: TerminalEndReason,
    pub code: Option<i32>,
}

/// The terminal this phone has on screen. `term` is absent while an open is
/// still pending (`open_id` names it) or after a refusal, which never became
/// a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    pub machine: String,
    pub term: Option<String>,
    pub open_id: Option<String>,
    pub shell: Option<String>,
    /// Whether this device's input is the one the terminal takes. False while
    /// attaching read-only, and after another device takes over.
    pub writer: bool,
    pub cols: u16,
    pub rows: u16,
    /// The next output byte offset expected: frames are drawn from here.
    pub expected: u64,
    /// A replay was asked for (an attach asks from the start of the ring);
    /// live frames are dropped until its answer arrives or a frame at
    /// `expected` fills the gap.
    pub replay_pending: bool,
    pub refusal: Option<Refusal>,
    pub ended: Option<Ended>,
}

/// What one input step asks the host to do: events to publish, when to come
/// back for the bytes still waiting, and what those bytes are (the app draws
/// them as its predicted echo).
#[derive(Debug, Default, PartialEq)]
pub struct InputStep {
    /// The machine the events go to — the attached terminal's, `None` when
    /// nothing is attached.
    pub machine: Option<String>,
    pub sends: Vec<TerminalInputMsg>,
    /// When to flush again, as an absolute ms deadline. `None` when nothing
    /// is waiting.
    pub flush_at_ms: Option<u64>,
    /// Bytes typed and not yet sent.
    pub waiting: Vec<u8>,
}

impl InputStep {
    fn empty() -> Self {
        Self::default()
    }
}

/// One output frame for the app. The bytes are raw, not base64: the host
/// emits them as its own event, never through a view snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputFrame {
    pub offset: u64,
    pub data: Vec<u8>,
    /// The bridge is asked for a replay from here (a frame was lost). Sent
    /// once per gap, not per frame.
    pub replay_from: Option<u64>,
}

/// The typed-but-unsent bytes and the `seq` of one terminal.
#[derive(Debug, Clone, Default)]
struct InputState {
    /// The `seq` the next input event carries; counts up by one from 1 and
    /// never restarts (a takeover only tells us what to resume at).
    next_seq: u64,
    pending: Vec<u8>,
    alternate_screen: bool,
    /// When the first and the last of `pending` were typed (ms).
    since_ms: u64,
    last_ms: u64,
    /// Sent events kept for a resend: `(seq, bytes)`, oldest first.
    sent: VecDeque<(u64, Vec<u8>)>,
    sent_bytes: usize,
    /// The next held `seq` to resend, when a `terminal-input-from` asked for
    /// one that is still held.
    resend_from: Option<u64>,
    /// The relay rate-cap window: its start and how many events went in it.
    window_start_ms: u64,
    window_count: u32,
}

impl InputState {
    fn fresh(now: u64) -> Self {
        Self { next_seq: 1, window_start_ms: now, ..Self::default() }
    }

    /// The time the relay cap next lets an event through, when it is full.
    fn cap_at(&self, transport: InputTransport) -> Option<u64> {
        (transport.capped() && self.window_count >= RELAY_INPUTS_PER_SEC)
            .then(|| self.window_start_ms.saturating_add(RELAY_WINDOW_MS))
    }

    /// When the host must come back: for bytes still waiting, and for a
    /// resend the cap held back.
    fn deadline(&self, transport: InputTransport) -> Option<u64> {
        let mut at: Option<u64> = None;
        if !self.pending.is_empty() {
            let pause = transport.pause_ms(self.alternate_screen);
            // On the alternate screen the window runs from the first key, so
            // a held key's repeats cannot postpone it past the cap; on the
            // normal screen it runs from the last, which is the typing pause.
            let from = if self.alternate_screen { self.since_ms } else { self.last_ms };
            at = Some(from.saturating_add(pause));
        }
        if let Some(cap) = self.cap_at(transport) {
            if !self.pending.is_empty() || self.resend_from.is_some() {
                at = Some(at.map_or(cap, |x| x.max(cap)));
            }
        }
        at
    }

    /// Keep a sent event for a possible resend, dropping the oldest past the
    /// caps. An event too big to ever fit is not kept at all.
    fn hold(&mut self, seq: u64, bytes: &[u8]) {
        if bytes.len() > INPUT_KEEP_BYTES {
            return;
        }
        self.sent.push_back((seq, bytes.to_vec()));
        self.sent_bytes += bytes.len();
        while self.sent.len() > INPUT_KEEP_EVENTS || self.sent_bytes > INPUT_KEEP_BYTES {
            let Some((_, dropped)) = self.sent.pop_front() else { break };
            self.sent_bytes = self.sent_bytes.saturating_sub(dropped.len());
        }
    }

    fn held(&self, seq: u64) -> Option<&[u8]> {
        self.sent.iter().find(|(s, _)| *s == seq).map(|(_, b)| b.as_slice())
    }

    /// Take one event's bytes out of what is waiting: the whole buffer, or a
    /// batch of it when more than one event's worth is buffered.
    fn take_batch(&mut self) -> Vec<u8> {
        let take = if self.pending.len() > INPUT_BATCH_BYTES {
            INPUT_BATCH_BYTES
        } else {
            self.pending.len()
        };
        self.pending.drain(..take).collect()
    }
}

/// The terminals of every machine, and the one on screen.
#[derive(Debug, Default)]
pub struct TerminalsState {
    /// machine → term → what the heartbeat lists.
    lists: BTreeMap<String, BTreeMap<String, TerminalInfo>>,
    /// Device id → the name its user gave it, learned from the heartbeat and
    /// from `terminal-event`. Used to name the device a refusal is about.
    names: BTreeMap<String, String>,
    attached: Option<Attached>,
    inputs: BTreeMap<(String, String), InputState>,
    /// The id this install is a device under
    /// ([`protocol::recipients::device_id`]), so the heartbeat's `writer` and
    /// a `terminal-event`'s `device` can be read as "us" or "another phone".
    /// Empty until the host sets it.
    device_id: String,
    /// Counts the opens this run started, so each carries its own `open_id`.
    open_seq: u64,
}

impl TerminalsState {
    /// The device id of this install. Set once by the host, from the first
    /// session key it ever granted a bridge.
    pub fn set_device_id(&mut self, device_id: String) {
        self.device_id = device_id;
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// The terminals `machine`'s heartbeat lists, oldest opened first.
    pub fn list(&self, machine: &str) -> Vec<TerminalInfo> {
        let mut list: Vec<TerminalInfo> = self
            .lists
            .get(machine)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        list.sort_by_key(|t| t.opened);
        list
    }

    /// Every machine's list, for the view.
    pub fn lists(&self) -> BTreeMap<String, Vec<TerminalInfo>> {
        self.lists.keys().map(|m| (m.clone(), self.list(m))).collect()
    }

    pub fn attached(&self) -> Option<&Attached> {
        self.attached.as_ref()
    }

    /// Whether a terminal is on screen right now.
    pub fn is_watching(&self) -> bool {
        self.attached.is_some()
    }

    /// The machine of the terminal on screen.
    pub fn watching_machine(&self) -> Option<&str> {
        self.attached.as_ref().map(|a| a.machine.as_str())
    }

    /// The terminal on screen, when it is `machine`'s — the term a `presence`
    /// to that machine watches.
    pub fn watching_term(&self, machine: &str) -> Option<String> {
        let a = self.attached.as_ref()?;
        (a.machine == machine).then(|| a.term.clone())?
    }

    /// Bytes typed and not yet sent, for the app's predicted echo. Empty on
    /// the alternate screen: there every key is a command whose effect the
    /// program decides, so nothing is predicted, and the bytes it holds for
    /// a few ms are no reason to redraw the app.
    pub fn waiting_input(&self) -> Vec<u8> {
        let Some(a) = self.attached.as_ref() else { return Vec::new() };
        let Some(term) = a.term.as_deref() else { return Vec::new() };
        self.inputs
            .get(&(a.machine.clone(), term.to_string()))
            .filter(|s| !s.alternate_screen)
            .map(|s| s.pending.clone())
            .unwrap_or_default()
    }

    /// The heartbeat's terminal list for `machine`. Returns whether anything
    /// the view shows changed.
    pub fn apply_list(&mut self, machine: &str, terminals: &[TerminalInfo]) -> bool {
        for t in terminals {
            if let Some(name) = &t.name {
                self.names.insert(t.device.clone(), name.clone());
            }
        }
        let next: BTreeMap<String, TerminalInfo> =
            terminals.iter().map(|t| (t.term.clone(), t.clone())).collect();
        let changed = self.lists.get(machine) != Some(&next);
        if changed {
            self.lists.insert(machine.to_string(), next);
        }
        // A terminal this phone has on screen that the list no longer names is
        // gone on the bridge (its shell exited, or the bridge restarted).
        let gone = self
            .attached
            .as_ref()
            .filter(|a| a.machine == machine && a.term.is_some())
            .and_then(|a| a.term.clone())
            .filter(|term| !terminals.iter().any(|t| &t.term == term));
        if let Some(term) = gone {
            self.attached = None;
            self.inputs.remove(&(machine.to_string(), term));
            return true;
        }
        changed
    }

    /// Forget a machine and anything of its on screen (the machine was
    /// removed, or unpaired).
    pub fn forget_machine(&mut self, machine: &str) {
        self.lists.remove(machine);
        self.inputs.retain(|(m, _), _| m != machine);
        if self.attached.as_ref().is_some_and(|a| a.machine == machine) {
            self.attached = None;
        }
    }

    // --- opens, attaches, detaches -----------------------------------------

    /// Start an open: the slot goes to "opening" and the command to send is
    /// returned. The `open_id` is this phone's own, echoed back by
    /// `terminal-opened` (or named by a refused `terminal-exited`).
    pub fn begin_open(
        &mut self,
        machine: &str,
        session: Option<String>,
        cols: u16,
        rows: u16,
    ) -> TerminalOpenMsg {
        self.open_seq += 1;
        let open_id = format!("o{}", self.open_seq);
        self.attached = Some(Attached {
            machine: machine.to_string(),
            term: None,
            open_id: Some(open_id.clone()),
            shell: None,
            writer: true,
            cols,
            rows,
            expected: 0,
            replay_pending: false,
            refusal: None,
            ended: None,
        });
        TerminalOpenMsg { open_id, cols, rows, session }
    }

    /// Attach to a terminal the heartbeat lists, read-only, from the start of
    /// what the bridge still holds. Returns the replay command to send, and
    /// waits for its answer before taking live frames.
    pub fn begin_attach(&mut self, machine: &str, term: &str) -> TerminalReplayMsg {
        let info = self.lists.get(machine).and_then(|m| m.get(term)).cloned();
        let writer = info
            .as_ref()
            .is_some_and(|t| !self.device_id.is_empty() && t.writer == self.device_id);
        self.attached = Some(Attached {
            machine: machine.to_string(),
            term: Some(term.to_string()),
            open_id: None,
            shell: info.as_ref().map(|t| t.shell.clone()),
            writer,
            cols: info.as_ref().map_or(80, |t| t.cols),
            rows: info.as_ref().map_or(24, |t| t.rows),
            expected: 0,
            replay_pending: true,
            refusal: None,
            ended: None,
        });
        self.inputs
            .entry((machine.to_string(), term.to_string()))
            .or_insert_with(|| InputState::fresh(0));
        TerminalReplayMsg { term: term.to_string(), from: 0 }
    }

    /// Leave the terminal on screen: nothing is watched any more, and whatever
    /// was typed but unsent goes out first (the terminal outlives this phone's
    /// screen — see `docs/TERMINAL.md`, "Lifetime"). The direct link's timing
    /// is used, since a detach is the user's last word and should not wait on
    /// the relay cap.
    pub fn detach(&mut self, now: u64) -> Vec<TerminalInputMsg> {
        let step = self.flush(InputTransport::Direct, now);
        self.attached = None;
        step.sends
    }

    // --- input --------------------------------------------------------------

    /// Type into the terminal on screen. `alternate_screen` is what the
    /// emulator says it is showing: on the normal screen printable bytes wait
    /// for a key a program acts on, on the alternate screen every key is a
    /// command and goes after the short window.
    pub fn input(
        &mut self,
        machine: &str,
        term: &str,
        bytes: &[u8],
        alternate_screen: bool,
        transport: InputTransport,
        now: u64,
    ) -> InputStep {
        if bytes.is_empty() || !self.is_attached(machine, term) {
            return InputStep::empty();
        }
        let state = self
            .inputs
            .entry((machine.to_string(), term.to_string()))
            .or_insert_with(|| InputState::fresh(now));
        if state.pending.is_empty() {
            state.since_ms = now;
        }
        state.last_ms = now;
        state.alternate_screen = alternate_screen;
        state.pending.extend_from_slice(bytes);
        // A key a program can act on sends what is waiting with it: `git che`
        // and Tab go as one `git che\t`. On the alternate screen every key is
        // such a key, and the window is what paces them, so nothing is forced.
        let acts = !alternate_screen
            && (state.pending.len() > INPUT_BATCH_BYTES || bytes.iter().any(|b| is_action_key(*b)));
        if acts {
            self.flush(transport, now)
        } else {
            self.step_for(machine, transport)
        }
    }

    /// Paste: the whole thing goes as one event, after whatever was typed.
    pub fn paste(
        &mut self,
        machine: &str,
        term: &str,
        bytes: &[u8],
        transport: InputTransport,
        now: u64,
    ) -> InputStep {
        if bytes.is_empty() || !self.is_attached(machine, term) {
            return InputStep::empty();
        }
        let state = self
            .inputs
            .entry((machine.to_string(), term.to_string()))
            .or_insert_with(|| InputState::fresh(now));
        if state.pending.is_empty() {
            state.since_ms = now;
        }
        state.last_ms = now;
        state.pending.extend_from_slice(bytes);
        self.flush(transport, now)
    }

    /// The flush deadline fired: send what is waiting.
    pub fn flush_due(&mut self, transport: InputTransport, now: u64) -> InputStep {
        self.flush(transport, now)
    }

    /// The bridge is still waiting for input from `seq` (or, on a takeover,
    /// names the seq this device's count resumes at): adopt it and resend what
    /// is still held from there.
    pub fn input_from(
        &mut self,
        machine: &str,
        msg: &TerminalInputFromMsg,
        transport: InputTransport,
        now: u64,
    ) -> InputStep {
        if msg.seq == 0 {
            return InputStep::empty();
        }
        let key = (machine.to_string(), msg.term.clone());
        let Some(state) = self.inputs.get_mut(&key) else { return InputStep::empty() };
        let oldest = state.sent.front().map(|(s, _)| *s);
        let newest = state.sent.back().map(|(s, _)| *s);
        match (oldest, newest) {
            // Held: resend from there, keeping the counter where it is.
            (Some(oldest), Some(newest)) if msg.seq >= oldest && msg.seq <= newest => {
                state.resend_from = Some(msg.seq);
            }
            // Older than anything held, or ahead of what was sent: nothing to
            // resend, so the count continues from what the bridge named.
            _ => {
                state.next_seq = msg.seq;
                state.resend_from = None;
            }
        }
        self.flush(transport, now)
    }

    /// Whether `(machine, term)` is the terminal on screen.
    pub fn is_attached(&self, machine: &str, term: &str) -> bool {
        self.attached
            .as_ref()
            .is_some_and(|a| a.machine == machine && a.term.as_deref() == Some(term))
    }

    // --- the bridge's answers ----------------------------------------------

    /// `terminal-opened`: the open this phone asked for has a terminal.
    /// Returns whether the view changed.
    pub fn opened(&mut self, machine: &str, open_id: &str, term: &str, shell: &str, now: u64) -> bool {
        let Some(a) = self.attached.as_mut() else { return false };
        if a.machine != machine || a.open_id.as_deref() != Some(open_id) {
            return false;
        }
        a.term = Some(term.to_string());
        a.open_id = None;
        a.shell = Some(shell.to_string());
        a.writer = true;
        a.expected = 0;
        a.replay_pending = false;
        a.refusal = None;
        a.ended = None;
        self.inputs
            .insert((machine.to_string(), term.to_string()), InputState::fresh(now));
        true
    }

    /// `terminal-output` for the terminal on screen. `None` when it is for
    /// another terminal or the frame is dropped (an overlap already drawn, or
    /// a live frame ahead of a replay that was asked for).
    pub fn output(&mut self, machine: &str, msg: &TerminalOutputMsg) -> Option<OutputFrame> {
        let a = self.attached.as_mut()?;
        if a.machine != machine || a.term.as_deref() != Some(msg.term.as_str()) {
            return None;
        }
        let bytes = STANDARD.decode(&msg.data).ok()?;
        if msg.offset > a.expected {
            if a.replay_pending && msg.replay == Some(true) {
                // The answer to the replay starts at the oldest byte the
                // bridge still holds, which is past what was asked for once
                // that output has left the ring. Take it from there: asking
                // again would only earn the same clamped answer.
                a.expected = msg.offset;
            } else {
                // A frame was lost. Ask for the bytes from where the screen is
                // once per gap, and drop what arrives until the replay does.
                if a.replay_pending {
                    return None;
                }
                a.replay_pending = true;
                return Some(OutputFrame {
                    offset: a.expected,
                    data: Vec::new(),
                    replay_from: Some(a.expected),
                });
            }
        }
        let skip = (a.expected - msg.offset) as usize;
        if skip >= bytes.len() {
            return None;
        }
        let data = bytes[skip..].to_vec();
        let offset = msg.offset + skip as u64;
        a.expected = msg.offset + bytes.len() as u64;
        a.replay_pending = false;
        Some(OutputFrame { offset, data, replay_from: None })
    }

    /// `terminal-exited`: a refusal of this phone's open (`open_id`), the end
    /// of the terminal on screen (`term`), or a terminal the list names.
    /// Returns whether the view changed.
    pub fn exited(&mut self, machine: &str, msg: &TerminalExitedMsg) -> bool {
        if let Some(open_id) = &msg.open_id {
            let names = &self.names;
            let Some(a) = self.attached.as_mut() else { return false };
            if a.machine != machine || a.open_id.as_deref() != Some(open_id.as_str()) {
                return false;
            }
            a.open_id = None;
            a.writer = false;
            a.refusal = Some(Refusal {
                reason: msg.reason,
                device: msg.device.clone(),
                name: msg.device.as_ref().and_then(|d| names.get(d).cloned()),
            });
            return true;
        }
        let Some(term) = &msg.term else { return false };
        let mut changed = false;
        if let Some(a) = self.attached.as_mut() {
            if a.machine == machine && a.term.as_deref() == Some(term.as_str()) {
                a.ended = Some(Ended { reason: msg.reason, code: msg.code });
                a.writer = false;
                a.replay_pending = false;
                changed = true;
            }
        }
        self.inputs.remove(&(machine.to_string(), term.clone()));
        if let Some(list) = self.lists.get_mut(machine) {
            changed |= list.remove(term).is_some();
        }
        changed
    }

    /// `terminal-event`: every present client is told who opened, attached,
    /// took over or closed a terminal. What matters here is the writer: a
    /// takeover by another phone makes this one read-only.
    pub fn event(&mut self, machine: &str, msg: &TerminalEventMsg) -> bool {
        if let Some(name) = &msg.name {
            self.names.insert(msg.device.clone(), name.clone());
        }
        let ours = !self.device_id.is_empty() && msg.device == self.device_id;
        let Some(a) = self.attached.as_mut() else { return false };
        if a.machine != machine || a.term.as_deref() != Some(msg.term.as_str()) {
            return false;
        }
        match msg.what {
            TerminalEventKind::Takeover => {
                let changed = a.writer != ours;
                a.writer = ours;
                changed
            }
            TerminalEventKind::Closed | TerminalEventKind::Exited => {
                let changed = a.writer;
                a.writer = false;
                changed
            }
            _ => false,
        }
    }

    // --- the flush itself ---------------------------------------------------

    /// Send what the cap allows, from the typed bytes first and then from a
    /// resend the bridge asked for.
    fn flush(&mut self, transport: InputTransport, now: u64) -> InputStep {
        let Some(a) = self.attached.as_ref() else { return InputStep::empty() };
        let Some(term) = a.term.clone() else { return InputStep::empty() };
        let machine = a.machine.clone();
        let Some(state) = self.inputs.get_mut(&(machine.clone(), term.clone())) else {
            return InputStep::empty();
        };
        let mut sends = Vec::new();
        loop {
            // The window has run out: the cap starts again from now.
            if transport.capped() && now >= state.window_start_ms.saturating_add(RELAY_WINDOW_MS) {
                state.window_start_ms = now;
                state.window_count = 0;
            }
            if state.cap_at(transport).is_some() {
                break;
            }
            let next = if !state.pending.is_empty() {
                let seq = state.next_seq;
                Some((seq, state.take_batch(), false))
            } else if let Some(from) = state.resend_from {
                match state.held(from).map(<[u8]>::to_vec) {
                    Some(bytes) => Some((from, bytes, true)),
                    None => {
                        // Nothing that old is held any more: the resend is over.
                        state.resend_from = None;
                        None
                    }
                }
            } else {
                None
            };
            let Some((seq, bytes, resending)) = next else { break };
            if resending {
                state.resend_from = Some(seq + 1);
            } else {
                state.next_seq = seq + 1;
                state.hold(seq, &bytes);
            }
            state.window_count += 1;
            sends.push(TerminalInputMsg { term: term.clone(), seq, data: STANDARD.encode(&bytes) });
        }
        let waiting = state.pending.clone();
        let flush_at_ms = state.deadline(transport);
        InputStep { machine: Some(machine), sends, flush_at_ms, waiting }
    }

    /// The step for a call that sent nothing: just when to come back.
    fn step_for(&self, machine: &str, transport: InputTransport) -> InputStep {
        let Some(a) = self.attached.as_ref() else { return InputStep::empty() };
        let Some(term) = a.term.clone() else { return InputStep::empty() };
        let Some(state) = self.inputs.get(&(machine.to_string(), term)) else {
            return InputStep::empty();
        };
        InputStep {
            machine: Some(machine.to_string()),
            sends: Vec::new(),
            flush_at_ms: state.deadline(transport),
            waiting: state.pending.clone(),
        }
    }
}

/// A byte a program acts on rather than one it echoes: Enter, Tab, Esc (and
/// so any escape sequence, arrows included), any Ctrl chord, and Backspace or
/// Delete. Alt is an Esc prefix, so the same test covers it.
fn is_action_key(b: u8) -> bool {
    b < 0x20 || b == 0x7f
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::TerminalVia;

    const M: &str = "machine";
    const T: &str = "t1";

    fn info(term: &str, writer: &str) -> TerminalInfo {
        TerminalInfo {
            term: term.into(),
            shell: "/bin/bash".into(),
            opened: 1,
            device: writer.into(),
            name: Some("Pixel".into()),
            writer: writer.into(),
            cols: 80,
            rows: 24,
        }
    }

    /// A store with one terminal open on `M`, attached and the writer.
    fn attached() -> TerminalsState {
        let mut s = TerminalsState::default();
        s.set_device_id("me".into());
        s.apply_list(M, &[info(T, "me")]);
        s.begin_attach(M, T);
        s
    }

    fn typed(s: &mut TerminalsState, bytes: &[u8], alt: bool, at: u64) -> InputStep {
        s.input(M, T, bytes, alt, InputTransport::Direct, at)
    }

    fn seqs(step: &InputStep) -> Vec<u64> {
        step.sends.iter().map(|m| m.seq).collect()
    }

    fn bytes_of(step: &InputStep) -> Vec<Vec<u8>> {
        step.sends
            .iter()
            .map(|m| STANDARD.decode(&m.data).unwrap())
            .collect()
    }

    #[test]
    fn a_heartbeat_list_is_kept_per_machine() {
        let mut s = TerminalsState::default();
        assert!(s.apply_list(M, &[info("t1", "me")]));
        assert!(!s.apply_list(M, &[info("t1", "me")]), "the same list is not a change");
        assert!(s.apply_list("other", &[info("t9", "x")]));
        assert_eq!(s.list(M).len(), 1);
        assert_eq!(s.lists().len(), 2);
    }

    #[test]
    fn an_open_waits_on_its_open_id_and_becomes_the_writer() {
        let mut s = TerminalsState::default();
        let cmd = s.begin_open(M, Some("s1".into()), 100, 40);
        assert_eq!(s.attached().unwrap().open_id.as_deref(), Some(cmd.open_id.as_str()));
        assert!(s.attached().unwrap().writer, "the opener is the writer from the start");
        assert_eq!(s.attached().unwrap().term, None);

        assert!(s.opened(M, &cmd.open_id, T, "/bin/bash", 0));
        let a = s.attached().unwrap();
        assert_eq!(a.term.as_deref(), Some(T));
        assert_eq!(a.shell.as_deref(), Some("/bin/bash"));
        assert!(a.writer);
        assert!(s.is_watching());
    }

    #[test]
    fn another_open_ids_answer_is_ignored() {
        let mut s = TerminalsState::default();
        s.begin_open(M, None, 80, 24);
        assert!(!s.opened(M, "not-mine", T, "/bin/sh", 0));
        assert_eq!(s.attached().unwrap().term, None);
    }

    #[test]
    fn a_refused_open_keeps_the_device_and_its_name() {
        let mut s = TerminalsState::default();
        s.apply_list(M, &[info(T, "d1")]); // learns d1's name
        let cmd = s.begin_open(M, None, 80, 24);
        assert!(s.exited(
            M,
            &TerminalExitedMsg {
                term: None,
                open_id: Some(cmd.open_id),
                code: None,
                reason: TerminalEndReason::NotAllowed,
                device: Some("d1".into()),
            }
        ));
        let refusal = s.attached().unwrap().refusal.clone().unwrap();
        assert_eq!(refusal.reason, TerminalEndReason::NotAllowed);
        assert_eq!(refusal.device.as_deref(), Some("d1"));
        assert_eq!(refusal.name.as_deref(), Some("Pixel"));
        assert!(!s.attached().unwrap().writer, "a refused open is not a writer");
    }

    #[test]
    fn an_exit_marks_the_terminal_and_drops_it_from_the_list() {
        let mut s = attached();
        assert!(s.exited(
            M,
            &TerminalExitedMsg {
                term: Some(T.into()),
                open_id: None,
                code: Some(0),
                reason: TerminalEndReason::Exit,
                device: None,
            }
        ));
        let ended = s.attached().unwrap().ended.clone().unwrap();
        assert_eq!(ended.reason, TerminalEndReason::Exit);
        assert_eq!(ended.code, Some(0));
        assert!(s.list(M).is_empty());
        assert!(!s.attached().unwrap().writer);
    }

    #[test]
    fn a_list_that_no_longer_names_the_terminal_clears_the_screen() {
        let mut s = attached();
        assert!(s.apply_list(M, &[]));
        assert!(s.attached().is_none());
        assert!(!s.is_watching());
    }

    #[test]
    fn a_takeover_by_another_phone_makes_this_one_read_only() {
        let mut s = attached();
        assert!(s.attached().unwrap().writer);
        assert!(s.event(
            M,
            &TerminalEventMsg {
                term: T.into(),
                what: TerminalEventKind::Takeover,
                device: "other".into(),
                name: Some("Tablet".into()),
                via: TerminalVia::Relay,
                at: 5,
            }
        ));
        assert!(!s.attached().unwrap().writer);
        // Its own takeover event leaves it the writer.
        assert!(s.event(
            M,
            &TerminalEventMsg {
                term: T.into(),
                what: TerminalEventKind::Takeover,
                device: "me".into(),
                name: None,
                via: TerminalVia::Direct,
                at: 6,
            }
        ));
        assert!(s.attached().unwrap().writer);
    }

    // --- batching -----------------------------------------------------------

    #[test]
    fn a_completion_key_sends_what_waited_with_it() {
        let mut s = attached();
        assert!(typed(&mut s, b"git che", false, 0).sends.is_empty(), "printable bytes wait");
        let step = typed(&mut s, b"\t", false, 10);
        assert_eq!(bytes_of(&step), vec![b"git che\t".to_vec()]);
        assert_eq!(seqs(&step), vec![1]);
        assert_eq!(step.flush_at_ms, None);
        assert!(step.waiting.is_empty());
    }

    #[test]
    fn typing_then_a_pause_sends_one_event_at_the_pause() {
        let mut s = attached();
        let step = typed(&mut s, b"ls", false, 100);
        assert!(step.sends.is_empty());
        assert_eq!(step.flush_at_ms, Some(100 + PAUSE_DIRECT_MS));
        assert_eq!(step.waiting, b"ls");
        let step = s.flush_due(InputTransport::Direct, 250);
        assert_eq!(bytes_of(&step), vec![b"ls".to_vec()]);
        assert_eq!(step.flush_at_ms, None);
    }

    #[test]
    fn a_second_keystroke_pushes_the_pause_out() {
        let mut s = attached();
        typed(&mut s, b"l", false, 100);
        let step = typed(&mut s, b"s", false, 200);
        assert_eq!(step.flush_at_ms, Some(200 + PAUSE_DIRECT_MS));
    }

    #[test]
    fn past_the_batch_cap_the_bytes_are_split() {
        let mut s = attached();
        let step = typed(&mut s, &vec![b'a'; 300], false, 0);
        let sent = bytes_of(&step);
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].len(), INPUT_BATCH_BYTES);
        assert_eq!(sent[1].len(), 300 - INPUT_BATCH_BYTES);
        assert_eq!(seqs(&step), vec![1, 2]);
    }

    #[test]
    fn the_alternate_screen_flushes_after_the_short_window() {
        let mut s = attached();
        let step = typed(&mut s, b"\x1b[A", true, 100);
        assert!(step.sends.is_empty(), "nothing is forced on the alternate screen");
        assert_eq!(step.flush_at_ms, Some(100 + ALT_PAUSE_DIRECT_MS));
        // A held key's repeat does not push the window out.
        let step = typed(&mut s, b"\x1b[A", true, 110);
        assert_eq!(step.flush_at_ms, Some(100 + ALT_PAUSE_DIRECT_MS));
        let step = s.flush_due(InputTransport::Direct, 120);
        assert_eq!(bytes_of(&step), vec![b"\x1b[A\x1b[A".to_vec()]);
    }

    #[test]
    fn a_paste_is_one_event() {
        let mut s = attached();
        let step = s.paste(M, T, b"a whole line of text\n", InputTransport::Direct, 0);
        assert_eq!(bytes_of(&step), vec![b"a whole line of text\n".to_vec()]);
        assert_eq!(seqs(&step), vec![1]);
    }

    #[test]
    fn over_relays_the_pause_is_longer_and_the_rate_is_capped() {
        let mut s = attached();
        let step = s.input(M, T, b"x", false, InputTransport::Relay, 0);
        assert_eq!(step.flush_at_ms, Some(PAUSE_RELAY_MS));
        // Five events in one second; the rest is merged into the next.
        let mut sent = 0;
        for i in 0..6u64 {
            sent += s.input(M, T, b"a\r", false, InputTransport::Relay, i).sends.len();
        }
        assert_eq!(sent, RELAY_INPUTS_PER_SEC as usize, "the cap merges the rest");
        let step = s.input(M, T, b"b\r", false, InputTransport::Relay, 100);
        assert!(step.sends.is_empty());
        assert_eq!(step.flush_at_ms, Some(RELAY_WINDOW_MS), "held until the window turns");
        let step = s.flush_due(InputTransport::Relay, RELAY_WINDOW_MS);
        assert_eq!(bytes_of(&step).concat(), b"a\rb\r".to_vec());
    }

    #[test]
    fn the_direct_link_has_no_rate_cap() {
        let mut s = attached();
        let mut sent = 0;
        for i in 0..10u64 {
            sent += typed(&mut s, b"a\r", false, i).sends.len();
        }
        assert_eq!(sent, 10);
    }

    // --- seq and resends ----------------------------------------------------

    #[test]
    fn every_event_counts_up_by_one() {
        let mut s = attached();
        assert_eq!(seqs(&typed(&mut s, b"a\r", false, 0)), vec![1]);
        assert_eq!(seqs(&typed(&mut s, b"b\r", false, 1)), vec![2]);
        assert_eq!(seqs(&s.paste(M, T, b"c", InputTransport::Direct, 2)), vec![3]);
    }

    #[test]
    fn a_gap_in_the_seq_resends_what_is_still_held() {
        let mut s = attached();
        typed(&mut s, b"a\r", false, 0);
        typed(&mut s, b"b\r", false, 1);
        typed(&mut s, b"c\r", false, 2);
        let step = s.input_from(
            M,
            &TerminalInputFromMsg { term: T.into(), seq: 2 },
            InputTransport::Direct,
            3,
        );
        assert_eq!(seqs(&step), vec![2, 3]);
        assert_eq!(bytes_of(&step), vec![b"b\r".to_vec(), b"c\r".to_vec()]);
        // The counter is where it was: the next event is 4, not 3 again.
        assert_eq!(seqs(&typed(&mut s, b"d\r", false, 4)), vec![4]);
    }

    #[test]
    fn a_seq_nothing_is_held_for_continues_from_there() {
        let mut s = attached();
        typed(&mut s, b"a\r", false, 0);
        let step = s.input_from(
            M,
            &TerminalInputFromMsg { term: T.into(), seq: 9 },
            InputTransport::Direct,
            1,
        );
        assert!(step.sends.is_empty(), "nothing older than what is held can be resent");
        assert_eq!(seqs(&typed(&mut s, b"b\r", false, 2)), vec![9]);
    }

    #[test]
    fn a_takeover_adopts_the_seq_the_bridge_names() {
        let mut s = attached();
        typed(&mut s, b"a\r", false, 0);
        typed(&mut s, b"b\r", false, 1);
        // A takeover names one past the last this device's count reached:
        // nothing is resent, and the counter carries on from there.
        let step = s.input_from(
            M,
            &TerminalInputFromMsg { term: T.into(), seq: 3 },
            InputTransport::Direct,
            2,
        );
        assert!(step.sends.is_empty());
        assert_eq!(seqs(&typed(&mut s, b"c\r", false, 3)), vec![3]);
    }

    #[test]
    fn only_the_last_kept_events_can_be_resent() {
        let mut s = attached();
        for i in 0..(INPUT_KEEP_EVENTS as u64 + 5) {
            typed(&mut s, b"x\r", false, i);
        }
        // seq 1 fell out of the buffer: the count continues from what the
        // bridge named rather than typing old input again.
        let step = s.input_from(
            M,
            &TerminalInputFromMsg { term: T.into(), seq: 1 },
            InputTransport::Direct,
            1000,
        );
        assert!(step.sends.is_empty());
        assert_eq!(seqs(&typed(&mut s, b"y\r", false, 1001)), vec![1]);
    }

    // --- output -------------------------------------------------------------

    fn out(offset: u64, text: &str) -> TerminalOutputMsg {
        TerminalOutputMsg { term: T.into(), offset, data: STANDARD.encode(text.as_bytes()), replay: None }
    }

    #[test]
    fn output_in_order_is_handed_straight_to_the_app() {
        let mut s = attached();
        let f = s.output(M, &out(0, "ls -la\n")).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (0, b"ls -la\n".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 7);
        let f = s.output(M, &out(7, "total 0\n")).unwrap();
        assert_eq!(f.offset, 7);
        assert_eq!(s.attached().unwrap().expected, 15);
    }

    #[test]
    fn a_gap_asks_for_a_replay_once_and_drops_until_it_arrives() {
        let mut s = attached();
        s.output(M, &out(0, "abcd"));
        let f = s.output(M, &out(10, "lost")).unwrap();
        assert_eq!(f.replay_from, Some(4), "asked from where the screen is");
        assert!(f.data.is_empty());
        assert_eq!(s.output(M, &out(20, "still lost")), None, "one request per gap");
        let mut answer = out(4, "efgh");
        answer.replay = Some(true);
        let f = s.output(M, &answer).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (4, b"efgh".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 8);
        assert!(!s.attached().unwrap().replay_pending);
        // The marking alone does not excuse a gap nobody asked about: with no
        // replay pending this is an ordinary lost frame.
        let mut ahead = out(20, "ahead");
        ahead.replay = Some(true);
        let f = s.output(M, &ahead).unwrap();
        assert_eq!(f.replay_from, Some(8), "asked from where the screen is");
        assert!(f.data.is_empty());
    }

    #[test]
    fn an_attach_takes_a_replay_clamped_to_the_ring() {
        // An attach asks from 0, so its answer is accepted from wherever the
        // ring now starts.
        let mut s = attached();
        assert!(s.attached().unwrap().replay_pending);
        let mut answer = out(300_000, "clamped");
        answer.replay = Some(true);
        let f = s.output(M, &answer).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (300_000, b"clamped".as_slice()));
        assert_eq!(f.replay_from, None, "a clamped answer is not a new gap");
        assert_eq!(s.attached().unwrap().expected, 300_007);
        assert!(!s.attached().unwrap().replay_pending);
    }

    #[test]
    fn a_gap_older_than_the_ring_resumes_from_the_replay() {
        let mut s = attached();
        s.output(M, &out(0, "abcd"));
        let f = s.output(M, &out(10, "lost")).unwrap();
        assert_eq!(f.replay_from, Some(4));
        // The requested bytes left the ring, so the answer starts later.
        let mut answer = out(300_000, "kept");
        answer.replay = Some(true);
        let f = s.output(M, &answer).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (300_000, b"kept".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 300_004);
        assert!(!s.attached().unwrap().replay_pending);
        // Live output continues from the answer's end.
        let f = s.output(M, &out(300_004, "!")).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (300_004, b"!".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 300_005);
    }

    #[test]
    fn a_live_frame_while_a_replay_is_pending_does_not_advance_the_screen() {
        let mut s = attached();
        assert_eq!(s.output(M, &out(500, "ahead")), None);
        assert!(s.attached().unwrap().replay_pending);
        assert_eq!(s.attached().unwrap().expected, 0);
        // The bridge may answer nothing (an empty ring, or nothing left after
        // `from`); the next live frame at the expected offset still lands.
        let f = s.output(M, &out(0, "live")).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (0, b"live".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 4);
        assert!(!s.attached().unwrap().replay_pending);
    }

    #[test]
    fn an_overlapping_frame_is_trimmed() {
        let mut s = attached();
        s.output(M, &out(0, "abcd"));
        let f = s.output(M, &out(2, "cdef")).unwrap();
        assert_eq!((f.offset, f.data.as_slice()), (4, b"ef".as_slice()));
        assert_eq!(s.attached().unwrap().expected, 6);
        // Wholly behind what was drawn: dropped.
        assert_eq!(s.output(M, &out(0, "ab")), None);
        assert_eq!(s.attached().unwrap().expected, 6);
    }

    #[test]
    fn output_for_another_terminal_or_a_bad_payload_is_dropped() {
        let mut s = attached();
        let mut other = out(0, "x");
        other.term = "t9".into();
        assert_eq!(s.output(M, &other), None);
        assert_eq!(
            s.output(
                M,
                &TerminalOutputMsg { term: T.into(), offset: 0, data: "not base64!".into(), replay: None },
            ),
            None
        );
        assert_eq!(s.attached().unwrap().expected, 0);
    }

    // --- presence and lifetime ---------------------------------------------

    #[test]
    fn watching_follows_the_attached_terminal() {
        let mut s = TerminalsState::default();
        assert!(!s.is_watching());
        assert_eq!(s.watching_term(M), None);
        s.begin_attach(M, T);
        assert_eq!(s.watching_machine(), Some(M));
        assert_eq!(s.watching_term(M), Some(T.into()));
        assert_eq!(s.watching_term("other"), None);
        s.detach(0);
        assert!(!s.is_watching());
        assert_eq!(s.watching_term(M), None);
    }

    #[test]
    fn detaching_sends_what_was_typed_but_unsent() {
        let mut s = attached();
        typed(&mut s, b"half typed", false, 0);
        let sends = s.detach(10);
        assert_eq!(sends.len(), 1);
        assert_eq!(STANDARD.decode(&sends[0].data).unwrap(), b"half typed".to_vec());
        assert!(s.attached().is_none());
    }

    #[test]
    fn the_waiting_bytes_are_the_predicted_echo() {
        let mut s = attached();
        typed(&mut s, b"git che", false, 0);
        assert_eq!(s.waiting_input(), b"git che".to_vec());
        typed(&mut s, b"\t", false, 1);
        assert!(s.waiting_input().is_empty());
        // On the alternate screen nothing is predicted, held or not.
        typed(&mut s, b"j", true, 2);
        assert!(s.waiting_input().is_empty());
    }

    #[test]
    fn typing_into_a_terminal_that_is_not_on_screen_does_nothing() {
        let mut s = attached();
        assert!(s.input(M, "t9", b"x\r", false, InputTransport::Direct, 0).sends.is_empty());
        assert!(s.input("other", T, b"x\r", false, InputTransport::Direct, 0).sends.is_empty());
    }

    #[test]
    fn forgetting_a_machine_clears_its_list_and_the_screen() {
        let mut s = attached();
        s.apply_list("other", &[info("t9", "x")]);
        s.forget_machine(M);
        assert!(s.attached().is_none());
        assert!(s.list(M).is_empty());
        assert_eq!(s.list("other").len(), 1);
    }
}
