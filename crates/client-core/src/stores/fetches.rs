//! `fetches` — which on-request answers from a bridge are still fresh, so a
//! screen that asks again sends nothing.
//!
//! A bridge answers model lists and provider profiles only when asked; the
//! screens that show them ask each time they open. What an answer is good
//! for depends on how it can change:
//! - provider profiles: the bridge pushes the new list to every phone
//!   whenever one changes, so an answer holds for the whole connection;
//! - a model list can change without a push (the agent learns of a new
//!   model), so it holds for [`MODELS_FRESH_FOR_MS`] — and not at all after
//!   the machine's credentials change ([`Fetches::forget_models`]).
//!
//! A reconnect may have missed a push, so it forgets everything
//! ([`Fetches::forget_all`]). In memory only: a fresh process asks again.

use std::collections::BTreeMap;

/// A request whose answer is worth keeping for a while.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fetch {
    ProviderProfiles,
    /// One agent's model list.
    Models(String),
}

/// How long an agent's model list counts as current.
pub const MODELS_FRESH_FOR_MS: u64 = 5 * 60_000;

/// A request unanswered for this long may have been lost: asking again is
/// allowed.
pub const FETCH_RETRY_AFTER_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Sent at this time (ms), no answer yet.
    InFlight(u64),
    /// Answered at this time (ms).
    Answered(u64),
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fetches {
    entries: BTreeMap<(String, Fetch), State>,
}

impl Fetches {
    /// Whether to send `fetch` to `machine` now; when it says yes it counts
    /// the request as sent. No while a fresh answer is held or a request is
    /// under [`FETCH_RETRY_AFTER_MS`] old.
    pub fn should_request(&mut self, machine: &str, fetch: Fetch, now: u64) -> bool {
        let fresh_for = match fetch {
            Fetch::ProviderProfiles => u64::MAX,
            Fetch::Models(_) => MODELS_FRESH_FOR_MS,
        };
        let key = (machine.to_string(), fetch);
        let skip = match self.entries.get(&key) {
            Some(State::Answered(at)) => now.saturating_sub(*at) < fresh_for,
            Some(State::InFlight(at)) => now.saturating_sub(*at) < FETCH_RETRY_AFTER_MS,
            None => false,
        };
        if !skip {
            self.entries.insert(key, State::InFlight(now));
        }
        !skip
    }

    /// `machine` answered `fetch` at `now`.
    pub fn answered(&mut self, machine: &str, fetch: Fetch, now: u64) {
        self.entries.insert((machine.to_string(), fetch), State::Answered(now));
    }

    /// Ask again next time (an answer that was an error, say).
    pub fn forget(&mut self, machine: &str, fetch: Fetch) {
        self.entries.remove(&(machine.to_string(), fetch));
    }

    /// `machine`'s model lists may have changed (its credentials did).
    pub fn forget_models(&mut self, machine: &str) {
        self.entries.retain(|(m, f), _| !(m == machine && matches!(f, Fetch::Models(_))));
    }

    /// A new connection: pushes may have been missed while away.
    pub fn forget_all(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_profiles_hold_for_the_connection_and_a_lost_request_is_retried() {
        let mut f = Fetches::default();
        assert!(f.should_request("m", Fetch::ProviderProfiles, 0));
        assert!(!f.should_request("m", Fetch::ProviderProfiles, 1_000), "in flight");
        assert!(f.should_request("m", Fetch::ProviderProfiles, FETCH_RETRY_AFTER_MS), "presumed lost");
        f.answered("m", Fetch::ProviderProfiles, FETCH_RETRY_AFTER_MS);
        assert!(!f.should_request("m", Fetch::ProviderProfiles, 100 * MODELS_FRESH_FOR_MS), "pushed on change");
        assert!(f.should_request("other", Fetch::ProviderProfiles, 0), "per machine");

        f.forget_all();
        assert!(f.should_request("m", Fetch::ProviderProfiles, 0), "a reconnect asks again");
    }

    #[test]
    fn a_model_list_goes_stale_and_new_credentials_retire_it() {
        let mut f = Fetches::default();
        let claude = || Fetch::Models("claude".into());
        f.answered("m", claude(), 0);
        f.answered("m", Fetch::ProviderProfiles, 0);
        assert!(!f.should_request("m", claude(), MODELS_FRESH_FOR_MS - 1));
        assert!(f.should_request("m", claude(), MODELS_FRESH_FOR_MS), "stale");
        assert!(f.should_request("m", Fetch::Models("opencode".into()), 0), "per agent");

        f.answered("m", claude(), 0);
        f.forget_models("m");
        assert!(f.should_request("m", claude(), 0));
        assert!(!f.should_request("m", Fetch::ProviderProfiles, 0), "profiles are kept");
    }
}
