//! Narrowed, hand-mapped view DTOs for the Android FFI surface — the same
//! disclosed-narrowing precedent `intent.rs`'s `UniffiIntent` already set.
//! UniFFI's `Record` derive needs concrete, homogeneously-typed fields, but
//! several real view types either carry arbitrary JSON
//! (`TranscriptRowView.entry` is `serde_json::Value` — `OutputEntry.metadata`
//! is genuinely untyped bridge-supplied JSON) or fields no Android screen has
//! a use for yet. The part of `UiView` this surface needs IS projected: the
//! credentials/provider-profile status maps — see
//! `UniffiCredentialsAck`/`UniffiProviderProfileAck` below — and the undo
//! toast + unread set — see `UniffiUndoToast`/`UniffiUiView.unread_sessions`.
//! Rather
//! than deriving `uniffi::Record` on those real types
//! — which would drag every transitive field into the FFI surface whether a
//! screen exists for it or not — this module hand-builds a small,
//! Android-specific projection of each, grown as screens need more of it, never widened "just in case" the way `UniffiIntent`'s own doc
//! comment already commits to for the intent side.
//!
//! `TranscriptRowsView`'s crossing goes one step further: `client_core`'s
//! `presentation::display_entries` module (already a complete, already-tested
//! port of `apps/mobile/src/ui/transcript/displayEntries.ts` — grouping,
//! answered-state detection, the pending-permission finder — but unwired
//! into any view until now) computes the *grouped* rows here, once, so
//! Android never re-implements that algorithm. The grouped list and the
//! pending-permission summary cross as JSON strings (`serde_json::to_string`)
//! for the same untyped-metadata reason individual rows already needed to;
//! Kotlin's `DisplayEntries.kt` is a `kotlinx.serialization` sealed-class
//! mirror + a `Json.decodeFromString` call, not a second implementation of
//! the grouping logic.

use std::collections::{BTreeSet, HashMap};

use client_runtime::client_core::notifications::session_key_of;
use client_runtime::client_core::stores::machines::{AgentActionState, AgentMcp, AgentPlugins, SessionMcp};
use client_runtime::client_core::presentation::activity::build_activity;
use client_runtime::client_core::presentation::display_entries::{
    build_display_entries, find_pending_permission, DisplayEntry, SeqEntry,
};
use client_runtime::{
    MachinesView, OutboxView, PairingView, PendingSessionsView, QuickPromptsView, SettingsView,
    TranscriptRowsView, UiView,
};
use client_runtime::view::TranscriptSyncView;
use protocol::common::{
    AgentDescriptor, AgentInstall, CredentialStatus, GsdAction, GsdExecution, GsdPhase, GsdState, OptionChoice,
    UsageData, UsageWindow,
};
use serde::Deserialize;

/// Renders any `Copy` wire enum (all `#[serde(rename_all = ...)]`, no data)
/// to its exact wire spelling by reusing the real `Serialize` impl, the same
/// way `intent.rs`'s `parse_enum` reuses the real `Deserialize` impl instead
/// of hand-duplicating a match per enum.
fn wire_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_string))
        .unwrap_or_default()
}

// --- machines / sessions -------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSessionSummary {
    pub id: String,
    pub title: Option<String>,
    pub slug: String,
    pub cwd: String,
    pub project: String,
    /// `idle` / `running` / `waiting_permission` / `waiting_question` /
    /// `offline` (`SessionState`'s own `snake_case` wire spelling), absent if
    /// the bridge never reported one.
    pub state: Option<String>,
    /// `live` / `stale` / `offline` — the machines store's own listing presence.
    pub presence: String,
    pub last_activity: String,
    /// The agent the session runs on (`UniffiAgent.id`).
    pub agent: String,
    pub model: Option<String>,
    /// Agent-defined mode / effort ids (see the agent's `modes` / `efforts`).
    pub mode: Option<String>,
    pub effort: Option<String>,
    pub context_percentage: Option<f64>,
    pub context_window: Option<u64>,
    pub committed: Option<bool>,
    pub seq_high: Option<u64>,
    /// The provider profile the session is bound to, when it is: the
    /// session runs on that profile's models, not the agent's own list.
    #[uniffi(default = None)]
    pub provider_id: Option<String>,
    /// Usage snapshot (5h/7d limits, cost) — requested via
    /// `UniffiIntent::RequestUsage`, absent until the bridge answers.
    pub usage: Option<UniffiUsageData>,
    /// GSD workflow state — requested via `UniffiIntent::RequestGsd`,
    /// absent until the bridge answers.
    pub gsd: Option<UniffiGsdState>,
    /// Slash commands — requested via `UniffiIntent::RequestCommands`,
    /// absent until the bridge answers.
    pub commands: Option<UniffiSessionCommands>,
    /// MCP servers — requested via `UniffiIntent::RequestSessionMcp`,
    /// absent until the bridge answers.
    pub mcp: Option<UniffiSessionMcp>,
}

/// One MCP server of a running session. `status` is the wire's word:
/// `connected`, `pending`, `failed`, `needs-auth` or `disabled`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSessionMcpServer {
    pub name: String,
    pub status: String,
    pub error: Option<String>,
    pub tools: Option<u32>,
}

/// A running session's MCP servers.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSessionMcp {
    pub servers: Vec<UniffiSessionMcpServer>,
    /// A server can be switched in this session.
    pub toggles: bool,
    /// A switch applies to every session of the agent in the same project.
    pub project_wide: bool,
    /// Why the last request got no answer (the servers held are kept).
    pub error: Option<String>,
    /// Servers switched and not answered yet.
    pub busy: Vec<String>,
}

fn to_uniffi_session_mcp(m: &SessionMcp) -> UniffiSessionMcp {
    UniffiSessionMcp {
        servers: m
            .servers
            .iter()
            .map(|s| UniffiSessionMcpServer {
                name: s.name.clone(),
                status: wire_str(&s.status),
                error: s.error.clone(),
                tools: s.tools,
            })
            .collect(),
        toggles: m.toggles,
        project_wide: m.project_wide,
        error: m.error.clone(),
        busy: m.busy.clone(),
    }
}

/// One slash command a session understands; typed as `/name` then its
/// arguments.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
}

/// A session's slash commands as its agent last listed them, and why the
/// last request got none (the list held before is kept).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSessionCommands {
    pub commands: Vec<UniffiSlashCommand>,
    pub error: Option<String>,
}

/// One usage-limit window — mirrors `protocol::common::UsageWindow` field for
/// field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUsageWindow {
    /// e.g. "5h", "7d".
    pub label: String,
    /// Percentage 0..=100, not a fraction — the wire carries it pre-scaled
    /// (the reference's usage badges round it directly and warn at 75/90).
    /// `None` when the bridge has no number.
    pub utilization: Option<f64>,
    /// When the window resets (the wire's own timestamp spelling).
    pub resets_at: Option<String>,
}

/// A session's usage snapshot — mirrors `protocol::common::UsageData` field
/// for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUsageData {
    pub available: bool,
    pub plan: Option<String>,
    pub windows: Vec<UniffiUsageWindow>,
    pub session_cost_usd: Option<f64>,
    pub fetched_at: String,
}

/// One GSD workflow phase — mirrors `protocol::common::GsdPhase` field for
/// field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdPhase {
    pub number: String,
    pub name: String,
    pub disk_status: String,
    pub plans: u64,
    pub summaries: u64,
    pub recently_touched: bool,
    pub action: Option<String>,
    pub command: Option<String>,
    pub plan_count: Option<i64>,
    pub needs_you: Option<i64>,
}

/// GSD's in-flight execution line — mirrors `protocol::common::GsdExecution`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdExecution {
    pub phase: String,
    pub plans_total: u64,
    pub plans_done: u64,
    pub current_plan: Option<String>,
    pub tasks_done: u64,
    pub tasks_total: Option<i64>,
    pub last_task: Option<String>,
}

/// One GSD recovery/action chip — mirrors `protocol::common::GsdAction`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdAction {
    pub id: String,
    pub label: String,
    pub command: String,
    pub recommended: bool,
}

/// A session's GSD workflow state — mirrors `protocol::common::GsdState`
/// field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiGsdState {
    pub installed: bool,
    pub available: bool,
    pub has_git: bool,
    pub situation: String,
    pub summary: String,
    pub milestone: Option<String>,
    pub current_phase: Option<String>,
    pub total_phases: Option<i64>,
    pub percent: f64,
    pub phases: Vec<UniffiGsdPhase>,
    pub actions: Vec<UniffiGsdAction>,
    pub recommended: Option<String>,
    pub paused: bool,
    pub blockers: Vec<String>,
    pub verify_failed: bool,
    pub execution: Option<UniffiGsdExecution>,
}

fn to_uniffi_usage_window(w: &UsageWindow) -> UniffiUsageWindow {
    UniffiUsageWindow {
        label: w.label.clone(),
        utilization: w.utilization,
        resets_at: w.resets_at.clone(),
    }
}

fn to_uniffi_usage_data(u: &UsageData) -> UniffiUsageData {
    UniffiUsageData {
        available: u.available,
        plan: u.plan.clone(),
        windows: u.windows.iter().map(to_uniffi_usage_window).collect(),
        session_cost_usd: u.session_cost_usd,
        fetched_at: u.fetched_at.clone(),
    }
}

fn to_uniffi_gsd_phase(p: &GsdPhase) -> UniffiGsdPhase {
    UniffiGsdPhase {
        number: p.number.clone(),
        name: p.name.clone(),
        disk_status: p.disk_status.clone(),
        plans: p.plans,
        summaries: p.summaries,
        recently_touched: p.recently_touched,
        action: p.action.clone(),
        command: p.command.clone(),
        plan_count: p.plan_count,
        needs_you: p.needs_you,
    }
}

fn to_uniffi_gsd_execution(e: &GsdExecution) -> UniffiGsdExecution {
    UniffiGsdExecution {
        phase: e.phase.clone(),
        plans_total: e.plans_total,
        plans_done: e.plans_done,
        current_plan: e.current_plan.clone(),
        tasks_done: e.tasks_done,
        tasks_total: e.tasks_total,
        last_task: e.last_task.clone(),
    }
}

fn to_uniffi_gsd_action(a: &GsdAction) -> UniffiGsdAction {
    UniffiGsdAction {
        id: a.id.clone(),
        label: a.label.clone(),
        command: a.command.clone(),
        recommended: a.recommended,
    }
}

fn to_uniffi_gsd_state(g: &GsdState) -> UniffiGsdState {
    UniffiGsdState {
        installed: g.installed,
        available: g.available,
        has_git: g.has_git,
        situation: g.situation.clone(),
        summary: g.summary.clone(),
        milestone: g.milestone.clone(),
        current_phase: g.current_phase.clone(),
        total_phases: g.total_phases,
        percent: g.percent,
        phases: g.phases.iter().map(to_uniffi_gsd_phase).collect(),
        actions: g.actions.iter().map(to_uniffi_gsd_action).collect(),
        recommended: g.recommended.clone(),
        paused: g.paused,
        blockers: g.blockers.clone(),
        verify_failed: g.verify_failed,
        execution: g.execution.as_ref().map(to_uniffi_gsd_execution),
    }
}

/// One selectable model, as reported by either backend's live SDK
/// (`MachineView.models`/`open_code_models`) or a custom provider profile's
/// own list (`ProviderProfileInfo.models`) — the same shape in every case,
/// so one record covers all three.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiModelEntry {
    pub id: String,
    pub label: Option<String>,
    /// Who serves the model, when the agent says.
    pub provider: Option<String>,
    /// How many tokens the model takes in, when known.
    pub context_window: Option<u32>,
    /// The model's own reasoning levels, for an agent whose levels differ by
    /// model; empty: the agent's.
    pub efforts: Vec<UniffiOptionChoice>,
}

fn to_uniffi_model_entries(models: &[protocol::events::ModelEntry]) -> Vec<UniffiModelEntry> {
    models
        .iter()
        .map(|m| UniffiModelEntry {
            id: m.id.clone(),
            label: m.label.clone(),
            provider: m.provider.clone(),
            context_window: None,
            efforts: m.efforts.iter().map(to_uniffi_option_choice).collect(),
        })
        .collect()
}

/// A provider profile's model, grouped under the profile — and under the
/// provider a gateway routes it to, when the endpoint names one, the same
/// group the agent's own list shows it under. Unnamed, it goes by its id
/// without that provider, which the group already shows.
fn to_uniffi_profile_model(profile: &str, m: &protocol::common::ProviderModel) -> UniffiModelEntry {
    let upstream = m.provider.as_deref().filter(|p| !p.is_empty());
    let label = m.label.clone().or_else(|| {
        upstream.and_then(|p| m.id.strip_prefix(p)).and_then(|rest| rest.strip_prefix('/')).map(str::to_string)
    });
    UniffiModelEntry {
        id: m.id.clone(),
        label,
        provider: Some(match upstream {
            Some(p) => format!("{profile} · {p}"),
            None => profile.to_string(),
        }),
        context_window: m.context_window,
        efforts: Vec::new(),
    }
}

/// A custom AI provider profile the bridge has stored. Which agent uses it,
/// and how, is that agent's catalog entry (`supports.providers` /
/// `supports.providerModels`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderProfileInfo {
    pub id: String,
    /// The agent the profile is for; empty for one stored before profiles
    /// had one, which no agent uses until it is given one.
    pub agent: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<UniffiModelEntry>,
    /// The models are the provider's own list.
    pub models_from_provider: bool,
    pub default_model: Option<String>,
    pub has_token: bool,
    /// Why the agent does not offer this profile's models, when it does not.
    pub error: Option<String>,
}

/// One selectable value of an agent option (a mode, an effort level, a plan
/// approval choice).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiOptionChoice {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

/// A credential's status — the secret itself never crosses.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiCredentialStatus {
    pub id: String,
    pub label: String,
    pub present: bool,
    pub from_env: bool,
    pub valid: Option<bool>,
}

/// An agent backend a bridge advertises (`protocol::common::AgentDescriptor`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAgent {
    pub id: String,
    pub display_name: String,
    pub modes: Vec<UniffiOptionChoice>,
    pub efforts: Vec<UniffiOptionChoice>,
    pub default_mode: Option<String>,
    /// The effort a session runs at when none is chosen.
    pub default_effort: Option<String>,
    pub supports_models: bool,
    pub supports_usage: bool,
    pub supports_providers: bool,
    /// The agent's provider profiles add models to its own list.
    pub supports_provider_models: bool,
    pub supports_gsd: bool,
    pub supports_interrupt: bool,
    pub supports_commands: bool,
    pub supports_plugins: bool,
    pub supports_mcp: bool,
    /// Sessions report background tasks, and `StopTask` stops one.
    pub supports_tasks: bool,
    pub credentials: Vec<UniffiCredentialStatus>,
    /// `ready` / `not_installed` / `installing` / `failed`; sessions start
    /// only on a `ready` agent.
    pub install_state: String,
    /// CodeDeck installed it and can remove it (only while `ready`).
    pub removable: bool,
    /// Why the install failed (only while `failed`).
    pub install_error: Option<String>,
    /// `install` / `remove`: asked of the bridge and not acknowledged yet.
    pub action_busy: Option<String>,
    /// Why the bridge refused the last install or removal.
    pub action_failure: Option<String>,
}

/// One agent's live model list on a machine.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAgentModels {
    pub agent: String,
    pub models: Vec<UniffiModelEntry>,
    pub default_model: Option<String>,
    /// The bridge's reason for its latest empty answer.
    pub error: Option<String>,
}

pub fn to_uniffi_option_choice(c: &OptionChoice) -> UniffiOptionChoice {
    UniffiOptionChoice {
        id: c.id.clone(),
        label: c.label.clone(),
        description: c.description.clone(),
    }
}

fn to_uniffi_credential_status(c: &CredentialStatus) -> UniffiCredentialStatus {
    UniffiCredentialStatus {
        id: c.id.clone(),
        label: c.label.clone(),
        present: c.present,
        from_env: c.from_env,
        valid: c.valid,
    }
}

fn to_uniffi_agent(a: &AgentDescriptor, action: Option<&AgentActionState>) -> UniffiAgent {
    let (install_state, removable, install_error) = match &a.install {
        AgentInstall::Ready { removable } => ("ready", *removable, None),
        AgentInstall::NotInstalled {} => ("not_installed", false, None),
        AgentInstall::Installing {} => ("installing", false, None),
        AgentInstall::Failed { reason } => ("failed", false, Some(reason.clone())),
    };
    UniffiAgent {
        id: a.id.clone(),
        display_name: a.display_name.clone(),
        modes: a.modes.iter().map(to_uniffi_option_choice).collect(),
        efforts: a.efforts.iter().map(to_uniffi_option_choice).collect(),
        default_mode: a.default_mode.clone(),
        default_effort: a.default_effort.clone(),
        supports_models: a.supports.models,
        supports_usage: a.supports.usage,
        supports_providers: a.supports.providers,
        supports_provider_models: a.supports.provider_models,
        supports_gsd: a.supports.gsd,
        supports_interrupt: a.supports.interrupt,
        supports_commands: a.supports.commands,
        supports_plugins: a.supports.plugins,
        supports_mcp: a.supports.mcp,
        supports_tasks: a.supports.tasks,
        credentials: a.credentials.iter().map(to_uniffi_credential_status).collect(),
        install_state: install_state.into(),
        removable,
        install_error,
        action_busy: action.and_then(|s| s.busy.as_ref()).map(wire_str),
        action_failure: action.and_then(|s| s.failure.clone()),
    }
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMachineSummary {
    pub pubkey_hex: String,
    pub name: String,
    pub host: Option<String>,
    pub sessions: Vec<UniffiSessionSummary>,
    /// Bridge heartbeat capability strings (e.g. `"files"`).
    pub capabilities: Vec<String>,
    pub folders: Vec<String>,
    pub roots: Vec<String>,
    /// The agents this bridge can run sessions on, in its own order.
    pub agents: Vec<UniffiAgent>,
    /// The bridge's own credentials (not tied to an agent).
    pub credentials: Vec<UniffiCredentialStatus>,
    /// Live model lists, one entry per agent that has answered `RequestModels`.
    pub models: Vec<UniffiAgentModels>,
    pub provider_profiles: Vec<UniffiProviderProfileInfo>,
    /// Plugins, one entry per agent that has answered `RequestPlugins`.
    pub plugins: Vec<UniffiAgentPlugins>,
    /// MCP servers, one entry per agent that has answered `RequestMcp`.
    pub mcp: Vec<UniffiAgentMcp>,
    /// The direct endpoints the bridge advertises, in its order.
    pub direct_advertised: Vec<String>,
    /// Whether the bridge advertised a certificate pin (without one no
    /// `wss://` endpoint is dialled).
    pub direct_pinned: bool,
    /// The direct endpoints the user added, tried after the advertised ones.
    pub direct_endpoints: Vec<String>,
    /// The endpoint the direct link is up on; `None` means the relays.
    pub direct_up: Option<String>,
    /// The bridge's npub (its pubkey in the form users see).
    pub npub: String,
    /// The relays this machine is reached over.
    pub relays: Vec<String>,
    /// When its last heartbeat arrived (ms), if one has since this start.
    pub last_heartbeat_at: Option<u64>,
    /// The bridge said it is shutting down, or none of its heartbeats has
    /// arrived since this start.
    pub machine_offline: bool,
    /// The agent new sessions start on; `None`: the bridge's first.
    pub default_agent: Option<String>,
    /// What each agent's new sessions start with.
    pub agent_defaults: Vec<UniffiAgentDefaults>,
}

/// A plugin installed for an agent on a machine.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiInstalledPlugin {
    /// What `UniffiIntent::PluginAction` names it by.
    pub id: String,
    pub name: String,
    pub marketplace: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
}

/// A plugin a marketplace offers that is not installed.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAvailablePlugin {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub description: Option<String>,
    pub install_count: Option<u64>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPluginMarketplace {
    pub name: String,
    /// `owner/repo`, a URL or a path.
    pub source: String,
}

/// The last plugin change that failed: its action's wire name, its target,
/// and why.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPluginFailure {
    pub action: String,
    pub target: String,
    pub error: String,
}

/// What the last plugin change that succeeded reported: its action's wire
/// name, its target, and the agent's words.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPluginNotice {
    pub action: String,
    pub target: String,
    pub message: String,
}

/// One agent's plugins on a machine.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAgentPlugins {
    pub agent: String,
    pub installed: Vec<UniffiInstalledPlugin>,
    /// `None`: plugins are installed by package name, from no marketplace.
    pub marketplaces: Option<Vec<UniffiPluginMarketplace>>,
    /// A plugin can be switched off without uninstalling it.
    pub toggles: bool,
    /// What the marketplaces offer, once asked for with `available`.
    pub available: Option<Vec<UniffiAvailablePlugin>>,
    /// Why the last list could not be read (the lists held are kept).
    pub error: Option<String>,
    /// Targets of changes sent and not acknowledged yet.
    pub busy: Vec<String>,
    /// What the last change that succeeded reported, in the agent's words
    /// (e.g. an update's from/to versions); cleared when the next change is
    /// sent.
    pub notice: Option<UniffiPluginNotice>,
    pub failure: Option<UniffiPluginFailure>,
}

fn to_uniffi_agent_plugins(agent: &str, p: &AgentPlugins) -> UniffiAgentPlugins {
    UniffiAgentPlugins {
        agent: agent.to_string(),
        installed: p
            .installed
            .iter()
            .map(|i| UniffiInstalledPlugin {
                id: i.id.clone(),
                name: i.name.clone(),
                marketplace: i.marketplace.clone(),
                version: i.version.clone(),
                description: i.description.clone(),
                enabled: i.enabled,
            })
            .collect(),
        marketplaces: p.marketplaces.as_ref().map(|list| {
            list.iter()
                .map(|m| UniffiPluginMarketplace { name: m.name.clone(), source: m.source.clone() })
                .collect()
        }),
        toggles: p.toggles,
        available: p.available.as_ref().map(|list| {
            list.iter()
                .map(|a| UniffiAvailablePlugin {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    marketplace: a.marketplace.clone(),
                    description: a.description.clone(),
                    install_count: a.install_count,
                })
                .collect()
        }),
        error: p.error.clone(),
        busy: p.busy.clone(),
        notice: p.notice.as_ref().map(|n| UniffiPluginNotice {
            action: wire_str(&n.action),
            target: n.target.clone(),
            message: n.message.clone(),
        }),
        failure: p.failure.as_ref().map(|f| UniffiPluginFailure {
            action: wire_str(&f.action),
            target: f.target.clone(),
            error: f.error.clone(),
        }),
    }
}

/// An MCP server configured for an agent on a machine — never its secrets:
/// `target` is a stdio server's program or a remote one's URL without its
/// query or user info, and env variables and headers are named only.
/// `transport` is `stdio`, `http` or `sse`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMcpServer {
    pub name: String,
    pub transport: String,
    pub target: String,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub enabled: bool,
}

/// The last MCP change that failed: its action's wire name, the servers it
/// named, and why.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMcpFailure {
    pub action: String,
    pub names: Vec<String>,
    pub error: String,
}

/// One agent's MCP servers on a machine.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAgentMcp {
    pub agent: String,
    pub servers: Vec<UniffiMcpServer>,
    /// A server can be switched off without removing it.
    pub toggles: bool,
    /// Why the last list could not be read (the list held is kept).
    pub error: Option<String>,
    /// Names of servers changed and not acknowledged yet.
    pub busy: Vec<String>,
    pub failure: Option<UniffiMcpFailure>,
}

fn to_uniffi_agent_mcp(agent: &str, a: &AgentMcp) -> UniffiAgentMcp {
    UniffiAgentMcp {
        agent: agent.to_string(),
        servers: a
            .servers
            .iter()
            .map(|s| UniffiMcpServer {
                name: s.name.clone(),
                transport: wire_str(&s.transport),
                target: s.target.clone(),
                env_keys: s.env_keys.clone(),
                header_keys: s.header_keys.clone(),
                enabled: s.enabled,
            })
            .collect(),
        toggles: a.toggles,
        error: a.error.clone(),
        busy: a.busy.clone(),
        failure: a.failure.as_ref().map(|f| UniffiMcpFailure {
            action: wire_str(&f.action),
            names: f.names.clone(),
            error: f.error.clone(),
        }),
    }
}

/// The mode / effort / model one agent's new sessions on a machine start
/// with: agent ids, `""` = the agent's own default.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiAgentDefaults {
    pub agent: String,
    pub mode: String,
    pub effort: String,
    pub model: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMachinesView {
    pub machines: Vec<UniffiMachineSummary>,
}

pub fn build_uniffi_machines_view(v: &MachinesView) -> UniffiMachinesView {
    UniffiMachinesView {
        machines: v
            .machines
            .values()
            .map(|m| UniffiMachineSummary {
                pubkey_hex: m.pubkey_hex.clone(),
                name: m.name.clone(),
                host: m.host.map(|h| wire_str(&h)),
                sessions: m
                    .sessions
                    .values()
                    .map(|s| {
                        let info = &s.info;
                        UniffiSessionSummary {
                            id: info.id.clone(),
                            title: info.title.clone(),
                            slug: info.slug.clone(),
                            cwd: info.cwd.clone(),
                            project: info.project.clone(),
                            state: info.state.map(|st| wire_str(&st)),
                            presence: wire_str(&s.presence),
                            last_activity: info.last_activity.clone(),
                            agent: info.agent.clone(),
                            model: info.model.clone(),
                            mode: info.mode.clone(),
                            effort: info.effort.clone(),
                            context_percentage: info.context_percentage,
                            context_window: info.context_window,
                            committed: info.committed,
                            seq_high: info.seq_high,
                            provider_id: info.provider_id.clone(),
                            usage: s.usage.as_ref().map(to_uniffi_usage_data),
                            gsd: s.gsd.as_ref().map(to_uniffi_gsd_state),
                            commands: s.commands.as_ref().map(|c| UniffiSessionCommands {
                                commands: c
                                    .commands
                                    .iter()
                                    .map(|x| UniffiSlashCommand {
                                        name: x.name.clone(),
                                        description: x.description.clone(),
                                        argument_hint: x.argument_hint.clone(),
                                    })
                                    .collect(),
                                error: c.error.clone(),
                            }),
                            mcp: s.mcp.as_ref().map(to_uniffi_session_mcp),
                        }
                    })
                    .collect(),
                capabilities: m.capabilities.clone(),
                folders: m.folders.clone(),
                roots: m.roots.clone(),
                agents: m.agents.iter().map(|a| to_uniffi_agent(a, m.agent_actions.get(&a.id))).collect(),
                credentials: m.credentials.iter().map(to_uniffi_credential_status).collect(),
                models: m
                    .models
                    .iter()
                    .map(|(agent, am)| UniffiAgentModels {
                        agent: agent.clone(),
                        models: am.models.as_deref().map(to_uniffi_model_entries).unwrap_or_default(),
                        default_model: am.default_model.clone(),
                        error: am.error.clone(),
                    })
                    .collect(),
                provider_profiles: m
                    .provider_profiles
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|p| UniffiProviderProfileInfo {
                        id: p.id.clone(),
                        agent: p.agent.clone(),
                        label: p.label.clone(),
                        base_url: p.base_url.clone(),
                        models: p.models.iter().map(|m| to_uniffi_profile_model(&p.label, m)).collect(),
                        models_from_provider: p.models_from_provider,
                        default_model: p.default_model.clone(),
                        has_token: p.has_token,
                        error: p.error.clone(),
                    })
                    .collect(),
                plugins: m.plugins.iter().map(|(agent, p)| to_uniffi_agent_plugins(agent, p)).collect(),
                mcp: m.mcp.iter().map(|(agent, a)| to_uniffi_agent_mcp(agent, a)).collect(),
                direct_advertised: m.direct.as_ref().map(|d| d.endpoints.clone()).unwrap_or_default(),
                direct_pinned: m.direct.as_ref().is_some_and(|d| d.cert_sha256.is_some()),
                direct_endpoints: m.direct_endpoints.clone(),
                direct_up: v.direct_up.get(&m.pubkey_hex).cloned(),
                npub: protocol::crypto::npub_from_hex(&m.pubkey_hex).unwrap_or_else(|_| m.pubkey_hex.clone()),
                relays: m.relays.clone(),
                last_heartbeat_at: m.last_heartbeat_at,
                machine_offline: m.machine_offline,
                default_agent: m.default_agent.clone(),
                agent_defaults: m
                    .agent_defaults
                    .iter()
                    .map(|(agent, d)| UniffiAgentDefaults {
                        agent: agent.clone(),
                        mode: d.mode.clone(),
                        effort: d.effort.clone(),
                        model: d.model.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

// --- outbox ----------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiOutboxItem {
    pub id: String,
    pub machine: String,
    pub session_id: String,
    pub text: String,
    /// `pending` / `published` / `confirmed` / `failed`.
    pub state: String,
    pub created_at: u64,
    pub error: Option<String>,
    pub attempts: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiOutboxView {
    pub items: Vec<UniffiOutboxItem>,
}

pub fn build_uniffi_outbox_view(v: &OutboxView) -> UniffiOutboxView {
    UniffiOutboxView {
        items: v
            .items
            .iter()
            .map(|i| UniffiOutboxItem {
                id: i.id.clone(),
                machine: i.machine.clone(),
                session_id: i.session_id.clone(),
                text: i.text.clone(),
                state: wire_str(&i.state),
                created_at: i.created_at,
                error: i.error.clone(),
                attempts: i.attempts,
            })
            .collect(),
    }
}

// --- ui (selection + optimistic card bookkeeping this slice needs) ---------

/// Fire-and-answer round-trip ack for `SetCredentials` (CDX-011) — mirrors
/// `client_core::stores::ui::CredentialsAck` field for field. `state` is
/// `"saving"` / `"saved"` / `"failed"`, the same wire spelling `wire_str`
/// gives every other status enum crossing this boundary.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiCredentialsAck {
    pub state: String,
    pub at: u64,
    /// The agent the write was for; `None` = the bridge's own credentials.
    /// The resulting statuses are on the machine (`UniffiMachineSummary`).
    pub agent: Option<String>,
    pub error: Option<String>,
}

/// Fire-and-answer round-trip ack for `SetProviderProfile` (CDX-062) —
/// mirrors `client_core::stores::ui::ProviderProfileAck` field for field.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiProviderProfileAck {
    pub state: String,
    pub at: u64,
    pub profile_id: Option<String>,
    pub token_valid: Option<bool>,
    pub error: Option<String>,
}

/// The bottom "Deleted X — Undo" toast after an optimistic session delete —
/// mirrors `client_core::stores::ui::UndoToast` field for field. Present
/// only while the 4 s undo window is open; the hide lands as the next
/// `UniffiUiView` re-fetch (the countdown itself belongs to the runtime's
/// delete controller, not to this projection).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUndoToast {
    pub machine: String,
    pub session_id: String,
    pub label: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiUiView {
    pub selected_machine: Option<String>,
    pub selected_session: Option<String>,
    /// Session keys with an unread dot — same `machine + " " + sessionId`
    /// format `session_key_of` produces.
    pub unread_sessions: Vec<String>,
    /// `sessionKey (machine + " " + sessionId)` -> responded card ids.
    pub responded_cards: HashMap<String, Vec<String>>,
    pub plan_approval_choices: HashMap<String, String>,
    /// Keyed by machine pubkey.
    pub credentials_status: HashMap<String, UniffiCredentialsAck>,
    /// Keyed by machine pubkey.
    pub provider_profile_status: HashMap<String, UniffiProviderProfileAck>,
    /// Present while a delete's undo window is open.
    pub undo_toast: Option<UniffiUndoToast>,
}

pub fn build_uniffi_ui_view(v: &UiView) -> UniffiUiView {
    UniffiUiView {
        selected_machine: v.selected_machine.clone(),
        selected_session: v.selected_session.clone(),
        unread_sessions: v.unread_sessions.iter().cloned().collect(),
        responded_cards: v
            .responded_cards
            .iter()
            .map(|(k, set)| (k.clone(), set.iter().cloned().collect()))
            .collect(),
        plan_approval_choices: v
            .plan_approval_choices
            .iter()
            .map(|(k, val)| (k.clone(), val.clone()))
            .collect(),
        credentials_status: v
            .credentials_status
            .iter()
            .map(|(k, a)| {
                (
                    k.clone(),
                    UniffiCredentialsAck {
                        state: wire_str(&a.state),
                        at: a.at,
                        agent: a.agent.clone(),
                        error: a.error.clone(),
                    },
                )
            })
            .collect(),
        provider_profile_status: v
            .provider_profile_status
            .iter()
            .map(|(k, a)| {
                (
                    k.clone(),
                    UniffiProviderProfileAck {
                        state: wire_str(&a.state),
                        at: a.at,
                        profile_id: a.profile_id.clone(),
                        token_valid: a.token_valid,
                        error: a.error.clone(),
                    },
                )
            })
            .collect(),
        undo_toast: v.undo_toast.clone().map(|t| UniffiUndoToast {
            machine: t.machine,
            session_id: t.session_id,
            label: t.label,
        }),
    }
}

// --- settings --------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiSettingsView {
    pub ui_scale: f64,
    pub stay_connected: bool,
    pub tor_proxy_enabled: bool,
    /// The Blossom server attachments are uploaded to; `""` = none, and
    /// they travel through the relays.
    pub blossom_server: String,
    /// The largest file one attachment can be, with or without that server.
    pub max_upload_bytes: u64,
    pub notifications_enabled: bool,
    pub show_usage_badge: bool,
    pub show_commit_badge: bool,
    pub backup: UniffiBackupView,
}

/// The config backup, as the settings page shows it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiBackupView {
    /// `None`: backup is off.
    pub relay: Option<String>,
    /// When a backup last reached the relay (ms since the epoch).
    pub saved_at: Option<u64>,
    pub status: UniffiBackupStatus,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum UniffiBackupStatus {
    /// Nothing going on (off, or on and up to date).
    Idle,
    /// Looking on the relay for a backup.
    Checking,
    /// A backup is on the relay: import it, or keep this phone's.
    Found { saved_at: u64, machines: u32 },
    Saving,
    Importing,
    /// The last operation failed; `reason` is for the user.
    Failed { reason: String },
}

fn build_uniffi_backup_status(s: &client_runtime::backup::BackupStatus) -> UniffiBackupStatus {
    use client_runtime::backup::BackupStatus;
    match s {
        BackupStatus::Idle => UniffiBackupStatus::Idle,
        BackupStatus::Checking => UniffiBackupStatus::Checking,
        BackupStatus::Found { saved_at, machines } => UniffiBackupStatus::Found { saved_at: *saved_at, machines: *machines },
        BackupStatus::Saving => UniffiBackupStatus::Saving,
        BackupStatus::Importing => UniffiBackupStatus::Importing,
        BackupStatus::Failed { reason } => UniffiBackupStatus::Failed { reason: reason.clone() },
    }
}

pub fn build_uniffi_settings_view(v: &SettingsView) -> UniffiSettingsView {
    let d = &v.data;
    UniffiSettingsView {
        ui_scale: d.ui_scale,
        stay_connected: d.stay_connected,
        tor_proxy_enabled: d.tor_proxy_enabled,
        blossom_server: d.blossom_server.clone(),
        max_upload_bytes: client_runtime::attachments::max_upload_bytes(!d.blossom_server.trim().is_empty()),
        notifications_enabled: d.notifications_enabled,
        show_usage_badge: d.show_usage_badge,
        show_commit_badge: d.show_commit_badge,
        backup: UniffiBackupView {
            relay: v.backup.relay.clone(),
            saved_at: v.backup.saved_at,
            status: build_uniffi_backup_status(&v.backup.status),
        },
    }
}

// --- quick prompts -----------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiQuickPrompt {
    pub id: String,
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiQuickPromptsView {
    pub prompts: Vec<UniffiQuickPrompt>,
}

pub fn build_uniffi_quick_prompts_view(v: &QuickPromptsView) -> UniffiQuickPromptsView {
    UniffiQuickPromptsView {
        prompts: v
            .prompts
            .iter()
            .map(|p| UniffiQuickPrompt { id: p.id.clone(), label: p.label.clone(), text: p.text.clone() })
            .collect(),
    }
}

// --- pending sessions -------------------------------------------------------

/// One optimistic new-session placeholder — mirrors
/// `client_core::stores::pending_sessions::PendingSessionView` field for
/// field. The bridge publishes `session-pending` on create and resolves the
/// placeholder with `session-ready`; a `session-failed` flips it to a
/// visible error card that stays until the user dismisses it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPendingSession {
    pub pending_id: String,
    /// Machine pubkey hex (`""` for a failure we saw no `session-pending` for).
    pub machine: String,
    /// Machine display name from the message (not the pubkey).
    pub machine_name: String,
    pub created_at: String,
    /// `pending` / `failed`.
    pub state: String,
    /// Set once `state == "failed"`.
    pub reason: Option<String>,
    /// ms timestamp the placeholder appeared (sweep bookkeeping).
    pub seen_at: u64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPendingSessionsView {
    /// Every held placeholder, in the real view's `pending_id`-keyed
    /// `BTreeMap` order. Not persisted (a placeholder that never resolves is
    /// meaningless after a restart) — a state-changed notification for this
    /// slice is the only signal a consumer gets that it changed.
    pub pending: Vec<UniffiPendingSession>,
}

pub fn build_uniffi_pending_sessions_view(v: &PendingSessionsView) -> UniffiPendingSessionsView {
    UniffiPendingSessionsView {
        pending: v
            .pending
            .values()
            .map(|p| UniffiPendingSession {
                pending_id: p.pending_id.clone(),
                machine: p.machine.clone(),
                machine_name: p.machine_name.clone(),
                created_at: p.created_at.clone(),
                state: wire_str(&p.state),
                reason: p.reason.clone(),
                seen_at: p.seen_at,
            })
            .collect(),
    }
}

// --- pairing -----------------------------------------------------------

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPairingCandidateView {
    pub pubkey_hex: String,
    pub npub: String,
    pub machine: String,
    pub relays: Vec<String>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiPairingView {
    /// `idle` / `awaiting-ack` / `paired` / `failed` — `PairingView.phase`'s
    /// own wire spelling (a `&'static str` on the real type; UniFFI's
    /// `Record` derive needs an owned `String` to synthesize an
    /// `FfiConverter` for it, same reason `ConnectionView`'s own doc comment
    /// gives for not deriving directly on the real struct).
    pub phase: String,
    pub error: Option<String>,
    /// CDX-040: the `failed` phase came from the phone's own deadline, not a nack.
    pub timed_out: bool,
    /// A deep-link URL awaiting explicit user confirmation (CDX-013), with
    /// enough of its parsed content to show what it wants to pair with.
    pub staged: Option<UniffiPairingCandidateView>,
    pub candidate: Option<UniffiPairingCandidateView>,
}

pub fn build_uniffi_pairing_view(v: &PairingView) -> UniffiPairingView {
    UniffiPairingView {
        phase: v.phase.to_string(),
        error: v.error.clone(),
        timed_out: v.timed_out,
        staged: v.staged.as_ref().map(|s| UniffiPairingCandidateView {
            pubkey_hex: s.pubkey_hex.clone(),
            npub: s.npub.clone(),
            machine: s.machine.clone(),
            relays: s.relays.clone(),
        }),
        candidate: v.candidate.as_ref().map(|c| UniffiPairingCandidateView {
            pubkey_hex: c.pubkey_hex.clone(),
            npub: c.npub.clone(),
            machine: c.machine.clone(),
            relays: c.relays.clone(),
        }),
    }
}

// --- transcript (grouped, via the now-wired presentation module) -----------

/// One display row, as JSON, under its key (`DisplayEntry::seq`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiKeyedEntry {
    pub key: u64,
    /// `serde_json::to_string` of one
    /// `client_core::presentation::display_entries::DisplayEntry`.
    pub json: String,
}

/// A session's grouped transcript as a change against the one the caller
/// already has. Streaming appends a row (or grows the last one) many times a
/// second; sending, and parsing, only what changed keeps each update small
/// however long the transcript is.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiTranscriptDelta {
    /// Pass back as `since` next time.
    pub revision: u64,
    /// `changed` is every row, in order: the caller's copy was not the base
    /// of this delta (first read, another session, or rows whose keys
    /// repeat), so it replaces it outright and ignores `order`.
    pub full: bool,
    /// Every row's key, in display order.
    pub order: Vec<u64>,
    /// The rows new or changed since `since` (all of them when `full`).
    pub changed: Vec<UniffiKeyedEntry>,
    /// `serde_json::to_string` of a `PendingPermissionSummary`, present iff a
    /// permission request is still unanswered and unresolved.
    pub pending_permission_json: Option<String>,
    /// `serde_json::to_string` of an `ActivityView` (the checklist,
    /// sub-agents and background tasks), present iff there is any.
    pub activity_json: Option<String>,
    /// `idle` / `requested` / `syncing` / `complete` / `failed`.
    pub sync_state: String,
    pub contiguous: bool,
}

/// One session's transcript entries, decoded, up to `high` — kept between
/// deltas so each one reads and decodes only the rows stored since. A stored
/// row never changes (the store inserts a seq once and ignores it after), so
/// the kept entries stay right as long as the coverage up to `high` is what
/// it was when they were read: a gap filled below `high`, or rows removed,
/// changes that coverage and the next read starts over.
pub struct TranscriptCache {
    machine: String,
    session_id: String,
    high: u64,
    /// `have_ranges` as they were, cut at `high`.
    coverage: Vec<(u64, u64)>,
    entries: Vec<SeqEntry>,
}

/// `ranges` cut at `high`: what of them lies at or below it.
fn ranges_upto(ranges: &[(u64, u64)], high: u64) -> Vec<(u64, u64)> {
    ranges.iter().filter(|(from, _)| *from <= high).map(|&(from, to)| (from, to.min(high))).collect()
}

fn decode(rows: &[client_runtime::view::TranscriptRowView]) -> impl Iterator<Item = SeqEntry> + '_ {
    rows.iter().filter_map(|r| {
        // Deserialized straight from the borrowed `Value`: `from_value`
        // would need a deep clone of each row's JSON tree first.
        protocol::common::OutputEntry::deserialize(&r.entry)
            .ok()
            .map(|entry| SeqEntry { seq: r.seq, entry })
    })
}

impl TranscriptCache {
    /// Where a read for this session may start: past the rows `cache`
    /// already holds for it, or `0` for all of them.
    pub fn resume_after(cache: &Option<TranscriptCache>, machine: &str, session_id: &str) -> u64 {
        cache
            .as_ref()
            .filter(|c| c.machine == machine && c.session_id == session_id)
            .map_or(0, |c| c.high)
    }

    /// Take in `view`, read past `after` (a [`Self::resume_after`] answer).
    /// Returns `false`, leaving `cache` as it was, when those rows do not
    /// continue what it holds — another read moved it on, or the coverage
    /// up to `after` changed — and the caller must read everything
    /// (`after = 0`, which is always taken in).
    pub fn absorb(
        cache: &mut Option<TranscriptCache>,
        view: &TranscriptRowsView,
        machine: &str,
        session_id: &str,
        after: u64,
    ) -> bool {
        let high = view.sync.local_high.max(after);
        let coverage = ranges_upto(&view.have_ranges, high);
        if after == 0 {
            *cache = Some(TranscriptCache {
                machine: machine.to_string(),
                session_id: session_id.to_string(),
                high,
                coverage,
                entries: decode(&view.rows).collect(),
            });
            return true;
        }
        let Some(c) = cache
            .as_mut()
            .filter(|c| c.machine == machine && c.session_id == session_id && c.high == after)
        else {
            return false;
        };
        if ranges_upto(&view.have_ranges, after) != c.coverage {
            return false;
        }
        c.entries.extend(decode(&view.rows).filter(|e| e.seq > after));
        c.high = high;
        c.coverage = coverage;
        true
    }

    pub fn entries(&self) -> &[SeqEntry] {
        &self.entries
    }
}

/// The rows last handed out, which the next delta is taken against.
pub struct TranscriptDeltaBase {
    machine: String,
    session_id: String,
    revision: u64,
    rows: Vec<DisplayEntry>,
}

/// This session's optimistically-responded card-id set, keyed the same way
/// `stores::ui::mark_card_responded` keys it — the one place that key format
/// (`"{machine} {session_id}"`) is spelled out, via the real `session_key_of`
/// rather than a hand-duplicated format string.
pub fn responded_cards_for<'a>(
    ui: &'a UiView,
    machine: &str,
    session_id: &str,
) -> Option<&'a BTreeSet<String>> {
    ui.responded_cards.get(&session_key_of(machine, session_id))
}

/// The delta of the session's transcript, `seq_entries` (a
/// [`TranscriptCache`]'s), against revision `since` of `base`; `sync` is the
/// session's sync status as the last read saw it.
pub fn build_uniffi_transcript_delta(
    seq_entries: &[SeqEntry],
    sync: &TranscriptSyncView,
    responded_cards: Option<&BTreeSet<String>>,
    base: &mut Option<TranscriptDeltaBase>,
    machine: &str,
    session_id: &str,
    since: u64,
) -> UniffiTranscriptDelta {
    let rows = build_display_entries(seq_entries);
    let pending = find_pending_permission(seq_entries, responded_cards);
    let activity = build_activity(seq_entries, &rows);
    let order: Vec<u64> = rows.iter().map(DisplayEntry::seq).collect();
    let unique = order.iter().collect::<BTreeSet<_>>().len() == order.len();

    let prior = base
        .as_ref()
        .filter(|b| since != 0 && b.revision == since && b.machine == machine && b.session_id == session_id && unique);
    let keyed = |row: &DisplayEntry| UniffiKeyedEntry {
        key: row.seq(),
        json: serde_json::to_string(row).unwrap_or_else(|_| "null".to_string()),
    };
    let (full, changed, unchanged) = match prior {
        Some(b) => {
            let old: HashMap<u64, &DisplayEntry> = b.rows.iter().map(|r| (r.seq(), r)).collect();
            let changed: Vec<UniffiKeyedEntry> =
                rows.iter().filter(|r| old.get(&r.seq()) != Some(r)).map(keyed).collect();
            let unchanged = changed.is_empty() && b.rows.len() == rows.len();
            (false, changed, unchanged)
        }
        None => (true, rows.iter().map(keyed).collect(), false),
    };
    let last = base.as_ref().map_or(0, |b| b.revision);
    let revision = if unchanged { since } else { last + 1 };
    *base = Some(TranscriptDeltaBase {
        machine: machine.to_string(),
        session_id: session_id.to_string(),
        revision,
        rows,
    });
    UniffiTranscriptDelta {
        revision,
        full,
        order,
        changed,
        pending_permission_json: pending.and_then(|p| serde_json::to_string(&p).ok()),
        activity_json: activity.and_then(|a| serde_json::to_string(&a).ok()),
        sync_state: wire_str(&sync.state),
        contiguous: sync.contiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use client_runtime::view::TranscriptRowView;
    use serde_json::json;

    fn view(rows: &[(u64, serde_json::Value)]) -> TranscriptRowsView {
        let mut v = TranscriptRowsView::empty();
        v.rows = rows.iter().map(|(seq, entry)| TranscriptRowView { seq: *seq, entry: entry.clone() }).collect();
        v
    }
    fn entries(rows: &[(u64, serde_json::Value)]) -> Vec<SeqEntry> {
        decode(&view(rows).rows).collect()
    }
    fn sync() -> TranscriptSyncView {
        TranscriptSyncView::empty()
    }
    fn text(role: &str, text: &str) -> serde_json::Value {
        json!({"timestamp": "t", "entryType": "text", "role": role, "text": text})
    }
    fn call(id: &str) -> serde_json::Value {
        json!({"timestamp": "t", "entryType": "tool_call", "callId": id, "toolName": "Bash", "kind": "execute", "title": "ls"})
    }
    fn result(id: &str) -> serde_json::Value {
        json!({"timestamp": "t", "entryType": "tool_result", "callId": id, "text": "ok"})
    }
    fn keys(d: &UniffiTranscriptDelta) -> Vec<u64> {
        d.changed.iter().map(|e| e.key).collect()
    }

    /// A read of `rows` (those past some seq), with the session stored up to
    /// `high` over `ranges`.
    fn read(rows: &[(u64, serde_json::Value)], high: u64, ranges: &[(u64, u64)]) -> TranscriptRowsView {
        let mut v = view(rows);
        v.sync.local_high = high;
        v.have_ranges = ranges.to_vec();
        v
    }
    fn cached_seqs(cache: &Option<TranscriptCache>) -> Vec<u64> {
        cache.as_ref().map(|c| c.entries().iter().map(|e| e.seq).collect()).unwrap_or_default()
    }

    #[test]
    fn a_profile_model_is_grouped_under_the_profile_and_its_upstream() {
        let routed = protocol::common::ProviderModel {
            id: "OpenCode Go/deepseek-v4.1-flash".into(),
            provider: Some("OpenCode Go".into()),
            context_window: Some(1_000_000),
            ..Default::default()
        };
        let m = to_uniffi_profile_model("CCR", &routed);
        assert_eq!(m.provider.as_deref(), Some("CCR · OpenCode Go"));
        assert_eq!(m.label.as_deref(), Some("deepseek-v4.1-flash"), "named without the group's provider");
        assert_eq!(m.context_window, Some(1_000_000));

        let own = protocol::common::ProviderModel { id: "kimi-k3".into(), label: Some("Kimi K3".into()), ..Default::default() };
        let m = to_uniffi_profile_model("Moonshot", &own);
        assert_eq!((m.provider.as_deref(), m.label.as_deref()), (Some("Moonshot"), Some("Kimi K3")));
    }

    #[test]
    fn the_cache_takes_in_only_what_was_stored_since() {
        let mut cache = None;
        assert_eq!(TranscriptCache::resume_after(&cache, "m", "s"), 0);
        let first = [(1, text("user", "hi")), (2, call("c1"))];
        assert!(TranscriptCache::absorb(&mut cache, &read(&first, 2, &[(1, 2)]), "m", "s", 0));
        assert_eq!(TranscriptCache::resume_after(&cache, "m", "s"), 2);
        // Another session starts from nothing.
        assert_eq!(TranscriptCache::resume_after(&cache, "m", "other"), 0);

        assert!(TranscriptCache::absorb(&mut cache, &read(&[(3, result("c1"))], 3, &[(1, 3)]), "m", "s", 2));
        assert_eq!(cached_seqs(&cache), [1, 2, 3]);
        // Nothing new is still a read that continues it.
        assert!(TranscriptCache::absorb(&mut cache, &read(&[], 3, &[(1, 3)]), "m", "s", 3));
        assert_eq!(cached_seqs(&cache), [1, 2, 3]);
    }

    #[test]
    fn a_read_that_does_not_continue_the_cache_is_refused() {
        let mut cache = None;
        // Seqs 1-2 and 5 are stored; 3-4 are a gap.
        let rows = [(1, text("user", "hi")), (2, call("c1")), (5, text("agent", "late"))];
        assert!(TranscriptCache::absorb(&mut cache, &read(&rows, 5, &[(1, 2), (5, 5)]), "m", "s", 0));

        // The gap filled below where the cache ends: its rows are not in the
        // cache, so it must be read again from the start.
        assert!(!TranscriptCache::absorb(&mut cache, &read(&[], 5, &[(1, 5)]), "m", "s", 5));
        // A read from before where the cache ends (another delta moved it
        // on), or for another session, is refused too.
        assert!(!TranscriptCache::absorb(&mut cache, &read(&[], 5, &[(1, 2), (5, 5)]), "m", "s", 2));
        assert!(!TranscriptCache::absorb(&mut cache, &read(&[], 5, &[(1, 2), (5, 5)]), "m", "other", 5));
        assert_eq!(cached_seqs(&cache), [1, 2, 5]);

        // A full read is always taken in.
        let all = [(1, text("user", "hi")), (2, call("c1")), (3, result("c1")), (4, text("agent", "ok")), (5, text("agent", "late"))];
        assert!(TranscriptCache::absorb(&mut cache, &read(&all, 5, &[(1, 5)]), "m", "s", 0));
        assert_eq!(cached_seqs(&cache), [1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_delta_carries_only_the_rows_that_changed() {
        let mut base = None;
        let mut rows = vec![(1, text("user", "hi")), (2, call("c1")), (3, text("agent", "done"))];
        let first = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", 0);
        assert!(first.full);
        assert_eq!((keys(&first), first.order.clone()), (vec![1, 2, 3], vec![1, 2, 3]));

        // Nothing new: nothing sent, the revision stays.
        let same = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", first.revision);
        assert!(!same.full && same.changed.is_empty());
        assert_eq!(same.revision, first.revision);

        // An appended row is the only one sent.
        rows.push((4, text("user", "again")));
        let appended = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", same.revision);
        assert!(!appended.full);
        assert_eq!((keys(&appended), appended.order.clone()), (vec![4], vec![1, 2, 3, 4]));
        assert!(appended.revision > same.revision);

        // A result lands on the call in an earlier row: that row is sent,
        // not just the last.
        rows.push((5, result("c1")));
        let earlier = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", appended.revision);
        assert_eq!(keys(&earlier), vec![2]);
        assert!(earlier.changed[0].json.contains("\"ok\""), "{}", earlier.changed[0].json);
    }

    #[test]
    fn a_caller_off_the_base_gets_everything() {
        let mut base = None;
        let rows = vec![(1, text("user", "hi"))];
        let first = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", 0);
        let _ = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "other", first.revision);
        // `base` now holds another session: this caller is off it.
        let back = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", first.revision);
        assert!(back.full);
        assert_eq!(keys(&back), vec![1]);
        let stale = build_uniffi_transcript_delta(&entries(&rows), &sync(), None, &mut base, "m", "s", back.revision - 1);
        assert!(stale.full, "a stale revision is not the base");
    }
}
