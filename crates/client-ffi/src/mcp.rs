//! MCP servers across the FFI: the record an app builds a server in (from
//! its form or from an import), and the core's import parser and checks,
//! so the app applies exactly the rules the core and the bridge do.

use std::collections::{BTreeMap, HashMap};

use client_runtime::client_core::mcp_import::parse_mcp_import;
use protocol::common::{McpServerSpec, McpTransport};

/// One MCP server to add. `transport`: `stdio` (uses `command`, `args`,
/// `env`) or `http` / `sse` (use `url`, `headers`). The env and header
/// values are secrets: `Debug` names only their keys.
#[derive(Clone, uniffi::Record)]
pub struct UniffiMcpServerSpec {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub url: String,
    pub headers: HashMap<String, String>,
}

impl std::fmt::Debug for UniffiMcpServerSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fn keys(m: &HashMap<String, String>) -> Vec<&String> {
            let mut k: Vec<&String> = m.keys().collect();
            k.sort();
            k
        }
        f.debug_struct("UniffiMcpServerSpec")
            .field("name", &self.name)
            .field("transport", &self.transport)
            .field("command", &self.command)
            .field("args", &self.args.len())
            .field("env", &keys(&self.env))
            .field("url", &protocol::common::redact_url(&self.url))
            .field("headers", &keys(&self.headers))
            .finish()
    }
}

impl UniffiMcpServerSpec {
    /// The wire's server; `Err` names an unknown transport.
    pub fn to_spec(&self) -> Result<McpServerSpec, String> {
        let sorted = |m: &HashMap<String, String>| m.iter().map(|(k, v)| (k.trim().to_string(), v.clone())).collect::<BTreeMap<_, _>>();
        let url = self.url.trim().to_string();
        let transport = match self.transport.as_str() {
            "stdio" => McpTransport::Stdio { command: self.command.trim().to_string(), args: self.args.clone(), env: sorted(&self.env) },
            "http" => McpTransport::Http { url, headers: sorted(&self.headers) },
            "sse" => McpTransport::Sse { url, headers: sorted(&self.headers) },
            other => return Err(format!("{other:?} is not an MCP transport.")),
        };
        Ok(McpServerSpec { name: self.name.trim().to_string(), transport })
    }

    fn from_spec(spec: McpServerSpec) -> Self {
        let map = |m: BTreeMap<String, String>| m.into_iter().collect::<HashMap<_, _>>();
        let mut out = Self {
            name: spec.name,
            transport: String::new(),
            command: String::new(),
            args: vec![],
            env: HashMap::new(),
            url: String::new(),
            headers: HashMap::new(),
        };
        match spec.transport {
            McpTransport::Stdio { command, args, env } => {
                out.transport = "stdio".into();
                out.command = command;
                out.args = args;
                out.env = map(env);
            }
            McpTransport::Http { url, headers } => {
                out.transport = "http".into();
                out.url = url;
                out.headers = map(headers);
            }
            McpTransport::Sse { url, headers } => {
                out.transport = "sse".into();
                out.url = url;
                out.headers = map(headers);
            }
        }
        out
    }
}

/// One entry of an import that cannot be added, and why.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMcpImportProblem {
    pub name: String,
    pub reason: String,
}

/// What pasted JSON holds: the servers that can be added and the entries
/// that cannot; `error` when it is not a server list at all.
#[derive(Debug, Clone, uniffi::Record)]
pub struct UniffiMcpImport {
    pub servers: Vec<UniffiMcpServerSpec>,
    pub problems: Vec<UniffiMcpImportProblem>,
    pub error: Option<String>,
}

/// Parse MCP server JSON as other clients write it (`{"mcpServers": …}`,
/// VS Code's `servers`, OpenCode's `mcp`, or a bare name → config map).
#[uniffi::export]
fn mcp_import(text: String) -> UniffiMcpImport {
    match parse_mcp_import(&text) {
        Ok(found) => UniffiMcpImport {
            servers: found.servers.into_iter().map(UniffiMcpServerSpec::from_spec).collect(),
            problems: found.problems.into_iter().map(|(name, reason)| UniffiMcpImportProblem { name, reason }).collect(),
            error: None,
        },
        Err(error) => UniffiMcpImport { servers: vec![], problems: vec![], error: Some(error) },
    }
}

/// Why `spec` cannot be added, if it cannot — the rule the bridge applies.
#[uniffi::export]
fn mcp_server_problem(spec: UniffiMcpServerSpec) -> Option<String> {
    match spec.to_spec() {
        Ok(s) => s.problem(),
        Err(e) => Some(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_import_crosses_with_its_values_and_debug_hides_them() {
        let found = mcp_import(r#"{"mcpServers":{"gh":{"url":"https://x/mcp","headers":{"Authorization":"Bearer sk-1"}}}}"#.into());
        assert!(found.error.is_none() && found.problems.is_empty());
        let gh = &found.servers[0];
        assert_eq!((gh.transport.as_str(), gh.headers["Authorization"].as_str()), ("http", "Bearer sk-1"));
        assert!(!format!("{gh:?}").contains("sk-1"));
        assert_eq!(gh.to_spec().unwrap().problem(), None);
        assert!(mcp_import("{}".into()).error.is_some());
    }

    #[test]
    fn a_form_is_checked_with_the_bridges_rules() {
        let spec = |transport: &str, url: &str| UniffiMcpServerSpec {
            name: "gh".into(),
            transport: transport.into(),
            command: String::new(),
            args: vec![],
            env: HashMap::new(),
            url: url.into(),
            headers: HashMap::new(),
        };
        assert_eq!(mcp_server_problem(spec("http", "https://x/mcp")), None);
        assert!(mcp_server_problem(spec("http", "ftp://x")).is_some());
        assert!(mcp_server_problem(spec("websocket", "wss://x")).is_some());
        assert!(mcp_server_problem(spec("stdio", "")).is_some(), "stdio needs a command");
    }
}
