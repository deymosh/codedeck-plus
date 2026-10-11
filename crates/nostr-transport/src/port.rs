//! The socket seam: what a runtime's subscription logic needs from a relay
//! connection, independent of whether it is the real [`crate::ws`] driver or
//! a scripted fake.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use protocol::crypto::Keypair;
use protocol::nip42::build_auth_event;
use protocol::nostr_event::SignedEvent;

/// Answers a relay's NIP-42 `AUTH` challenge: signs the kind-22242 event
/// with the side's own identity. A local key answers at once; a key held
/// elsewhere (a phone's external signer) may take a while, and the
/// transport keeps serving the relay's other traffic meanwhile.
pub trait AuthSigner {
    /// The AUTH event answering `challenge` from `relay`, dated `now_ms`.
    fn sign_auth(
        &self,
        relay: &str,
        challenge: &str,
        now_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<SignedEvent, String>> + '_>>;
}

impl AuthSigner for Keypair {
    fn sign_auth(
        &self,
        relay: &str,
        challenge: &str,
        now_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<SignedEvent, String>> + '_>> {
        let event = build_auth_event(self, relay, challenge, now_ms).map_err(|e| e.to_string());
        Box::pin(async move { event })
    }
}

/// A relay subscription filter (the subset CodeDeck+ uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    pub kinds: Vec<u16>,
    pub authors: Vec<String>,
    /// the `#p` tag filter.
    pub p_tags: Vec<String>,
    /// the `#d` tag filter (an addressable event's identifier).
    pub d_tags: Vec<String>,
    /// the `#c` tag filter: the recipient tags of the copies meant for this
    /// client (`protocol::recipients`).
    pub c_tags: Vec<String>,
    pub since: Option<i64>,
}

/// A Nostr event. Subscription logic only routes / dedups / advances cursors
/// on `id` / `kind` / `created_at` / `pubkey`; `tags` and `content` are
/// carried through untouched for the layer above (address check, decrypt,
/// decode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NostrEvent {
    pub id: String,
    pub kind: u16,
    pub created_at: i64,
    pub pubkey: String,
    pub tags: Vec<Vec<String>>,
    /// `event.content`: `base64(NIP-44(json))`, or a `chunk` fragment.
    pub content: String,
}

impl NostrEvent {
    /// The first value of the event's first `name` tag.
    pub fn tag(&self, name: &str) -> Option<&str> {
        self.tags.iter().find(|t| t.first().is_some_and(|n| n == name)).and_then(|t| t.get(1)).map(String::as_str)
    }
}

/// Callbacks a `Transport` invokes for one subscription. `Rc` (not `Box`) so
/// a transport can clone one callback out from under a `RefCell` borrow and
/// invoke it after dropping the borrow — a callback may re-enter `subscribe`
/// / `TransportSub::close`.
pub struct SubCallbacks {
    pub on_event: Rc<dyn Fn(&NostrEvent)>,
    /// end of stored events for this subscription.
    pub on_eose: Rc<dyn Fn()>,
    /// the underlying subscription died (NOT a deliberate `close()`).
    pub on_close: Rc<dyn Fn(Option<String>)>,
}

pub trait TransportSub {
    /// Tear down. After this the transport must not invoke the callbacks.
    fn close(&self);
}

/// The socket seam. Production: a WS pool over the configured relay list.
/// Tests: a scriptable fake.
pub trait Transport {
    /// Subscribe on every relay, those added later included.
    fn subscribe(&self, filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub>;
    /// Subscribe on `relays` only (of those configured; every relay when
    /// empty): no other relay sees the REQ, and `on_eose` / `on_close`
    /// speak for these relays alone. Default: [`Self::subscribe`] (test
    /// transports with no relays of their own).
    fn subscribe_to(&self, relays: &[String], filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub> {
        let _ = relays;
        self.subscribe(filter, callbacks)
    }
    /// Replace the relay list. Default: no-op (in-memory test transports).
    fn set_relays(&self, _urls: &[String]) {}
    /// Replace the SOCKS5 proxy (Tor on/off, or a different host:port) and
    /// redial every relay through it. Default: no-op (in-memory test
    /// transports have no real socket to redial).
    fn set_proxy(&self, _proxy: Option<String>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_reads_the_first_value_of_the_first_tag_so_named() {
        let tags = [vec!["p", "aa"], vec!["c", "c1"], vec!["c", "c2"], vec!["d"]];
        let event = NostrEvent {
            id: "e".into(),
            kind: 30515,
            created_at: 1,
            pubkey: "b".into(),
            tags: tags.iter().map(|t| t.iter().map(|s| s.to_string()).collect()).collect(),
            content: String::new(),
        };
        assert_eq!(event.tag("c"), Some("c1"));
        assert_eq!(event.tag("d"), None);
        assert_eq!(event.tag("x"), None);
    }
}
