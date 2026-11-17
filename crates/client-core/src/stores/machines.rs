//! `machines` store: what the phone knows about each paired bridge — its
//! sessions, agents and settings — and the actions that change it, as a pure
//! state machine ([`MachinesState`]) the runtime persists after each change.
//!
//! Its parts, each re-exported here:
//! - `view`: the view types the UI, the backup and the persisted store read;
//! - `merge`: the session-list merge, where a session missing from a list is
//!   never deleted (bug B, sessions vanishing from the phone), and the title
//!   helpers;
//! - `persist`: what is stripped before the store is written, and the
//!   tolerant parse at boot.

use std::collections::{BTreeMap, BTreeSet};

use protocol::capabilities::BridgeHostKind;
use protocol::common::{
    AgentAction, CredentialStatus, McpAction, PluginAction, RemoteSessionInfo, SignInStatus, UsageData,
};
use protocol::events::{
    AccountSignInMsg, AccountsMsg, AgentAckMsg, AgentStyleMsg, CommandsMsg, McpAckMsg, McpServersMsg, ModelsMsg,
    PermissionRulesMsg, PersonasMsg, PluginAckMsg, PluginsMsg, ProviderProfilesMsg, SessionListMsg, SessionMcpMsg,
};

use super::agent_styles::AgentStyles;
use super::fetches::Fetches;
use super::pairing::is_relay_url;

mod merge;
mod persist;
mod view;

pub use merge::{merge_session_list, title_from_first_message, MergeOptions};
pub use persist::{hydrate_dismissed, hydrate_machines, serialize_dismissed, serialize_machines};
pub use view::{
    AgentAccounts, AgentActionState, AgentDefaults, AgentMcp, AgentModels, AgentPermissionRules,
    AgentPlugins, Dismissed, Incompatible, ListingPresence, MachineView, McpFailure, PersonaList,
    PluginFailure, PluginNotice, SessionCommands, SessionMcp, SessionView, SignInView,
};
use merge::with_guarded_title;

/// Whether `url` is a direct endpoint the phone may dial: `wss://` to any
/// host, `ws://` only to an onion service.
pub fn is_direct_endpoint(url: &str) -> bool {
    let host = |rest: &str| rest.split(['/', ':']).next().unwrap_or("").to_ascii_lowercase();
    match (url.strip_prefix("wss://"), url.strip_prefix("ws://")) {
        (Some(rest), _) => !host(rest).is_empty(),
        (None, Some(rest)) => host(rest).ends_with(".onion"),
        _ => false,
    }
}

/// A user-deleted session keeps suppressing incoming lists and live output
/// while its bridge still lists it, and for this long after: both since its
/// bridge last listed it, by that bridge's heartbeats, and by the phone's
/// clock. Counted in heartbeats too, so a bridge that was offline for a day
/// does not bring it back when it returns before it has heard the close. It
/// must outlast the direct link's resume window: a reconnecting link
/// re-sends what the bridge published in its last
/// [`protocol::direct::OUTBOX_SECS`], including the deleted session's final
/// output, which would otherwise read as news.
pub const DISMISSED_TTL_MS: u64 = 2 * protocol::direct::OUTBOX_SECS * 1000;

/// How often a `close-session` is sent again while the bridge still lists
/// the session it closes (the first went out when the delete committed).
pub const CLOSE_RETRY_MS: u64 = 5 * 60 * 1000;

/// How long a machine-settings change waits for an answer before the phone
/// gives up on it. The bridge sets no deadline of its own — it answers when
/// the agent host does — so this one is the phone's: it settles a change the
/// machine never answered (it was offline, a relay dropped it) so the UI does
/// not spin forever. An answer that arrives later still lands and replaces
/// the "did not answer" note.
pub const SETTINGS_ANSWER_TIMEOUT_MS: u64 = 60_000;

/// The same for the changes the bridge answers only once the work is done,
/// which can take minutes: a plugin's install, update or removal (a
/// marketplace clone, a package download) and an agent's removal. An agent's
/// install is answered when it is taken up, and keeps the short deadline.
pub const SLOW_SETTINGS_ANSWER_TIMEOUT_MS: u64 = 5 * 60_000;

/// What the phone shows when a change went unanswered for
/// [`SETTINGS_ANSWER_TIMEOUT_MS`].
const NO_ANSWER: &str = "The machine did not answer. It may be offline; try again once it is back.";

/// One machine-settings change sent and not answered yet, with what is needed
/// to settle it if the answer never comes: the data identifies the item in
/// the store it made busy.
#[derive(Debug, Clone, PartialEq)]
enum Unanswered {
    /// A plugin install / uninstall / enable / disable / update, or a
    /// marketplace change, by its target.
    Plugin { agent: String, target: String, action: PluginAction },
    /// An agent install or removal.
    AgentAction { agent: String, action: AgentAction },
    /// A change to an agent's MCP servers, by the names it touched.
    Mcp { agent: String, action: McpAction, names: Vec<String> },
    /// Removals of saved permission rules, by their ids.
    PermissionRules { agent: String, ids: Vec<String> },
    /// A change to a provider account (a sign-in, a removal, …).
    Account { agent: String, account: String },
    /// A switch of one server in a running session.
    SessionMcp { session_id: String, name: String },
}

impl Unanswered {
    /// How long the bridge may take to answer it.
    fn timeout_ms(&self) -> u64 {
        match self {
            Self::Plugin { .. } | Self::AgentAction { action: AgentAction::Remove, .. } => SLOW_SETTINGS_ANSWER_TIMEOUT_MS,
            _ => SETTINGS_ANSWER_TIMEOUT_MS,
        }
    }
}

/// Whether `error` is the note left by giving up on a change, which any later
/// answer from the machine makes stale (a real failure it reported is not).
fn is_no_answer(error: &str) -> bool {
    error == NO_ANSWER
}

/// The machines store as a pure state machine. Every method mutates
/// only `self`; the runtime persists `serialize_machines(&self.machines)` and
/// `serialize_dismissed(&self.dismissed_sessions)` after anything that
/// changes either. `fetches` is in-memory only.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MachinesState {
    pub machines: BTreeMap<String, MachineView>,
    pub dismissed_sessions: BTreeMap<String, Dismissed>,
    /// When a `close-session` last went to a dismissed session's bridge
    /// (ms); in memory only, so a restart sends it again at the first chance.
    pub close_sent: BTreeMap<String, u64>,
    pub merge_options: MergeOptions,
    /// The model lists and provider profiles answered on this connection.
    pub fetches: Fetches,
    /// Per machine, when the newest message read from it was written: a
    /// relay replaying something older says nothing about it now.
    pub read_at: BTreeMap<String, u64>,
    /// Agents' styles by hash, shared by every machine; persisted under its
    /// own key.
    pub agent_styles: AgentStyles,
    /// Every machine-settings change sent and not answered yet, with the
    /// machine it went to and when it is given up on (ms). In memory only, like the `busy`
    /// fields it settles: nothing here is worth surviving a restart, since a
    /// change in flight at the last shutdown was answered or not by then.
    unanswered: Vec<(String, Unanswered, u64)>,
}

impl MachinesState {
    pub fn new(machines: BTreeMap<String, MachineView>, merge_options: MergeOptions) -> Self {
        Self {
            machines,
            dismissed_sessions: BTreeMap::new(),
            close_sent: BTreeMap::new(),
            merge_options,
            fetches: Fetches::default(),
            read_at: BTreeMap::new(),
            agent_styles: AgentStyles::default(),
            unanswered: Vec::new(),
        }
    }

    pub fn machine(&self, pubkey_hex: &str) -> Option<&MachineView> {
        self.machines.get(pubkey_hex)
    }
    pub fn session(&self, machine_pubkey: &str, session_id: &str) -> Option<&SessionView> {
        self.machines.get(machine_pubkey)?.sessions.get(session_id)
    }
    pub fn machine_pubkeys(&self) -> Vec<String> {
        self.machines.keys().cloned().collect()
    }

    /// Upsert a machine record (pair-ack). An existing record keeps its fields;
    /// only `name` (and `label` / `host` when given) update, and `relays` the
    /// pairing learned are added to the ones it has.
    pub fn register_machine(
        &mut self,
        pubkey_hex: &str,
        name: &str,
        label: Option<String>,
        host: Option<BridgeHostKind>,
        relays: &[String],
    ) {
        let entry = self
            .machines
            .entry(pubkey_hex.to_string())
            .or_insert_with(|| MachineView::new(pubkey_hex.to_string(), name.to_string()));
        entry.name = name.to_string();
        if let Some(l) = label {
            entry.label = Some(l);
        }
        if let Some(h) = host {
            entry.host = Some(h);
        }
        for relay in relays {
            if !entry.relays.contains(relay) {
                entry.relays.push(relay.clone());
            }
        }
    }

    /// Every paired machine's relays, deduplicated, in machine order.
    pub fn relay_set(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for relay in self.machines.values().flat_map(|m| &m.relays) {
            if !out.contains(relay) {
                out.push(relay.clone());
            }
        }
        out
    }

    /// Replace `machine`'s relays. Returns false (and changes nothing) for an
    /// unknown machine, an empty list — a machine must stay reachable — or a
    /// URL that is not a relay the phone may dial.
    pub fn set_relays(&mut self, machine_pubkey: &str, relays: Vec<String>) -> bool {
        let mut clean: Vec<String> = Vec::new();
        for relay in relays.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
            if !is_relay_url(&relay) {
                return false;
            }
            if !clean.contains(&relay) {
                clean.push(relay);
            }
        }
        if clean.is_empty() {
            return false;
        }
        self.with_machine(machine_pubkey, |m| m.relays = clean)
    }

    /// A message `machine` wrote at `at` was read. True when that cleared a
    /// version mismatch no newer than it.
    pub fn note_read(&mut self, machine_pubkey: &str, at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        let read = self.read_at.entry(machine_pubkey.to_string()).or_default();
        *read = (*read).max(at);
        match m.incompatible {
            Some(i) if i.at <= at => {
                m.incompatible = None;
                true
            }
            _ => false,
        }
    }

    /// A message `machine` wrote at `at` was refused for its version
    /// (`theirs`). Only one newer than everything read from it counts. True
    /// when that changed which side needs updating.
    pub fn note_unreadable(&mut self, machine_pubkey: &str, theirs: Option<u64>, at: u64) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        if self.read_at.get(machine_pubkey).is_some_and(|read| at <= *read) {
            return false;
        }
        let changed = m.incompatible.is_none_or(|i| i.theirs != theirs);
        if m.incompatible.is_none_or(|i| i.at <= at) {
            m.incompatible = Some(Incompatible { theirs, at });
        }
        changed
    }

    /// The agent `machine`'s new sessions start on; `None` clears it.
    pub fn set_default_agent(&mut self, machine_pubkey: &str, agent: Option<String>) -> bool {
        let agent = agent.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
        self.with_machine(machine_pubkey, |m| m.default_agent = agent)
    }

    /// What a new `agent` session on `machine` starts with; all-empty
    /// forgets the entry.
    pub fn set_agent_defaults(&mut self, machine_pubkey: &str, agent: &str, defaults: AgentDefaults) -> bool {
        let defaults = AgentDefaults {
            mode: defaults.mode.trim().to_string(),
            effort: defaults.effort.trim().to_string(),
            model: defaults.model.trim().to_string(),
            persona: defaults.persona.trim().to_string(),
        };
        self.with_machine(machine_pubkey, |m| {
            if defaults.is_empty() {
                m.agent_defaults.remove(agent);
            } else {
                m.agent_defaults.insert(agent.to_string(), defaults);
            }
        })
    }

    /// The name the user gave `machine`; `None` or blank clears it.
    pub fn set_label(&mut self, machine_pubkey: &str, label: Option<String>) -> bool {
        let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
        self.with_machine(machine_pubkey, |m| m.label = label)
    }

    /// Replace every agent's new-session defaults for `machine` at once.
    pub fn replace_agent_defaults(&mut self, machine_pubkey: &str, defaults: BTreeMap<String, AgentDefaults>) -> bool {
        self.with_machine(machine_pubkey, |m| m.agent_defaults = defaults)
    }

    /// Forget a machine, and the sessions deleted on it: with the machine
    /// gone no heartbeat of it can bring them back.
    pub fn remove_machine(&mut self, pubkey_hex: &str) -> bool {
        let removed = self.machines.remove(pubkey_hex).is_some();
        self.prune_dismissed(0);
        removed
    }

    /// Forget the dismissals that are over: the machine is gone, or it has
    /// not listed the session for [`DISMISSED_TTL_MS`] of its heartbeats and
    /// as long by `now`.
    fn prune_dismissed(&mut self, now: u64) {
        let machines = &self.machines;
        self.dismissed_sessions.retain(|_, d| {
            let Some(m) = machines.get(&d.machine) else { return false };
            let quiet = m.last_heartbeat_at.map_or(0, |hb| hb.saturating_sub(d.at));
            quiet < DISMISSED_TTL_MS || now.saturating_sub(d.at) < DISMISSED_TTL_MS
        });
        let dismissed = &self.dismissed_sessions;
        self.close_sent.retain(|id, _| dismissed.contains_key(id));
    }

    /// Whether `msg` is no newer than the newest list applied for
    /// `machine_pubkey`, so applying it would step the machine back.
    pub fn is_outdated_list(&self, machine_pubkey: &str, msg: &SessionListMsg) -> bool {
        let applied = self.machine(machine_pubkey).and_then(|m| m.list_rev);
        matches!((msg.rev, applied), (Some(rev), Some(applied)) if rev <= applied)
    }

    /// The heartbeat path. CDX-022: the record is SPREAD from the existing one,
    /// never rebuilt — a field the wire omits (`models`, `host`, …) keeps its
    /// stored value; a field the wire carries always wins. The resurrection
    /// shield filters user-deleted sessions out of `msg` BEFORE the merge.
    ///
    /// Returns the deleted sessions the bridge still lists whose
    /// `close-session` it has not acknowledged: it never heard it, so the
    /// caller sends it again (see [`Self::closes_due`]). Each one listed stays
    /// dismissed for as long as it is listed.
    pub fn apply_session_list(&mut self, machine_pubkey: &str, msg: &SessionListMsg, at: u64) -> Vec<String> {
        let mut unclosed = Vec::new();
        for info in &msg.sessions {
            if let Some(d) = self.dismissed_sessions.get_mut(&info.id).filter(|d| d.machine == machine_pubkey) {
                d.at = d.at.max(at);
                if !d.closed {
                    unclosed.push(info.id.clone());
                }
            }
        }
        let dismissed = &self.dismissed_sessions;

        let prev_sessions = self
            .machines
            .get(machine_pubkey)
            .map(|m| m.sessions.clone())
            .unwrap_or_default();

        // Filtered copy of the incoming list (resurrection shield).
        let mut shielded = msg.clone();
        shielded
            .sessions
            .retain(|s| !dismissed.contains_key(&s.id));

        let sessions = merge_session_list(&prev_sessions, &shielded, at, self.merge_options);

        let entry = self
            .machines
            .entry(machine_pubkey.to_string())
            .or_insert_with(|| MachineView::new(machine_pubkey.to_string(), msg.machine.clone()));
        entry.pubkey_hex = machine_pubkey.to_string();
        entry.name = msg.machine.clone();
        if let Some(h) = msg.host {
            entry.host = Some(h);
        }
        if let Some(caps) = &msg.capabilities {
            entry.capabilities = caps.clone();
        }
        if let Some(f) = &msg.folders {
            entry.folders = f.clone();
        }
        if let Some(r) = &msg.roots {
            entry.roots = r.clone();
        }
        entry.agents = msg.agents.clone();
        entry.credentials = msg.credentials.clone();
        entry.machine_offline = msg.machine_offline.unwrap_or(false);
        entry.direct = msg.direct.clone();
        if msg.rev.is_some() {
            entry.list_rev = msg.rev;
        }
        entry.last_heartbeat_at = Some(at);
        entry.sessions = sessions;
        self.prune_dismissed(at);
        unclosed
    }

    /// Of `sessions` (deleted ones their bridge still lists), those whose
    /// `close-session` is due again, noted as sent `now`.
    pub fn closes_due(&mut self, sessions: &[String], now: u64) -> Vec<String> {
        let mut due = Vec::new();
        for id in sessions {
            if self.close_sent.get(id).is_none_or(|at| now.saturating_sub(*at) >= CLOSE_RETRY_MS) {
                self.close_sent.insert(id.clone(), now);
                due.push(id.clone());
            }
        }
        due
    }

    /// A `close-session` for `session_id` went out `now`.
    pub fn note_close_sent(&mut self, session_id: &str, now: u64) {
        self.close_sent.insert(session_id.to_string(), now);
    }

    /// The bridge acknowledged closing `session_id`: it is not sent again.
    /// The session stays dismissed (a replay of its output is not news).
    pub fn note_closed(&mut self, session_id: &str) {
        if let Some(d) = self.dismissed_sessions.get_mut(session_id) {
            d.closed = true;
        }
        self.close_sent.remove(session_id);
    }

    /// Where to reach `machine` directly: the endpoints to try, in order,
    /// and the certificate pin for its `wss://` ones. `None` when there is
    /// nowhere to try.
    pub fn direct_target(&self, machine_pubkey: &str) -> Option<(Vec<String>, Option<String>)> {
        let m = self.machines.get(machine_pubkey)?;
        let mut endpoints: Vec<String> = m.direct.iter().flat_map(|d| d.endpoints.iter().cloned()).collect();
        for extra in &m.direct_endpoints {
            if !endpoints.contains(extra) {
                endpoints.push(extra.clone());
            }
        }
        let pin = m.direct.as_ref().and_then(|d| d.cert_sha256.clone());
        (!endpoints.is_empty()).then_some((endpoints, pin))
    }

    /// Replace the user's own direct endpoints for `machine`. Returns false
    /// (and changes nothing) for an unknown machine or an endpoint that is
    /// neither `wss://…` nor `ws://….onion`.
    pub fn set_direct_endpoints(&mut self, machine_pubkey: &str, endpoints: Vec<String>) -> bool {
        let endpoints: Vec<String> = endpoints.into_iter().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect();
        if !endpoints.iter().all(|e| is_direct_endpoint(e)) {
            return false;
        }
        self.with_machine(machine_pubkey, |m| m.direct_endpoints = endpoints)
    }

    fn with_machine<F: FnOnce(&mut MachineView)>(&mut self, machine_pubkey: &str, f: F) -> bool {
        match self.machines.get_mut(machine_pubkey) {
            Some(m) => {
                f(m);
                true
            }
            None => false,
        }
    }

    pub fn apply_session_upsert(&mut self, machine_pubkey: &str, info: &RemoteSessionInfo, at: u64) {
        self.with_machine(machine_pubkey, |m| {
            let prior = m.sessions.get(&info.id);
            let view = SessionView {
                info: with_guarded_title(info, prior),
                presence: ListingPresence::Live,
                last_listed_at: at,
                usage: prior.and_then(|p| p.usage.clone()),
                commands: prior.and_then(|p| p.commands.clone()),
                mcp: prior.and_then(|p| p.mcp.clone()),
                personas: prior.and_then(|p| p.personas.clone()),
            };
            m.sessions.insert(info.id.clone(), view);
        });
    }

    /// Patch a session's `info` in place (e.g. mode / effort / model confirmed).
    pub fn update_session_info<F: FnOnce(&mut RemoteSessionInfo)>(
        &mut self,
        machine_pubkey: &str,
        session_id: &str,
        patch: F,
    ) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                patch(&mut s.info);
            }
        });
    }

    /// The FIRST user message titles an untitled session. No-op when the session
    /// is unknown, already titled, or the text is whitespace-only.
    pub fn note_first_user_message(&mut self, machine_pubkey: &str, session_id: &str, text: &str) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(session_id) else {
                return;
            };
            if s.info.title.is_some() {
                return;
            }
            let title = title_from_first_message(text);
            if title.is_empty() {
                return;
            }
            s.info.title = Some(title);
        });
    }

    /// Explicit user delete — one of exactly two removal paths.
    pub fn user_remove_session(&mut self, machine_pubkey: &str, session_id: &str) {
        self.with_machine(machine_pubkey, |m| {
            m.sessions.remove(session_id);
        });
    }

    /// Shield a user-deleted session on `machine_pubkey` from resurrection
    /// by heartbeats that still list it.
    pub fn dismiss_session(&mut self, machine_pubkey: &str, session_id: &str, at: u64) {
        self.prune_dismissed(at);
        self.dismissed_sessions
            .insert(session_id.to_string(), Dismissed { machine: machine_pubkey.to_string(), at, closed: false });
    }

    /// The user deleted `session_id`, and its bridge may still have it or
    /// have just dropped it (see [`DISMISSED_TTL_MS`]).
    pub fn is_dismissed(&self, session_id: &str) -> bool {
        self.dismissed_sessions.contains_key(session_id)
    }

    /// Undo a delete: un-dismiss and re-insert the exact snapshotted view.
    pub fn restore_session(&mut self, machine_pubkey: &str, view: SessionView) {
        self.dismissed_sessions.remove(&view.info.id);
        self.close_sent.remove(&view.info.id);
        self.with_machine(machine_pubkey, |m| {
            m.sessions.insert(view.info.id.clone(), view);
        });
    }

    pub fn apply_usage(&mut self, machine_pubkey: &str, session_id: &str, usage: UsageData) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(s) = m.sessions.get_mut(session_id) {
                s.usage = Some(usage);
            }
        });
    }

    /// A session's list lands on the session, a machine-wide one on the
    /// agent's entry.
    pub fn apply_personas(&mut self, machine_pubkey: &str, msg: &PersonasMsg) {
        self.with_machine(machine_pubkey, |m| match &msg.session_id {
            Some(id) => {
                if let Some(s) = m.sessions.get_mut(id) {
                    s.personas = Some(PersonaList::apply(s.personas.take(), msg));
                }
            }
            None => {
                let held = m.personas.remove(&msg.agent);
                m.personas.insert(msg.agent.clone(), PersonaList::apply(held, msg));
            }
        });
    }

    /// A list replaces the one held; an empty answer (it always carries the
    /// reason) keeps the held list and records why.
    pub fn apply_commands(&mut self, machine_pubkey: &str, msg: &CommandsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(&msg.session_id) else { return };
            if msg.commands.is_empty() {
                let held = s.commands.take().map(|c| c.commands).unwrap_or_default();
                s.commands = Some(SessionCommands { commands: held, error: msg.error.clone() });
            } else {
                s.commands = Some(SessionCommands { commands: msg.commands.clone(), error: None });
            }
        });
    }

    /// A list replaces the held one; a failed read keeps it and records why.
    /// A list without `available` keeps the held offer, less anything now
    /// installed.
    pub fn apply_plugins(&mut self, machine_pubkey: &str, msg: &PluginsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(msg.agent.clone()).or_default();
            if let Some(error) = &msg.error {
                p.error = Some(error.clone());
                return;
            }
            p.error = None;
            if p.failure.as_ref().is_some_and(|f| is_no_answer(&f.error)) {
                p.failure = None;
            }
            p.installed = msg.installed.clone();
            p.marketplaces = msg.marketplaces.clone();
            p.toggles = msg.toggles;
            p.install_hint = msg.install_hint.clone();
            p.install_note = msg.install_note.clone();
            if let Some(available) = &msg.available {
                p.available = Some(available.clone());
            }
            let installed: Vec<&str> = p.installed.iter().map(|i| i.id.as_str()).collect();
            if let Some(available) = &mut p.available {
                available.retain(|a| !installed.contains(&a.id.as_str()));
            }
        });
    }

    /// A change was sent: its target is busy until acknowledged, and the
    /// previous change's report gives way to it. The change is remembered
    /// with `now` so an answer that never comes can be given up on (see
    /// [`Self::expire_unanswered`]).
    pub fn plugin_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: PluginAction, target: &str, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(agent.to_string()).or_default();
            if !p.busy.iter().any(|t| t == target) {
                p.busy.push(target.to_string());
            }
            p.notice = None;
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Plugin { agent: agent.to_string(), target: target.to_string(), action },
            now,
        );
    }

    pub fn apply_plugin_ack(&mut self, machine_pubkey: &str, msg: &PluginAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let p = m.plugins.entry(msg.agent.clone()).or_default();
            p.busy.retain(|t| *t != msg.target);
            p.notice = msg.success.then(|| msg.message.clone()).flatten().map(|message| PluginNotice {
                action: msg.action,
                target: msg.target.clone(),
                message,
            });
            p.failure = (!msg.success).then(|| PluginFailure {
                action: msg.action,
                target: msg.target.clone(),
                error: msg.error.clone().unwrap_or_else(|| "It could not be done.".into()),
            });
        });
    }

    /// An install or removal was sent: the agent is busy until acknowledged.
    pub fn agent_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: AgentAction, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.agent_actions.entry(agent.to_string()).or_default();
            a.busy = Some(action);
            a.failure = None;
        });
        self.record_unanswered(machine_pubkey, Unanswered::AgentAction { agent: agent.to_string(), action }, now);
    }

    pub fn apply_agent_ack(&mut self, machine_pubkey: &str, msg: &AgentAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.agent_actions.entry(msg.agent.clone()).or_default();
            a.busy = None;
            a.failure = (!msg.success).then(|| msg.error.clone().unwrap_or_else(|| "It could not be done.".into()));
        });
    }

    /// A list replaces the held one; a failed read keeps it and records why.
    pub fn apply_mcp(&mut self, machine_pubkey: &str, msg: &McpServersMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(msg.agent.clone()).or_default();
            match &msg.error {
                Some(error) => a.error = Some(error.clone()),
                None => {
                    a.error = None;
                    if a.failure.as_ref().is_some_and(|f| is_no_answer(&f.error)) {
                        a.failure = None;
                    }
                    a.servers = msg.servers.clone();
                    a.toggles = msg.toggles;
                }
            }
        });
    }

    /// A change was sent: the servers it names are busy until acknowledged.
    pub fn mcp_action_sent(&mut self, machine_pubkey: &str, agent: &str, action: McpAction, names: &[String], now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(agent.to_string()).or_default();
            for n in names {
                if !a.busy.contains(n) {
                    a.busy.push(n.clone());
                }
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Mcp { agent: agent.to_string(), action, names: names.to_vec() },
            now,
        );
    }

    pub fn apply_mcp_ack(&mut self, machine_pubkey: &str, msg: &McpAckMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.mcp.entry(msg.agent.clone()).or_default();
            a.busy.retain(|n| !msg.names.contains(n));
            a.failure = (!msg.success).then(|| McpFailure {
                action: msg.action,
                names: msg.names.clone(),
                error: msg.error.clone().unwrap_or_else(|| "It could not be done.".into()),
            });
        });
    }

    /// A list replaces the held one; a failure keeps it and records why.
    /// Either way the answer settles every removal in flight: the bridge
    /// answers each request with exactly one message.
    pub fn apply_permission_rules(&mut self, machine_pubkey: &str, msg: &PermissionRulesMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.permission_rules.entry(msg.agent.clone()).or_default();
            a.busy.clear();
            match &msg.error {
                Some(error) => a.error = Some(error.clone()),
                None => {
                    a.error = None;
                    a.rules = msg.rules.clone();
                }
            }
        });
    }

    /// A list replaces what it covers — the connected accounts always, the
    /// whole catalogue when it is one; a failure keeps what is held and says
    /// why. Either way it settles every change in flight: the bridge answers
    /// each with exactly one message.
    pub fn apply_accounts(&mut self, machine_pubkey: &str, msg: &AccountsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(msg.agent.clone()).or_default();
            a.busy.clear();
            if let Some(error) = &msg.error {
                a.error = Some(error.clone());
                return;
            }
            a.error = None;
            a.connected = msg.accounts.iter().filter(|x| !x.connections.is_empty()).cloned().collect();
            if msg.all {
                a.all = Some(msg.accounts.clone());
            } else if let Some(all) = &mut a.all {
                // Keep the catalogue's connections in step with the list.
                for account in all.iter_mut() {
                    account.connections =
                        msg.accounts.iter().find(|x| x.id == account.id).map(|x| x.connections.clone()).unwrap_or_default();
                }
            }
        });
    }

    /// A change was sent: its account is busy until answered, and a sign-in
    /// is followed from here.
    pub fn account_action_sent(&mut self, machine_pubkey: &str, agent: &str, account: &str, sign_in: bool, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(agent.to_string()).or_default();
            if !a.busy.iter().any(|b| b == account) {
                a.busy.push(account.to_string());
            }
            if sign_in {
                a.sign_in = Some(SignInView { account: account.to_string(), status: SignInStatus::Started, attempt: None, error: None });
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::Account { agent: agent.to_string(), account: account.to_string() },
            now,
        );
    }

    /// Where a sign-in stands. Its link and code stay shown until it ends;
    /// one about another sign-in than the one followed is not this client's
    /// to show.
    pub fn apply_account_sign_in(&mut self, machine_pubkey: &str, msg: &AccountSignInMsg) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.accounts.entry(msg.agent.clone()).or_default();
            a.busy.retain(|b| *b != msg.account);
            if a.error.as_deref().is_some_and(is_no_answer) {
                a.error = None;
            }
            let Some(view) = &mut a.sign_in else { return };
            if view.account != msg.account {
                return;
            }
            let followed = view.attempt.as_ref().map(|x| x.attempt_id.clone());
            if let (Some(followed), Some(id)) = (&followed, &msg.attempt_id) {
                if followed != id {
                    return;
                }
            }
            view.status = msg.status;
            view.error = msg.error.clone();
            if let Some(attempt) = &msg.attempt {
                view.attempt = Some(attempt.clone());
            }
        });
    }

    /// The sign-in's result has been seen: stop showing it.
    pub fn dismiss_sign_in(&mut self, machine_pubkey: &str, agent: &str) {
        self.with_machine(machine_pubkey, |m| {
            if let Some(a) = m.accounts.get_mut(agent) {
                a.sign_in = None;
            }
        });
    }

    /// A removal was sent: the rules it names are busy until answered.
    pub fn permission_rules_remove_sent(&mut self, machine_pubkey: &str, agent: &str, ids: &[String], now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let a = m.permission_rules.entry(agent.to_string()).or_default();
            for id in ids {
                if !a.busy.contains(id) {
                    a.busy.push(id.clone());
                }
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::PermissionRules { agent: agent.to_string(), ids: ids.to_vec() },
            now,
        );
    }

    /// A session's servers replace the held ones and settle every switch in
    /// flight; a failed answer keeps them and records why.
    pub fn apply_session_mcp(&mut self, machine_pubkey: &str, msg: &SessionMcpMsg) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(&msg.session_id) else { return };
            let held = s.mcp.get_or_insert_with(SessionMcp::default);
            held.busy.clear();
            match &msg.error {
                Some(error) => held.error = Some(error.clone()),
                None => {
                    *held = SessionMcp {
                        servers: msg.servers.clone(),
                        toggles: msg.toggles,
                        project_wide: msg.project_wide,
                        error: None,
                        busy: vec![],
                    }
                }
            }
        });
    }

    /// A switch was sent: that server is busy until the session answers.
    pub fn session_mcp_toggle_sent(&mut self, machine_pubkey: &str, session_id: &str, name: &str, now: u64) {
        self.with_machine(machine_pubkey, |m| {
            let Some(s) = m.sessions.get_mut(session_id) else { return };
            let held = s.mcp.get_or_insert_with(SessionMcp::default);
            if !held.busy.iter().any(|n| n == name) {
                held.busy.push(name.to_string());
            }
        });
        self.record_unanswered(
            machine_pubkey,
            Unanswered::SessionMcp { session_id: session_id.to_string(), name: name.to_string() },
            now,
        );
    }

    /// Remember a change just sent, so [`Self::expire_unanswered`] can give up
    /// on it if no answer comes. Resending the same change replaces its
    /// timestamp rather than adding a second entry: the answer settles it
    /// once, so it must be given up on once.
    fn record_unanswered(&mut self, machine_pubkey: &str, item: Unanswered, now: u64) {
        let deadline = now.saturating_add(item.timeout_ms());
        if let Some(entry) = self.unanswered.iter_mut().find(|(m, u, _)| m == machine_pubkey && *u == item) {
            entry.2 = deadline;
            return;
        }
        self.unanswered.push((machine_pubkey.to_string(), item, deadline));
    }

    /// When the earliest unanswered change gives up, as a wall-clock ms — the
    /// runtime arms its timer for this. `None` when nothing is in flight.
    pub fn next_unanswered_deadline(&self) -> Option<u64> {
        self.unanswered
            .iter()
            .map(|(_, _, deadline)| *deadline)
            .min()
    }

    /// Give up on every change whose deadline ([`SETTINGS_ANSWER_TIMEOUT_MS`],
    /// or [`SLOW_SETTINGS_ANSWER_TIMEOUT_MS`] after it was sent) has come,
    /// and settle whatever it still has busy, so a machine that never answers
    /// does not leave the UI spinning. A change already answered is dropped
    /// without change; one whose machine or session is gone is just dropped.
    /// Returns whether any stored state changed.
    pub fn expire_unanswered(&mut self, now: u64) -> bool {
        let all = std::mem::take(&mut self.unanswered);
        let mut due = Vec::new();
        for entry in all {
            if entry.2 <= now {
                due.push(entry);
            } else {
                self.unanswered.push(entry);
            }
        }
        let mut changed = false;
        for (machine, item, _) in due {
            changed |= self.settle_unanswered(&machine, item);
        }
        changed
    }

    /// Settle one unanswered change: if what it names is still busy, clear it
    /// and record why. False when it was already answered or its machine or
    /// session is gone — nothing to change.
    fn settle_unanswered(&mut self, machine_pubkey: &str, item: Unanswered) -> bool {
        let Some(m) = self.machines.get_mut(machine_pubkey) else { return false };
        match item {
            Unanswered::Plugin { agent, target, action } => {
                let Some(p) = m.plugins.get_mut(&agent) else { return false };
                if !p.busy.contains(&target) {
                    return false;
                }
                p.busy.retain(|t| *t != target);
                p.failure = Some(PluginFailure { action, target, error: NO_ANSWER.into() });
                true
            }
            Unanswered::AgentAction { agent, .. } => {
                let Some(a) = m.agent_actions.get_mut(&agent) else { return false };
                if a.busy.is_none() {
                    return false;
                }
                a.busy = None;
                a.failure = Some(NO_ANSWER.into());
                true
            }
            Unanswered::Mcp { agent, action, names } => {
                let Some(a) = m.mcp.get_mut(&agent) else { return false };
                let still: Vec<String> = names.iter().filter(|n| a.busy.contains(*n)).cloned().collect();
                if still.is_empty() {
                    return false;
                }
                a.busy.retain(|n| !names.contains(n));
                a.failure = Some(McpFailure { action, names: still, error: NO_ANSWER.into() });
                true
            }
            Unanswered::PermissionRules { agent, ids } => {
                let Some(a) = m.permission_rules.get_mut(&agent) else { return false };
                if !ids.iter().any(|id| a.busy.contains(id)) {
                    return false;
                }
                a.busy.retain(|id| !ids.contains(id));
                a.error = Some(NO_ANSWER.into());
                true
            }
            Unanswered::Account { agent, account } => {
                let Some(a) = m.accounts.get_mut(&agent) else { return false };
                // Any answer about the account clears it from `busy`, so a
                // busy account is one the machine never answered for.
                if !a.busy.contains(&account) {
                    return false;
                }
                a.busy.retain(|b| *b != account);
                a.error = Some(NO_ANSWER.into());
                // A sign-in the machine never took up is reported failed
                // rather than left waiting for a link that will not come.
                if let Some(view) = a.sign_in.as_mut() {
                    if view.account == account && view.status == SignInStatus::Started && view.attempt.is_none() {
                        view.status = SignInStatus::Failed;
                        view.error = Some(NO_ANSWER.into());
                    }
                }
                true
            }
            Unanswered::SessionMcp { session_id, name } => {
                let Some(held) = m.sessions.get_mut(&session_id).and_then(|s| s.mcp.as_mut()) else {
                    return false;
                };
                if !held.busy.contains(&name) {
                    return false;
                }
                held.busy.retain(|n| *n != name);
                held.error = Some(NO_ANSWER.into());
                true
            }
        }
    }

    /// The agent running `session_id` on `machine`, when its bridge names a
    /// style for it that is not cached yet — what to ask that bridge for.
    pub fn missing_style(&self, machine_pubkey: &str, session_id: &str) -> Option<String> {
        let machine = self.machines.get(machine_pubkey)?;
        let agent = &machine.sessions.get(session_id)?.info.agent;
        let hash = machine.agent(agent)?.style_hash.as_deref()?;
        (!self.agent_styles.contains(hash)).then(|| agent.to_string())
    }

    /// A bridge's answer to `agent-style-request`. Returns whether the cache
    /// changed.
    pub fn apply_agent_style(&mut self, msg: &AgentStyleMsg) -> bool {
        let (Some(hash), Some(style)) = (&msg.style_hash, &msg.style) else {
            return false;
        };
        let named: BTreeSet<String> = self
            .machines
            .values()
            .flat_map(|m| m.agents.iter().filter_map(|a| a.style_hash.clone()))
            .collect();
        self.agent_styles.insert(hash, style.clone(), &named)
    }

    /// CDX-035: an EMPTY `models` is a "could not answer" report (it carries a
    /// reason) — it must never overwrite a good list. A non-empty answer is
    /// always authoritative and clears any stored reason. Applies only to the
    /// answering agent's entry, and only for a known machine.
    pub fn apply_models(&mut self, machine_pubkey: &str, msg: &ModelsMsg) {
        self.with_machine(machine_pubkey, |m| {
            let entry = m.models.entry(msg.agent.clone()).or_default();
            if msg.models.is_empty() {
                entry.error = msg.error.clone();
                return;
            }
            entry.models = Some(msg.models.clone());
            if let Some(dm) = &msg.default_model {
                entry.default_model = Some(dm.clone());
            }
            entry.error = None;
        });
    }

    /// A `credentials-ack` for the bridge's own credentials (no `agent`)
    /// replaces the stored statuses; one for an agent patches that agent's
    /// catalog entry. Either way the next heartbeat re-states them.
    pub fn apply_credential_statuses(
        &mut self,
        machine_pubkey: &str,
        agent: Option<&str>,
        statuses: &[CredentialStatus],
    ) {
        self.with_machine(machine_pubkey, |m| match agent {
            None => m.credentials = statuses.to_vec(),
            Some(id) => {
                if let Some(a) = m.agents.iter_mut().find(|a| a.id == id) {
                    a.credentials = statuses.to_vec();
                }
            }
        });
    }

    /// CDX-062: plain replace (unlike `apply_models`) — the bridge always
    /// answers straight from storage, so an empty list truly means zero
    /// profiles.
    pub fn apply_provider_profiles(&mut self, machine_pubkey: &str, msg: &ProviderProfilesMsg) {
        self.with_machine(machine_pubkey, |m| {
            m.provider_profiles = Some(msg.profiles.clone());
        });
    }
}

#[cfg(test)]
mod tests;
