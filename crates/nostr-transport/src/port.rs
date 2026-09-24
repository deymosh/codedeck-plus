//! The socket seam: what a runtime's subscription logic needs from a relay
//! connection, independent of whether it is the real [`crate::ws`] driver or
//! a scripted fake.

use std::rc::Rc;

/// A relay subscription filter (the subset CodeDeck+ uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    pub kinds: Vec<u16>,
    pub authors: Vec<String>,
    /// the `#p` tag filter.
    pub p_tags: Vec<String>,
    /// the `#h` tag filter (Marmot kind-445 group routing).
    pub h_tags: Vec<String>,
    pub since: Option<i64>,
}

/// A Nostr event. Subscription logic only routes / dedups / advances cursors
/// on `id` / `kind` / `created_at` / `pubkey`; `content` is carried through
/// untouched for the layer above (decrypt + decode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NostrEvent {
    pub id: String,
    pub kind: u16,
    pub created_at: i64,
    pub pubkey: String,
    /// `event.content`: `base64(NIP-44(json))`, or a `chunk` fragment.
    pub content: String,
    /// The full relay event object — gift-wrap paths re-parse it (they need
    /// `tags` + `sig`, not just what subscriptions route on).
    pub raw: serde_json::Value,
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
    fn subscribe(&self, filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub>;
    /// Replace the relay list. Default: no-op (in-memory test transports).
    fn set_relays(&self, _urls: &[String]) {}
    /// Replace the SOCKS5 proxy (Tor on/off, or a different host:port) and
    /// redial every relay through it. Default: no-op (in-memory test
    /// transports have no real socket to redial).
    fn set_proxy(&self, _proxy: Option<String>) {}
}
