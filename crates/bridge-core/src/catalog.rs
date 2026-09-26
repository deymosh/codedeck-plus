//! The agents this bridge can run, as the agent host reported them, and the
//! answers the engine needs from that list: is this agent usable, is this
//! one of its modes, what does the phone see.

use agent_protocol::AgentInfo;
use protocol::common::{AgentDescriptor, CredentialStatus};

#[derive(Default)]
pub(crate) struct Catalog {
    agents: Vec<AgentInfo>,
    /// The host has reported at least once. Kept across host restarts, so
    /// the phone's pickers do not blink while the host comes back.
    known: bool,
}

impl Catalog {
    pub fn set(&mut self, agents: Vec<AgentInfo>) {
        self.agents = agents;
        self.known = true;
    }

    pub fn get(&self, id: &str) -> Option<&AgentInfo> {
        self.agents.iter().find(|a| a.id == id)
    }

    /// The agent, when sessions can run on it; otherwise why not.
    pub fn usable(&self, id: &str) -> Result<&AgentInfo, String> {
        if !self.known {
            return Err("The agent host is not running yet — try again in a moment.".into());
        }
        let agent = self.get(id).ok_or_else(|| format!("This bridge has no agent '{id}'."))?;
        match &agent.unavailable_reason {
            Some(reason) => Err(reason.clone()),
            None => Ok(agent),
        }
    }

    /// What the heartbeat advertises: every usable agent, with the status of
    /// its credentials.
    pub fn descriptors(&self, credentials: impl Fn(&AgentInfo) -> Vec<CredentialStatus>) -> Vec<AgentDescriptor> {
        self.agents
            .iter()
            .filter(|a| a.unavailable_reason.is_none())
            .map(|a| AgentDescriptor {
                id: a.id.clone(),
                display_name: a.display_name.clone(),
                modes: a.modes.clone(),
                efforts: a.efforts.clone(),
                default_mode: a.default_mode.clone(),
                default_effort: a.default_effort.clone(),
                supports: a.supports.clone(),
                credentials: credentials(a),
            })
            .collect()
    }
}

pub(crate) fn is_mode(agent: &AgentInfo, mode: &str) -> bool {
    agent.modes.iter().any(|m| m.id == mode)
}

pub(crate) fn is_effort(agent: &AgentInfo, effort: &str) -> bool {
    agent.efforts.iter().any(|e| e.id == effort)
}
