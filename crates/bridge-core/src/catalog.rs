//! The agents this bridge can run, as the agent host reported them, and the
//! answers the engine needs from that list: is this agent usable, is this
//! one of its modes, what does the phone see.

use agent_protocol::AgentInfo;
use protocol::common::{AgentDescriptor, AgentInstall, CredentialStatus};

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

    /// One agent's entry changed (`agent-changed`): it replaces the one the
    /// host reported before, or joins the list.
    pub fn update(&mut self, agent: AgentInfo) {
        match self.agents.iter_mut().find(|a| a.id == agent.id) {
            Some(entry) => *entry = agent,
            None => self.agents.push(agent),
        }
    }

    pub fn get(&self, id: &str) -> Option<&AgentInfo> {
        self.agents.iter().find(|a| a.id == id)
    }

    pub fn all(&self) -> &[AgentInfo] {
        &self.agents
    }

    /// The agent, when this bridge has it (usable now or not); otherwise why
    /// it cannot say.
    pub fn known(&self, id: &str) -> Result<&AgentInfo, String> {
        if !self.known {
            return Err("The agent host is not running yet — try again in a moment.".into());
        }
        self.get(id).ok_or_else(|| format!("This bridge has no agent '{id}'."))
    }

    /// The agent, when sessions can run on it; otherwise why not.
    pub fn usable(&self, id: &str) -> Result<&AgentInfo, String> {
        let agent = self.known(id)?;
        let name = &agent.display_name;
        match (&agent.install, &agent.unavailable_reason) {
            (AgentInstall::Ready { .. }, None) => Ok(agent),
            (AgentInstall::Ready { .. }, Some(reason)) => Err(reason.clone()),
            (AgentInstall::NotInstalled {}, _) => {
                Err(format!("{name} is not installed on this machine — install it from the list of agents."))
            }
            (AgentInstall::Installing {}, _) => Err(format!("{name} is still being installed.")),
            (AgentInstall::Failed { reason }, _) => Err(format!("{name} could not be installed: {reason}")),
            (AgentInstall::Unknown, _) => Err(format!("{name} is in an install state this bridge does not know.")),
        }
    }

    /// The agent is being installed: a session of it waits rather than fail.
    pub fn installing(&self, id: &str) -> bool {
        self.get(id).is_some_and(|a| matches!(a.install, AgentInstall::Installing {}))
    }

    /// What the heartbeat advertises: every agent the phone can run or
    /// install — not one that is installed but cannot run here — with the
    /// status of its credentials.
    pub fn descriptors(&self, credentials: impl Fn(&AgentInfo) -> Vec<CredentialStatus>) -> Vec<AgentDescriptor> {
        self.agents
            .iter()
            .filter(|a| !(a.install.is_ready() && a.unavailable_reason.is_some()))
            .map(|a| AgentDescriptor {
                id: a.id.clone(),
                display_name: a.display_name.clone(),
                modes: a.modes.clone(),
                efforts: a.efforts.clone(),
                default_mode: a.default_mode.clone(),
                default_effort: a.default_effort.clone(),
                supports: a.supports.clone(),
                credentials: credentials(a),
                install: a.install.clone(),
            })
            .collect()
    }
}

pub(crate) fn is_mode(agent: &AgentInfo, mode: &str) -> bool {
    agent.modes.iter().any(|m| m.id == mode)
}

/// Whether `effort` may be asked of `agent`: one of its levels, or — for an
/// agent that lists none of its own, its levels differing by model
/// (`ModelEntry.efforts`) — any, which the agent itself checks.
pub(crate) fn is_effort(agent: &AgentInfo, effort: &str) -> bool {
    agent.efforts.is_empty() || agent.efforts.iter().any(|e| e.id == effort)
}
