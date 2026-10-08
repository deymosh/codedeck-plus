//! The relay read-loop logic, pure. [`super::WsTransport`] owns N relay sockets
//! and one `Router`; every parsed inbound frame ([`RelayMessage`]) and every
//! socket lifecycle change goes through [`Router::route`] / the `relay_*` /
//! `*_sub` / `*_publish` methods, which return [`RouterAction`]s for the socket
//! layer to carry out (invoke a `SubCallbacks` closure, answer AUTH, resolve a
//! publish future).
//!
//! It holds no sockets. It is deterministic and fully unit-tested.
//!
//! Fan-out model — one logical subscription (`sub_id`, one per
//! `Transport::subscribe` call) is REQ'd to every relay, and re-REQ'd to a
//! relay each time it (re)connects:
//! * `on_event` fires once per event id per subscription: the copies other
//!   relays send are dropped before anyone parses or verifies them (see
//!   [`Router::note_delivered`]).
//! * `on_eose` fires **once**, when every REQ'd relay still connected has sent
//!   EOSE (EOSE = "stored events are in from all relays"), so the connection FSM's socket-open is honest. A
//!   relay still waiting on NIP-42 AUTH does not hold it back.
//! * `on_close` fires **once**, only when the subscription is dead on *every*
//!   REQ'd relay (all `CLOSED` / all sockets dropped). One relay dropping while
//!   another still carries the REQ is not a close — the FSM must not back off
//!   while a socket is live. A relay that reconnects carries the REQ again, so
//!   it counts as live from then on (and a later total loss closes again).
//!
//! NIP-42: a relay that answers a REQ or an EVENT with `auth-required:` gets
//! it again exactly once, after the relay has accepted our AUTH. Until then
//! the REQ / EVENT waits; if the relay refuses the AUTH, or demands it again
//! after accepting it, the subscription is dead there and the publish is
//! rejected there — never a REQ/CLOSED loop.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::publish::{classify_publish, combine_publish, PublishResult, PublishVerdict};
use serde_json::Value;

use super::frames::RelayMessage;

/// Prefix (case-insensitive) a relay uses on `CLOSED` / `OK` to demand NIP-42
/// AUTH before it will serve a subscription or take an event.
const AUTH_REQUIRED_PREFIX: &str = "auth-required:";

/// Event ids remembered per subscription for the cross-relay dedup. A replay
/// older than this window is delivered again; the layer above dedups too.
const DELIVERED_CAP: usize = 1024;

/// What the socket layer must do in response to a frame / lifecycle change.
#[derive(Debug, Clone, PartialEq)]
pub enum RouterAction {
    /// Verify this raw event and, if valid, invoke `sub_id`'s `on_event` and
    /// then [`Router::note_delivered`].
    Event { sub_id: String, event: Value },
    /// Invoke `sub_id`'s `on_eose` (fires at most once per sub).
    Eose { sub_id: String },
    /// Invoke `sub_id`'s `on_close` — dead on every REQ'd relay.
    SubClosed { sub_id: String, reason: Option<String> },
    /// `relay` sent `["AUTH", challenge]`; sign and send an AUTH event, then
    /// report its id through [`Router::auth_sent`].
    NeedAuth { relay: String, challenge: String },
    /// `relay` accepted our AUTH after refusing `sub_id` with
    /// `auth-required:`: re-send that subscription's REQ to it.
    ResubAfterAuth { relay: String, sub_id: String },
    /// `relay` accepted our AUTH after refusing event `event_id` with
    /// `auth-required:`: re-send that same EVENT to it.
    RepublishAfterAuth { relay: String, event_id: String },
    /// A publish reached its verdict (every relay reported OK/no, timed out, or
    /// went unreachable). Resolve the publish future with `result`.
    PublishSettled { event_id: String, result: PublishResult },
}

/// A bounded set of recently seen ids, oldest evicted first.
#[derive(Debug, Default)]
struct RecentIds {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentIds {
    fn contains(&self, id: &str) -> bool {
        self.set.contains(id)
    }

    fn insert(&mut self, id: &str) {
        if !self.set.insert(id.to_string()) {
            return;
        }
        self.order.push_back(id.to_string());
        if self.order.len() > DELIVERED_CAP {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
    }
}

#[derive(Debug, Default)]
struct SubState {
    /// Relays the REQ was sent to (every configured relay, and every relay
    /// that connected since).
    reqd: HashSet<String>,
    /// Relays that have sent EOSE for this sub.
    eosed: HashSet<String>,
    /// Relays where this sub ended (`CLOSED` without auth-required, or the
    /// socket dropped).
    dead_on: HashSet<String>,
    /// Relays holding this sub back until our AUTH is accepted there.
    auth_wait: HashSet<String>,
    delivered: RecentIds,
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

/// NIP-42 progress on one live connection. Reset whenever it (re)connects.
#[derive(Debug, Default)]
struct RelayAuth {
    /// Id of the AUTH event we sent and the relay has not answered yet.
    pending: Option<String>,
    /// The relay's answer to our last AUTH: `Some(true)` accepted.
    accepted: Option<bool>,
    /// Subs / events refused with `auth-required:` before AUTH settled.
    waiting_subs: HashSet<String>,
    waiting_events: HashSet<String>,
    /// Subs / events already re-sent once after AUTH; a second refusal is final.
    retried_subs: HashSet<String>,
    retried_events: HashSet<String>,
}

/// See the module docs.
#[derive(Debug, Default)]
pub struct Router {
    connected: HashSet<String>,
    auth: HashMap<String, RelayAuth>,
    subs: HashMap<String, SubState>,
    publishes: HashMap<String, PublishState>,
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    // --- lifecycle ------------------------------------------------------

    /// A relay socket finished connecting; every open subscription's REQ is
    /// being replayed onto it, so each counts it as a fresh, live carrier.
    pub fn relay_connected(&mut self, relay: &str) {
        self.connected.insert(relay.to_string());
        self.auth.insert(relay.to_string(), RelayAuth::default());
        for s in self.subs.values_mut() {
            s.reqd.insert(relay.to_string());
            s.eosed.remove(relay);
            s.dead_on.remove(relay);
            s.auth_wait.remove(relay);
            // Live again: a later loss of every relay is a new close.
            s.closed_fired = false;
        }
    }

    /// Relays with a live, connected socket right now — for a per-relay
    /// status indicator (Settings). Not a subscription/publish-readiness
    /// signal, just "the socket is up."
    pub fn connected_relays(&self) -> &HashSet<String> {
        &self.connected
    }

    /// The socket to `relay` was closed on purpose (teardown, or a redial
    /// through a new proxy / relay list): stop counting it without the
    /// failure bookkeeping — a deliberate close raises no `on_close`, and a
    /// redial replays every stored REQ once the new socket is up. A sub that
    /// was only waiting on this relay's EOSE may now have it from the rest.
    pub fn forget_connected(&mut self, relay: &str) -> Vec<RouterAction> {
        self.connected.remove(relay);
        self.auth.remove(relay);
        let mut out = Vec::new();
        for (sub_id, s) in &mut self.subs {
            s.reqd.remove(relay);
            s.eosed.remove(relay);
            s.dead_on.remove(relay);
            s.auth_wait.remove(relay);
            Self::maybe_eose(sub_id, s, &self.connected, &mut out);
        }
        out
    }

    /// A relay socket closed or failed (or its dial did). Subs may go fully
    /// dead; publishes still awaiting an OK from it resolve that relay as
    /// unreachable.
    pub fn relay_disconnected(&mut self, relay: &str) -> Vec<RouterAction> {
        self.connected.remove(relay);
        self.auth.remove(relay);
        let mut out = Vec::new();

        for (sub_id, s) in &mut self.subs {
            if !s.reqd.contains(relay) {
                continue;
            }
            s.eosed.remove(relay);
            s.auth_wait.remove(relay);
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
        for a in self.auth.values_mut() {
            a.waiting_subs.remove(sub_id);
            a.retried_subs.remove(sub_id);
        }
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
        for a in self.auth.values_mut() {
            a.waiting_events.remove(event_id);
            a.retried_events.remove(event_id);
        }
    }

    /// We answered `relay`'s challenge with the AUTH event `auth_event_id`;
    /// the relay's `OK` for that id settles it.
    pub fn auth_sent(&mut self, relay: &str, auth_event_id: &str) {
        if let Some(a) = self.auth.get_mut(relay) {
            a.pending = Some(auth_event_id.to_string());
            a.accepted = None;
        }
    }

    /// `event_id` passed verification and went to `sub_id`'s `on_event`; the
    /// copies other relays send are dropped from now on. Only a verified
    /// event is noted, so a relay forging an id cannot shadow the real event.
    pub fn note_delivered(&mut self, sub_id: &str, event_id: &str) {
        if let Some(s) = self.subs.get_mut(sub_id) {
            s.delivered.insert(event_id);
        }
    }

    // --- frame routing ------------------------------------------------

    /// Route one parsed frame that arrived on `relay`'s socket.
    pub fn route(&mut self, relay: &str, msg: RelayMessage) -> Vec<RouterAction> {
        let mut out = Vec::new();
        match msg {
            RelayMessage::Event { sub_id, event } => {
                if let Some(s) = self.subs.get(&sub_id) {
                    let seen = event
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| s.delivered.contains(id));
                    if !seen {
                        out.push(RouterAction::Event { sub_id, event });
                    }
                }
            }
            RelayMessage::Eose { sub_id } => {
                if let Some(s) = self.subs.get_mut(&sub_id) {
                    s.eosed.insert(relay.to_string());
                    Self::maybe_eose(&sub_id, s, &self.connected, &mut out);
                }
            }
            RelayMessage::Closed { sub_id, message } => {
                if is_auth_required(&message) {
                    self.sub_needs_auth(relay, &sub_id, message, &mut out);
                } else {
                    self.sub_dead_on(relay, &sub_id, message, &mut out);
                }
            }
            RelayMessage::Ok { event_id, accepted, message } => {
                let answers_our_auth = self
                    .auth
                    .get(relay)
                    .is_some_and(|a| a.pending.as_deref() == Some(event_id.as_str()));
                if answers_our_auth {
                    self.auth_settled(relay, accepted, message, &mut out);
                } else if !accepted && is_auth_required(&message) {
                    self.event_needs_auth(relay, &event_id, message, &mut out);
                } else {
                    let outcome = if accepted {
                        classify_publish(Ok(&message))
                    } else {
                        classify_publish(Err(&message))
                    };
                    self.publish_result(relay, &event_id, outcome, &mut out);
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

    // --- NIP-42 -----------------------------------------------------

    fn sub_needs_auth(&mut self, relay: &str, sub_id: &str, message: String, out: &mut Vec<RouterAction>) {
        if !self.subs.contains_key(sub_id) {
            return;
        }
        let Some(a) = self.auth.get_mut(relay) else { return };
        match a.accepted {
            // AUTH is in and this sub has not been re-sent yet.
            Some(true) if a.retried_subs.insert(sub_id.to_string()) => {
                out.push(RouterAction::ResubAfterAuth { relay: relay.to_string(), sub_id: sub_id.to_string() });
            }
            // Refused our AUTH, or demands it again after accepting it: our
            // key is not welcome here.
            Some(_) => self.sub_dead_on(relay, sub_id, message, out),
            None => {
                a.waiting_subs.insert(sub_id.to_string());
                if let Some(s) = self.subs.get_mut(sub_id) {
                    s.auth_wait.insert(relay.to_string());
                    Self::maybe_eose(sub_id, s, &self.connected, out);
                }
            }
        }
    }

    fn event_needs_auth(&mut self, relay: &str, event_id: &str, message: String, out: &mut Vec<RouterAction>) {
        let awaited = self.publishes.get(event_id).is_some_and(|p| p.awaiting.contains(relay));
        let Some(a) = self.auth.get_mut(relay).filter(|_| awaited) else {
            return self.publish_result(relay, event_id, classify_publish(Err(&message)), out);
        };
        match a.accepted {
            Some(true) if a.retried_events.insert(event_id.to_string()) => {
                out.push(RouterAction::RepublishAfterAuth {
                    relay: relay.to_string(),
                    event_id: event_id.to_string(),
                });
            }
            Some(_) => self.publish_result(relay, event_id, classify_publish(Err(&message)), out),
            None => {
                a.waiting_events.insert(event_id.to_string());
            }
        }
    }

    fn auth_settled(&mut self, relay: &str, accepted: bool, message: String, out: &mut Vec<RouterAction>) {
        let Some(a) = self.auth.get_mut(relay) else { return };
        a.pending = None;
        a.accepted = Some(accepted);
        let subs: Vec<String> = a.waiting_subs.drain().collect();
        let events: Vec<String> = a.waiting_events.drain().collect();
        if accepted {
            a.retried_subs.extend(subs.iter().cloned());
            a.retried_events.extend(events.iter().cloned());
            for sub_id in subs {
                if let Some(s) = self.subs.get_mut(&sub_id) {
                    s.auth_wait.remove(relay);
                    out.push(RouterAction::ResubAfterAuth { relay: relay.to_string(), sub_id });
                }
            }
            for event_id in events {
                out.push(RouterAction::RepublishAfterAuth { relay: relay.to_string(), event_id });
            }
        } else {
            let reason = format!("auth-required: AUTH refused ({message})");
            for sub_id in subs {
                self.sub_dead_on(relay, &sub_id, reason.clone(), out);
            }
            for event_id in events {
                self.publish_result(relay, &event_id, classify_publish(Err(&reason)), out);
            }
        }
    }

    fn sub_dead_on(&mut self, relay: &str, sub_id: &str, message: String, out: &mut Vec<RouterAction>) {
        if let Some(s) = self.subs.get_mut(sub_id) {
            s.eosed.remove(relay);
            s.auth_wait.remove(relay);
            s.dead_on.insert(relay.to_string());
            Self::maybe_eose(sub_id, s, &self.connected, out);
            Self::maybe_sub_closed(sub_id, s, &self.connected, Some(message), out);
        }
    }

    fn publish_result(&mut self, relay: &str, event_id: &str, outcome: PublishResult, out: &mut Vec<RouterAction>) {
        if let Some(p) = self.publishes.get_mut(event_id) {
            if p.awaiting.remove(relay) {
                p.results.push(outcome);
                Self::maybe_publish_settled(event_id, p, out);
            }
        }
    }

    // --- predicates ------------------------------------------------

    /// REQ'd relays that are still connected and have not ended the sub.
    fn live_relays<'a>(s: &'a SubState, connected: &'a HashSet<String>) -> impl Iterator<Item = &'a String> {
        s.reqd.iter().filter(|r| connected.contains(*r) && !s.dead_on.contains(*r))
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
        // A relay parked on AUTH has nothing to give yet: it does not hold
        // EOSE back, and its stored events arrive after it (as live ones do).
        let complete = {
            let mut waiting_on = Self::live_relays(s, connected).filter(|r| !s.auth_wait.contains(*r)).peekable();
            waiting_on.peek().is_some() && waiting_on.all(|r| s.eosed.contains(r))
        };
        if complete {
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
        if Self::live_relays(s, connected).next().is_none() {
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
        // Otherwise wait for every relay.
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

fn is_auth_required(message: &str) -> bool {
    message.trim_start().to_ascii_lowercase().starts_with(AUTH_REQUIRED_PREFIX)
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

    fn closed(sub: &str, message: &str) -> RelayMessage {
        RelayMessage::Closed { sub_id: sub.into(), message: message.into() }
    }

    fn ok(id: &str, accepted: bool, message: &str) -> RelayMessage {
        RelayMessage::Ok { event_id: id.into(), accepted, message: message.into() }
    }

    fn settled(actions: &[RouterAction]) -> Option<PublishVerdict> {
        actions.iter().find_map(|a| match a {
            RouterAction::PublishSettled { result, .. } => Some(result.verdict),
            _ => None,
        })
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
    fn a_delivered_event_is_not_routed_again_from_another_relay() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.open_sub("s2", &relays());
        let ev = json!({ "id": "e1" });
        assert_eq!(r.route(R1, RelayMessage::Event { sub_id: "s1".into(), event: ev.clone() }).len(), 1);
        // Not yet verified and noted: a second copy is still routed, so a
        // forged first copy cannot shadow the real one.
        assert_eq!(r.route(R2, RelayMessage::Event { sub_id: "s1".into(), event: ev.clone() }).len(), 1);
        r.note_delivered("s1", "e1");
        assert!(r.route(R2, RelayMessage::Event { sub_id: "s1".into(), event: ev.clone() }).is_empty());
        // Per subscription: another sub matching the same event still gets it.
        assert_eq!(r.route(R2, RelayMessage::Event { sub_id: "s2".into(), event: ev }).len(), 1);
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
    fn eose_fires_when_the_last_missing_relay_is_removed_deliberately() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.route(R1, RelayMessage::Eose { sub_id: "s1".into() });
        assert_eq!(r.forget_connected(R2), vec![RouterAction::Eose { sub_id: "s1".into() }]);
    }

    #[test]
    fn one_relay_closing_a_sub_is_not_a_sub_close() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r.route(R1, closed("s1", "error: bye")).is_empty());
    }

    #[test]
    fn sub_close_fires_once_when_dead_on_every_relay() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        assert!(r.route(R1, closed("s1", "error: a")).is_empty());
        assert_eq!(
            r.route(R2, closed("s1", "error: b")),
            vec![RouterAction::SubClosed { sub_id: "s1".into(), reason: Some("error: b".into()) }]
        );
        // idempotent
        assert!(r.route(R2, closed("s1", "again")).is_empty());
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
    fn a_relay_that_reconnects_carries_the_sub_again() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.relay_disconnected(R1);
        r.relay_connected(R1);
        // R1 is back with the REQ replayed: losing R2 alone is not a close.
        assert!(r
            .relay_disconnected(R2)
            .iter()
            .all(|a| !matches!(a, RouterAction::SubClosed { .. })));
        // A relay CLOSED on it earlier is live again after a reconnect too.
        r.relay_connected(R2);
        r.route(R2, closed("s1", "error: x"));
        r.relay_disconnected(R2);
        r.relay_connected(R2);
        assert!(r
            .relay_disconnected(R1)
            .iter()
            .all(|a| !matches!(a, RouterAction::SubClosed { .. })));
    }

    #[test]
    fn a_sub_revived_by_a_reconnect_closes_again_on_the_next_total_loss() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.relay_disconnected(R1);
        assert!(r.relay_disconnected(R2).iter().any(|a| matches!(a, RouterAction::SubClosed { .. })));
        r.relay_connected(R1);
        assert!(r.relay_disconnected(R1).iter().any(|a| matches!(a, RouterAction::SubClosed { .. })));
    }

    #[test]
    fn a_relay_added_after_the_sub_opened_counts_once_it_connects() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.open_sub("s1", &[R1.to_string()]);
        r.relay_connected(R2);
        r.route(R1, RelayMessage::Eose { sub_id: "s1".into() });
        // R2 got the REQ on connect; EOSE waits for it too...
        assert!(r.route(R1, RelayMessage::Eose { sub_id: "s1".into() }).is_empty());
        assert_eq!(
            r.route(R2, RelayMessage::Eose { sub_id: "s1".into() }),
            vec![RouterAction::Eose { sub_id: "s1".into() }]
        );
        // ...and it keeps the sub alive when R1 goes.
        assert!(r
            .relay_disconnected(R1)
            .iter()
            .all(|a| !matches!(a, RouterAction::SubClosed { .. })));
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
    fn auth_required_waits_for_the_auth_ok_then_resubscribes_once() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.route(R1, RelayMessage::Auth { challenge: "chal".into() });
        r.auth_sent(R1, "auth-1");
        // Refused before our AUTH is in: nothing is re-sent yet.
        assert!(r.route(R1, closed("s1", "auth-required: come back")).is_empty());
        assert_eq!(
            r.route(R1, ok("auth-1", true, "")),
            vec![RouterAction::ResubAfterAuth { relay: R1.into(), sub_id: "s1".into() }]
        );
        // Refused again after AUTH was accepted: final, not a loop. Dead on R1
        // only, so no close while R2 carries it.
        assert!(r.route(R1, closed("s1", "auth-required: still no")).is_empty());
        assert_eq!(
            r.route(R2, closed("s1", "error: x")),
            vec![RouterAction::SubClosed { sub_id: "s1".into(), reason: Some("error: x".into()) }]
        );
    }

    #[test]
    fn auth_required_after_the_auth_ok_resubscribes_at_once() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.auth_sent(R1, "auth-1");
        r.route(R1, ok("auth-1", true, ""));
        assert_eq!(
            r.route(R1, closed("s1", "auth-required: x")),
            vec![RouterAction::ResubAfterAuth { relay: R1.into(), sub_id: "s1".into() }]
        );
    }

    #[test]
    fn a_refused_auth_ends_the_waiting_sub_on_that_relay() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.open_sub("s1", &[R1.to_string()]);
        r.auth_sent(R1, "auth-1");
        r.route(R1, closed("s1", "auth-required: x"));
        let actions = r.route(R1, ok("auth-1", false, "restricted: not on the list"));
        assert!(actions.iter().any(|a| matches!(
            a,
            RouterAction::SubClosed { reason: Some(reason), .. } if reason.contains("AUTH refused")
        )));
    }

    #[test]
    fn a_relay_waiting_on_auth_does_not_hold_eose_back() {
        let mut r = router_with_two_relays();
        r.open_sub("s1", &relays());
        r.auth_sent(R1, "auth-1");
        r.route(R2, RelayMessage::Eose { sub_id: "s1".into() });
        assert_eq!(
            r.route(R1, closed("s1", "auth-required: x")),
            vec![RouterAction::Eose { sub_id: "s1".into() }]
        );
    }

    #[test]
    fn a_publish_refused_for_auth_is_republished_once_auth_is_in() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.auth_sent(R1, "auth-1");
        r.open_publish("evt", &[R1.to_string()]);
        assert!(r.route(R1, ok("evt", false, "auth-required: sign in")).is_empty());
        assert_eq!(
            r.route(R1, ok("auth-1", true, "")),
            vec![RouterAction::RepublishAfterAuth { relay: R1.into(), event_id: "evt".into() }]
        );
        assert_eq!(settled(&r.route(R1, ok("evt", true, ""))), Some(PublishVerdict::Accepted));
    }

    #[test]
    fn a_publish_refused_for_auth_twice_is_rejected() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.auth_sent(R1, "auth-1");
        r.route(R1, ok("auth-1", true, ""));
        r.open_publish("evt", &[R1.to_string()]);
        assert_eq!(
            r.route(R1, ok("evt", false, "auth-required: x")),
            vec![RouterAction::RepublishAfterAuth { relay: R1.into(), event_id: "evt".into() }]
        );
        assert_eq!(settled(&r.route(R1, ok("evt", false, "auth-required: x"))), Some(PublishVerdict::Rejected));
    }

    #[test]
    fn a_refused_auth_rejects_the_waiting_publish() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.auth_sent(R1, "auth-1");
        r.open_publish("evt", &[R1.to_string()]);
        r.route(R1, ok("evt", false, "auth-required: x"));
        assert_eq!(settled(&r.route(R1, ok("auth-1", false, "no"))), Some(PublishVerdict::Rejected));
    }

    #[test]
    fn a_reconnect_starts_auth_over() {
        let mut r = Router::new();
        r.relay_connected(R1);
        r.open_sub("s1", &[R1.to_string()]);
        r.auth_sent(R1, "auth-1");
        r.route(R1, ok("auth-1", true, ""));
        r.route(R1, closed("s1", "auth-required: x"));
        r.relay_disconnected(R1);
        r.relay_connected(R1);
        // The new connection has not authenticated: the refusal waits again.
        assert!(r.route(R1, closed("s1", "auth-required: x")).is_empty());
    }

    #[test]
    fn publish_settles_on_first_acceptance_across_relays() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        assert!(r.route(R1, ok("evt", false, "rate-limited: no")).is_empty());
        let actions = r.route(R2, ok("evt", true, ""));
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
        r.route(R1, ok("evt", false, "blocked: no"));
        let actions = r.route(R2, ok("evt", false, "pow: no"));
        assert_eq!(settled(&actions), Some(PublishVerdict::Rejected));
    }

    #[test]
    fn publish_timeout_settles_unconfirmed_for_the_silent_relays() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        r.route(R1, ok("evt", false, "rate-limited: x"));
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
        assert_eq!(settled(&r.route(R1, ok("evt", true, ""))), Some(PublishVerdict::Accepted));
        // R2 never mattered; its later drop settles nothing more.
        assert_eq!(settled(&r.relay_disconnected(R2)), None);
    }

    #[test]
    fn publish_settles_unreachable_when_every_relay_drops() {
        let mut r = router_with_two_relays();
        r.open_publish("evt", &relays());
        r.relay_disconnected(R1);
        assert_eq!(settled(&r.relay_disconnected(R2)), Some(PublishVerdict::Unreachable));
    }
}
