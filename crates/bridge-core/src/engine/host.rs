//! The agent host side of the engine: requests to it, its replies, the
//! session events it streams, the cards it asks the user for — and the
//! session lifecycle all of that drives.
//!
//! A session's life, as the bridge sees it:
//! - created from the phone it is *pending*: the phone shows a placeholder,
//!   the host is asked to start it, and it becomes *ready* on the host's
//!   `ready` (or is failed, with the reason);
//! - when its agent dies it is restarted — resuming its conversation when
//!   the agent has one — up to [`MAX_RESTARTS`] times, each with a notice in
//!   the transcript, then ended with one;
//! - when the host itself dies every running session is treated as crashed,
//!   and restarted once the host is back;
//! - an ended session keeps its record, so it stays on the phone and is
//!   resumed when the bridge next starts.

use std::collections::BTreeMap;

use agent_protocol::{
    BridgeMessage, HostFrame, HostMessage, PlanOutcome, QuestionOutcome, SelectOutcome, SessionEvent, StartSession,
};
use protocol::common::{EntryBody, NoticeKind, OutputEntry, Role, SessionOption, ToolKind};
use protocol::common::{McpAction, PluginAction};
use protocol::events::{
    BridgeToPhone, CommandsMsg, ModelsMsg, OptionConfirmedMsg, PluginAckMsg, PluginsMsg, SessionFailedMsg,
    SessionReadyMsg, UsageMsg,
};

use super::Engine;
use crate::io::Effect;
use crate::out::TimerKind;
use crate::session::{
    is_slash_command, runs_git_commit, strip_session_meta, title_from, Card, CardKind, Phase, Runner, StartKind,
    MAX_RESTARTS, META_REQUEST,
};
use crate::settings::{GITHUB_PAT, GITHUB_PAT_ENV};

/// A request to the agent host waiting for its reply.
#[derive(Debug)]
pub(crate) enum HostCall {
    Initialize,
    StartSession { session_id: String },
    EndSession,
    Prompt { session_id: String },
    Interrupt,
    StopTask,
    SetOption { session_id: String, option: SessionOption, value: String },
    ListModels { agent: String },
    GetUsage { session_id: String },
    ListCommands { session_id: String },
    ListPlugins { agent: String },
    PluginAction { agent: String, action: PluginAction, target: String },
    ListMcp { agent: String },
    McpAction { agent: String, action: McpAction, names: Vec<String> },
    /// A session's MCP status, asked for or answering a toggle.
    SessionMcp { session_id: String },
    CheckCredential { ticket: u64, agent: String, credential: String, value: agent_protocol::Secret },
    /// A provider profile's token check, for the save waiting on it.
    CheckProvider { ticket: u64 },
    /// A provider's model list, for the save waiting on it.
    ListProviderModels { ticket: u64 },
    /// An agent's profiles, for the save waiting on them when there is one.
    SetProviders { agent: String, save: Option<u64> },
    DeleteConversation(ConversationDelete),
}

/// The facts a `SessionEvent::Info` changed; absent = unchanged.
struct InfoUpdate {
    native_session_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    title: Option<String>,
    context_window: Option<u64>,
    context_percentage: Option<f64>,
}

/// A conversation of a deleted session, for its agent to delete.
#[derive(Debug, Clone)]
pub(crate) struct ConversationDelete {
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub conversation_id: String,
}

fn cancelled(kind: &CardKind, reason: &str) -> BridgeMessage {
    let reason = reason.to_string();
    match kind {
        CardKind::Permission { .. } => BridgeMessage::PermissionOutcome(SelectOutcome::Cancelled { reason }),
        CardKind::Plan { .. } => BridgeMessage::PlanOutcome(PlanOutcome::Cancelled { reason }),
        CardKind::Question { .. } => BridgeMessage::QuestionOutcome(QuestionOutcome::Cancelled { reason }),
    }
}

impl Engine {
    pub(super) fn run_ref(&self, session_id: &str) -> Option<&Runner> {
        self.sessions.get(session_id)?.run.as_ref()
    }

    pub(super) fn run_mut(&mut self, session_id: &str) -> Option<&mut Runner> {
        self.sessions.get_mut(session_id)?.run.as_mut()
    }

    /// The session runs in the host right now.
    pub(super) fn is_running(&self, session_id: &str) -> bool {
        self.run_ref(session_id).is_some_and(|r| r.started)
    }

    // --- the link ---

    /// Send a request; None when the host is down.
    pub(super) fn call(&mut self, call: HostCall, message: BridgeMessage) -> Option<String> {
        if !self.host.up {
            log::warn!("[Engine] The agent host is down — {call:?} not sent");
            return None;
        }
        self.host.next_id += 1;
        let id = format!("b{}", self.host.next_id);
        self.host.calls.insert(id.clone(), call);
        self.out.host(Some(id.clone()), message);
        Some(id)
    }

    /// Answer a host request (dropped when the host that asked is gone).
    fn reply(&mut self, host_id: String, message: BridgeMessage) {
        if self.host.up {
            self.out.host(Some(host_id), message);
        }
    }

    pub(super) fn on_host_up(&mut self) {
        log::info!("[Engine] Agent host up — initializing");
        self.host.up = true;
        self.host.initialized = false;
        let version = self.config.bridge_version.clone();
        self.call(HostCall::Initialize, BridgeMessage::Initialize { bridge_version: version });
    }

    pub(super) fn on_host_down(&mut self, reason: &str) {
        log::warn!("[Engine] Agent host down: {reason}");
        self.host.up = false;
        self.host.initialized = false;
        for call in std::mem::take(&mut self.host.calls).into_values() {
            if let HostCall::DeleteConversation(delete) = call {
                self.host.deletes.push(delete);
                continue;
            }
            // Session-bound requests die with the sessions, handled below.
            if !matches!(
                call,
                HostCall::Initialize
                    | HostCall::StartSession { .. }
                    | HostCall::Prompt { .. }
                    | HostCall::Interrupt
                    | HostCall::StopTask
                    | HostCall::EndSession
            ) {
                self.on_reply(call, Err("the agent host stopped".into()));
            }
        }
        let error = format!("The agent host stopped ({reason})");
        let running: Vec<String> =
            self.sessions.iter().filter(|(_, s)| s.run.as_ref().is_some_and(|r| r.started)).map(|(id, _)| id.clone()).collect();
        for id in running {
            self.on_agent_ended(&id, Some(error.clone()), false);
        }
    }

    pub(super) fn on_host_frame(&mut self, frame: HostFrame) {
        let HostFrame { id, message, .. } = frame;
        match id {
            None => match message {
                HostMessage::SessionEvent { session_id, event } => self.on_session_event(&session_id, event),
                _ => log::warn!("[Engine] The agent host sent a request or reply without an id — dropped"),
            },
            Some(id) if message.is_reply() => match self.host.calls.remove(&id) {
                Some(call) => {
                    let result = match message {
                        HostMessage::Error { message } => Err(message),
                        other => Ok(other),
                    };
                    self.on_reply(call, result);
                }
                None => log::warn!("[Engine] The agent host answered unknown request {id}"),
            },
            Some(id) => self.on_host_request(id, message),
        }
    }

    fn on_reply(&mut self, call: HostCall, result: Result<HostMessage, String>) {
        match call {
            HostCall::Initialize => match result {
                Ok(HostMessage::Initialized { host_version, agents }) => {
                    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
                    log::info!("[Engine] Agent host {host_version} ready: {}", ids.join(", "));
                    self.catalog.set(agents);
                    self.host.initialized = true;
                    self.list_dirty = true;
                    let waiting: Vec<String> = self
                        .sessions
                        .iter()
                        .filter(|(_, s)| s.run.as_ref().is_some_and(|r| !r.started))
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in waiting {
                        self.spawn(&id);
                    }
                    for delete in std::mem::take(&mut self.host.deletes) {
                        self.delete_conversation(delete);
                    }
                    self.push_all_providers();
                }
                Ok(_) => log::error!("[Engine] The agent host answered initialize with the wrong reply"),
                Err(err) => log::error!("[Engine] The agent host failed to initialize: {err}"),
            },
            HostCall::StartSession { session_id } => {
                if let Err(err) = result {
                    self.start_failed(&session_id, err);
                }
            }
            HostCall::Prompt { session_id } => {
                if let Err(err) = result {
                    log::warn!("[Engine] Input for {session_id} was refused: {err}");
                }
            }
            HostCall::Interrupt | HostCall::StopTask | HostCall::EndSession => {
                if let Err(err) = result {
                    log::warn!("[Engine] The agent host refused a request: {err}");
                }
            }
            HostCall::SetOption { session_id, option, value } => {
                self.on_option_reply(&session_id, option, value, result.map(|_| ()));
            }
            HostCall::ListModels { agent } => self.on_models_reply(agent, result),
            HostCall::GetUsage { session_id } => {
                if let Ok(HostMessage::Usage { usage: Some(usage) }) = result {
                    self.publish_all(BridgeToPhone::Usage(UsageMsg { session_id, usage }));
                }
            }
            HostCall::ListCommands { session_id } => self.on_commands_reply(session_id, result),
            HostCall::ListPlugins { agent } => self.on_plugins_reply(agent, result),
            HostCall::PluginAction { agent, action, target } => self.on_plugin_action_reply(agent, action, target, result),
            HostCall::ListMcp { agent } => self.on_mcp_reply(agent, result),
            HostCall::McpAction { agent, action, names } => self.on_mcp_action_reply(agent, action, names, result),
            HostCall::SessionMcp { session_id } => self.on_session_mcp_reply(session_id, result),
            HostCall::CheckCredential { ticket, agent, credential, value } => {
                let valid = match result {
                    Ok(HostMessage::CredentialChecked { valid }) => valid,
                    _ => None,
                };
                self.on_credential_checked(ticket, &agent, &credential, &value, valid);
            }
            HostCall::CheckProvider { ticket } => {
                let valid = match result {
                    Ok(HostMessage::CredentialChecked { valid }) => valid,
                    _ => None,
                };
                self.on_provider_token_checked(ticket, valid);
            }
            HostCall::ListProviderModels { ticket } => {
                let models = match result {
                    Ok(HostMessage::ProviderModels { models }) => Ok(models),
                    Ok(_) => Err("the agent host gave no model list".to_string()),
                    Err(err) => Err(err),
                };
                self.on_provider_models_fetched(ticket, models);
            }
            HostCall::SetProviders { agent, save } => {
                let refused = match result {
                    Ok(HostMessage::ProvidersSet { refused }) => Ok(refused),
                    Ok(_) => Err("the agent host answered with the wrong reply".to_string()),
                    Err(err) => Err(err),
                };
                self.on_providers_set(&agent, save, refused);
            }
            HostCall::DeleteConversation(delete) => match result {
                Ok(_) => log::info!("[Engine] Conversation {} of {} deleted", delete.conversation_id, delete.session_id),
                Err(err) => log::warn!(
                    "[Engine] Deleting conversation {} of {} failed: {err}",
                    delete.conversation_id,
                    delete.session_id
                ),
            },
        }
    }

    /// Ask the host to delete a deleted session's conversation, or keep the
    /// request until the host is back.
    pub(super) fn delete_conversation(&mut self, delete: ConversationDelete) {
        if !self.host.initialized {
            self.host.deletes.push(delete);
            return;
        }
        let message = BridgeMessage::DeleteConversation {
            session_id: delete.session_id.clone(),
            agent: delete.agent.clone(),
            cwd: delete.cwd.clone(),
            conversation_id: delete.conversation_id.clone(),
        };
        self.call(HostCall::DeleteConversation(delete), message);
    }

    fn on_option_reply(&mut self, session_id: &str, option: SessionOption, value: String, result: Result<(), String>) {
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let confirmed = match result {
            Ok(()) => {
                log::info!("[Engine] {option:?} set to {value} for {session_id}");
                let field = match option {
                    SessionOption::Mode => &mut session.rec.mode,
                    SessionOption::Effort => &mut session.rec.effort,
                    SessionOption::Model => &mut session.rec.model,
                };
                *field = Some(value.clone());
                self.registry_dirty |= session.listed;
                self.list_dirty = true;
                Some(value)
            }
            Err(err) => {
                log::warn!("[Engine] {option:?} '{value}' refused for {session_id}: {err}");
                // A refused mode confirms nothing (the phone keeps what it
                // knew); effort and model confirm the value still in force.
                match option {
                    SessionOption::Mode => None,
                    SessionOption::Effort => session.rec.effort.clone(),
                    SessionOption::Model => session.rec.model.clone(),
                }
            }
        };
        if let Some(value) = confirmed {
            self.publish_all(BridgeToPhone::OptionConfirmed(OptionConfirmedMsg {
                session_id: session_id.to_string(),
                option,
                value,
            }));
        }
    }

    /// An empty list answers with a reason rather than nothing, so the phone
    /// can tell "no answer yet" from a lost message and keeps asking.
    fn on_models_reply(&mut self, agent: String, result: Result<HostMessage, String>) {
        let name = self.catalog.get(&agent).map_or_else(|| agent.clone(), |a| a.display_name.clone());
        let (models, default_model, error) = match result {
            Ok(HostMessage::Models { models, default_model }) if !models.is_empty() => (models, default_model, None),
            Ok(HostMessage::Models { .. }) => (
                Vec::new(),
                None,
                Some(format!("{name} reported no models — check its sign-in or configuration on the bridge, then try again.")),
            ),
            Ok(_) => (Vec::new(), None, Some(format!("{name} gave no model list."))),
            Err(err) => (Vec::new(), None, Some(format!("Could not list {name}'s models: {err}"))),
        };
        if let Some(error) = &error {
            log::info!("[Engine] models-request: {error}");
        }
        self.publish_all(BridgeToPhone::Models(ModelsMsg { agent, models, default_model, error }));
    }

    /// Like `models`, an empty list goes out with the reason.
    fn on_commands_reply(&mut self, session_id: String, result: Result<HostMessage, String>) {
        let (commands, error) = match result {
            Ok(HostMessage::Commands { commands }) if !commands.is_empty() => (commands, None),
            Ok(HostMessage::Commands { .. }) => (Vec::new(), Some("The agent lists no slash commands for this session.".to_string())),
            Ok(_) => (Vec::new(), Some("The agent gave no command list.".to_string())),
            Err(err) => (Vec::new(), Some(format!("Could not list the session's commands: {err}"))),
        };
        if let Some(error) = &error {
            log::info!("[Engine] commands-request for {session_id}: {error}");
        }
        self.publish_all(BridgeToPhone::Commands(CommandsMsg { session_id, commands, error }));
    }

    fn on_plugins_reply(&mut self, agent: String, result: Result<HostMessage, String>) {
        let msg = match result {
            Ok(HostMessage::Plugins { installed, marketplaces, toggles, available, .. }) => {
                PluginsMsg { agent, installed, marketplaces, toggles, available, error: None }
            }
            Ok(_) => Self::plugins_error(agent, "The agent gave no plugin list.".into()),
            Err(err) => Self::plugins_error(agent, format!("Could not list the plugins: {err}")),
        };
        if let Some(error) = &msg.error {
            log::info!("[Engine] plugins-request: {error}");
        }
        self.publish_all(BridgeToPhone::Plugins(msg));
    }

    pub(super) fn plugins_error(agent: String, error: String) -> PluginsMsg {
        PluginsMsg { agent, installed: vec![], marketplaces: None, toggles: false, available: None, error: Some(error) }
    }

    /// A done action is acknowledged, then the new list goes out, so every
    /// phone showing the plugins sees the change. The resent list keeps the
    /// host's `available`: a marketplace change alters the catalog, and the
    /// phone would otherwise keep showing the old one. The host's `message`
    /// rides the ack, so the phone can show what was done (an update's
    /// versions) where it was asked.
    fn on_plugin_action_reply(
        &mut self,
        agent: String,
        action: PluginAction,
        target: String,
        result: Result<HostMessage, String>,
    ) {
        let (plugins, ack_message, error) = match result {
            Ok(HostMessage::Plugins { installed, marketplaces, toggles, available, message }) => {
                let plugins =
                    PluginsMsg { agent: agent.clone(), installed, marketplaces, toggles, available, error: None };
                (Some(plugins), message, None)
            }
            Ok(_) => (None, None, Some("The agent gave no answer to the change.".to_string())),
            Err(err) => (None, None, Some(err)),
        };
        match &error {
            Some(error) => log::info!("[Engine] plugin-action {action:?} {target}: {error}"),
            None => log::info!("[Engine] plugin-action {action:?} {target}: done"),
        }
        let success = error.is_none();
        self.publish_all(BridgeToPhone::PluginAck(PluginAckMsg {
            agent,
            action,
            target,
            success,
            error,
            message: ack_message.filter(|_| success),
        }));
        if let Some(plugins) = plugins {
            self.publish_all(BridgeToPhone::Plugins(plugins));
        }
    }

    // --- starting sessions ---

    /// Ask the host to run a session; while the host is not ready it waits
    /// and is started once it is.
    pub(super) fn spawn(&mut self, session_id: &str) {
        if !self.host.initialized {
            log::info!("[Engine] Session {session_id} waits for the agent host");
            return;
        }
        let params = match self.start_params(session_id) {
            Ok(params) => params,
            Err(reason) => return self.start_failed(session_id, reason),
        };
        let seq_high = self.seq_highs.get(session_id).copied().unwrap_or(0);
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let Some(run) = session.run.as_mut() else { return };
        if run.start_kind == StartKind::Resume && params.resume.is_none() {
            announce_fresh_start(session_id, &session.rec, seq_high);
        }
        run.started = true;
        let queued = std::mem::take(&mut run.queued);
        let read_head = !session.rec.committed && run.base_head.is_none();
        let cwd = session.rec.cwd.clone();
        self.call(
            HostCall::StartSession { session_id: session_id.to_string() },
            BridgeMessage::StartSession(Box::new(params)),
        );
        for text in queued {
            self.prompt(session_id, text);
        }
        if read_head {
            self.out.push(Effect::ReadGitHead { session_id: session_id.to_string(), cwd });
        }
    }

    fn start_params(&self, session_id: &str) -> Result<StartSession, String> {
        let session = self.sessions.get(session_id).ok_or("the session is gone")?;
        let run = session.run.as_ref().ok_or("the session is not running")?;
        let rec = &session.rec;
        self.catalog.usable(&rec.agent)?;
        // A bound profile is looked up now, at every start, so a rotated
        // token reaches restarts — and a deleted or insecure one refuses the
        // start instead of silently falling back to the agent's own account.
        let provider = rec.provider_id.as_deref().map(|id| self.provider_binding(id, &rec.agent)).transpose()?;
        let env = self
            .credentials
            .get(None, GITHUB_PAT)
            .map(|token| BTreeMap::from([(GITHUB_PAT_ENV.to_string(), token.clone())]))
            .unwrap_or_default();
        Ok(StartSession {
            session_id: session_id.to_string(),
            agent: rec.agent.clone(),
            cwd: rec.cwd.clone(),
            mode: rec.mode.clone(),
            effort: rec.effort.clone(),
            model: rec.model.clone(),
            // A new session starts a fresh conversation; a resumed or
            // restarted one continues the agent's, when it has one.
            resume: match run.start_kind {
                StartKind::Create => None,
                StartKind::Resume | StartKind::Restart => rec.native_session_id.clone(),
            },
            credentials: self.credentials.agents.get(&rec.agent).cloned().unwrap_or_default(),
            env,
            provider,
        })
    }

    fn start_failed(&mut self, session_id: &str, reason: String) {
        let Some(run) = self.run_ref(session_id) else { return };
        match (run.phase, run.start_kind) {
            (Phase::Pending, _) => self.fail_creation(session_id, &reason),
            (Phase::Ready, StartKind::Restart) => self.session_died(session_id, format!("Session restart failed: {reason}")),
            (Phase::Ready, _) => self.session_died(session_id, format!("Session could not be resumed: {reason}")),
        }
    }

    // --- what sessions report ---

    fn on_session_event(&mut self, session_id: &str, event: SessionEvent) {
        if !self.is_running(session_id) {
            log::debug!("[Engine] Event for {session_id}, which is not running — dropped");
            return;
        }
        match event {
            SessionEvent::Ready {} => self.on_ready(session_id),
            SessionEvent::Info { native_session_id, model, mode, title, context_window, context_percentage } => {
                let info = InfoUpdate { native_session_id, model, mode, title, context_window, context_percentage };
                self.on_info(session_id, info);
            }
            SessionEvent::Entries { entries } => self.on_entries(session_id, entries),
            SessionEvent::Turn { state } => {
                // The agent may repeat the state it is in; only a change is
                // worth a new session list.
                if let Some(run) = self.run_mut(session_id) {
                    if run.turn != state {
                        run.turn = state;
                        self.list_dirty = true;
                    }
                }
            }
            SessionEvent::Ended { error, resume_lost } => {
                if let Some(run) = self.run_mut(session_id) {
                    run.started = false;
                }
                self.on_agent_ended(session_id, error, resume_lost);
            }
        }
    }

    fn on_ready(&mut self, session_id: &str) {
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let Some(run) = session.run.as_mut() else { return };
        if run.phase != Phase::Pending {
            log::info!("[Engine] Session {session_id} is running");
            return;
        }
        run.phase = Phase::Ready;
        session.listed = true;
        self.registry_dirty = true;
        self.list_dirty = true;
        log::info!("[Engine] Session {session_id} ready");
        let info = self.remote_info(&self.sessions[session_id]);
        self.publish_all(BridgeToPhone::SessionReady(SessionReadyMsg { pending_id: session_id.to_string(), session: info }));
    }

    fn on_info(&mut self, session_id: &str, info: InfoUpdate) {
        let InfoUpdate { native_session_id, model, mode, title, context_window, context_percentage } = info;
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let title = title.and_then(|t| title_from(&t));
        if title.is_some() {
            if let Some(run) = session.run.as_mut() {
                run.agent_titled = true;
            }
        }
        let rec = &mut session.rec;
        let mut changed = false;
        let mut set = |field: &mut Option<String>, value: Option<String>| {
            if value.is_some() && *field != value {
                *field = value;
                changed = true;
            }
        };
        set(&mut rec.native_session_id, native_session_id);
        set(&mut rec.model, model);
        set(&mut rec.title, title);
        let mode_changed = mode.is_some() && rec.mode != mode;
        set(&mut rec.mode, mode.clone());
        if context_window.is_some_and(|w| w > 0) && rec.context_window != context_window {
            rec.context_window = context_window;
            changed = true;
        }
        if let Some(pct) = context_percentage.filter(|p| p.is_finite()) {
            let pct = pct.clamp(0.0, 100.0);
            if rec.context_percentage != Some(pct) {
                rec.context_percentage = Some(pct);
                changed = true;
            }
        }
        if changed {
            self.registry_dirty |= session.listed;
            self.list_dirty = true;
        }
        // The agent changed its own mode (entered plan mode, or a plan
        // approval switched it): the phone learns it like a set-option reply.
        if let (true, Some(value)) = (mode_changed, mode) {
            self.publish_all(BridgeToPhone::OptionConfirmed(OptionConfirmedMsg {
                session_id: session_id.to_string(),
                option: SessionOption::Mode,
                value,
            }));
        }
    }

    fn on_entries(&mut self, session_id: &str, entries: Vec<OutputEntry>) {
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let Some(run) = session.run.as_mut() else { return };
        let mut kept = Vec::with_capacity(entries.len());
        let mut commit_check = false;
        let mut meta_changed = false;
        for mut entry in entries {
            match &mut entry.body {
                // The agent echoing a message the bridge already wrote.
                EntryBody::Text { role: Role::User, text, .. } if run.take_echo(text) => continue,
                EntryBody::Text { role: Role::Agent, text, .. } => {
                    let (stripped, meta) = strip_session_meta(text);
                    if stripped != *text {
                        *text = stripped;
                        if let Some(meta) = meta.filter(|_| !run.summarized) {
                            run.summarized = true;
                            if let Some(topic) = meta.topic.filter(|_| !run.agent_titled) {
                                session.rec.title = Some(topic);
                            }
                            if let Some(project) = meta.project {
                                session.rec.project = project;
                            }
                            log::info!(
                                "[Engine] Session meta for {session_id}: topic={:?}, project={:?}",
                                session.rec.title,
                                session.rec.project
                            );
                            meta_changed = true;
                        }
                        if text.is_empty() {
                            continue;
                        }
                    }
                }
                EntryBody::ToolCall { kind: ToolKind::Execute, title, input, .. } => {
                    let command = input.as_deref().unwrap_or(title);
                    commit_check |= !session.rec.committed && runs_git_commit(command);
                }
                _ => {}
            }
            kept.push(entry);
        }
        if meta_changed {
            self.registry_dirty |= session.listed;
            self.list_dirty = true;
        }
        let cwd = session.rec.cwd.clone();
        self.append(session_id, kept);
        // The agent may just have committed: check now rather than at the
        // next poll.
        if commit_check {
            self.out.push(Effect::ReadGitHead { session_id: session_id.to_string(), cwd });
        }
    }

    // --- ending ---

    /// The agent stopped: normally (`error` None) or not.
    pub(super) fn on_agent_ended(&mut self, session_id: &str, error: Option<String>, resume_lost: bool) {
        let Some(run) = self.run_mut(session_id) else { return };
        run.started = false;
        if run.phase == Phase::Pending {
            let reason = error.unwrap_or_else(|| "the agent stopped before the session was ready".into());
            return self.fail_creation(session_id, &reason);
        }
        match error {
            None => {
                log::info!("[Engine] Session {session_id} ended");
                self.end_session(session_id);
            }
            Some(error) => self.restart_or_end(session_id, &error, resume_lost),
        }
    }

    fn restart_or_end(&mut self, session_id: &str, error: &str, resume_lost: bool) {
        log::warn!("[Engine] Session {session_id} stopped: {error}");
        let Some(run) = self.run_mut(session_id) else { return };
        if run.restarts >= MAX_RESTARTS {
            log::warn!("[Engine] Session {session_id} failed after {MAX_RESTARTS} restarts");
            // The drop travels with the notice that admits the memory loss.
            if resume_lost {
                self.drop_resume_target(session_id);
            }
            let text = if resume_lost {
                "Session ended: its conversation was missing and the restart attempts are used up. The transcript is preserved; reopening this session starts a fresh conversation in the same workspace, and the agent will not remember earlier turns."
            } else {
                "Session ended unexpectedly after multiple restart attempts."
            };
            return self.session_died(session_id, text.to_string());
        }
        run.restarts += 1;
        run.start_kind = StartKind::Restart;
        let attempt = run.restarts;
        log::info!("[Engine] Restarting session {session_id} (attempt {attempt}/{MAX_RESTARTS})");
        // Anything still waiting on the user belonged to the dead agent.
        self.cancel_cards(session_id, "Session restarted — please retry");
        if resume_lost {
            self.drop_resume_target(session_id);
        }
        self.list_dirty = true;
        let text = if resume_lost {
            format!("Session's conversation was missing — starting a fresh conversation in the same workspace (attempt {attempt}). The transcript is preserved, but the agent does not remember earlier turns.")
        } else {
            format!("Session interrupted — restarting (attempt {attempt})...")
        };
        let entry = self.entry(EntryBody::Notice { kind: NoticeKind::SessionRestart, text });
        self.append(session_id, vec![entry]);
        self.spawn(session_id);
    }

    /// The agent could not find the conversation to resume: forget it as the
    /// resume target so the next start is fresh, but keep the id — it is the
    /// only pointer to that conversation.
    fn drop_resume_target(&mut self, session_id: &str) {
        let Some(session) = self.sessions.get_mut(session_id) else { return };
        let Some(dropped) = session.rec.native_session_id.take() else { return };
        log::warn!(
            "[Engine] Conversation {dropped} of {session_id} is gone — the next start is fresh (kept as previousNativeSessionId)"
        );
        session.rec.previous_native_session_id = Some(dropped);
        self.registry_dirty |= session.listed;
    }

    fn session_died(&mut self, session_id: &str, text: String) {
        log::warn!("[Engine] Session {session_id}: {text}");
        let entry = self.entry(EntryBody::Notice { kind: NoticeKind::SessionDied, text });
        self.append(session_id, vec![entry]);
        self.end_session(session_id);
    }

    /// The session stops running; its record stays.
    fn end_session(&mut self, session_id: &str) {
        self.cancel_cards(session_id, "Session ended");
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.run = None;
        }
        self.list_dirty = true;
    }

    /// A session that never became ready: the phone's placeholder resolves
    /// to a failure with the reason, and the session is forgotten.
    fn fail_creation(&mut self, session_id: &str, reason: &str) {
        log::warn!("[Engine] Session {session_id} creation failed: {reason}");
        self.cancel_cards(session_id, "Session creation failed");
        let entry = self.entry(EntryBody::Notice {
            kind: NoticeKind::SessionFailed,
            text: format!("Session creation failed: {reason}"),
        });
        self.append(session_id, vec![entry]);
        self.sessions.remove(session_id);
        self.publish_all(BridgeToPhone::SessionFailed(SessionFailedMsg {
            pending_id: session_id.to_string(),
            reason: reason.to_string(),
        }));
    }

    /// Stop a session on purpose (phone close, shutdown): cancel its cards
    /// and tell the host. No `ended` follows.
    pub(super) fn close_runner(&mut self, session_id: &str, reason: &str) {
        let Some(run) = self.run_ref(session_id) else { return };
        let started = run.started;
        self.cancel_cards(session_id, reason);
        if started {
            self.call(HostCall::EndSession, BridgeMessage::EndSession { session_id: session_id.to_string() });
        }
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.run = None;
        }
        log::info!("[Engine] Session {session_id} closed");
    }

    // --- input ---

    /// User input for a session. While a question is pending, any input can
    /// only be its answer. Otherwise the bridge writes the user's transcript
    /// entry itself (agents do not reliably echo input) and hands the text
    /// to the agent — with a request for the session's topic appended to the
    /// first ordinary message. False when the session is not running.
    pub(super) fn send_input(&mut self, session_id: &str, text: String) -> bool {
        let Some(run) = self.run_ref(session_id) else { return false };
        if let Some(request_id) = run.active_question() {
            return self.answer_next_question(session_id, &request_id, text);
        }
        let now = self.now_iso();
        let Some(session) = self.sessions.get_mut(session_id) else { return false };
        let Some(run) = session.run.as_mut() else { return false };
        let typed = text.clone();
        let mut text = text;
        let title = title_from(&text);
        if session.rec.title.is_none() && title.is_some() {
            session.rec.title = title.clone();
            self.list_dirty = true;
        }
        // A slash command takes everything after its name as arguments, so
        // the request waits for the next ordinary message.
        if !run.meta_requested && title.is_some() && !is_slash_command(&text) {
            run.meta_requested = true;
            text.push_str(META_REQUEST);
        }
        // What an echo would carry is what the agent received, suffix included.
        run.remember_authored(&text);
        let started = run.started;
        if !started {
            run.queued.push(text.clone());
        }
        self.registry_dirty |= session.listed;
        let entry = OutputEntry::new(now, EntryBody::Text { role: Role::User, text: typed });
        // Before the prompt, so the user's entry precedes the reply.
        self.append(session_id, vec![entry]);
        if started {
            self.prompt(session_id, text);
        }
        true
    }

    fn prompt(&mut self, session_id: &str, text: String) {
        self.call(
            HostCall::Prompt { session_id: session_id.to_string() },
            BridgeMessage::Prompt { session_id: session_id.to_string(), text },
        );
    }

    pub(super) fn interrupt(&mut self, session_id: &str) {
        let Some(run) = self.run_ref(session_id) else { return };
        log::info!("[Engine] Interrupting session {session_id}");
        if run.started {
            self.call(HostCall::Interrupt, BridgeMessage::Interrupt { session_id: session_id.to_string() });
        }
        self.cancel_cards(session_id, "Interrupted by user");
        self.list_dirty = true;
    }

    /// Stop one background task; the agent's next entry for it says so.
    pub(super) fn stop_task(&mut self, session_id: &str, task_id: &str) {
        if !self.is_running(session_id) {
            return;
        }
        log::info!("[Engine] Stopping task {task_id} of session {session_id}");
        self.call(
            HostCall::StopTask,
            BridgeMessage::StopTask { session_id: session_id.to_string(), task_id: task_id.to_string() },
        );
    }

    // --- cards ---

    fn on_host_request(&mut self, host_id: String, message: HostMessage) {
        match message {
            HostMessage::RequestPermission(req) => {
                if !self.is_running(&req.session_id) {
                    return self.reply(host_id, cancelled(&CardKind::Permission { options: vec![] }, "the session is not running"));
                }
                log::info!("[Engine] Waiting on approval: {} ({}) in {}", req.tool_name, req.request_id, req.session_id);
                let mut entry = self.entry(EntryBody::PermissionRequest {
                    request_id: req.request_id.clone(),
                    tool_name: req.tool_name,
                    kind: req.kind,
                    title: req.title,
                    description: req.description,
                    locations: req.locations,
                    raw_input: req.raw_input,
                    options: req.options.clone(),
                    reason: req.reason,
                    hook: req.hook,
                    hook_plugin: req.hook_plugin,
                });
                entry.subagent = req.subagent;
                let kind = CardKind::Permission { options: req.options };
                self.open_card(&req.session_id, &req.request_id, host_id, kind, vec![entry]);
            }
            HostMessage::AskQuestion(req) => {
                let kind = CardKind::Question { questions: vec![], answers: BTreeMap::new() };
                if !self.is_running(&req.session_id) {
                    return self.reply(host_id, cancelled(&kind, "the session is not running"));
                }
                if req.questions.is_empty() {
                    return self.reply(host_id, BridgeMessage::QuestionOutcome(QuestionOutcome::Answered { answers: vec![] }));
                }
                log::info!("[Engine] Waiting on an answer: {} in {}", req.request_id, req.session_id);
                let count = req.questions.len() as u32;
                let entries = req
                    .questions
                    .iter()
                    .enumerate()
                    .map(|(i, q)| {
                        self.entry(EntryBody::Question {
                            request_id: req.request_id.clone(),
                            index: i as u32,
                            count,
                            header: q.header.clone(),
                            question: q.question.clone(),
                            options: q.options.clone(),
                            multi_select: q.multi_select,
                        })
                    })
                    .collect();
                let kind = CardKind::Question { questions: req.questions, answers: BTreeMap::new() };
                self.open_card(&req.session_id, &req.request_id, host_id, kind, entries);
            }
            HostMessage::RequestPlanApproval(req) => {
                if !self.is_running(&req.session_id) {
                    return self.reply(host_id, cancelled(&CardKind::Plan { options: vec![], revise: None }, "the session is not running"));
                }
                log::info!("[Engine] Waiting on plan approval: {} in {}", req.request_id, req.session_id);
                // A `revise` that names none of the options would offer a
                // feedback box no choice can carry: the card has none then.
                let revise = req.revise.filter(|id| req.options.iter().any(|o| &o.id == id));
                let entry = self.entry(EntryBody::PlanApproval {
                    request_id: req.request_id.clone(),
                    options: req.options.clone(),
                    revise: revise.clone(),
                });
                let kind = CardKind::Plan { options: req.options, revise };
                self.open_card(&req.session_id, &req.request_id, host_id, kind, vec![entry]);
            }
            _ => log::warn!("[Engine] The agent host sent a reply kind as a request — dropped"),
        }
    }

    fn open_card(&mut self, session_id: &str, request_id: &str, host_id: String, kind: CardKind, entries: Vec<OutputEntry>) {
        let timer = self.out.set_timer(
            self.config.card_timeout_ms,
            TimerKind::Card { session_id: session_id.to_string(), request_id: request_id.to_string() },
        );
        let Some(run) = self.run_mut(session_id) else { return };
        run.card_seq += 1;
        let card = Card { host_id, kind, timer, order: run.card_seq };
        if let Some(old) = run.cards.insert(request_id.to_string(), card) {
            log::warn!("[Engine] Request {request_id} in {session_id} asked again — the earlier one is replaced");
            self.out.cancel_timer(old.timer);
            self.reply(old.host_id, cancelled(&old.kind, "asked again"));
        }
        self.append(session_id, entries);
        self.list_dirty = true;
    }

    /// Answer a card and close it with a `resolved` entry.
    pub(super) fn close_card(&mut self, session_id: &str, request_id: &str, answer: BridgeMessage, summary: &str) {
        let Some(card) = self.run_mut(session_id).and_then(|r| r.cards.remove(request_id)) else { return };
        self.out.cancel_timer(card.timer);
        self.reply(card.host_id, answer);
        let entry = self.entry(EntryBody::Resolved { request_id: request_id.to_string(), summary: summary.to_string() });
        self.append(session_id, vec![entry]);
        self.list_dirty = true;
    }

    /// Cancel every card of a session, oldest first.
    fn cancel_cards(&mut self, session_id: &str, reason: &str) {
        let Some(run) = self.run_ref(session_id) else { return };
        let mut ids: Vec<(u64, String)> = run.cards.iter().map(|(id, c)| (c.order, id.clone())).collect();
        ids.sort();
        for (_, request_id) in ids {
            let Some(kind) = self.run_ref(session_id).and_then(|r| r.cards.get(&request_id)).map(|c| cancelled(&c.kind, reason)) else {
                continue;
            };
            self.close_card(session_id, &request_id, kind, reason);
        }
    }

    pub(super) fn card_timed_out(&mut self, session_id: &str, request_id: &str) {
        let Some(answer) = self.run_ref(session_id).and_then(|r| r.cards.get(request_id)).map(|c| cancelled(&c.kind, "timed out")) else {
            return;
        };
        log::info!("[Engine] Request {request_id} in {session_id} timed out");
        self.close_card(session_id, request_id, answer, "Timed out");
    }

    /// Record the answer to question `index`; the ask resolves once every
    /// question has one. False when there is no such pending question.
    pub(super) fn answer_question(&mut self, session_id: &str, request_id: &str, index: u32, answer: String) -> bool {
        let Some(card) = self.run_mut(session_id).and_then(|r| r.cards.get_mut(request_id)) else { return false };
        let CardKind::Question { questions, answers } = &mut card.kind else { return false };
        if index as usize >= questions.len() {
            return false;
        }
        answers.insert(index, answer);
        if answers.len() < questions.len() {
            return true;
        }
        let answers: Vec<String> = answers.values().cloned().collect();
        let summary = answers.join(" · ");
        self.close_card(
            session_id,
            request_id,
            BridgeMessage::QuestionOutcome(QuestionOutcome::Answered { answers }),
            &summary,
        );
        true
    }

    /// Free text answers the first unanswered question of the active ask.
    fn answer_next_question(&mut self, session_id: &str, request_id: &str, text: String) -> bool {
        let index = self
            .run_ref(session_id)
            .and_then(|r| r.cards.get(request_id))
            .and_then(|c| match &c.kind {
                CardKind::Question { questions, answers } => {
                    (0..questions.len() as u32).find(|i| !answers.contains_key(i))
                }
                _ => None,
            })
            .unwrap_or(0);
        self.answer_question(session_id, request_id, index, text)
    }
}

/// A resumed session with no conversation to continue. Two cases read very
/// differently and the log must not confuse them: a session that never ran
/// a turn (nothing to lose), and one whose history exists but whose
/// conversation is gone (the agent starts over without its memory).
fn announce_fresh_start(session_id: &str, rec: &crate::registry::SessionRecord, seq_high: u64) {
    if seq_high == 0 {
        log::info!("[Engine] Session {session_id} has no conversation yet (never ran a turn) — starting fresh in {}", rec.cwd);
    } else {
        let dropped = rec.previous_native_session_id.as_ref().map(|id| format!(" (dropped {id})")).unwrap_or_default();
        log::warn!(
            "[Engine] Session {session_id} has {seq_high} transcript entries but no resumable conversation{dropped} — starting a FRESH conversation in {}; the agent does not remember earlier turns",
            rec.cwd
        );
    }
}
