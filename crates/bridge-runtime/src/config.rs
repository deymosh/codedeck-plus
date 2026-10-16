//! Configuration: command-line flags > `CODEDECK_*` environment >
//! `$CODEDECK_HOME/config.json` > defaults. Same keys as the TypeScript
//! bridge's config, so an existing `config.json` keeps working.

use std::collections::BTreeMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use protocol::capabilities::BridgeHostKind;
use protocol::relays::DEFAULT_RELAYS;
use serde::Deserialize;

/// Flags that feed configuration (the rest of the CLI lives in `main.rs`).
#[derive(Debug, Default, Clone)]
pub struct Flags {
    pub home: Option<PathBuf>,
    pub machine_name: Option<String>,
    pub relays: Vec<String>,
    pub workspaces: Vec<PathBuf>,
    pub claude_path: Option<String>,
    pub tor_proxy: Option<String>,
    pub opencode_server_url: Option<String>,
    pub opencode_path: Option<String>,
    pub deepseek_path: Option<String>,
    pub agent_host: Option<PathBuf>,
    pub service: bool,
    pub test_mode: bool,
    /// `--terminal`: run terminals on this bridge. Never switched from a
    /// phone — the machine's owner decides.
    pub terminal: bool,
    pub direct_listen: Option<String>,
    pub direct_onion_listen: Option<String>,
    pub direct_endpoints: Vec<String>,
}

/// `config.json`; every key optional.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    machine_name: Option<String>,
    relays: Option<Vec<String>>,
    workspace_roots: Option<Vec<String>>,
    relay_register_endpoint: Option<String>,
    relay_register_token: Option<String>,
    blossom_register_endpoint: Option<String>,
    blossom_register_token: Option<String>,
    claude_path: Option<String>,
    transcript_keep_last: Option<u64>,
    tor_proxy_url: Option<String>,
    open_code_server_url: Option<String>,
    open_code_path: Option<String>,
    deepseek_path: Option<String>,
    open_code_port: Option<u16>,
    agent_host_path: Option<String>,
    node_path: Option<String>,
    direct: Option<FileDirect>,
    terminal: Option<FileTerminal>,
    audit: Option<FileAudit>,
    /// Keys this bridge does not know, kept only to warn about them.
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDirect {
    listen: Option<String>,
    onion_listen: Option<String>,
    endpoints: Option<Vec<String>>,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

/// The `terminal` object: whether this machine runs terminals, who may open
/// one, and what runs in it. Off unless the owner turns it on.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTerminal {
    enabled: Option<bool>,
    /// Whether a terminal may open over a relay as well as the direct link.
    relays: Option<bool>,
    /// How long a terminal with no client attached lives. 0 keeps it until it
    /// ends on its own.
    idle_minutes: Option<u64>,
    max_terminals: Option<usize>,
    /// The program to run in a terminal, when the owner wants a fixed one.
    command: Option<Vec<String>>,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

/// The `audit` object: how long recordings are kept and whether each audit
/// line is also copied to the system log.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileAudit {
    max_days: Option<u64>,
    max_bytes: Option<u64>,
    syslog: Option<bool>,
    #[serde(flatten)]
    unknown: BTreeMap<String, serde_json::Value>,
}

/// The keys in `config.json` this bridge does not know (a typo, or a flat
/// `"direct.listen"` for the nested `"direct": {"listen": …}`), which it
/// would otherwise ignore without a word.
fn unknown_keys(file: &FileConfig) -> Vec<String> {
    let nested = |prefix: &str, keys: std::collections::btree_map::Keys<'_, String, serde_json::Value>| {
        keys.map(|k| format!("{prefix}.{k}")).collect::<Vec<_>>()
    };
    let direct = file.direct.iter().flat_map(|d| nested("direct", d.unknown.keys()));
    let terminal = file.terminal.iter().flat_map(|t| nested("terminal", t.unknown.keys()));
    let audit = file.audit.iter().flat_map(|a| nested("audit", a.unknown.keys()));
    file.unknown.keys().cloned().chain(direct).chain(terminal).chain(audit).collect()
}

/// The direct link (see `crate::direct`): where to listen, and what to
/// advertise. Off unless a listener is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DirectConfig {
    /// The `wss://` listener (TLS, self-signed certificate phones pin).
    pub listen: Option<SocketAddr>,
    /// A plain `ws://` listener for an onion service to forward to. Loopback
    /// only: cleartext never leaves the machine except inside Tor.
    pub onion_listen: Option<SocketAddr>,
    /// The URLs phones dial, in order. Empty: the `wss://` listener's LAN
    /// address, found at start.
    pub endpoints: Vec<String>,
}

impl DirectConfig {
    pub fn enabled(&self) -> bool {
        self.listen.is_some() || self.onion_listen.is_some()
    }
}

/// Whether `url` is a direct endpoint a phone may dial: `wss://` anywhere,
/// `ws://` only to an onion service.
pub fn is_direct_endpoint(url: &str) -> bool {
    let host = |rest: &str| rest.split(['/', ':']).next().unwrap_or("").to_ascii_lowercase();
    if let Some(rest) = url.strip_prefix("wss://") {
        !host(rest).is_empty()
    } else if let Some(rest) = url.strip_prefix("ws://") {
        host(rest).ends_with(".onion")
    } else {
        false
    }
}

fn direct_config(flags: &Flags, file: Option<FileDirect>) -> Result<DirectConfig, String> {
    let file = file.unwrap_or_default();
    let addr = |what: &str, value: Option<String>| -> Result<Option<SocketAddr>, String> {
        value
            .map(|v| v.parse::<SocketAddr>().map_err(|e| format!("direct {what} {v:?}: {e} (expected ip:port)")))
            .transpose()
    };
    let listen = addr("listen", flags.direct_listen.clone().or_else(|| env("CODEDECK_DIRECT_LISTEN")).or(file.listen))?;
    let onion_listen = addr(
        "onion listen",
        flags.direct_onion_listen.clone().or_else(|| env("CODEDECK_DIRECT_ONION_LISTEN")).or(file.onion_listen),
    )?;
    if onion_listen.is_some_and(|a| !a.ip().is_loopback()) {
        return Err("the direct onion listener serves cleartext: it must listen on loopback (e.g. 127.0.0.1:7448)".into());
    }
    let endpoints = non_empty(flags.direct_endpoints.clone())
        .or_else(|| split_list(env("CODEDECK_DIRECT_ENDPOINTS")))
        .or(file.endpoints)
        .unwrap_or_default();
    for url in &endpoints {
        if !is_direct_endpoint(url) {
            return Err(format!("direct endpoint {url:?}: use wss://host:port, or ws:// only for a .onion"));
        }
        if url.starts_with("wss://") && listen.is_none() {
            return Err(format!("direct endpoint {url:?} needs a direct listener (--direct-listen)"));
        }
        if url.starts_with("ws://") && onion_listen.is_none() {
            return Err(format!("direct endpoint {url:?} needs an onion listener (--direct-onion-listen)"));
        }
    }
    Ok(DirectConfig { listen, onion_listen, endpoints })
}

/// How long an unattended terminal lives by default, and the longest the
/// owner may make it: a terminal is a shell as the bridge's own user, so an
/// abandoned one must not run for ever.
pub const DEFAULT_TERMINAL_IDLE_MINUTES: u64 = 60;
pub const MAX_TERMINAL_IDLE_MINUTES: u64 = 24 * 60;
/// How long recordings are kept and how large the audit directory may grow,
/// by default.
pub const DEFAULT_AUDIT_MAX_DAYS: u64 = 90;
pub const DEFAULT_AUDIT_MAX_BYTES: u64 = 1 << 30;

/// Whether this machine runs terminals, who may open one, and what runs in it
/// — the `terminal` object, resolved. The engine gets a
/// [`TerminalConfig`](bridge_core::TerminalConfig) built from this at start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSettings {
    pub enabled: bool,
    pub relays_allowed: bool,
    /// 0 keeps an unattended terminal alive until it ends on its own.
    pub idle_minutes: u64,
    pub max_terminals: usize,
    /// The program a terminal runs instead of the user's shell, when set.
    pub command: Option<Vec<String>>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            relays_allowed: false,
            idle_minutes: DEFAULT_TERMINAL_IDLE_MINUTES,
            max_terminals: bridge_core::TerminalConfig::default().max_terminals,
            command: None,
        }
    }
}

/// How the terminal audit is kept: how long recordings live, how large the
/// audit directory may grow, and whether each line is also copied to the
/// system log. 0 for `max_days` / `max_bytes` means no limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditSettings {
    pub max_days: u64,
    pub max_bytes: u64,
    pub syslog: bool,
}

impl Default for AuditSettings {
    fn default() -> Self {
        Self { max_days: DEFAULT_AUDIT_MAX_DAYS, max_bytes: DEFAULT_AUDIT_MAX_BYTES, syslog: false }
    }
}

fn terminal_settings(flags: &Flags, file: Option<FileTerminal>) -> TerminalSettings {
    let file = file.unwrap_or_default();
    // Flags win, then the environment, then the file, then the default. The
    // `--terminal` flag can only switch terminals on; `CODEDECK_TERMINAL`
    // carries a boolean, so it overrides the file in either direction.
    let enabled = if flags.terminal {
        true
    } else if let Some(v) = env_bool("CODEDECK_TERMINAL") {
        v
    } else {
        file.enabled.unwrap_or(false)
    };
    let defaults = TerminalSettings::default();
    TerminalSettings {
        enabled,
        relays_allowed: file.relays.unwrap_or(defaults.relays_allowed),
        idle_minutes: file.idle_minutes.unwrap_or(defaults.idle_minutes).min(MAX_TERMINAL_IDLE_MINUTES),
        max_terminals: file.max_terminals.unwrap_or(defaults.max_terminals),
        command: file.command.filter(|c| !c.is_empty()),
    }
}

fn audit_settings(file: Option<FileAudit>) -> AuditSettings {
    let file = file.unwrap_or_default();
    let defaults = AuditSettings::default();
    AuditSettings {
        max_days: file.max_days.unwrap_or(defaults.max_days),
        max_bytes: file.max_bytes.unwrap_or(defaults.max_bytes),
        syslog: file.syslog.unwrap_or(defaults.syslog),
    }
}

/// An admin endpoint that registers a paired phone's pubkey.
#[derive(Clone)]
pub struct RegisterEndpoint {
    pub url: String,
    /// Bearer admin token — never logged.
    pub token: String,
}

impl std::fmt::Debug for RegisterEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RegisterEndpoint({})", self.url)
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub home: PathBuf,
    pub config_file: PathBuf,
    pub config_file_exists: bool,
    pub machine: String,
    pub host_kind: BridgeHostKind,
    pub relays: Vec<String>,
    pub workspace_roots: Vec<PathBuf>,
    pub relay_register: Option<RegisterEndpoint>,
    pub blossom_register: Option<RegisterEndpoint>,
    /// SOCKS5 proxy for all Nostr traffic (relays, Blossom, pubkey
    /// registration), as `host:port`.
    pub tor_proxy: Option<String>,
    pub transcript_keep_last: Option<usize>,
    /// How the agent host is started.
    pub node_path: String,
    pub agent_host_path: PathBuf,
    pub test_mode: bool,
    /// Environment handed to the agent host (driver settings).
    pub host_env: BTreeMap<String, String>,
    pub direct: DirectConfig,
    /// Terminals on this machine: whether they run, who may have one, and what
    /// runs in one.
    pub terminal: TerminalSettings,
    /// How the terminal audit is kept.
    pub audit: AuditSettings,
}

/// Read an env var; empty counts as unset (Compose's `${VAR:-}` defines every
/// variable an operator never set as the empty string).
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// `0` / `false` = off, anything else = on, empty/unset = no opinion.
fn env_bool(name: &str) -> Option<bool> {
    env(name).map(|v| v != "0" && v != "false")
}

fn split_list(value: Option<String>) -> Option<Vec<String>> {
    let items: Vec<String> = value?.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    (!items.is_empty()).then_some(items)
}

fn non_empty<T>(list: Vec<T>) -> Option<Vec<T>> {
    (!list.is_empty()).then_some(list)
}

pub fn home_dir(flags: &Flags) -> PathBuf {
    flags
        .home
        .clone()
        .or_else(|| env("CODEDECK_HOME").map(PathBuf::from))
        .unwrap_or_else(|| user_home().join(".codedeck"))
}

pub fn user_home() -> PathBuf {
    env("HOME").or_else(|| env("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// `socks5h://127.0.0.1:9050` (or a bare `host:port`) → `host:port`.
pub fn proxy_host_port(url: &str) -> Result<String, String> {
    let rest = match url.split_once("://") {
        Some((scheme, rest)) if scheme.starts_with("socks5") => rest,
        Some((scheme, _)) => return Err(format!("unsupported proxy scheme '{scheme}' (use socks5h://host:port)")),
        None => url,
    };
    let host_port = rest.trim_end_matches('/');
    match host_port.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.parse::<u16>().is_ok() => Ok(host_port.to_string()),
        _ => Err(format!("invalid proxy '{url}' (expected socks5h://host:port)")),
    }
}

fn hostname() -> String {
    env("HOSTNAME")
        .or_else(|| fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .or_else(|| env("COMPUTERNAME"))
        .unwrap_or_else(|| "bridge".into())
}

/// The directory the running binary sits in (None when it cannot be resolved).
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| fs::canonicalize(exe).ok())
        .map(strip_verbatim)
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// On Windows `fs::canonicalize` returns a verbatim path (`\\?\C:\...`,
/// `\\?\UNC\server\share\...`). Node cannot load a main module from one — its
/// module resolver ends up at `lstat('C:')` and dies with EISDIR — so paths
/// handed to `node` are turned back into their ordinary form.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\").filter(|r| r.as_bytes().get(1) == Some(&b':')) {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// The Node executable's file name on this platform.
const NODE_BIN: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// A `node` shipped beside the binary — the release archives bundle one so
/// they need nothing installed.
fn bundled_node(exe_dir: Option<&Path>) -> Option<String> {
    let node = exe_dir?.join(NODE_BIN);
    node.is_file().then(|| node.to_string_lossy().into_owned())
}

/// Where the agent host bundle is by default: `agent-host/dist/main.js` beside
/// the binary (the release archive and the image lay it out so), else the
/// workspace build.
fn default_agent_host() -> PathBuf {
    let beside = exe_dir().map(|d| d.join("agent-host").join("dist").join("main.js"));
    match beside {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("packages/agent-host/dist/main.js"),
    }
}

/// The workspace root when none is configured: `workspaces/` in the bridge
/// home. Not the working directory: that depends on how the bridge was
/// started — `/` for a system service, the install folder (holding the
/// bridge's own `agent-host/` and `node`) for a release started in place —
/// and a project root has to be named to be served.
fn default_workspace(home: &Path) -> PathBuf {
    home.join("workspaces")
}

pub fn load(flags: &Flags) -> Result<Config, String> {
    let home = absolute(&home_dir(flags));
    let config_file = home.join("config.json");
    let config_file_exists = config_file.exists();
    let file: FileConfig = if config_file_exists {
        // It can hold admin tokens: keep it owner-only.
        crate::state::restrict(&config_file, 0o600);
        let raw = fs::read_to_string(&config_file).map_err(|e| format!("cannot read {}: {e}", config_file.display()))?;
        serde_json::from_str(&raw).map_err(|e| format!("invalid config in {}: {e}", config_file.display()))?
    } else {
        FileConfig::default()
    };
    let unknown = unknown_keys(&file);
    if !unknown.is_empty() {
        log::warn!(
            "[Config] {} has keys this bridge does not know, ignored: {} (nested settings go in an object, e.g. \"direct\": {{\"listen\": …}})",
            config_file.display(),
            unknown.join(", "),
        );
    }

    let host_kind = if flags.service || env("INVOCATION_ID").is_some() { BridgeHostKind::Service } else { BridgeHostKind::Cli };
    let machine = flags
        .machine_name
        .clone()
        .or_else(|| env("CODEDECK_MACHINE_NAME"))
        .or(file.machine_name)
        .unwrap_or_else(|| format!("{} ({})", hostname(), host_kind.as_wire()));
    let relays = non_empty(flags.relays.clone())
        .or_else(|| split_list(env("CODEDECK_RELAYS")))
        .or(file.relays.and_then(non_empty))
        .unwrap_or_else(|| DEFAULT_RELAYS.iter().map(|r| r.to_string()).collect());
    let configured_roots = non_empty(flags.workspaces.clone())
        .or_else(|| split_list(env("CODEDECK_WORKSPACE_ROOTS")).map(|v| v.into_iter().map(PathBuf::from).collect()))
        .or_else(|| file.workspace_roots.and_then(non_empty).map(|v| v.into_iter().map(PathBuf::from).collect()));
    let workspace_roots = match configured_roots {
        Some(roots) => roots.iter().map(|p| absolute(p)).collect(),
        None => {
            let root = default_workspace(&home);
            fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
            vec![root]
        }
    };
    let register = |url: Option<String>, token: Option<String>| match (url, token) {
        (Some(url), Some(token)) => Some(RegisterEndpoint { url, token }),
        _ => None,
    };
    let relay_register = register(
        env("CODEDECK_RELAY_REGISTER_ENDPOINT").or(file.relay_register_endpoint),
        env("CODEDECK_RELAY_REGISTER_TOKEN").or(file.relay_register_token),
    );
    let blossom_register = register(
        env("CODEDECK_BLOSSOM_REGISTER_ENDPOINT").or(file.blossom_register_endpoint),
        env("CODEDECK_BLOSSOM_REGISTER_TOKEN").or(file.blossom_register_token),
    );
    let tor_proxy = flags
        .tor_proxy
        .clone()
        .or_else(|| env("CODEDECK_TOR_PROXY_URL"))
        .or(file.tor_proxy_url)
        .map(|url| proxy_host_port(&url))
        .transpose()?;
    let transcript_keep_last = env("CODEDECK_TRANSCRIPT_KEEP_LAST")
        .and_then(|v| v.parse::<u64>().ok())
        .or(file.transcript_keep_last)
        .map(|n| n as usize);

    // Driver settings travel to the agent host as its environment.
    let mut host_env = BTreeMap::new();
    let mut put = |key: &str, value: Option<String>| {
        if let Some(value) = value {
            host_env.insert(key.to_string(), value);
        }
    };
    put("CODEDECK_CLAUDE_PATH", flags.claude_path.clone().or_else(|| env("CODEDECK_CLAUDE_PATH")).or(file.claude_path));
    put(
        "CODEDECK_OPENCODE_SERVER_URL",
        flags.opencode_server_url.clone().or_else(|| env("CODEDECK_OPENCODE_SERVER_URL")).or(file.open_code_server_url),
    );
    put("CODEDECK_OPENCODE_PATH", flags.opencode_path.clone().or_else(|| env("CODEDECK_OPENCODE_PATH")).or(file.open_code_path));
    put("CODEDECK_OPENCODE_PORT", env("CODEDECK_OPENCODE_PORT").or(file.open_code_port.map(|p| p.to_string())));
    put("CODEDECK_DEEPSEEK_PATH", flags.deepseek_path.clone().or_else(|| env("CODEDECK_DEEPSEEK_PATH")).or(file.deepseek_path));
    let test_mode = flags.test_mode || env_bool("CODEDECK_TEST_MODE").unwrap_or(false);
    put("CODEDECK_TEST_MODE", test_mode.then(|| "1".into()));
    put("CODEDECK_AGENT_HOST_DRIVERS", env("CODEDECK_AGENT_HOST_DRIVERS"));
    // Agent binaries the host installs on demand live under the bridge's home,
    // and so does the state of an agent that keeps its own (the harness's
    // profiles, sessions and credentials).
    put("CODEDECK_AGENT_CACHE", Some(home.join("agents").to_string_lossy().into_owned()));
    put("CODEDECK_DEEPSEEK_HOME", Some(home.join("dsh").to_string_lossy().into_owned()));

    let direct = direct_config(flags, file.direct)?;
    let terminal = terminal_settings(flags, file.terminal);
    let audit = audit_settings(file.audit);

    let agent_host_path = flags
        .agent_host
        .clone()
        .or_else(|| env("CODEDECK_AGENT_HOST").map(PathBuf::from))
        .or_else(|| file.agent_host_path.map(PathBuf::from))
        .unwrap_or_else(default_agent_host);

    Ok(Config {
        config_file,
        config_file_exists,
        machine,
        host_kind,
        relays,
        workspace_roots,
        relay_register,
        blossom_register,
        tor_proxy,
        transcript_keep_last,
        node_path: env("CODEDECK_NODE_PATH")
            .or(file.node_path)
            .or_else(|| bundled_node(exe_dir().as_deref()))
            .unwrap_or_else(|| "node".into()),
        agent_host_path: absolute(&agent_host_path),
        test_mode,
        host_env,
        direct,
        terminal,
        audit,
        home,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_config_keys_are_named_nested_ones_included() {
        let file: FileConfig = serde_json::from_str(
            r#"{"machineName":"desktop","direct.listen":"0.0.0.0:7447","direct":{"listen":"0.0.0.0:7447","endpoint":"wss://x"}}"#,
        )
        .unwrap();
        assert_eq!(unknown_keys(&file), vec!["direct.listen".to_string(), "direct.endpoint".to_string()]);
        assert_eq!(file.direct.and_then(|d| d.listen).as_deref(), Some("0.0.0.0:7447"), "known keys still read");

        let clean: FileConfig = serde_json::from_str(r#"{"machineName":"desktop","direct":{"listen":"0.0.0.0:7447"}}"#).unwrap();
        assert!(unknown_keys(&clean).is_empty());
    }

    /// `config.example.json` at the repository root shows every key: this
    /// destructures the file config without `..`, so a new key does not
    /// compile until it is listed here, and then fails until the example
    /// sets it; a key the bridge does not know fails too.
    #[test]
    fn the_example_config_sets_every_key_and_only_known_ones() {
        let file: FileConfig = serde_json::from_str(include_str!("../../../config.example.json")).unwrap();
        assert_eq!(unknown_keys(&file), Vec::<String>::new());
        let FileConfig {
            machine_name,
            relays,
            workspace_roots,
            relay_register_endpoint,
            relay_register_token,
            blossom_register_endpoint,
            blossom_register_token,
            claude_path,
            transcript_keep_last,
            tor_proxy_url,
            open_code_server_url,
            open_code_path,
            deepseek_path,
            open_code_port,
            agent_host_path,
            node_path,
            direct,
            terminal,
            audit,
            unknown: _,
        } = file;
        let set = [
            ("machineName", machine_name.is_some()),
            ("relays", relays.is_some()),
            ("workspaceRoots", workspace_roots.is_some()),
            ("relayRegisterEndpoint", relay_register_endpoint.is_some()),
            ("relayRegisterToken", relay_register_token.is_some()),
            ("blossomRegisterEndpoint", blossom_register_endpoint.is_some()),
            ("blossomRegisterToken", blossom_register_token.is_some()),
            ("claudePath", claude_path.is_some()),
            ("transcriptKeepLast", transcript_keep_last.is_some()),
            ("torProxyUrl", tor_proxy_url.is_some()),
            ("openCodeServerUrl", open_code_server_url.is_some()),
            ("openCodePath", open_code_path.is_some()),
            ("deepseekPath", deepseek_path.is_some()),
            ("openCodePort", open_code_port.is_some()),
            ("agentHostPath", agent_host_path.is_some()),
            ("nodePath", node_path.is_some()),
        ];
        for (key, present) in set {
            assert!(present, "config.example.json does not set {key}");
        }
        let FileDirect { listen, onion_listen, endpoints, unknown: _ } = direct.expect("config.example.json sets direct");
        assert!(listen.is_some() && onion_listen.is_some() && endpoints.is_some(), "config.example.json sets every direct key");
        // And the values it shows are ones the bridge accepts.
        let direct = FileDirect { listen, onion_listen, endpoints, unknown: Default::default() };
        direct_config(&Flags::default(), Some(direct)).expect("the example's direct section is valid");
        proxy_host_port(&tor_proxy_url.unwrap()).expect("the example's proxy URL is valid");

        let FileTerminal { enabled, relays, idle_minutes, max_terminals, command, unknown: _ } =
            terminal.expect("config.example.json sets terminal");
        assert!(
            enabled.is_some() && relays.is_some() && idle_minutes.is_some() && max_terminals.is_some() && command.is_some(),
            "config.example.json sets every terminal key"
        );
        let FileAudit { max_days, max_bytes, syslog, unknown: _ } = audit.expect("config.example.json sets audit");
        assert!(max_days.is_some() && max_bytes.is_some() && syslog.is_some(), "config.example.json sets every audit key");
    }

    #[test]
    fn terminal_settings_read_the_file_and_the_flag_wins() {
        // Defaults: terminals off, the engine's own limits. (Only when the
        // environment does not itself switch them on.)
        if env("CODEDECK_TERMINAL").is_none() {
            assert_eq!(terminal_settings(&Flags::default(), None), TerminalSettings::default());
        }

        let file: FileTerminal = serde_json::from_str(
            r#"{"enabled":true,"relays":true,"idleMinutes":30,"maxTerminals":2,"command":["tmux","new"]}"#,
        )
        .unwrap();
        let settings = terminal_settings(&Flags::default(), Some(file));
        assert!(settings.enabled && settings.relays_allowed);
        assert_eq!(settings.idle_minutes, 30);
        assert_eq!(settings.max_terminals, 2);
        assert_eq!(settings.command.as_deref(), Some(&["tmux".to_string(), "new".to_string()][..]));

        // The flag turns terminals on whatever the file says.
        let file: FileTerminal = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(terminal_settings(&Flags { terminal: true, ..Default::default() }, Some(file)).enabled);

        // An idle time is capped at a day, and an empty command is none.
        let file: FileTerminal = serde_json::from_str(r#"{"idleMinutes":100000,"command":[]}"#).unwrap();
        let settings = terminal_settings(&Flags::default(), Some(file));
        assert_eq!(settings.idle_minutes, MAX_TERMINAL_IDLE_MINUTES);
        assert_eq!(settings.command, None);
    }

    #[test]
    fn audit_settings_read_the_file_with_defaults() {
        assert_eq!(audit_settings(None), AuditSettings::default());
        assert_eq!(AuditSettings::default().max_days, DEFAULT_AUDIT_MAX_DAYS);
        assert_eq!(AuditSettings::default().max_bytes, DEFAULT_AUDIT_MAX_BYTES);
        let file: FileAudit = serde_json::from_str(r#"{"maxDays":7,"maxBytes":1024,"syslog":true}"#).unwrap();
        assert_eq!(audit_settings(Some(file)), AuditSettings { max_days: 7, max_bytes: 1024, syslog: true });
    }

    #[test]
    fn unknown_keys_in_the_terminal_and_audit_objects_are_named() {
        let file: FileConfig = serde_json::from_str(
            r#"{"terminal":{"enabled":true,"idleMinute":30},"audit":{"maxDay":7},"terminal.enabled":true}"#,
        )
        .unwrap();
        assert_eq!(
            unknown_keys(&file),
            vec!["terminal.enabled".to_string(), "terminal.idleMinute".to_string(), "audit.maxDay".to_string()]
        );
    }

    #[test]
    fn verbatim_windows_paths_are_made_ordinary() {
        let s = |p: &str| strip_verbatim(PathBuf::from(p)).to_string_lossy().into_owned();
        assert_eq!(s(r"\\?\C:\bridge\codedeck-bridge.exe"), r"C:\bridge\codedeck-bridge.exe");
        assert_eq!(s(r"\\?\UNC\server\share\codedeck-bridge.exe"), r"\\server\share\codedeck-bridge.exe");
        // A verbatim path with no drive letter has no ordinary form: kept as is.
        assert_eq!(s(r"\\?\Volume{0}\codedeck-bridge.exe"), r"\\?\Volume{0}\codedeck-bridge.exe");
        assert_eq!(s("/opt/codedeck/codedeck-bridge"), "/opt/codedeck/codedeck-bridge");
    }

    #[test]
    fn a_bundled_node_is_preferred_only_when_present() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(bundled_node(Some(dir.path())), None);
        std::fs::write(dir.path().join(NODE_BIN), "#!/bin/sh").unwrap();
        let bundled = bundled_node(Some(dir.path())).unwrap();
        assert!(bundled.ends_with(NODE_BIN));
    }

    #[test]
    fn the_default_workspace_is_in_the_bridge_home() {
        assert_eq!(default_workspace(Path::new("/home/me/.codedeck")), PathBuf::from("/home/me/.codedeck/workspaces"));
    }

    #[test]
    fn direct_endpoints_are_wss_or_onion_only() {
        assert!(is_direct_endpoint("wss://192.168.1.20:7447"));
        assert!(is_direct_endpoint("wss://laptop.tail1234.ts.net:7447"));
        assert!(is_direct_endpoint("ws://abcdef.onion:7448"));
        assert!(!is_direct_endpoint("ws://192.168.1.20:7447"), "no cleartext on a LAN");
        assert!(!is_direct_endpoint("ws://evil.onion.example.com:80"));
        assert!(!is_direct_endpoint("https://x"));
        assert!(!is_direct_endpoint("wss://"));
    }

    #[test]
    fn the_onion_listener_must_be_loopback_and_endpoints_need_their_listener() {
        let flags = |listen: Option<&str>, onion: Option<&str>, endpoints: &[&str]| Flags {
            direct_listen: listen.map(str::to_string),
            direct_onion_listen: onion.map(str::to_string),
            direct_endpoints: endpoints.iter().map(|e| e.to_string()).collect(),
            ..Flags::default()
        };
        assert_eq!(direct_config(&flags(None, None, &[]), None).unwrap(), DirectConfig::default());
        assert!(direct_config(&flags(None, Some("0.0.0.0:7448"), &[]), None).is_err());
        assert!(direct_config(&flags(None, None, &["wss://10.0.0.2:7447"]), None).is_err());
        assert!(direct_config(&flags(Some("0.0.0.0:7447"), None, &["ws://x.onion:7448"]), None).is_err());
        let ok = direct_config(&flags(Some("0.0.0.0:7447"), Some("127.0.0.1:7448"), &["wss://10.0.0.2:7447", "ws://x.onion:7448"]), None).unwrap();
        assert!(ok.enabled());
        assert_eq!(ok.endpoints.len(), 2);
        assert!(direct_config(&flags(Some("not an addr"), None, &[]), None).is_err());
    }

    #[test]
    fn proxy_urls_become_host_port() {
        assert_eq!(proxy_host_port("socks5h://127.0.0.1:9050").unwrap(), "127.0.0.1:9050");
        assert_eq!(proxy_host_port("socks5://tor:9050/").unwrap(), "tor:9050");
        assert_eq!(proxy_host_port("codedeck-tor:9050").unwrap(), "codedeck-tor:9050");
        assert!(proxy_host_port("http://proxy:8080").is_err());
        assert!(proxy_host_port("socks5h://nohost").is_err());
    }

    #[test]
    fn a_config_file_is_read_and_flags_win() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"machineName":"from-file","relays":["wss://file"],"workspaceRoots":["/srv/w"],"transcriptKeepLast":7}"#,
        )
        .unwrap();
        let flags = Flags { home: Some(dir.path().into()), relays: vec!["wss://flag".into()], ..Default::default() };
        let config = load(&flags).unwrap();
        assert_eq!(config.relays, ["wss://flag"]);
        assert_eq!(config.transcript_keep_last, Some(7));
        assert!(config.config_file_exists);
        if env("CODEDECK_MACHINE_NAME").is_none() {
            assert_eq!(config.machine, "from-file");
        }
    }

    #[test]
    fn a_broken_config_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.json"), "{nope").unwrap();
        let err = load(&Flags { home: Some(dir.path().into()), ..Default::default() }).unwrap_err();
        assert!(err.contains("invalid config"));
    }
}
