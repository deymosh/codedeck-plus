//! Saved permission rules: what an agent keeps from "always allow" answers
//! (`permission-rules-request`, `permission-rules-remove`).
//!
//! The bridge keeps no rule state. The agent's own store is the list; the
//! bridge checks what a phone asks, hands it to the host, and answers the
//! client that asked — only the page that asked shows the rules, so no other
//! client is sent them.

use agent_protocol::{BridgeMessage, HostMessage};
use protocol::events::{BridgeToPhone, PermissionRulesMsg};

use super::{Engine, HostCall};
use crate::io::Addressee;

/// Rules one remove may name: a whole list cleared at once, not a flood.
const MAX_IDS_PER_REMOVE: usize = 200;
/// The longest id a rule may have; agents' ids are short opaque strings.
const MAX_ID_LEN: usize = 256;

const HOST_DOWN: &str = "The agent host is not running — try again in a moment.";

impl Engine {
    /// Why `agent`'s saved rules cannot be reached here, if they cannot.
    fn permission_rules_unusable(&self, agent: &str) -> Option<String> {
        match self.catalog.usable(agent) {
            Err(reason) => Some(reason),
            Ok(a) if !a.supports.permission_rules => Some(format!("{} keeps no permission rules.", a.display_name)),
            Ok(_) => None,
        }
    }

    pub(super) fn on_permission_rules_request(&mut self, agent: String, phone: &str) {
        let to = self.reply_to(phone);
        let error = self.permission_rules_unusable(&agent).or_else(|| {
            let call = HostCall::PermissionRules { agent: agent.clone(), to: to.clone() };
            let sent = self.call(call, BridgeMessage::ListPermissionRules { agent: agent.clone() });
            sent.is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] permission-rules-request: {error}");
            self.out.publish_addressed(vec![to], BridgeToPhone::PermissionRules(rules_error(agent, error)));
        }
    }

    pub(super) fn on_permission_rules_remove(&mut self, agent: String, ids: Vec<String>, phone: &str) {
        let to = self.reply_to(phone);
        let mut unique: Vec<String> = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let malformed = if unique.is_empty() {
            Some("Name the rules to remove.".to_string())
        } else if unique.len() > MAX_IDS_PER_REMOVE {
            Some(format!("Remove at most {MAX_IDS_PER_REMOVE} rules at once."))
        } else if unique.iter().any(|id| id.is_empty() || id.len() > MAX_ID_LEN) {
            Some("That is not a rule this agent saved.".to_string())
        } else {
            None
        };
        let error = malformed.or_else(|| self.permission_rules_unusable(&agent)).or_else(|| {
            let count = unique.len();
            let call = HostCall::PermissionRules { agent: agent.clone(), to: to.clone() };
            let sent = self.call(call, BridgeMessage::RemovePermissionRules { agent: agent.clone(), ids: unique });
            log::info!("[Engine] permission-rules-remove: {count} rule(s) of {agent}");
            sent.is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] permission-rules-remove: {error}");
            self.out.publish_addressed(vec![to], BridgeToPhone::PermissionRules(rules_error(agent, error)));
        }
    }

    pub(super) fn on_permission_rules_reply(&mut self, agent: String, to: Addressee, result: Result<HostMessage, String>) {
        let msg = match result {
            Ok(HostMessage::PermissionRules { rules }) => PermissionRulesMsg { agent, rules, error: None },
            Ok(_) => rules_error(agent, "The agent gave no rule list.".into()),
            Err(err) => rules_error(agent, err),
        };
        if let Some(error) = &msg.error {
            log::info!("[Engine] permission-rules: {error}");
        }
        self.out.publish_addressed(vec![to], BridgeToPhone::PermissionRules(msg));
    }
}

fn rules_error(agent: String, error: String) -> PermissionRulesMsg {
    PermissionRulesMsg { agent, rules: vec![], error: Some(error) }
}
