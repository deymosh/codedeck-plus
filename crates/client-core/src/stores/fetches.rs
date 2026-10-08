//! `fetches` — which on-request answers from a bridge are still current, so a
//! screen that asks again sends nothing.
//!
//! A bridge answers model lists and provider profiles only when asked; the
//! screens that show them ask each time they open. What an answer is good
//! for depends on how it can change:
//! - provider profiles: the bridge pushes the new list to every phone
//!   whenever one changes, so an answer holds for the whole connection;
//! - a model list can change without a push (a provider profile was added,
//!   the agent learned of a new model), so it is asked for every time a
//!   screen needs it — only a request still in flight is not repeated.
//!
//! A reconnect may have missed a push, so it forgets everything
//! ([`Fetches::forget_all`]). In memory only: a fresh process asks again.

use std::collections::BTreeMap;

/// A request whose answer, or whose pending answer, is worth remembering.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fetch {
    ProviderProfiles,
    /// One agent's model list.
    Models(String),
}

/// A request unanswered for this long may have been lost: asking again is
/// allowed.
pub const FETCH_RETRY_AFTER_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Sent at this time (ms), no answer yet.
    InFlight(u64),
    /// Answered, and every change since will be pushed.
    Current,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fetches {
    entries: BTreeMap<(String, Fetch), State>,
}

impl Fetches {
    /// Whether to send `fetch` to `machine` now; when it says yes it counts
    /// the request as sent. No while a pushed answer is held or a request is
    /// under [`FETCH_RETRY_AFTER_MS`] old.
    pub fn should_request(&mut self, machine: &str, fetch: Fetch, now: u64) -> bool {
        let key = (machine.to_string(), fetch);
        let skip = match self.entries.get(&key) {
            Some(State::Current) => true,
            Some(State::InFlight(at)) => now.saturating_sub(*at) < FETCH_RETRY_AFTER_MS,
            None => false,
        };
        if !skip {
            self.entries.insert(key, State::InFlight(now));
        }
        !skip
    }

    /// `machine` answered `fetch`. Only an answer the bridge keeps current
    /// by pushing is held; any other is asked for again next time.
    pub fn answered(&mut self, machine: &str, fetch: Fetch) {
        let key = (machine.to_string(), fetch);
        match key.1 {
            Fetch::ProviderProfiles => {
                self.entries.insert(key, State::Current);
            }
            Fetch::Models(_) => {
                self.entries.remove(&key);
            }
        }
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
        f.answered("m", Fetch::ProviderProfiles);
        assert!(!f.should_request("m", Fetch::ProviderProfiles, u64::MAX), "pushed on change");
        assert!(f.should_request("other", Fetch::ProviderProfiles, 0), "per machine");

        f.forget_all();
        assert!(f.should_request("m", Fetch::ProviderProfiles, 0), "a reconnect asks again");
    }

    #[test]
    fn a_model_list_is_asked_for_again_once_answered() {
        let mut f = Fetches::default();
        let claude = || Fetch::Models("claude".into());
        assert!(f.should_request("m", claude(), 0));
        assert!(!f.should_request("m", claude(), 1_000), "in flight");
        assert!(f.should_request("m", Fetch::Models("opencode".into()), 1_000), "per agent");
        f.answered("m", claude());
        assert!(f.should_request("m", claude(), 1_001), "answered: the next screen asks again");
    }
}
