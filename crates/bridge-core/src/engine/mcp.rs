//! MCP servers: an agent's library on this machine (`mcp-request`,
//! `mcp-action`) and the servers of one running session
//! (`session-mcp-request`, `session-mcp-toggle`).
//!
//! The bridge keeps no MCP state. The agent's own configuration is the
//! library and the running agent knows its session's servers; the bridge
//! checks what a phone asks, hands it to the host, and relays the answer to
//! every phone. The secrets a server is added with (env and header values)
//! go to the host as [`agent_protocol::Secret`]s and nothing here logs them.

use agent_protocol::{BridgeMessage, HostMessage, McpServerAdd};
use protocol::commands::{McpActionMsg, SessionMcpToggleMsg};
use protocol::common::{is_valid_mcp_name, McpAction, MCP_NAME_ERROR};
use protocol::events::{BridgeToPhone, McpAckMsg, McpServersMsg, SessionMcpMsg};

use super::{Engine, HostCall};

/// Servers one `add` may carry: an import of a whole config, not a flood.
const MAX_SERVERS_PER_ADD: usize = 50;

const HOST_DOWN: &str = "The agent host is not running — try again in a moment.";

impl Engine {
    /// Why `agent`'s MCP servers cannot be managed here, if they cannot.
    fn mcp_unusable(&self, agent: &str) -> Option<String> {
        match self.catalog.usable(agent) {
            Err(reason) => Some(reason),
            Ok(a) if !a.supports.mcp => Some(format!("{} has no MCP servers to manage.", a.display_name)),
            Ok(_) => None,
        }
    }

    pub(super) fn on_mcp_request(&mut self, agent: String) {
        let error = self.mcp_unusable(&agent).or_else(|| {
            let sent = self.call(HostCall::ListMcp { agent: agent.clone() }, BridgeMessage::ListMcp { agent: agent.clone() });
            sent.is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] mcp-request: {error}");
            self.publish_all(BridgeToPhone::McpServers(mcp_error(agent, error)));
        }
    }

    /// Every server is checked with the same rules the phone applies before
    /// sending; one bad server refuses the whole action, so nothing is half
    /// done.
    pub(super) fn on_mcp_action(&mut self, m: McpActionMsg) {
        let McpActionMsg { agent, action, servers, names, .. } = m;
        let names: Vec<String> = match action {
            McpAction::Add => servers.iter().map(|s| s.name.clone()).collect(),
            _ => names,
        };
        let malformed = match action {
            McpAction::Add if servers.is_empty() => Some("There is no server to add.".to_string()),
            McpAction::Add if servers.len() > MAX_SERVERS_PER_ADD => {
                Some(format!("Add at most {MAX_SERVERS_PER_ADD} servers at once."))
            }
            McpAction::Add => servers.iter().find_map(|s| s.problem()).or_else(|| {
                let mut seen = std::collections::BTreeSet::new();
                names.iter().find(|n| !seen.insert(n.as_str())).map(|n| format!("{n} is listed twice."))
            }),
            _ if names.is_empty() => Some("Name the servers to change.".to_string()),
            _ => names.iter().any(|n| !is_valid_mcp_name(n)).then(|| MCP_NAME_ERROR.to_string()),
        };
        let error = malformed.or_else(|| self.mcp_unusable(&agent)).or_else(|| {
            let (servers, host_names) = match action {
                McpAction::Add => (servers.into_iter().map(McpServerAdd::from).collect(), vec![]),
                _ => (vec![], names.clone()),
            };
            let call = HostCall::McpAction { agent: agent.clone(), action, names: names.clone() };
            let message = BridgeMessage::McpAction { agent: agent.clone(), action, servers, names: host_names };
            self.call(call, message).is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] mcp-action {action:?} {names:?}: {error}");
            self.publish_all(BridgeToPhone::McpAck(McpAckMsg { agent, action, names, success: false, error: Some(error) }));
        }
    }

    /// Why `session_id`'s MCP servers cannot be asked about, if they cannot.
    fn session_mcp_unusable(&self, session_id: &str) -> Option<String> {
        let Some(session) = self.sessions.get(session_id) else {
            return Some("The bridge has no such session.".into());
        };
        if !self.catalog.get(&session.rec.agent).is_some_and(|a| a.supports.mcp) {
            return Some("This agent has no MCP servers.".into());
        }
        if !self.is_running(session_id) {
            return Some("The session is not running — its MCP servers are shown once it is.".into());
        }
        None
    }

    pub(super) fn on_session_mcp_request(&mut self, session_id: String) {
        let error = self.session_mcp_unusable(&session_id).or_else(|| {
            let call = HostCall::SessionMcp { session_id: session_id.clone() };
            let sent = self.call(call, BridgeMessage::SessionMcp { session_id: session_id.clone() });
            sent.is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] session-mcp-request for {session_id}: {error}");
            self.publish_all(BridgeToPhone::SessionMcp(session_mcp_error(session_id, error)));
        }
    }

    pub(super) fn on_session_mcp_toggle(&mut self, m: SessionMcpToggleMsg) {
        let SessionMcpToggleMsg { session_id, name, enabled, .. } = m;
        let error = (!is_valid_mcp_name(&name))
            .then(|| MCP_NAME_ERROR.to_string())
            .or_else(|| self.session_mcp_unusable(&session_id))
            .or_else(|| {
                let call = HostCall::SessionMcp { session_id: session_id.clone() };
                let message = BridgeMessage::SessionMcpToggle { session_id: session_id.clone(), name: name.clone(), enabled };
                self.call(call, message).is_none().then(|| HOST_DOWN.to_string())
            });
        if let Some(error) = error {
            log::info!("[Engine] session-mcp-toggle {name} for {session_id}: {error}");
            self.publish_all(BridgeToPhone::SessionMcp(session_mcp_error(session_id, error)));
        }
    }

    pub(super) fn on_mcp_reply(&mut self, agent: String, result: Result<HostMessage, String>) {
        let msg = match result {
            Ok(HostMessage::McpServers { servers, toggles }) => McpServersMsg { agent, servers, toggles, error: None },
            Ok(_) => mcp_error(agent, "The agent gave no MCP server list.".into()),
            Err(err) => mcp_error(agent, format!("Could not list the MCP servers: {err}")),
        };
        if let Some(error) = &msg.error {
            log::info!("[Engine] mcp-request: {error}");
        }
        self.publish_all(BridgeToPhone::McpServers(msg));
    }

    /// A done action is acknowledged, then the new list goes out, so every
    /// phone showing the servers sees the change.
    pub(super) fn on_mcp_action_reply(
        &mut self,
        agent: String,
        action: McpAction,
        names: Vec<String>,
        result: Result<HostMessage, String>,
    ) {
        let (list, error) = match result {
            Ok(HostMessage::McpServers { servers, toggles }) => {
                (Some(McpServersMsg { agent: agent.clone(), servers, toggles, error: None }), None)
            }
            Ok(_) => (None, Some("The agent gave no answer to the change.".to_string())),
            Err(err) => (None, Some(err)),
        };
        match &error {
            Some(error) => log::info!("[Engine] mcp-action {action:?} {names:?}: {error}"),
            None => log::info!("[Engine] mcp-action {action:?} {names:?}: done"),
        }
        self.publish_all(BridgeToPhone::McpAck(McpAckMsg { agent, action, names, success: error.is_none(), error }));
        if let Some(list) = list {
            self.publish_all(BridgeToPhone::McpServers(list));
        }
    }

    pub(super) fn on_session_mcp_reply(&mut self, session_id: String, result: Result<HostMessage, String>) {
        let msg = match result {
            Ok(HostMessage::SessionMcp { servers, toggles, project_wide }) => {
                SessionMcpMsg { session_id, servers, toggles, project_wide, error: None }
            }
            Ok(_) => session_mcp_error(session_id, "The agent gave no MCP server status.".into()),
            Err(err) => session_mcp_error(session_id, err),
        };
        if let Some(error) = &msg.error {
            log::info!("[Engine] session-mcp for {}: {error}", msg.session_id);
        }
        self.publish_all(BridgeToPhone::SessionMcp(msg));
    }
}

fn mcp_error(agent: String, error: String) -> McpServersMsg {
    McpServersMsg { agent, servers: vec![], toggles: false, error: Some(error) }
}

fn session_mcp_error(session_id: String, error: String) -> SessionMcpMsg {
    SessionMcpMsg { session_id, servers: vec![], toggles: false, project_wide: false, error: Some(error) }
}
