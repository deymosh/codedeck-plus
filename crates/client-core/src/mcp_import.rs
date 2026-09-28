//! MCP server import: turn the JSON people copy from a server's README or
//! another client into [`McpServerSpec`]s. Total — anything that does not
//! parse is a [`McpImport`] problem or an `Err`, never a panic.
//!
//! Accepted shapes (the ones MCP servers document for the common clients):
//! - `{"mcpServers": {name: config}}` — Claude Code / Claude Desktop / Cursor;
//! - `{"servers": {name: config}}` — VS Code;
//! - `{"mcp": {name: config}}` — OpenCode;
//! - a bare `{name: config}` map.
//!
//! A config is a stdio server (`command` as a string or, OpenCode-style, an
//! array whose head is the program; `args`; `env` or `environment`) or a
//! remote one (`url`, `headers`); `type` picks the transport and is inferred
//! when absent: a `command` means stdio, a `url` means streamable HTTP.
//! Non-string env and header values are written as their JSON text.

use std::collections::BTreeMap;

use protocol::common::{McpServerSpec, McpTransport};
use serde_json::{Map, Value};

/// What an import found: the servers that can be added, by name,
/// and each entry that cannot, with the reason, by name.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct McpImport {
    pub servers: Vec<McpServerSpec>,
    pub problems: Vec<(String, String)>,
}

/// Parse `text`. `Err` only when it is not a server list at all.
pub fn parse_mcp_import(text: &str) -> Result<McpImport, String> {
    let root: Value = serde_json::from_str(text.trim()).map_err(|_| "This is not valid JSON.".to_string())?;
    let Value::Object(root) = root else {
        return Err("Paste a JSON object of MCP servers.".into());
    };
    let map = ["mcpServers", "servers", "mcp"]
        .iter()
        .find_map(|k| root.get(*k).and_then(Value::as_object))
        .unwrap_or(&root);
    if looks_like_one_config(map) {
        return Err("This is one server's settings without a name. Add it with the form, or paste it as \
             {\"mcpServers\": {\"name\": …}}."
            .into());
    }
    if map.is_empty() {
        return Err("No MCP servers found in this JSON.".into());
    }
    let mut out = McpImport::default();
    for (name, config) in map {
        match server(name, config) {
            Ok(spec) => match spec.problem() {
                None => out.servers.push(spec),
                Some(p) => out.problems.push((name.clone(), p)),
            },
            Err(p) => out.problems.push((name.clone(), format!("{name}: {p}"))),
        }
    }
    Ok(out)
}

fn looks_like_one_config(map: &Map<String, Value>) -> bool {
    ["command", "url", "type", "args"].iter().any(|k| map.get(*k).is_some_and(|v| !v.is_object()))
}

fn server(name: &str, config: &Value) -> Result<McpServerSpec, String> {
    let Value::Object(c) = config else {
        return Err("its settings are not an object.".into());
    };
    let kind = c.get("type").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let has_command = c.contains_key("command");
    let transport = match kind.as_deref() {
        Some("stdio" | "local") => stdio(c)?,
        Some("http" | "streamable-http" | "streamablehttp" | "remote") => McpTransport::Http { url: url(c)?, headers: strings(c, &["headers"])? },
        Some("sse") => McpTransport::Sse { url: url(c)?, headers: strings(c, &["headers"])? },
        Some(other) => return Err(format!("the transport \"{other}\" is not supported.")),
        None if has_command => stdio(c)?,
        None if c.contains_key("url") => McpTransport::Http { url: url(c)?, headers: strings(c, &["headers"])? },
        None => return Err("it has neither a command nor a URL.".into()),
    };
    Ok(McpServerSpec { name: name.to_string(), transport })
}

fn stdio(c: &Map<String, Value>) -> Result<McpTransport, String> {
    let (command, mut args) = match c.get("command") {
        Some(Value::String(s)) => (s.clone(), Vec::new()),
        Some(Value::Array(parts)) => {
            let parts = string_list(parts).ok_or("its command is not a list of strings.")?;
            let (head, rest) = parts.split_first().ok_or("its command is empty.")?;
            (head.clone(), rest.to_vec())
        }
        _ => return Err("its command is missing.".into()),
    };
    match c.get("args") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => args.extend(string_list(a).ok_or("its args are not a list of strings.")?),
        Some(_) => return Err("its args are not a list.".into()),
    }
    Ok(McpTransport::Stdio { command, args, env: strings(c, &["env", "environment"])? })
}

fn url(c: &Map<String, Value>) -> Result<String, String> {
    c.get("url").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "its URL is missing.".into())
}

fn string_list(items: &[Value]) -> Option<Vec<String>> {
    items.iter().map(|v| v.as_str().map(str::to_string)).collect()
}

/// The first of `keys` present, as a string map.
fn strings(c: &Map<String, Value>, keys: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let Some(v) = keys.iter().find_map(|k| c.get(*k)) else {
        return Ok(BTreeMap::new());
    };
    match v {
        Value::Null => Ok(BTreeMap::new()),
        Value::Object(m) => Ok(m
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string)))
            .collect()),
        _ => Err(format!("its {} is not an object.", keys[0])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(i: &McpImport) -> Vec<&str> {
        i.servers.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn reads_the_claude_and_cursor_shape() {
        let i = parse_mcp_import(
            r#"{"mcpServers": {
                "github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/",
                           "headers": {"Authorization": "Bearer ghp_x"}},
                "fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/w"],
                       "env": {"DEBUG": 1}}
            }}"#,
        )
        .unwrap();
        assert!(i.problems.is_empty(), "{:?}", i.problems);
        assert_eq!(names(&i), ["fs", "github"]);
        assert_eq!(
            i.servers[1].transport,
            McpTransport::Http {
                url: "https://api.githubcopilot.com/mcp/".into(),
                headers: [("Authorization".to_string(), "Bearer ghp_x".to_string())].into(),
            }
        );
        match &i.servers[0].transport {
            McpTransport::Stdio { command, args, env } => {
                assert_eq!(command, "npx");
                assert_eq!(args.len(), 3);
                assert_eq!(env["DEBUG"], "1");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reads_the_vs_code_opencode_and_bare_shapes() {
        let vscode = parse_mcp_import(r#"{"servers": {"a": {"type": "sse", "url": "https://a.example/sse"}}}"#).unwrap();
        assert!(matches!(vscode.servers[0].transport, McpTransport::Sse { .. }));

        let opencode = parse_mcp_import(
            r#"{"mcp": {"b": {"type": "local", "command": ["bunx", "srv", "--port", "1"], "environment": {"K": "v"}},
                        "c": {"type": "remote", "url": "https://c.example/mcp"}}}"#,
        )
        .unwrap();
        assert_eq!(
            opencode.servers[0].transport,
            McpTransport::Stdio {
                command: "bunx".into(),
                args: vec!["srv".into(), "--port".into(), "1".into()],
                env: [("K".to_string(), "v".to_string())].into(),
            }
        );
        assert!(matches!(opencode.servers[1].transport, McpTransport::Http { .. }));

        let bare = parse_mcp_import(r#"{"d": {"url": "https://d.example/mcp"}}"#).unwrap();
        assert_eq!(names(&bare), ["d"]);
    }

    #[test]
    fn a_bad_entry_is_a_problem_the_others_still_import() {
        let i = parse_mcp_import(
            r#"{"mcpServers": {
                "ok": {"command": "uvx", "args": ["srv"]},
                "ws": {"type": "websocket", "url": "wss://x"},
                "nourl": {"type": "http"},
                "bad name": {"command": "x"},
                "ftp": {"url": "ftp://x"},
                "flag": {"command": "--evil"}
            }}"#,
        )
        .unwrap();
        assert_eq!(names(&i), ["ok"]);
        let bad: Vec<&str> = i.problems.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(bad.len(), 5, "{:?}", i.problems);
        for n in ["ws", "nourl", "bad name", "ftp", "flag"] {
            assert!(bad.contains(&n), "{n} in {bad:?}");
        }
    }

    #[test]
    fn not_a_server_list_is_an_error() {
        assert!(parse_mcp_import("nope").is_err());
        assert!(parse_mcp_import("[1]").is_err());
        assert!(parse_mcp_import(r#"{"mcpServers": {}}"#).is_err());
        let one = parse_mcp_import(r#"{"command": "npx", "args": ["srv"]}"#).unwrap_err();
        assert!(one.contains("without a name"), "{one}");
    }
}
