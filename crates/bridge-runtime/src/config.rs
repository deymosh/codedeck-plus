//! Configuration: command-line flags > `CODEDECK_*` environment >
//! `$CODEDECK_HOME/config.json` > defaults. Same keys as the TypeScript
//! bridge's config, so an existing `config.json` keeps working.

use std::collections::BTreeMap;
use std::fs;
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
    pub opencode_auto_start: bool,
    pub opencode_path: Option<String>,
    pub agent_host: Option<PathBuf>,
    pub service: bool,
    pub test_mode: bool,
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
    nvpn_path: Option<String>,
    mesh_admin_enabled: Option<bool>,
    adb_path: Option<String>,
    transcript_keep_last: Option<u64>,
    tor_proxy_url: Option<String>,
    open_code_server_url: Option<String>,
    open_code_auto_start: Option<bool>,
    open_code_path: Option<String>,
    open_code_port: Option<u16>,
    agent_host_path: Option<String>,
    node_path: Option<String>,
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
    /// SOCKS5 proxy for relay connections only, as `host:port`.
    pub tor_proxy: Option<String>,
    pub transcript_keep_last: Option<usize>,
    /// How the agent host is started.
    pub node_path: String,
    pub agent_host_path: PathBuf,
    pub test_mode: bool,
    /// Environment handed to the agent host (driver settings).
    pub host_env: BTreeMap<String, String>,
    pub adb_path: Option<String>,
    pub nvpn_path: Option<String>,
    pub mesh_admin_enabled: bool,
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

fn user_home() -> PathBuf {
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

/// Where the agent host bundle is by default: `agent-host/main.js` beside the
/// binary (the release layout and the image), else the workspace build.
fn default_agent_host() -> PathBuf {
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("agent-host").join("main.js")));
    match beside {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("packages/agent-host/dist/main.js"),
    }
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
    let cwd = std::env::current_dir().map_err(|e| format!("no working directory: {e}"))?;
    let workspace_roots = non_empty(flags.workspaces.clone())
        .or_else(|| split_list(env("CODEDECK_WORKSPACE_ROOTS")).map(|v| v.into_iter().map(PathBuf::from).collect()))
        .or_else(|| file.workspace_roots.and_then(non_empty).map(|v| v.into_iter().map(PathBuf::from).collect()))
        .unwrap_or_else(|| vec![cwd.clone()])
        .iter()
        .map(|p| absolute(p))
        .collect();
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
    let auto_start = flags.opencode_auto_start || env_bool("CODEDECK_OPENCODE_AUTO_START").or(file.open_code_auto_start).unwrap_or(false);
    put("CODEDECK_OPENCODE_AUTO_START", auto_start.then(|| "1".into()));
    put("CODEDECK_OPENCODE_PATH", flags.opencode_path.clone().or_else(|| env("CODEDECK_OPENCODE_PATH")).or(file.open_code_path));
    put("CODEDECK_OPENCODE_PORT", env("CODEDECK_OPENCODE_PORT").or(file.open_code_port.map(|p| p.to_string())));
    let test_mode = flags.test_mode || env_bool("CODEDECK_TEST_MODE").unwrap_or(false);
    put("CODEDECK_TEST_MODE", test_mode.then(|| "1".into()));
    put("CODEDECK_AGENT_HOST_DRIVERS", env("CODEDECK_AGENT_HOST_DRIVERS"));

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
        node_path: env("CODEDECK_NODE_PATH").or(file.node_path).unwrap_or_else(|| "node".into()),
        agent_host_path: absolute(&agent_host_path),
        test_mode,
        host_env,
        adb_path: env("CODEDECK_ADB_PATH").or(file.adb_path),
        nvpn_path: env("CODEDECK_NVPN_PATH").or(file.nvpn_path),
        mesh_admin_enabled: env_bool("CODEDECK_MESH_ADMIN").or(file.mesh_admin_enabled).unwrap_or(true),
        home,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
