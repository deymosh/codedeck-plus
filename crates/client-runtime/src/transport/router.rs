//! The relay read-loop logic, pure. [`super::WsTransport`] owns N relay sockets
//! and one `Router`; every parsed inbound frame ([`RelayMessage`]) and every
//! socket lifecycle change goes through [`Router::route`] / the `relay_*` /
//! `*_sub` / `*_publish` methods, which return [`RouterAction`]s for the socket
//! layer to carry out (invoke a `SubCallbacks` closure, answer AUTH, resolve a
//! publish future).
//!
//! What the router does NOT do: cross-relay event dedup (the `nostr_client`
//! `SeenIds` cap absorbs the replays), and holding sockets. It is deterministic
//! and fully unit-tested.
//!
//! Fan-out model — one logical subscription (`sub_id`, one per
//! `Transport::subscribe` call) is REQ'd to every relay:
//! * `on_event` fires per received event (no dedup here).
//! * `on_eose` fires **once**, when every REQ'd relay still connected has sent
//!   EOSE — matching nostr-tools `subscribeMany` (EOSE = "stored events are in
//!   from all relays"), so the connection FSM's socket-open is honest.
//! * `on_close` fires **once**, only when the subscription is dead on *every*
//!   REQ'd relay (all `CLOSED` / all sockets dropped). One relay dropping while
//!   another still carries the REQ is not a close — the FSM must not back off
//!   while a socket is live.

use std::collections::{HashMap, HashSet};

use client_core::bridge_api::{classify_publish, combine_publish, PublishResult, PublishVerdict};
use serde_json::Value;

use super::frames::RelayMessage;

/// Prefix (case-insensitive) a relay uses on `CLOSED` to demand NIP-42 AUTH
/// before it will serve a subscription.
const AUTH_REQUIRED_PREFIX: &str = "auth-required:";

/// What the socket layer must do in response to a frame / lifecycle change.
#[derive(Debug, Clone, PartialEq)]
pub enum RouterAction {
    /// Invoke `sub_id`'s `on_event` with this raw event object.
    Event { sub_id: String, event: Value },
    /// Invoke `sub_id`'s `on_eose` (fires at most once per sub).
    Eose { sub_id: String },
    /// Invoke `sub_id`'s `on_close` — dead on every REQ'd relay.
    SubClosed { sub_id: String, reason: Option<String> },
    /// `relay` sent `["AUTH", challenge]`; sign + send an AUTH event.
    NeedAuth { relay: String, challenge: String },
    /// `relay` closed `sub_id` with `auth-required`; after AUTH completes,
    /// re-send that subscription's REQ to `relay`.
    ResubAfterAuth { relay: String, sub_id: String },
    /// A publish reached its verdict (every relay reported OK/no, timed out, or
    /// went unreachable). Resolve the publish future with `result`.
    PublishSettled { event_id: String, result: PublishResult },
}

#[derive(Debug, Default)]
struct SubState {
    /// Relays the REQ was sent to.
    reqd: HashSet<String>,
    /// Relays that have sent EOSE for this sub.
    eosed: HashSet<String>,
    /// Relays where this sub ended (`CLOSED` without auth-required, or the
    /// socket dropped).
    dead_on: HashSet<String>,
    eose_fired: bool,
    closed_fired: bool,
}

#[derive(Debug, Default)]
struct PublishState {
    /// Relays the EVENT was sent to that have not reported yet.
    awaiting: HashSet<String>,
    results: Vec<PublishResult>,
    settled: bool,
}

/// See the module docs.
#[derive(Debug, Default)]
pub struct Router {
    connected: HashSet<String>,
    subs: HashMap<String, SubState>,
    publishes: HashMap<String, PublishState>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    // --- lifecycle ------------------------------------------------------

    /// A relay socket finished connecting (and, for a private relay, AUTH).
    pub fn relay_connected(&mut self, relay: &str) {
        self.connected.insert(relay.to_string());
    }

    /// Relays with a live, connected socket right now — for a per-relay
    /// status indicator (Settings). Not a subscription/publish-readiness
    /// signal, just "the socket is up."
    pub fn connected_relays(&self) -> &HashSet<String> {
        &self.connected
    }

    /// A relay socket closed or failed. Subs may go fully dead; publishes still
    /// awaiting an OK from it resolve that relay as unreachable.
    pub fn relay_disconnected(&mut self, relay: &str) -> Vec<RouterAction> {
        self.connected.remove(relay);
        let mut out = Vec::new();

        for (sub_id, s) in &mut self.subs {
            if !s.reqd.contains(relay) {
                continue;
            }
            s.eosed.remove(relay);
            s.dead_on.insert(relay.to_string());
            Self::maybe_eose(sub_id, s, &self.connected, &mut out);
            Self::maybe_sub_closed(
                sub_id,
                s,
                &self.connected,
                Some("relay disconnected".to_string()),
                &mut out,
            );
        }

        for (event_id, p) in &mut self.publishes {
            if p.awaiting.remove(relay) {
                p.results.push(classify_publish(Ok("connection failure: relay disconnected")));
                Self::maybe_publish_settled(event_id, p, &mut out);
            }
        }
        out
    }

    /// Register a subscription — the REQ is about to go to `relays`.
    pub fn open_sub(&mut self, sub_id: &str, relays: &[String]) {
        self.subs.insert(
            sub_id.to_string(),
            SubState {
                reqd: relays.iter().cloned().collect(),
                ..SubState::default()
            },
        );
    }

    /// The subscription was closed locally (`TransportSub::close()`) — forget it
    /// silently, so no late frame produces a callback.
    pub fn drop_sub(&mut self, sub_id: &str) {
        self.subs.remove(sub_id);
    }

    /// Register a publish — the EVENT is about to go to `relays`.
    pub fn open_publish(&mut self, event_id: &str, relays: &[String]) {
        self.publishes.insert(
            event_id.to_string(),
            PublishState {
                awaiting: relays.iter().cloned().collect(),
                ..PublishState::default()
            },
        );
    }

    /// The publish's wall-clock budget elapsed before every relay reported.
    /// Settle with what arrived; a relay that never answered is `unconfirmed`
    /// (the frame did reach an open socket).
    pub fn publish_timed_out(&mut self, event_id: &str) -> Option<RouterAction> {
        let p = self.publishes.get_mut(event_id)?;
        if p.settled {
            return None;
        }
        for _ in 0..p.awaiting.len() {
            p.results.push(classify_publish(Err("publish timed out")));
        }
        p.awaiting.clear();
        let mut out = Vec::new();
        Self::maybe_publish_settled(event_id, p, &mut out);
        out.into_iter().next()
    }

    /// Forget a settled/abandoned publish.
    pub fn drop_publish(&mut self, event_id: &str) {
        self.publishes.remove(event_id);
    }

    // --- frame routing ------------------------------------------------

    /// Route one parsed frame that arrived on `relay`'s socket.
    pub fn route(&mut self, relay: &str, msg: RelayMessage) -> Vec<RouterAction> {
        let mut out = Vec::new();
        match msg {
            RelayMessage::Event { sub_id, event } => {
                if self.subs.contains_key(&sub_id) {
                    out.push(RouterAction::Event { sub_id, event });
                }
            }
            RelayMessage::Eose { sub_id } => {
                if let Some(s) = self.subs.get_mut(&sub_id) {
                    s.eosed.insert(relay.to_string());
                    Self::maybe_eose(&sub_id, s, &self.connected, &mut out);
                }
            }
            RelayMessage::Closed { sub_id, message } => {
                if message.trim_start().to_ascii_lowercase().starts_with(AUTH_REQUIRED_PREFIX) {
                    if self.subs.contains_key(&sub_id) {
                        out.push(RouterAction::ResubAfterAuth {
                            relay: relay.to_string(),
                            sub_id,
                        });
                    }
                } else if let Some(s) = self.subs.get_mut(&sub_id) {
                    s.eosed.remove(relay);
                    s.dead_on.insert(relay.to_string());
                    Self::maybe_sub_closed(
                        &sub_id,
                        s,
                        &self.connected,
                        Some(message),
                        &mut out,
                    );
                }
            }
            RelayMessage::Ok { event_id, accepted, message } => {
                if let Some(p) = self.publishes.get_mut(&event_id) {
                    if p.awaiting.remove(relay) {
                        let outcome = if accepted {
                            classify_publish(Ok(&message))
                        } else {
                            classify_publish(Err(&message))
                        };
                        p.results.push(outcome);
                        Self::maybe_publish_settled(&event_id, p, &mut out);
                    }
                }
            }
            RelayMessage::Auth { challenge } => {
                out.push(RouterAction::NeedAuth {
                    relay: relay.to_string(),
                    challenge,
                });
            }
            // NOTICE is logged by the socket layer; COUNT / future verbs ignored.
            RelayMessage::Notice { .. } | RelayMessage::Unknown { .. } => {}
        }
        out
    }

    // --- predicates ------------------------------------------------

    /// REQ'd relays that are still connected and have not ended the sub.
    fn live_relays(s: &SubState, connected: &HashSet<String>) -> HashSet<String> {
        s.reqd
            .intersection(connected)
            .filter(|r| !s.dead_on.contains(*r))
            .cloned()
            .collect()
    }

    fn maybe_eose(
        sub_id: &str,
        s: &mut SubState,
        connected: &HashSet<String>,
        out: &mut Vec<RouterAction>,
    ) {
        if s.eose_fired {
            return;
        }
        let live = Self::live_relays(s, connected);
        if !live.is_empty() && live.iter().all(|r| s.eosed.contains(r)) {
            s.eose_fired = true;
            out.push(RouterAction::Eose {
                sub_id: sub_id.to_string(),
            });
        }
    }

    fn maybe_sub_closed(
        sub_id: &str,
        s: &mut SubState,
        connected: &HashSet<String>,
        reason: Option<String>,
        out: &mut Vec<RouterAction>,
    ) {
        if s.closed_fired {
            return;
        }
        if Self::live_relays(s, connected).is_empty() {
            s.closed_fired = true;
            out.push(RouterAction::SubClosed {
                sub_id: sub_id.to_string(),
                reason,
            });
        }
    }

    fn maybe_publish_settled(event_id: &str, p: &mut PublishState, out: &mut Vec<RouterAction>) {
        if p.settled {
            return;
        }
        // An acceptance is final — no reason to wait on a slow sibling relay
        // (matches the TS `raceForAcceptance`). Otherwise wait for every relay.
        let accepted = p
            .results
            .iter()
            .any(|r| r.verdict == PublishVerdict::Accepted);
        if !accepted && !p.awaiting.is_empty() {
            return;
        }
        p.settled = true;
        out.push(RouterAction::PublishSettled {
            event_id: event_id.to_string(),
            result: combine_publish(&p.results),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const R1: &str = "wss://r1.example";
    const R2: &str = "wss://r2.example";

    fn relays() -> Vec<String> {
        vec![R1.to_string(), R2.to_string()]
    }

    fn router_with_two_relays() -> Router {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.relay_connected(R2);
        r
    }

    #[test]
    fn events_are_delivered_only_for_known_subs() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        let ev = json!({ "id": "e1", "kind": 24515 });
        assert_eq!(
            r.route(R1, RelayMessage::Event { sub_id: "s1".into(), event: ev.clone() }),
            vec![RouterAction::Event { sub_id: "s1".into(), event: ev }]
        );
        assert!(r
            .route(R1, RelayMessage::Event { sub_id: "ghost".into(), event: json!({}) })
            .is_empty());
    }

    #[test]
    fn eose_fires_once_after_every_live_relay_reports() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r.route(R1, RelayMessage::Eose { sub_id: "s1".into() }).is_empty());
        assert_eq!(
            r.route(R2, RelayMessage::Eose { sub_id: "s1".into() }),
            vec![RouterAction::Eose { sub_id: "s1".into() }]
        );
        // no second fire
        assert!(r.route(R1, RelayMessage::Eose { sub_id: "s1".into() }).is_empty());
    }

    #[test]
    fn eose_fires_when_the_last_missing_relay_drops() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r.route(R1, RelayMessage::Eose { sub_id: "s1".into() }).is_empty());
        // R2 never EOSEs; it disconnects -> R1 is now the only live relay and it
        // has EOSEd.
        let actions = r.relay_disconnected(R2);
        assert!(actions.contains(&RouterAction::Eose { sub_id: "s1".into() }));
    }

    #[test]
    fn one_relay_closing_a_sub_is_not_a_sub_close() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        let actions = r.route(R1, RelayMessage::Closed { sub_id: "s1".into(), message: "error: bye".into() });
        assert!(actions.is_empty());
    }

    #[test]
    fn sub_close_fires_once_when_dead_on_every_relay() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r
            .route(R1, RelayMessage::Closed { sub_id: "s1".into(), message: "error: a".into() })
            .is_empty());
        assert_eq!(
            r.route(R2, RelayMessage::Closed { sub_id: "s1".into(), message: "error: b".into() }),
            vec![RouterAction::SubClosed { sub_id: "s1".into(), reason: Some("error: b".into()) }]
        );
        // idempotent
        assert!(r
            .route(R2, RelayMessage::Closed { sub_id: "s1".into(), message: "again".into() })
            .is_empty());
    }

    #[test]
    fn losing_every_socket_closes_the_sub() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r.relay_disconnected(R1).iter().all(|a| !matches!(a, RouterAction::SubClosed { .. })));
        let actions = r.relay_disconnected(R2);
        assert!(actions.contains(&RouterAction::SubClosed {
            sub_id: "s1".into(),
            reason: Some("relay disconnected".into()),
        }));
    }

    #[test]
    fn dropped_sub_makes_late_frames_silent() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.drop_sub("s1");
        assert!(r
            .route(R1, RelayMessage::Event { sub_id: "s1".into(), event: json!({}) })
            .is_empty());
        assert!(r.route(R1, RelayMessage::Eose { sub_id: "s1".into() }).is_empty());
    }

    #[test]
    fn auth_challenge_is_surfaced() {
        let mut r = router_with_two_relays();
        assert_eq!(
            r.route(R1, RelayMessage::Auth { challenge: "chal".into() }),
            vec![RouterAction::NeedAuth { relay: R1.into(), challenge: "chal".into() }]
        );
    }

    #[test]
    fn auth_required_closed_asks_for_a_resub_not_a_close() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert_eq!(
            r.route(R1, RelayMessage::Closed { sub_id: "s1".into(), message: "auth-required: come back".into() }),
            vec![RouterAction::ResubAfterAuth { relay: R1.into(), sub_id: "s1".into() }]
        );
        // the sub is NOT marked dead by an auth-required close
        assert!(r
            .route(R2, RelayMessage::Closed { sub_id: "s1".into(), message: "error: x".into() })
            .is_empty());
    }

    #[test]
    fn publish_settles_on_first_acceptance_across_relays() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        assert!(r
            .route(R1, RelayMessage::Ok { event_id: "evt".into(), accepted: false, message: "rate-limited: no".into() })
            .is_empty());
        let actions = r.route(R2, RelayMessage::Ok { event_id: "evt".into(), accepted: true, message: String::new() });
        assert_eq!(
            actions,
            vec![RouterAction::PublishSettled {
                event_id: "evt".into(),
                result: PublishResult { verdict: PublishVerdict::Accepted, detail: None },
            }]
        );
    }

    #[test]
    fn publish_rejected_everywhere_settles_rejected() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        r.route(R1, RelayMessage::Ok { event_id: "evt".into(), accepted: false, message: "blocked: no".into() });
        let actions = r.route(R2, RelayMessage::Ok { event_id: "evt".into(), accepted: false, message: "pow: no".into() });
        match actions.as_slice() {
            [RouterAction::PublishSettled { result, .. }] => {
                assert_eq!(result.verdict, PublishVerdict::Rejected);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn publish_timeout_settles_unconfirmed_for_the_silent_relays() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        r.route(R1, RelayMessage::Ok { event_id: "evt".into(), accepted: false, message: "rate-limited: x".into() });
        // R2 never answers.
        match r.publish_timed_out("evt") {
            Some(RouterAction::PublishSettled { result, .. }) => {
                // softest wins: unconfirmed (R2 silent) beats rejected (R1).
                assert_eq!(result.verdict, PublishVerdict::Unconfirmed);
            }
            other => panic!("{other:?}"),
        }
        assert!(r.publish_timed_out("evt").is_none()); // already settled
    }

    #[test]
    fn publish_settles_immediately_on_first_acceptance() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        match r
            .route(R1, RelayMessage::Ok { event_id: "evt".into(), accepted: true, message: String::new() })
            .as_slice()
        {
            [RouterAction::PublishSettled { result, .. }] => {
                assert_eq!(result.verdict, PublishVerdict::Accepted);
            }
            other => panic!("{other:?}"),
        }
        // R2 never mattered; its later drop settles nothing more.
        assert!(r
            .relay_disconnected(R2)
            .iter()
            .all(|a| !matches!(a, RouterAction::PublishSettled { .. })));
    }

    #[test]
    fn publish_settles_unreachable_when_every_relay_drops() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        r.relay_disconnected(R1);
        match r.relay_disconnected(R2).as_slice() {
            [RouterAction::PublishSettled { result, .. }] => {
                assert_eq!(result.verdict, PublishVerdict::Unreachable);
            }
            other => panic!("{other:?}"),
        }
    }
}
