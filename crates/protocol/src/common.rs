//! Shared wire building blocks — types referenced by both command and event
//! messages.
//!
//! v11 is agent-neutral: nothing here names a particular coding agent. What an
//! agent can do (its modes, effort levels, credentials, optional features) is
//! DATA the bridge advertises per agent ([`AgentDescriptor`]); what a session
//! produced is a typed [`OutputEntry`] whose [`EntryBody`] variant says what it
//! is, instead of a loose metadata record interpreted by convention. An
//! unknown enum value is a decode error.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

// --- agents ---

/// One selectable value of a per-agent option (a mode, an effort level, a
/// plan-approval choice). `id` is what rides the wire; `label` is for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct OptionChoice {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Optional features an agent supports. A client offers a feature only when
/// the session's agent advertises it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSupports {
    /// `models-request` returns a live model list for this agent.
    #[serde(default)]
    pub models: bool,
    /// `usage-request` returns subscription usage for this agent's sessions.
    #[serde(default)]
    pub usage: bool,
    /// Sessions may be bound to one of this agent's provider profiles
    /// (`providerId`), which then serves the whole session.
    #[serde(default)]
    pub providers: bool,
    /// This agent's provider profiles add their models to its own model
    /// list, beside every provider it already has; a session picks one of
    /// them as it would any other model.
    #[serde(default)]
    pub provider_models: bool,
    /// `gsd-request` returns GSD workflow state for this agent's sessions.
    #[serde(default)]
    pub gsd: bool,
    /// `interrupt` stops the running turn.
    #[serde(default)]
    pub interrupt: bool,
    /// `commands-request` returns the slash commands a session of this agent
    /// understands.
    #[serde(default)]
    pub commands: bool,
    /// `plugins-request` / `plugin-action` list and manage the agent's
    /// plugins and the marketplaces they come from, for the whole machine.
    #[serde(default)]
    pub plugins: bool,
    /// `mcp-request` / `mcp-action` list and manage the agent's MCP servers
    /// for the whole machine; `session-mcp-request` / `session-mcp-toggle`
    /// show and switch them in one session.
    #[serde(default)]
    pub mcp: bool,
    /// Sessions report the work they run in the background
    /// (`background_task` entries), and `stop-task` stops it.
    #[serde(default)]
    pub tasks: bool,
}

// --- MCP servers ---

/// How an agent reaches an MCP server. The VALUES of `env` and `headers` are
/// secrets (a bearer token, an API key): they ride phone→bridge only, and
/// nothing the bridge sends back carries them — see [`McpServerInfo`]. Its
/// `Debug` names the keys only, so a logged command cannot leak them.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpTransport {
    /// A local process the agent starts and talks to over stdio.
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    /// A remote server over streamable HTTP.
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    /// A remote server over server-sent events (the older remote transport).
    Sse {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
}

impl std::fmt::Debug for McpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let keys = |m: &BTreeMap<String, String>| m.keys().cloned().collect::<Vec<_>>();
        match self {
            // The arguments are left out too: a server may take its token there.
            Self::Stdio { command, args, env } => f
                .debug_struct("Stdio")
                .field("command", command)
                .field("args", &args.len())
                .field("env", &keys(env))
                .finish(),
            Self::Http { url, headers } => {
                f.debug_struct("Http").field("url", &redact_url(url)).field("headers", &keys(headers)).finish()
            }
            Self::Sse { url, headers } => {
                f.debug_struct("Sse").field("url", &redact_url(url)).field("headers", &keys(headers)).finish()
            }
        }
    }
}

/// `url` without its user info, query and fragment — the parts that may
/// carry a credential. What is left names the server.
pub fn redact_url(url: &str) -> String {
    let cut = url.find(['?', '#']).map_or(url, |i| &url[..i]);
    match cut.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').map_or((rest, None), |(a, p)| (a, Some(p)));
            let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
            match path {
                Some(p) => format!("{scheme}://{host}/{p}"),
                None => format!("{scheme}://{host}"),
            }
        }
        None => cut.to_string(),
    }
}

/// An MCP server to add, as the user entered or imported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct McpServerSpec {
    pub name: String,
    pub transport: McpTransport,
}

/// An MCP server name: 1–64 letters, digits, `-`, `_` or `.`, starting with
/// a letter or digit (an agent's CLI takes it as an argument, where a leading
/// `-` would read as an option).
pub fn is_valid_mcp_name(name: &str) -> bool {
    name.len() <= 64
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub const MCP_NAME_ERROR: &str =
    "A server name is 1 to 64 letters, digits, dashes, underscores or dots, starting with a letter or digit.";

impl McpServerSpec {
    /// Why this server cannot be added, if it cannot — the one rule set the
    /// phone checks before sending and the bridge checks on receipt. A name
    /// is 1–64 letters, digits, `-`, `_` or `.` (it becomes a key in the
    /// agent's config and part of its tool names); a command must not look
    /// like a flag; a URL is `http(s)://`; env and header names are plain.
    pub fn problem(&self) -> Option<String> {
        if !is_valid_mcp_name(&self.name) {
            return Some(MCP_NAME_ERROR.into());
        }
        let plain = |k: &String| !k.is_empty() && !k.chars().any(|c| c.is_whitespace() || c.is_control() || c == ':' || c == '=');
        match &self.transport {
            McpTransport::Stdio { command, args, env } => {
                if command.trim().is_empty() || command.starts_with('-') {
                    return Some(format!("{}: the command to run is missing.", self.name));
                }
                if args.iter().chain(env.values()).any(|s| s.contains('\0')) || !env.keys().all(plain) {
                    return Some(format!("{}: an environment variable name is not valid.", self.name));
                }
            }
            McpTransport::Http { url, headers } | McpTransport::Sse { url, headers } => {
                let lower = url.to_ascii_lowercase();
                let host = lower.split_once("://").map(|(_, r)| r).unwrap_or("");
                if !(lower.starts_with("https://") || lower.starts_with("http://")) || host.is_empty() {
                    return Some(format!("{}: the URL must start with https:// or http://.", self.name));
                }
                if !headers.keys().all(plain) || headers.values().any(|v| v.contains(['\r', '\n'])) {
                    return Some(format!("{}: a header is not valid.", self.name));
                }
            }
        }
        None
    }
}

/// Which [`McpTransport`] a server uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportKind {
    Stdio,
    Http,
    Sse,
}

/// An MCP server configured for an agent on the bridge's machine, as the
/// bridge reports it: enough to recognise it, never its secrets. `target` is
/// the program a stdio server runs (without its arguments, which may carry a
/// token) or a remote server's URL without its query, fragment or user info;
/// `env_keys` / `header_keys` name what is set, not the values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub transport: McpTransportKind,
    pub target: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_keys: Vec<String>,
    /// A disabled server stays configured but no session starts it.
    pub enabled: bool,
}

/// A change to an agent's MCP servers. `add` takes `servers` (a server with
/// the name of an existing one replaces it); the others take `names`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum McpAction {
    Add,
    Remove,
    Enable,
    Disable,
}

/// Where one MCP server stands in a running session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum McpStatus {
    Connected,
    /// Starting or connecting.
    Pending,
    Failed,
    /// The server wants an OAuth sign-in, done on the machine itself.
    NeedsAuth,
    Disabled,
}

/// One MCP server of a running session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMcpServer {
    pub name: String,
    pub status: McpStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// How many tools it offers, once connected and when the agent says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<u32>,
}

// --- plugins ---

/// A plugin installed for an agent on the bridge's machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// What `plugin-action` names it by (`name@marketplace`).
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// A disabled plugin stays installed but no session loads it.
    pub enabled: bool,
}

/// A plugin one of the known marketplaces offers and that is not installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    /// What `plugin-action` installs it by (`name@marketplace`).
    pub id: String,
    pub name: String,
    pub marketplace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// How many times the marketplace says it was installed, when it says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub install_count: Option<u64>,
}

/// A marketplace plugins are installed from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplace {
    /// What `plugin-action` names it by.
    pub name: String,
    /// Where it comes from, for display: `owner/repo`, a URL or a path.
    pub source: String,
}

/// A change to an agent's plugins; `target` names a plugin (`install`,
/// `uninstall`, `enable`, `disable`, `update` — update brings an installed
/// plugin to its marketplace's latest version) or a marketplace
/// (`add-marketplace` takes its source: `owner/repo`, a git URL or a
/// marketplace.json URL; `remove-marketplace` and `update-marketplace` its
/// name). For an agent without marketplaces, `install` takes a package name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PluginAction {
    Install,
    Uninstall,
    Enable,
    Disable,
    Update,
    AddMarketplace,
    RemoveMarketplace,
    UpdateMarketplace,
}

/// A credential the bridge holds for an agent (or for itself), by id. The
/// secret never rides bridge→phone; only whether it is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub id: String,
    pub label: String,
    /// Set — by the phone or by the bridge's own environment.
    pub present: bool,
    /// Present only because the bridge's environment provides it (the phone
    /// cannot clear it).
    #[serde(default, skip_serializing_if = "is_false")]
    pub from_env: bool,
    /// The bridge checked the stored value against the provider; absent when
    /// it was not checked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid: Option<bool>,
}

/// An agent backend a bridge can run sessions on, advertised in the session
/// list heartbeat. Clients build their pickers from this rather than from
/// hardcoded lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    /// Stable id, e.g. `"claude-code"`, `"opencode"`.
    pub id: String,
    pub display_name: String,
    /// Permission / operating modes, in picker order. Empty = the agent has
    /// no switchable mode.
    #[serde(default)]
    pub modes: Vec<OptionChoice>,
    /// Reasoning-effort levels, in picker order. Empty = not configurable.
    #[serde(default)]
    pub efforts: Vec<OptionChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    /// The effort a session runs at when none is chosen; one of `efforts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default)]
    pub supports: AgentSupports,
    /// Credentials this agent can use, with their current status.
    #[serde(default)]
    pub credentials: Vec<CredentialStatus>,
    /// Whether the agent is on the bridge's machine. Sessions start only on
    /// a `ready` one; the rest of the descriptor is filled in once it is.
    #[serde(default)]
    pub install: AgentInstall,
}

/// Where an agent stands on the bridge's machine. The bridge installs an
/// agent when asked (`agent-action`), at the version its build pins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentInstall {
    /// Installed. `removable`: CodeDeck installed it and can remove it; an
    /// agent the machine has of its own (on PATH, bundled, configured) is
    /// not.
    Ready {
        #[serde(default, skip_serializing_if = "is_false")]
        removable: bool,
    },
    NotInstalled {},
    Installing {},
    /// The last install did not finish, for `reason`; installing again
    /// retries.
    Failed { reason: String },
}

impl Default for AgentInstall {
    fn default() -> Self {
        Self::Ready { removable: false }
    }
}

impl AgentInstall {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready { .. })
    }
}

/// A change to which agents are on the bridge's machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AgentAction {
    /// Download and install the agent at the version the bridge pins.
    Install,
    /// Remove what CodeDeck installed of it (`ready` with `removable`); its
    /// sessions end. The agent's own settings and conversations stay.
    Remove,
}

// --- sessions ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    WaitingPermission,
    WaitingQuestion,
    /// Set on every session when the bridge shuts down cleanly.
    Offline,
}

/// The per-session options `set-option` changes and `option-confirmed`
/// reports. Values are agent-defined strings (see [`AgentDescriptor`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SessionOption {
    Mode,
    Effort,
    Model,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionInfo {
    pub id: String,
    /// The [`AgentDescriptor::id`] this session runs on.
    pub agent: String,
    pub slug: String,
    pub cwd: String,
    pub last_activity: String,
    #[specta(type = specta_typescript::Number)]
    pub line_count: u64,
    /// nullable (always present on the wire, may be `null`).
    pub title: Option<String>,
    pub project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_percentage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<SessionState>,
    /// Highest transcript seq the bridge has persisted for this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub seq_high: Option<u64>,
    /// Bound custom provider profile (absent = the agent's own provider).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_label: Option<String>,
}

// --- provider base URL rule (CDX-071) ---

/// The message BOTH ends show when a base URL is rejected.
pub const PROVIDER_BASE_URL_ERROR: &str = "Base URL must be https:// (http:// is allowed only for this machine — localhost, \
     127.0.0.1, [::1] — or an address on your own network, such as 192.168.1.10)";

/// Is `raw` https, or http to this machine (`localhost` / `127.0.0.1` /
/// `[::1]`, matched exactly)? The rule for an endpoint whose traffic must
/// not cross any network in cleartext.
pub fn is_https_or_loopback_url(raw: &str) -> bool {
    match plain_http_host(raw) {
        PlainHttp::NotHttp(https) => https,
        PlainHttp::Host(host) => matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"),
        PlainHttp::Refused => false,
    }
}

/// Is `raw` an acceptable custom-provider base URL? https anywhere; http to
/// this machine, where a local model server has no cert and the traffic
/// never leaves it; or http to an IP address of the user's own network — a
/// gateway or model server at home or on the office LAN, which rarely has a
/// cert either. Its token then crosses that network in cleartext, which the
/// user chose by pointing a profile there; anything beyond it (a public
/// address, or a name DNS could point anywhere) needs https.
///
/// Private means the IPv4 ranges set aside for local networks (10/8,
/// 172.16/12, 192.168/16), carrier-grade NAT space (100.64/10, which VPN
/// overlays such as Tailscale number their machines in), and IPv6 unique
/// local addresses (fc00::/7) — written as addresses, never as names.
pub fn is_valid_provider_base_url(raw: &str) -> bool {
    if is_https_or_loopback_url(raw) {
        return true;
    }
    match plain_http_host(raw) {
        PlainHttp::Host(host) => is_private_network_address(&host),
        _ => false,
    }
}

enum PlainHttp {
    /// Not `http://`: whether it is a usable `https://` URL instead.
    NotHttp(bool),
    /// An `http://` URL's host, lower-case (an IPv6 literal without its
    /// brackets).
    Host(String),
    /// An `http://` URL this split cannot read exactly as a WHATWG parser
    /// would.
    Refused,
}

/// A minimal scheme+host split — no url crate (protocol package stays
/// dep-light).
///
/// It refuses whatever the WHATWG URL parser (what actually dials, e.g.
/// reqwest) could read differently: userinfo (`http://evil.com@localhost`),
/// a backslash (a path separator there, so `http://evil.com\@localhost`
/// dials evil.com), and whitespace or control characters (silently removed
/// there). Refusing is the safe side of any remaining disagreement: a host
/// this split does not recognise is rejected, never guessed at.
fn plain_http_host(raw: &str) -> PlainHttp {
    let rest = match raw.split_once("://") {
        Some((scheme, rest)) => match scheme.to_ascii_lowercase().as_str() {
            "https" => return PlainHttp::NotHttp(!rest.is_empty()),
            "http" => rest,
            _ => return PlainHttp::NotHttp(false),
        },
        None => return PlainHttp::NotHttp(false),
    };
    if rest.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return PlainHttp::Refused;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return PlainHttp::Refused;
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 literal: [addr] or [addr]:port — nothing else after the bracket.
        match stripped.split_once(']') {
            Some((h, after)) if after.is_empty() || after.starts_with(':') => h,
            _ => return PlainHttp::Refused,
        }
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    PlainHttp::Host(host.to_ascii_lowercase())
}

/// Is `host` an IP address on a private network (see
/// [`is_valid_provider_base_url`])? Only the canonical spelling counts:
/// std's parser refuses the shorthands and leading zeros a WHATWG parser
/// would read as another address (`010.0.0.1` is 8.0.0.1 there).
fn is_private_network_address(host: &str) -> bool {
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        let [a, b, ..] = v4.octets();
        return a == 10
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 100 && (64..=127).contains(&b));
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        return v6.segments()[0] & 0xfe00 == 0xfc00;
    }
    false
}

/// A model a provider profile offers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The provider a gateway routes the model to (`OpenCode Go` for a
    /// router's `OpenCode Go/deepseek-v4.1-flash`), when the endpoint says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// How many tokens the model takes in, when the endpoint says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
}

/// The REDACTED wire shape of a stored provider profile (`hasToken` only — the
/// token itself never rides bridge→phone). CDX-071: `baseUrl` stays a bare
/// non-empty string on read so a pre-gate cleartext profile is still listable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileInfo {
    pub id: String,
    /// The agent the profile is for: the endpoint speaks that agent's API.
    pub agent: String,
    pub label: String,
    pub base_url: String,
    pub models: Vec<ProviderModel>,
    /// The models are the provider's own list, read when it was last saved.
    #[serde(default, skip_serializing_if = "is_false")]
    pub models_from_provider: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub has_token: bool,
    /// Why the agent does not offer this profile's models, when it does not
    /// (one of its own providers has the profile's name, say).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- transcript entries ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineType {
    Add,
    Del,
    Context,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub kind: DiffLineType,
    pub text: String,
}

/// Who wrote a text entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
}

/// What a tool call does, normalized across agents (the Agent Client
/// Protocol's tool kinds, plus `agent`). Clients pick icons and summaries
/// from this rather than from agent-specific tool names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    /// Hands a task to a sub-agent, which works on its own and reports back.
    Agent,
    Other,
}

/// What choosing a permission option does — lets a client style and order
/// the choices without knowing the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    pub kind: PermissionOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Session lifecycle notices a client shows as a marker line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// The agent process was restarted; the conversation may continue fresh.
    SessionRestart,
    /// The agent process died unexpectedly.
    SessionDied,
    /// The session could not start or continue.
    SessionFailed,
    /// The agent rejected its credentials.
    AuthError,
}

/// What a transcript entry is. Tagged by `entryType`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "entryType",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EntryBody {
    /// Conversation text.
    Text { role: Role, text: String },
    /// A plan the agent proposes (rendered as markdown, never collapsed).
    Plan { text: String },
    /// Model reasoning. `redacted` = the provider withheld the content.
    Thinking {
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        redacted: bool,
    },
    ToolCall {
        call_id: String,
        /// The agent's own tool name (display only — clients branch on `kind`).
        tool_name: String,
        kind: ToolKind,
        /// One-line human summary, e.g. `npm test` or `src/main.rs`.
        title: String,
        /// Files or paths the call touches.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        locations: Vec<String>,
        /// The call's whole input as a person reads it, when it says more
        /// than `title`: the full command of an `execute` call, a search's
        /// pattern and scope, a tool's arguments as indented JSON. Absent for
        /// a file change, whose `diff` entry already carries the content. The
        /// host bounds its size.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
    },
    ToolResult {
        call_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
    /// A file change, as add/del/context lines.
    Diff {
        path: String,
        lines: Vec<DiffLine>,
        #[serde(default, skip_serializing_if = "is_false")]
        truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
    },
    /// The agent is waiting for the user to allow or deny a tool call.
    /// Answered with `permission-response` using one of `options`.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        kind: ToolKind,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        locations: Vec<String>,
        options: Vec<PermissionOption>,
        /// Why the agent asks rather than deciding itself, in its words
        /// (a hook's reason, a safety check's warning), when it says.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// The hook that asked for this approval (`PreToolUse:Bash`), when
        /// one did: it asks every time, so no "always" choice is offered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hook: Option<String>,
        /// The plugin that hook comes from, when it is known to be one
        /// plugin's: the name the user installed it under.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hook_plugin: Option<String>,
    },
    /// One question of a (possibly multi-question) ask, all sharing
    /// `request_id`. Answered with `question-response`.
    Question {
        request_id: String,
        #[specta(type = specta_typescript::Number)]
        index: u32,
        #[specta(type = specta_typescript::Number)]
        count: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        header: Option<String>,
        question: String,
        #[serde(default)]
        options: Vec<QuestionOption>,
        #[serde(default, skip_serializing_if = "is_false")]
        multi_select: bool,
    },
    /// The agent finished planning and asks how to proceed. Answered with
    /// `plan-response` using one of `options`.
    PlanApproval {
        request_id: String,
        options: Vec<OptionChoice>,
        /// The option that sends the plan back to the agent to revise, when
        /// one does: a `plan-response` choosing it may carry the user's
        /// `feedback`, which the agent revises the plan with.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revise: Option<String>,
    },
    /// A permission request, question or plan approval was answered (or
    /// cancelled); `summary` is a short human description of the outcome.
    Resolved { request_id: String, summary: String },
    Notice { kind: NoticeKind, text: String },
    /// A one-line status message from the bridge or agent.
    Status { text: String },
    Error { text: String },
    /// The agent's turn ended; it is waiting for input.
    TurnComplete {},
    /// Work the agent left running in the background (a command, a
    /// sub-agent) changed state. One entry per change, all sharing
    /// `task_id`; the latest says where the task stands.
    BackgroundTask {
        task_id: String,
        kind: TaskKind,
        /// What the task does, in a line (`npm run dev`, `Audit the API`).
        title: String,
        status: TaskStatus,
        /// The tool call that started it, when one did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        /// How it went, once it ended, in the agent's words.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    /// The agent's checklist for the work at hand, whole each time it
    /// changes. `call_id` is the tool call that wrote it, when one did.
    Todos {
        items: Vec<TodoItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// A shell command.
    Shell,
    /// A sub-agent.
    Agent,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    /// Stopped before it finished (by the user, or by the agent).
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

/// One item of the agent's checklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
    /// The item as the agent says it while working on it ("Running the
    /// tests" for "Run the tests"), when it gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_text: Option<String>,
}

/// Identifies the sub-agent that produced an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    /// What kind of sub-agent it is (`Explore`, `general`), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The `agent` tool call that started it, when known: its entries
    /// belong under that call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_call_id: Option<String>,
}

/// One transcript entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OutputEntry {
    pub timestamp: String,
    #[serde(flatten)]
    pub body: EntryBody,
    /// Set when a sub-agent (not the session's main agent) produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<Subagent>,
    /// Agent-specific data no client depends on — the one sanctioned escape
    /// hatch; anything a client renders belongs in a typed field instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub agent_extras: Option<serde_json::Value>,
}

impl OutputEntry {
    pub fn new(timestamp: impl Into<String>, body: EntryBody) -> Self {
        Self {
            timestamp: timestamp.into(),
            body,
            subagent: None,
            agent_extras: None,
        }
    }
}

// --- usage ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// e.g. "5h", "7d", "7d Opus".
    pub label: String,
    /// 0–100.
    pub utilization: Option<f64>,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub available: bool,
    /// Subscription / plan name, when the agent's provider reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_cost_usd: Option<f64>,
    /// What fills the session's context window, when its agent can say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextBreakdown>,
    pub fetched_at: String,
}

/// What fills a session's context window, part by part, as its agent counts
/// it — the same picture the agent's own context view gives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    /// Tokens in the window now.
    pub used_tokens: u32,
    /// The window's size.
    pub window_tokens: u32,
    /// The parts, in the agent's order: "Messages", "System prompt", "MCP
    /// tools", the free rest.
    #[serde(default)]
    pub categories: Vec<ContextCategory>,
    /// Lists behind some parts, item by item (each MCP tool, each memory
    /// file), when the agent names them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ContextGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategory {
    pub name: String,
    pub tokens: u32,
    pub kind: ContextKind,
}

/// Where a [`ContextCategory`] stands against the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ContextKind {
    /// Content in the window.
    Used,
    /// The window's unused rest.
    Free,
    /// Kept free for compaction.
    Buffer,
    /// Loaded only when needed: outside the window until then.
    Deferred,
}

/// A part of the context listed item by item: "MCP tools" and each tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextGroup {
    pub name: String,
    pub tokens: u32,
    #[serde(default)]
    pub items: Vec<ContextItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub name: String,
    pub tokens: u32,
}

/// Credential writes by id: a string sets it, `null` clears it, an absent
/// id is left unchanged.
pub type CredentialValues = BTreeMap<String, Option<String>>;

// --- GSD workflow state ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdPhase {
    pub number: String,
    pub name: String,
    pub disk_status: String,
    #[specta(type = specta_typescript::Number)]
    pub plans: u64,
    #[specta(type = specta_typescript::Number)]
    pub summaries: u64,
    pub recently_touched: bool,
    pub action: Option<String>,
    pub command: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub plan_count: Option<i64>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub needs_you: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdExecution {
    pub phase: String,
    #[specta(type = specta_typescript::Number)]
    pub plans_total: u64,
    #[specta(type = specta_typescript::Number)]
    pub plans_done: u64,
    pub current_plan: Option<String>,
    #[specta(type = specta_typescript::Number)]
    pub tasks_done: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub tasks_total: Option<i64>,
    pub last_task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct GsdAction {
    pub id: String,
    pub label: String,
    pub command: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GsdState {
    pub installed: bool,
    pub available: bool,
    pub has_git: bool,
    pub situation: String,
    pub summary: String,
    pub milestone: Option<String>,
    pub current_phase: Option<String>,
    #[specta(type = Option<specta_typescript::Number>)]
    pub total_phases: Option<i64>,
    pub percent: f64,
    pub phases: Vec<GsdPhase>,
    pub actions: Vec<GsdAction>,
    pub recommended: Option<String>,
    pub paused: bool,
    pub blockers: Vec<String>,
    pub verify_failed: bool,
    pub execution: Option<GsdExecution>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redact_url_keeps_only_what_names_the_server() {
        assert_eq!(redact_url("https://mcp.example.com/v1/sse?key=abc#x"), "https://mcp.example.com/v1/sse");
        assert_eq!(redact_url("https://user:pw@mcp.example.com/@scope/x"), "https://mcp.example.com/@scope/x");
        assert_eq!(redact_url("https://tok@mcp.example.com"), "https://mcp.example.com");
        assert_eq!(redact_url("not a url?q"), "not a url");
    }

    #[test]
    fn an_mcp_transport_never_debug_prints_its_secrets() {
        let stdio = McpTransport::Stdio {
            command: "npx".into(),
            args: vec!["--token".into(), "sk-args".into()],
            env: [("API_KEY".to_string(), "sk-env".to_string())].into(),
        };
        let http = McpTransport::Http {
            url: "https://x.example/mcp?token=sk-query".into(),
            headers: [("Authorization".to_string(), "Bearer sk-header".to_string())].into(),
        };
        let shown = format!("{stdio:?} {http:?}");
        assert!(!shown.contains("sk-"), "{shown}");
        assert!(shown.contains("API_KEY") && shown.contains("Authorization"), "{shown}");
    }

    fn entry_rt(v: serde_json::Value) -> OutputEntry {
        let e: OutputEntry = serde_json::from_value(v.clone()).unwrap_or_else(|err| panic!("{v} -> {err}"));
        let back = serde_json::to_value(&e).unwrap();
        assert_eq!(back, v, "entries serialize back to the exact wire shape");
        e
    }

    #[test]
    fn enum_wire_values() {
        assert_eq!(serde_json::to_string(&SessionState::WaitingPermission).unwrap(), r#""waiting_permission""#);
        assert_eq!(serde_json::to_string(&DiffLineType::Del).unwrap(), r#""del""#);
        assert_eq!(serde_json::to_string(&ToolKind::SwitchMode).unwrap(), r#""switch_mode""#);
        assert_eq!(serde_json::to_string(&PermissionOptionKind::AllowAlways).unwrap(), r#""allow_always""#);
        assert_eq!(serde_json::to_string(&SessionOption::Effort).unwrap(), r#""effort""#);
        assert_eq!(serde_json::to_string(&NoticeKind::AuthError).unwrap(), r#""auth_error""#);
    }

    #[test]
    fn unknown_enum_value_is_a_decode_error() {
        assert!(serde_json::from_str::<SessionState>(r#""paused""#).is_err());
        assert!(serde_json::from_str::<ToolKind>(r#""teleport""#).is_err());
    }

    #[test]
    fn provider_base_url_rule() {
        assert!(is_valid_provider_base_url("https://api.example.com/v1"));
        assert!(is_valid_provider_base_url("http://localhost:11434/v1"));
        assert!(is_valid_provider_base_url("http://127.0.0.1:1234"));
        assert!(is_valid_provider_base_url("http://[::1]:8080/v1"));
        assert!(!is_valid_provider_base_url("http://api.example.com"));
        assert!(!is_valid_provider_base_url("http://evil.localhost"));
        assert!(!is_valid_provider_base_url("http://0.0.0.0:1234"));
        assert!(!is_valid_provider_base_url("ftp://localhost"));
        assert!(!is_valid_provider_base_url("not a url"));
        assert!(!is_valid_provider_base_url("https://"));
    }

    #[test]
    fn a_provider_may_be_on_the_users_own_network() {
        for ok in [
            "http://192.168.1.2:3458",
            "http://10.0.0.7/v1",
            "http://172.16.0.1",
            "http://172.31.255.254:80",
            "http://100.101.102.103:8080",
            "http://[fd12:3456::1]:3000/v1",
            "http://[FC00::1]",
        ] {
            assert!(is_valid_provider_base_url(ok), "{ok}");
            assert!(!is_https_or_loopback_url(ok), "{ok}");
        }
        for refused in [
            "http://172.32.0.1",
            "http://192.169.0.1",
            "http://100.128.0.1",
            "http://8.8.8.8",
            "http://[2001:db8::1]",
            "http://[fe80::1]",
            // Spellings a WHATWG parser reads as another address.
            "http://010.0.0.1",
            "http://192.168.1",
            "http://0xc0.168.1.1",
            // A name could point anywhere.
            "http://router.local",
            "http://192.168.1.2.nip.io",
            "http://192.168.1.2@evil.com",
        ] {
            assert!(!is_valid_provider_base_url(refused), "{refused}");
        }
        assert!(is_https_or_loopback_url("https://relay.example"));
        assert!(is_https_or_loopback_url("http://localhost:8080"));
        assert!(!is_https_or_loopback_url("http://[::2]"));
    }

    #[test]
    fn provider_base_url_rule_refuses_what_a_whatwg_parser_reads_differently() {
        assert!(is_valid_provider_base_url("http://LOCALHOST:8080"));
        assert!(is_valid_provider_base_url("http://[::1]"));
        // WHATWG dials evil.com for each of these.
        assert!(!is_valid_provider_base_url(r"http://evil.com\@localhost"));
        assert!(!is_valid_provider_base_url(r"http://evil.com\@localhost/v1"));
        assert!(!is_valid_provider_base_url("http://localhost@evil.com"));
        // Userinfo, even when the host really is loopback.
        assert!(!is_valid_provider_base_url("http://evil.com@localhost"));
        assert!(!is_valid_provider_base_url("http://user:pass@127.0.0.1:1234"));
        // Characters WHATWG strips before parsing.
        assert!(!is_valid_provider_base_url("http://local\thost"));
        assert!(!is_valid_provider_base_url("http://evil.com\n@localhost"));
        assert!(!is_valid_provider_base_url("http://localhost :80"));
        // Junk after an IPv6 literal.
        assert!(!is_valid_provider_base_url("http://[::1]evil.com"));
        assert!(!is_valid_provider_base_url("http://[::2]:80"));
    }

    #[test]
    fn remote_session_info_round_trip_minimal_and_full() {
        let minimal = r#"{"id":"s","agent":"claude-code","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}"#;
        let v: RemoteSessionInfo = serde_json::from_str(minimal).unwrap();
        assert_eq!(v.title, None);
        assert_eq!(v.state, None);
        assert_eq!(serde_json::from_str::<RemoteSessionInfo>(&serde_json::to_string(&v).unwrap()).unwrap(), v);

        let full = json!({
            "id":"s","agent":"opencode","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":42,
            "title":"T","project":"p","mode":"plan","effort":"high",
            "model":"m","contextWindow":200000,"contextPercentage":37.5,"committed":true,
            "state":"running","seqHigh":917,"providerId":"pid","providerLabel":"Prov"
        });
        let v: RemoteSessionInfo = serde_json::from_value(full).unwrap();
        assert_eq!(v.mode.as_deref(), Some("plan"));
        assert_eq!(v.seq_high, Some(917));
        assert_eq!(v.agent, "opencode");
    }

    #[test]
    fn a_session_must_name_its_agent() {
        let no_agent = r#"{"id":"s","slug":"sl","cwd":"/w","lastActivity":"t","lineCount":0,"title":null,"project":"p"}"#;
        assert!(serde_json::from_str::<RemoteSessionInfo>(no_agent).is_err());
    }

    #[test]
    fn every_entry_body_round_trips_its_exact_wire_shape() {
        entry_rt(json!({"timestamp":"t","entryType":"text","role":"user","text":"hi"}));
        entry_rt(json!({"timestamp":"t","entryType":"plan","text":"1. do x"}));
        entry_rt(json!({"timestamp":"t","entryType":"thinking","text":"","redacted":true}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_call","callId":"c1","toolName":"Bash","kind":"execute","title":"cat <<EOF…","input":"cat <<EOF\nhi\nEOF"}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_call","callId":"c2","toolName":"Agent","kind":"agent","title":"Explore auth"}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_call","callId":"c3","toolName":"Read","kind":"read","title":"a.rs",
            "subagent":{"label":"Explore","parentCallId":"c2"}}));
        entry_rt(json!({"timestamp":"t","entryType":"background_task","taskId":"b1","kind":"shell","title":"npm run dev","status":"running","callId":"c4"}));
        entry_rt(json!({"timestamp":"t","entryType":"background_task","taskId":"b1","kind":"shell","title":"npm run dev","status":"failed","summary":"exit 1"}));
        entry_rt(json!({"timestamp":"t","entryType":"todos","callId":"c5","items":[
            {"text":"Run the tests","status":"in_progress","activeText":"Running the tests"},
            {"text":"Fix it","status":"pending"},{"text":"Old idea","status":"cancelled"},{"text":"Read","status":"completed"}]}));
        entry_rt(json!({"timestamp":"t","entryType":"tool_result","callId":"c1","text":"ok","isError":true}));
        entry_rt(json!({"timestamp":"t","entryType":"diff","path":"/w/a.rs","lines":[{"type":"add","text":"x"}],"truncated":true,"callId":"c1"}));
        entry_rt(json!({"timestamp":"t","entryType":"permission_request","requestId":"r","toolName":"Bash","kind":"execute","title":"rm -rf build","locations":["/w/build"],
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}]}));
        entry_rt(json!({"timestamp":"t","entryType":"question","requestId":"q","index":0,"count":2,"header":"Color","question":"Which?","options":[{"label":"Red","description":"warm"}],"multiSelect":true}));
        entry_rt(json!({"timestamp":"t","entryType":"plan_approval","requestId":"p","options":[{"id":"approve","label":"Approve"}]}));
        entry_rt(json!({"timestamp":"t","entryType":"resolved","requestId":"r","summary":"Allowed"}));
        entry_rt(json!({"timestamp":"t","entryType":"notice","kind":"session_restart","text":"restarted"}));
        entry_rt(json!({"timestamp":"t","entryType":"status","text":"compacting"}));
        entry_rt(json!({"timestamp":"t","entryType":"error","text":"boom"}));
        entry_rt(json!({"timestamp":"t","entryType":"turn_complete"}));
    }

    #[test]
    fn entry_envelope_fields_ride_alongside_the_body() {
        let e = entry_rt(json!({
            "timestamp":"t","entryType":"tool_call","callId":"c","toolName":"Read","kind":"read","title":"a.rs",
            "subagent":{"label":"explorer"},"agentExtras":{"parentToolUseId":"x"}
        }));
        assert_eq!(e.subagent, Some(Subagent { label: Some("explorer".into()), parent_call_id: None }));
        assert!(e.agent_extras.is_some());
    }

    #[test]
    fn an_unknown_entry_type_is_a_decode_error() {
        assert!(serde_json::from_value::<OutputEntry>(json!({"timestamp":"t","entryType":"hologram"})).is_err());
    }

    #[test]
    fn agent_descriptor_defaults_optional_lists() {
        let a: AgentDescriptor = serde_json::from_value(json!({"id":"pi","displayName":"Pi"})).unwrap();
        assert!(a.modes.is_empty() && a.efforts.is_empty() && a.credentials.is_empty());
        assert_eq!(a.supports, AgentSupports::default());
    }
}
