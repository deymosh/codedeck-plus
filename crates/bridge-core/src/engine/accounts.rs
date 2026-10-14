//! Agent accounts: the providers an agent can be given access to on this
//! machine — a key, or a sign-in to a subscription (`accounts-request`,
//! `account-action`).
//!
//! The bridge keeps no account state: the agent's own store holds the keys
//! and tokens, and they never come back out of it. The bridge checks what a
//! phone asks, hands it to the host — the key and a pasted sign-in address
//! as [`agent_protocol::Secret`]s, never logged — and answers the client that
//! asked. The one thing it remembers is who started each sign-in, so the
//! host's word that it ended reaches that client.

use agent_protocol::{AccountChange, BridgeMessage, HostMessage};
use protocol::common::{AccountAction, SignInStatus};
use protocol::events::{AccountSignInMsg, AccountsMsg, BridgeToPhone};

use super::{Engine, HostCall};
use crate::io::Addressee;

/// The longest id, method, label or answer a phone may send.
const MAX_FIELD_LEN: usize = 256;
/// The longest key: provider keys are a few hundred bytes at most.
const MAX_KEY_LEN: usize = 8 * 1024;
/// The longest pasted sign-in address.
const MAX_CALLBACK_LEN: usize = 8 * 1024;
const MAX_ANSWERS: usize = 20;
/// Sign-ins waiting to end at once. A sign-in lapses on its own within
/// minutes, so an older one forgotten past this many is long over.
const MAX_SIGN_INS: usize = 16;

const HOST_DOWN: &str = "The agent host is not running — try again in a moment.";

/// A sign-in the host is watching, and the client waiting on its end.
#[derive(Debug, Clone)]
pub(crate) struct SignIn {
    pub attempt_id: String,
    pub agent: String,
    pub account: String,
    pub to: Addressee,
}

/// What an `account-action` is waiting on: a list, or a sign-in's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccountReply {
    List,
    SignIn,
}

impl Engine {
    /// Why `agent`'s accounts cannot be reached here, if they cannot.
    fn accounts_unusable(&self, agent: &str) -> Option<String> {
        match self.catalog.usable(agent) {
            Err(reason) => Some(reason),
            Ok(a) if !a.supports.accounts => Some(format!("{} has no accounts to connect here.", a.display_name)),
            Ok(_) => None,
        }
    }

    pub(super) fn on_accounts_request(&mut self, agent: String, all: bool, phone: &str) {
        let to = self.reply_to(phone);
        let error = self.accounts_unusable(&agent).or_else(|| {
            let call = HostCall::Accounts { agent: agent.clone(), all, to: to.clone() };
            let sent = self.call(call, BridgeMessage::ListAccounts { agent: agent.clone(), all });
            sent.is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] accounts-request: {error}");
            self.out.publish_addressed(vec![to], BridgeToPhone::Accounts(accounts_error(agent, all, error)));
        }
    }

    pub(super) fn on_account_action(&mut self, agent: String, account: String, action: AccountAction, phone: &str) {
        let to = self.reply_to(phone);
        let reply = match action {
            AccountAction::SignIn { .. } | AccountAction::Finish { .. } | AccountAction::Cancel { .. } => AccountReply::SignIn,
            _ => AccountReply::List,
        };
        let attempt_id = match &action {
            AccountAction::Finish { attempt, .. } | AccountAction::Cancel { attempt } => Some(attempt.clone()),
            _ => None,
        };
        let error = action_problem(&account, &action).or_else(|| self.accounts_unusable(&agent)).or_else(|| {
            let call = HostCall::AccountAction { agent: agent.clone(), account: account.clone(), reply, to: to.clone() };
            let change = AccountChange::from(action);
            log::info!("[Engine] account-action on {agent}/{account}");
            let message = BridgeMessage::AccountAction { agent: agent.clone(), account: account.clone(), change };
            self.call(call, message).is_none().then(|| HOST_DOWN.to_string())
        });
        if let Some(error) = error {
            log::info!("[Engine] account-action on {agent}/{account}: {error}");
            let msg = match reply {
                AccountReply::List => BridgeToPhone::Accounts(accounts_error(agent, false, error)),
                AccountReply::SignIn => BridgeToPhone::AccountSignIn(sign_in_failed(agent, account, attempt_id, error)),
            };
            self.out.publish_addressed(vec![to], msg);
        }
    }

    pub(super) fn on_accounts_reply(&mut self, agent: String, all: bool, to: Addressee, result: Result<HostMessage, String>) {
        let msg = match result {
            Ok(HostMessage::Accounts { accounts }) => AccountsMsg { agent, accounts, all, error: None },
            Ok(_) => accounts_error(agent, all, "The agent gave no account list.".into()),
            Err(err) => accounts_error(agent, all, err),
        };
        if let Some(error) = &msg.error {
            log::info!("[Engine] accounts: {error}");
        }
        self.out.publish_addressed(vec![to], BridgeToPhone::Accounts(msg));
    }

    pub(super) fn on_account_action_reply(
        &mut self,
        agent: String,
        account: String,
        reply: AccountReply,
        to: Addressee,
        result: Result<HostMessage, String>,
    ) {
        let msg = match (reply, result) {
            (_, Ok(HostMessage::Accounts { accounts })) => BridgeToPhone::Accounts(AccountsMsg { agent, accounts, all: false, error: None }),
            (_, Ok(HostMessage::AccountSignIn { status, attempt_id, attempt, error })) => {
                if status == SignInStatus::Started {
                    self.remember_sign_in(SignIn { attempt_id: attempt_id.clone(), agent: agent.clone(), account: account.clone(), to: to.clone() });
                } else {
                    self.sign_ins.retain(|s| s.attempt_id != attempt_id);
                }
                BridgeToPhone::AccountSignIn(AccountSignInMsg { agent, account, status, attempt_id: Some(attempt_id), attempt, error })
            }
            (AccountReply::List, Ok(_)) => BridgeToPhone::Accounts(accounts_error(agent, false, "The agent gave no answer to the change.".into())),
            (AccountReply::SignIn, Ok(_)) => {
                BridgeToPhone::AccountSignIn(sign_in_failed(agent, account, None, "The agent gave no answer to the sign-in.".into()))
            }
            (AccountReply::List, Err(err)) => BridgeToPhone::Accounts(accounts_error(agent, false, err)),
            (AccountReply::SignIn, Err(err)) => BridgeToPhone::AccountSignIn(sign_in_failed(agent, account, None, err)),
        };
        self.out.publish_addressed(vec![to], msg);
    }

    /// The host's word that a sign-in ended, for the client that started it.
    /// One the bridge no longer knows (forgotten, or started before a
    /// restart) has no one waiting on it.
    pub(super) fn on_account_sign_in_ended(
        &mut self,
        attempt_id: String,
        status: SignInStatus,
        error: Option<String>,
    ) {
        let Some(at) = self.sign_ins.iter().position(|s| s.attempt_id == attempt_id) else {
            log::info!("[Engine] A sign-in no client is waiting on ended ({status:?})");
            return;
        };
        let SignIn { agent, account, to, .. } = self.sign_ins.remove(at);
        log::info!("[Engine] Sign-in to {agent}/{account} ended: {status:?}");
        let msg = AccountSignInMsg { agent, account, status, attempt_id: Some(attempt_id), attempt: None, error };
        self.out.publish_addressed(vec![to], BridgeToPhone::AccountSignIn(msg));
    }

    /// The host stopped, and every sign-in it was watching with it.
    pub(super) fn fail_sign_ins(&mut self, reason: &str) {
        for SignIn { attempt_id, agent, account, to } in std::mem::take(&mut self.sign_ins) {
            let msg = sign_in_failed(agent, account, Some(attempt_id), reason.to_string());
            self.out.publish_addressed(vec![to], BridgeToPhone::AccountSignIn(msg));
        }
    }

    fn remember_sign_in(&mut self, sign_in: SignIn) {
        self.sign_ins.retain(|s| s.attempt_id != sign_in.attempt_id);
        if self.sign_ins.len() >= MAX_SIGN_INS {
            self.sign_ins.remove(0);
        }
        self.sign_ins.push(sign_in);
    }
}

/// What is wrong with an action before it reaches the host, if anything.
/// The host checks a pasted address against the sign-in's own; this only
/// refuses what could never be one.
fn action_problem(account: &str, action: &AccountAction) -> Option<String> {
    let bad = |s: &str| s.is_empty() || s.len() > MAX_FIELD_LEN;
    if bad(account) {
        return Some("That is not an account of this agent.".into());
    }
    let answers_ok = |answers: &std::collections::BTreeMap<String, String>| {
        answers.len() <= MAX_ANSWERS && answers.iter().all(|(k, v)| !bad(k) && v.len() <= MAX_FIELD_LEN)
    };
    let label_ok = |label: &Option<String>| label.as_ref().is_none_or(|l| l.len() <= MAX_FIELD_LEN);
    match action {
        AccountAction::Key { method, key, label, answers } => {
            if bad(method) || !label_ok(label) || !answers_ok(answers) {
                Some("The account's form is not filled in right.".into())
            } else if key.trim().is_empty() {
                Some("There is no key to keep.".into())
            } else if key.len() > MAX_KEY_LEN {
                Some("That is too long to be a key.".into())
            } else {
                None
            }
        }
        AccountAction::SignIn { method, label, answers } => {
            (bad(method) || !label_ok(label) || !answers_ok(answers)).then(|| "The account's form is not filled in right.".into())
        }
        AccountAction::Finish { attempt, callback_url } => {
            if bad(attempt) {
                Some("There is no such sign-in.".into())
            } else if callback_url.len() > MAX_CALLBACK_LEN || !is_loopback_http(callback_url) {
                Some("Paste the address the browser could not open — it starts with http://127.0.0.1 or http://localhost.".into())
            } else {
                None
            }
        }
        AccountAction::Cancel { attempt } => bad(attempt).then(|| "There is no such sign-in.".into()),
        AccountAction::Activate { connection } | AccountAction::Remove { connection } => {
            bad(connection).then(|| "There is no such connection.".into())
        }
    }
}

/// An `http://` address on this machine's loopback: the only kind a pasted
/// sign-in address may be.
fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.trim().strip_prefix("http://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // A user-info part would let `127.0.0.1@elsewhere` pass a prefix check.
    if host.contains('@') {
        return false;
    }
    let name = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

fn accounts_error(agent: String, all: bool, error: String) -> AccountsMsg {
    AccountsMsg { agent, accounts: vec![], all, error: Some(error) }
}

fn sign_in_failed(agent: String, account: String, attempt_id: Option<String>, error: String) -> AccountSignInMsg {
    AccountSignInMsg { agent, account, status: SignInStatus::Failed, attempt_id, attempt: None, error: Some(error) }
}

#[cfg(test)]
mod tests {
    use super::is_loopback_http;

    #[test]
    fn only_a_loopback_http_address_may_be_pasted() {
        assert!(is_loopback_http("http://127.0.0.1:1455/auth/callback?code=x&state=y"));
        assert!(is_loopback_http("http://localhost:8080/cb"));
        assert!(is_loopback_http("http://[::1]:9/cb"));
        assert!(!is_loopback_http("https://127.0.0.1:1/cb"));
        assert!(!is_loopback_http("http://127.0.0.1@evil.example/cb"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.example/cb"));
        assert!(!is_loopback_http("http://10.0.0.1/cb"));
        assert!(!is_loopback_http("file:///etc/passwd"));
    }
}
