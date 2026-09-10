//! `NostrClient` — the client's socket layer, behind a `Transport` port. Port of
//! `apps/mobile/src/core/services/nostrClient.ts` (+ the per-class filter split
//! from `platform/poolOptions.ts`).
//!
//! Per-traffic-class subscriptions — what structurally kills bug A's since-filter
//! starvation:
//! - 30515 session-list heartbeat: NO `since` (replaceable — always fetch current)
//! - 4516 stored responses: `since = last_stored_seen − 60s` (low-frequency only)
//! - 24515 ephemeral live output: NO `since` (relays never store it)
//!
//! Generation guard (CDB-037): every (re)connect bumps `epoch`; callbacks from
//! superseded subscriptions are ignored, so a deliberate teardown never
//! masquerades as a lost connection and never feeds the FSM a fake `socket-close`.
//!
//! `Rc<RefCell<_>>` mirrors the single-threaded TS `this`. The tokio transport
//! that lands later drives this from one task (a `LocalSet`), or upgrades the
//! interior mutability to `Arc<Mutex<_>>`; the logic is unchanged either way.

use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::rc::Rc;

use client_core::wire::kinds::{LIVE_KIND, RESPONSE_KIND, SESSION_LIST_KIND};

/// since-filter grace below the stored-seen cursor (overlap beats gaps; the
/// event-id dedup absorbs the replays).
pub const STORED_SINCE_GRACE_SECONDS: i64 = 60;
const SEEN_IDS_CAP: usize = 2000;

/// A relay subscription filter (the subset the client uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    pub kinds: Vec<u16>,
    pub authors: Vec<String>,
    /// the `#p` tag filter.
    pub p_tags: Vec<String>,
    pub since: Option<i64>,
}

/// A Nostr event. The client itself only routes / dedups / advances the cursor
/// on `id` / `kind` / `created_at` / `pubkey`; `content` is carried through
/// untouched for the layer above (`bridge_api::ingest` — decrypt + decode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NostrEvent {
    pub id: String,
    pub kind: u16,
    pub created_at: i64,
    pub pubkey: String,
    /// `event.content`: `base64(NIP-44(json))`, or a `chunk` fragment.
    pub content: String,
}

/// Callbacks a `Transport` invokes for one subscription. Mirrors the TS
/// `TransportSubscriptionParams`. `Rc` (not `Box`) so a transport can clone one
/// callback out from under a `RefCell` borrow and invoke it after dropping the
/// borrow — a user callback may re-enter `subscribe` / `TransportSub::close`.
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

/// The socket seam. Production: a WS pool over the settings relay list. Tests: a
/// scriptable fake.
pub trait Transport {
    fn subscribe(&self, filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub>;
    /// Replace the relay list. Default: no-op (in-memory test transports).
    fn set_relays(&self, _urls: &[String]) {}
}

/// The client's outward surface — what a heard event / lifecycle change does.
pub trait NostrClientHost {
    /// Bridge pubkeys to subscribe to: paired machines + any pairing candidate.
    fn authors(&self) -> Vec<String>;
    fn on_event(&self, event: &NostrEvent);
    /// All subscriptions of the current epoch reached EOSE.
    fn on_socket_open(&self);
    /// The current epoch's subscription died on its own.
    fn on_socket_close(&self, reason: Option<String>);
    /// Persisted `created_at` high-water mark over stored kinds (seconds).
    fn last_stored_seen(&self) -> i64;
    fn note_stored_seen(&self, ts: i64);
    fn log(&self, _msg: &str) {}
}

/// The three per-class filters. Pure.
pub fn build_phone_filters(phone_pubkey: &str, authors: &[String], last_stored_seen: i64) -> Vec<Filter> {
    let f = |kinds: Vec<u16>, since: Option<i64>| Filter {
        kinds,
        authors: authors.to_vec(),
        p_tags: vec![phone_pubkey.to_string()],
        since,
    };
    vec![
        // Replaceable heartbeat: always fetch current — NEVER a since filter.
        f(vec![SESSION_LIST_KIND], None),
        // Stored responses: low-frequency, resume from the stored cursor.
        f(
            vec![RESPONSE_KIND],
            (last_stored_seen > 0).then_some(last_stored_seen - STORED_SINCE_GRACE_SECONDS),
        ),
        // Ephemeral live output: nothing stored to resume from.
        f(vec![LIVE_KIND], None),
    ]
}

struct SeenIds {
    set: HashSet<String>,
    order: VecDeque<String>,
    cap: usize,
}

impl SeenIds {
    fn new(cap: usize) -> Self {
        Self { set: HashSet::new(), order: VecDeque::new(), cap }
    }
    /// `true` if newly inserted; `false` if already seen.
    fn insert(&mut self, id: &str) -> bool {
        if self.set.contains(id) {
            return false;
        }
        self.set.insert(id.to_string());
        self.order.push_back(id.to_string());
        if self.set.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

struct Inner {
    epoch: u64,
    connected_epoch: Option<u64>,
    eose_count: usize,
    filter_count: usize,
    seen: SeenIds,
    subs: Vec<Box<dyn TransportSub>>,
}

pub struct NostrClient<T: Transport, H: NostrClientHost> {
    transport: T,
    host: Rc<H>,
    phone_pubkey: String,
    inner: Rc<RefCell<Inner>>,
}

/// Orphan in-flight callbacks (epoch++) BEFORE closing the sockets — CDB-037
/// order — then close and forget them.
fn teardown_inner(inner: &Rc<RefCell<Inner>>) {
    let subs = {
        let mut i = inner.borrow_mut();
        i.epoch += 1;
        i.connected_epoch = None;
        std::mem::take(&mut i.subs)
    };
    for s in subs {
        s.close();
    }
}

fn handle_event(inner: &Rc<RefCell<Inner>>, host: &impl NostrClientHost, ev: &NostrEvent) {
    // Relays replay stored events on reconnect (overlapping since windows).
    if !inner.borrow_mut().seen.insert(&ev.id) {
        return;
    }
    if (ev.kind == RESPONSE_KIND || ev.kind == SESSION_LIST_KIND) && ev.created_at > host.last_stored_seen() {
        host.note_stored_seen(ev.created_at);
    }
    host.on_event(ev);
}

impl<T: Transport, H: NostrClientHost + 'static> NostrClient<T, H> {
    pub fn new(transport: T, host: Rc<H>, phone_pubkey: impl Into<String>) -> Self {
        Self {
            transport,
            host,
            phone_pubkey: phone_pubkey.into(),
            inner: Rc::new(RefCell::new(Inner {
                epoch: 0,
                connected_epoch: None,
                eose_count: 0,
                filter_count: 0,
                seen: SeenIds::new(SEEN_IDS_CAP),
                subs: Vec::new(),
            })),
        }
    }

    pub fn is_connected(&self) -> bool {
        let i = self.inner.borrow();
        i.connected_epoch == Some(i.epoch) && !i.subs.is_empty()
    }

    /// (Re)subscribe under a fresh epoch. A previous epoch's teardown is silent
    /// by construction.
    pub fn connect(&self) {
        teardown_inner(&self.inner);
        let epoch = {
            let mut i = self.inner.borrow_mut();
            i.epoch += 1;
            i.epoch
        };

        let authors = self.host.authors();
        if authors.is_empty() {
            // Nothing to subscribe to yet (unpaired). Report open so the FSM is
            // honest — the pairing flow resubscribes once a candidate exists.
            self.host.log("[NostrClient] no machines to subscribe to — open (vacuous)");
            self.inner.borrow_mut().connected_epoch = Some(epoch);
            self.host.on_socket_open();
            return;
        }

        let filters = build_phone_filters(&self.phone_pubkey, &authors, self.host.last_stored_seen());
        {
            let mut i = self.inner.borrow_mut();
            i.eose_count = 0;
            i.filter_count = filters.len();
        }

        let mut subs = Vec::with_capacity(filters.len());
        for filter in filters {
            let (i_ev, h_ev) = (Rc::clone(&self.inner), Rc::clone(&self.host));
            let (i_eo, h_eo) = (Rc::clone(&self.inner), Rc::clone(&self.host));
            let (i_cl, h_cl) = (Rc::clone(&self.inner), Rc::clone(&self.host));
            let sub = self.transport.subscribe(
                filter,
                SubCallbacks {
                    on_event: Rc::new(move |ev| {
                        if i_ev.borrow().epoch != epoch {
                            return; // superseded subscription
                        }
                        handle_event(&i_ev, &*h_ev, ev);
                    }),
                    on_eose: Rc::new(move || {
                        let all_in = {
                            let mut i = i_eo.borrow_mut();
                            if i.epoch != epoch {
                                return;
                            }
                            i.eose_count += 1;
                            if i.eose_count == i.filter_count {
                                i.connected_epoch = Some(epoch);
                                true
                            } else {
                                false
                            }
                        };
                        if all_in {
                            h_eo.on_socket_open();
                        }
                    }),
                    on_close: Rc::new(move |reason| {
                        if i_cl.borrow().epoch != epoch {
                            h_cl.log("[NostrClient] ignoring close of superseded subscription");
                            return;
                        }
                        // One class subscription dying means the socket is bad —
                        // tear the epoch down and report ONE close to the FSM.
                        teardown_inner(&i_cl);
                        h_cl.on_socket_close(reason);
                    }),
                },
            );
            subs.push(sub);
        }
        self.inner.borrow_mut().subs = subs;
    }

    /// Deliberate teardown — never surfaces as `socket-close`.
    pub fn disconnect(&self) {
        teardown_inner(&self.inner);
        self.inner.borrow_mut().epoch += 1;
    }

    /// Rebuild subscriptions (a machine was added/removed, relays changed).
    pub fn resubscribe(&self) {
        self.connect();
    }

    /// Point the transport at a new relay list and resubscribe if live.
    pub fn set_relays(&self, urls: &[String]) {
        self.transport.set_relays(urls);
        if self.is_connected() {
            self.resubscribe();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // --- scriptable fake transport ---

    struct FakeSubState {
        filter: Filter,
        cb: SubCallbacks,
        closed: Cell<bool>,
    }

    #[derive(Clone)]
    struct FakeTransport {
        subs: Rc<RefCell<Vec<Rc<FakeSubState>>>>,
        relays_set: Rc<RefCell<Vec<Vec<String>>>>,
    }

    impl FakeTransport {
        fn new() -> Self {
            Self { subs: Rc::new(RefCell::new(Vec::new())), relays_set: Rc::new(RefCell::new(Vec::new())) }
        }
        fn open(&self) -> Vec<Rc<FakeSubState>> {
            self.subs.borrow().iter().filter(|s| !s.closed.get()).cloned().collect()
        }
        fn eose_all(&self) {
            for s in self.open() {
                (s.cb.on_eose)();
            }
        }
        fn emit(&self, ev: &NostrEvent) {
            for s in self.open() {
                if s.filter.kinds.contains(&ev.kind) {
                    (s.cb.on_event)(ev);
                }
            }
        }
    }

    struct FakeSubHandle(Rc<FakeSubState>);
    impl TransportSub for FakeSubHandle {
        fn close(&self) {
            self.0.closed.set(true);
        }
    }

    impl Transport for FakeTransport {
        fn subscribe(&self, filter: Filter, callbacks: SubCallbacks) -> Box<dyn TransportSub> {
            let st = Rc::new(FakeSubState { filter, cb: callbacks, closed: Cell::new(false) });
            self.subs.borrow_mut().push(Rc::clone(&st));
            Box::new(FakeSubHandle(st))
        }
        fn set_relays(&self, urls: &[String]) {
            self.relays_set.borrow_mut().push(urls.to_vec());
        }
    }

    // --- host ---

    struct Host {
        authors: Vec<String>,
        events: RefCell<Vec<String>>,
        opens: Cell<usize>,
        closes: Cell<usize>,
        cursor: Cell<i64>,
    }
    impl Host {
        fn new(authors: &[&str]) -> Rc<Self> {
            Rc::new(Self {
                authors: authors.iter().map(|s| s.to_string()).collect(),
                events: RefCell::new(Vec::new()),
                opens: Cell::new(0),
                closes: Cell::new(0),
                cursor: Cell::new(0),
            })
        }
    }
    impl NostrClientHost for Host {
        fn authors(&self) -> Vec<String> {
            self.authors.clone()
        }
        fn on_event(&self, event: &NostrEvent) {
            self.events.borrow_mut().push(event.id.clone());
        }
        fn on_socket_open(&self) {
            self.opens.set(self.opens.get() + 1);
        }
        fn on_socket_close(&self, _reason: Option<String>) {
            self.closes.set(self.closes.get() + 1);
        }
        fn last_stored_seen(&self) -> i64 {
            self.cursor.get()
        }
        fn note_stored_seen(&self, ts: i64) {
            self.cursor.set(ts);
        }
    }

    fn evt(id: &str, kind: u16, created_at: i64) -> NostrEvent {
        NostrEvent { id: id.into(), kind, created_at, pubkey: "b1".into(), content: String::new() }
    }

    fn harness(authors: &[&str]) -> (FakeTransport, Rc<Host>, NostrClient<FakeTransport, Host>) {
        let t = FakeTransport::new();
        let h = Host::new(authors);
        let c = NostrClient::new(t.clone(), Rc::clone(&h), "phone-pk");
        (t, h, c)
    }

    // --- build_phone_filters ---

    #[test]
    fn builds_exactly_three_filters() {
        let f = build_phone_filters("phone-pk", &["b1".into(), "b2".into()], 0);
        assert_eq!(f.iter().map(|x| x.kinds.clone()).collect::<Vec<_>>(), vec![
            vec![SESSION_LIST_KIND],
            vec![RESPONSE_KIND],
            vec![LIVE_KIND],
        ]);
        for x in &f {
            assert_eq!(x.authors, vec!["b1".to_string(), "b2".to_string()]);
            assert_eq!(x.p_tags, vec!["phone-pk".to_string()]);
        }
    }

    #[test]
    fn heartbeat_and_live_never_carry_since() {
        for last in [0, 1_234_567] {
            let f = build_phone_filters("p", &["b1".into()], last);
            assert_eq!(f[0].since, None);
            assert_eq!(f[2].since, None);
        }
    }

    #[test]
    fn response_filter_resumes_from_cursor_minus_grace_and_omits_on_first_run() {
        assert_eq!(build_phone_filters("p", &["b1".into()], 0)[1].since, None);
        assert_eq!(
            build_phone_filters("p", &["b1".into()], 10_000)[1].since,
            Some(10_000 - STORED_SINCE_GRACE_SECONDS)
        );
    }

    // --- NostrClient ---

    #[test]
    fn connect_opens_three_subs_and_reports_open_after_all_eose() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        assert_eq!(t.open().len(), 3);
        (t.open()[0].cb.on_eose)();
        (t.open()[1].cb.on_eose)();
        assert_eq!(h.opens.get(), 0);
        (t.open()[2].cb.on_eose)();
        assert_eq!(h.opens.get(), 1);
        assert!(c.is_connected());
    }

    #[test]
    fn epoch_guard_deliberate_teardown_never_surfaces_as_close() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        t.eose_all();
        let old: Vec<_> = t.open();

        c.resubscribe();
        for s in &old {
            (s.cb.on_close)(Some("teardown".into()));
        }
        assert_eq!(h.closes.get(), 0);

        c.disconnect();
        for s in t.subs.borrow().iter().filter(|s| s.closed.get()) {
            (s.cb.on_close)(Some("teardown".into()));
        }
        assert_eq!(h.closes.get(), 0);
    }

    #[test]
    fn real_subscription_death_reports_exactly_one_close_and_tears_the_epoch_down() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        t.eose_all();
        let live: Vec<_> = t.open();
        (live[1].cb.on_close)(Some("relay gone".into()));
        assert_eq!(h.closes.get(), 1);
        assert!(!c.is_connected());
        assert_eq!(t.open().len(), 0); // siblings closed too
        (live[0].cb.on_close)(Some("cascade".into()));
        (live[2].cb.on_close)(Some("cascade".into()));
        assert_eq!(h.closes.get(), 1); // superseded — no double report
    }

    #[test]
    fn events_from_a_superseded_epoch_are_dropped() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        let old_live = t.open()[2].clone();
        c.resubscribe();
        (old_live.cb.on_event)(&evt("stale-1", LIVE_KIND, 100));
        assert!(h.events.borrow().is_empty());
        t.emit(&evt("fresh-1", LIVE_KIND, 100));
        assert_eq!(*h.events.borrow(), vec!["fresh-1".to_string()]);
    }

    #[test]
    fn dedups_replayed_event_ids_across_resubscribes() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        t.emit(&evt("e1", LIVE_KIND, 100));
        c.resubscribe();
        t.emit(&evt("e1", LIVE_KIND, 100));
        t.emit(&evt("e2", LIVE_KIND, 100));
        assert_eq!(*h.events.borrow(), vec!["e1".to_string(), "e2".to_string()]);
    }

    #[test]
    fn tracks_stored_cursor_and_ignores_ephemeral() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        t.emit(&evt("a", SESSION_LIST_KIND, 50));
        assert_eq!(h.cursor.get(), 50);
        t.emit(&evt("b", RESPONSE_KIND, 80));
        assert_eq!(h.cursor.get(), 80);
        t.emit(&evt("c", LIVE_KIND, 9_999)); // live output must NOT advance it (bug A)
        assert_eq!(h.cursor.get(), 80);
        t.emit(&evt("d", RESPONSE_KIND, 70)); // older stored event never regresses it
        assert_eq!(h.cursor.get(), 80);
    }

    #[test]
    fn reconnect_resumes_response_filter_from_the_persisted_cursor() {
        let (t, h, c) = harness(&["b1"]);
        c.connect();
        t.emit(&evt("a", RESPONSE_KIND, 500));
        c.resubscribe();
        let resumed = t.open().into_iter().find(|s| s.filter.kinds.contains(&RESPONSE_KIND)).unwrap();
        assert_eq!(resumed.filter.since, Some(500 - STORED_SINCE_GRACE_SECONDS));
        let _ = h;
    }

    #[test]
    fn with_no_machines_connect_reports_a_vacuous_open() {
        let (t, h, c) = harness(&[]);
        c.connect();
        assert_eq!(h.opens.get(), 1);
        assert_eq!(t.subs.borrow().len(), 0);
    }

    #[test]
    fn set_relays_forwards_and_resubscribes_when_live() {
        let (t, _h, c) = harness(&["b1"]);
        c.connect();
        t.eose_all();
        c.set_relays(&["wss://new.example".to_string()]);
        assert_eq!(*t.relays_set.borrow(), vec![vec!["wss://new.example".to_string()]]);
        assert_eq!(t.subs.borrow().len(), 6); // 3 old (closed) + 3 new
        assert_eq!(t.open().len(), 3);
    }
}
