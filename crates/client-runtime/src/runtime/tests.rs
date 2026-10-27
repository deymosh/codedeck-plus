use super::*;
use crate::ports::RecordingNotifier;
use crate::transport::mock::{mock_relay, MockRelay};
use protocol::crypto::{generate_keypair, keypair_from_secret_hex, Keypair};
use protocol::codec::encode_bridge_to_phone;
use protocol::commands::UploadFileMsg;
use protocol::kinds::{LIVE_KIND, RESPONSE_KIND, SESSION_LIST_KIND};
use crate::stores::LAST_STORED_SEEN_KEY;
use crate::intent::SessionFileSend;
use client_core::stores::session_key::{SessionGrant, SessionKey};
use std::sync::Mutex;
use tokio::task::LocalSet;

mod tor;
mod connection;
mod store_layer;
mod machines;
mod session_keys;
mod direct;
mod sync;
mod backup;
mod presence;
mod terminal;

pub(super) const SEC_PHONE: &str =
    "0000000000000000000000000000000000000000000000000000000000000001";

#[derive(Default)]
pub(super) struct Spy {
    statuses: Mutex<Vec<(ConnectionStatus, bool)>>,
    connected_relays: Mutex<Vec<Vec<String>>>,
    messages: Mutex<Vec<(String, BridgeToPhone)>>,
    failures: Mutex<Vec<ActionFailedKind>>,
    events: Mutex<Vec<CoreEvent>>,
}

impl CoreObserver for Spy {
    fn connection_changed(&self, status: ConnectionStatus, needs_pairing_check: bool, connected_relays: &[String]) {
        self.statuses.lock().unwrap().push((status, needs_pairing_check));
        self.connected_relays.lock().unwrap().push(connected_relays.to_vec());
    }
    fn bridge_message(&self, machine: String, msg: BridgeToPhone) {
        self.messages.lock().unwrap().push((machine, msg));
    }
    fn action_failed(&self, kind: ActionFailedKind) {
        self.failures.lock().unwrap().push(kind);
    }
    fn on_event(&self, event: CoreEvent) {
        self.events.lock().unwrap().push(event);
    }
}

pub(super) struct FixedClock(RefCell<u64>);

impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        *self.0.borrow()
    }
}

pub(super) struct ZeroEntropy;

impl Entropy for ZeroEntropy {
    fn unit(&self) -> f64 {
        0.0
    }
}

pub(super) fn fast_reconnect() -> ReconnectConfig {
    ReconnectConfig {
        base_ms: 40,
        max_ms: 120,
        jitter_fraction: 0.0,
        heartbeat_stale_after_ms: 150_000,
        connect_deadline_ms: 45_000,
    }
}

/// A fixed wait, only where no event names what the test needs: a check that
/// something did NOT happen (give the loop time to prove the absence), a
/// fake-clock step that must land before the test moves the clock on, or a
/// private state the views do not expose.
pub(super) async fn settle() {
    tokio::time::sleep(Duration::from_millis(120)).await;
}

/// Wait for a condition that names the event a test needs, instead of always
/// burning the same wall-clock time and hoping it was enough.
pub(super) async fn wait_for(mut cond: impl FnMut() -> bool) {
    for _ in 0..600 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never became true");
}

/// Wait until the live FSM reports `want`.
pub(super) async fn wait_status(core: &Core, want: ConnectionStatus) {
    for _ in 0..600 {
        if core.connection_status().await.0 == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the core never reached {want:?}");
}

pub(super) async fn wait_connected(core: &Core) {
    wait_status(core, ConnectionStatus::Connected).await;
}

/// [`wait_for`] for a probe that has to query a view (answered in order with
/// everything the loop had already queued).
pub(super) async fn wait_for_async<F, Fut>(mut probe: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..600 {
        if probe().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never became true");
}

pub(super) async fn core_for(mock: &MockRelay, phone: &Keypair, spy: Rc<Spy>) -> Core {
    core_for_ports(mock, phone, spy, CorePorts::default()).await
}

pub(super) async fn core_for_ports(
    mock: &MockRelay,
    phone: &Keypair,
    spy: Rc<Spy>,
    ports: CorePorts,
) -> Core {
    core_for_ports_clock(mock, phone, spy, ports, Rc::new(FixedClock(RefCell::new(1_000_000)))).await
}

pub(super) async fn core_for_ports_clock(
    mock: &MockRelay,
    phone: &Keypair,
    spy: Rc<Spy>,
    ports: CorePorts,
    clock: Rc<FixedClock>,
) -> Core {
    let core = Core::spawn(
        CoreConfig {
            identity: Rc::new(crate::signer::LocalSigner(phone.clone())),
            proxy: None,
            tor: false,
            device_label: None,
            reconnect: fast_reconnect(),
        },
        ports,
        spy,
        clock,
        Rc::new(ZeroEntropy),
    )
    .await;
    // No paired machine brings a relay here; point the transport at the
    // mock the way a paired machine's relays would.
    core.set_relays(vec![mock.url.clone()]);
    core
}

/// EOSE the three bridge subscriptions. All are named `cd-N` and replay
/// in non-deterministic order.
pub(super) async fn eose_all(mock: &mut MockRelay) {
    let mut seen = 0;
    while seen < 3 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == "REQ" {
            let sub_id = v[1].as_str().unwrap();
            mock.push(format!(r#"["EOSE","{sub_id}"]"#));
            seen += 1;
        }
    }
}

/// A resubscribe triggered by an authors-filter change (a new pairing
/// candidate, a freshly paired machine) re-does the phone's 3 traffic
/// filters: this drains exactly 3 REQs (skipping the CLOSE frames for the
/// superseded subs along the way) and returns one sub_id the router now
/// has open.
pub(super) async fn drain_traffic_resubscribe(mock: &mut MockRelay) -> String {
    let mut seen = 0;
    let mut sub_id = String::new();
    while seen < 3 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] == "REQ" {
            let id = v[1].as_str().unwrap().to_string();
            mock.push(format!(r#"["EOSE","{id}"]"#));
            sub_id = id;
            seen += 1;
        }
    }
    sub_id
}

/// Pushes one raw encrypted `machine -> phone` event through the mock
/// relay, tagged to `sub_id` — the router only delivers an `EVENT` frame
/// for a sub_id it currently has open (it doesn't check the filter), and
/// every resubscribe (a new pairing candidate, a freshly paired machine)
/// tears down the old subs and opens new ones with new ids, so the caller
/// must hand in a sub_id drained from the CURRENT `eose_all` round, not
/// one left over from an earlier one.
pub(super) fn push_bridge_to_phone_event(
    mock: &MockRelay,
    machine: &protocol::crypto::Keypair,
    phone_pubkey_hex: &str,
    sub_id: &str,
    msg: &BridgeToPhone,
) {
    push_bridge_to_phone_event_at(mock, machine, phone_pubkey_hex, sub_id, msg, LIVE_KIND, None);
}

/// [`push_bridge_to_phone_event`] as an event of `kind`, written at
/// `created_at` (seconds) rather than now.
pub(super) fn push_bridge_to_phone_event_at(
    mock: &MockRelay,
    machine: &protocol::crypto::Keypair,
    phone_pubkey_hex: &str,
    sub_id: &str,
    msg: &BridgeToPhone,
    kind: u16,
    created_at: Option<u64>,
) {
    let plaintext = encode_bridge_to_phone(msg);
    let ct = protocol::crypto::encrypt_to(&machine.secret_key, phone_pubkey_hex, &plaintext)
        .unwrap();
    let mut builder = nostr::EventBuilder::new(nostr::Kind::Custom(kind), ct).tag(recipient(machine, phone_pubkey_hex));
    if let Some(at) = created_at {
        builder = builder.custom_created_at(nostr::Timestamp::from(at));
    }
    let event = builder.sign_with_keys(&nostr::Keys::new(machine.secret_key.clone())).unwrap();
    mock.push(format!(
        r#"["EVENT","{sub_id}",{}]"#,
        <nostr::Event as nostr::JsonUtil>::as_json(&event)
    ));
}

/// The recipient tag of a copy `bridge` encrypted to `key`.
pub(super) fn recipient(bridge: &protocol::crypto::Keypair, key: impl AsRef<str>) -> nostr::Tag {
    let tag = protocol::recipients::recipient_tag(&bridge.pubkey_hex, key.as_ref());
    nostr::Tag::custom(nostr::TagKind::custom(protocol::recipients::RECIPIENT_TAG), [tag])
}

/// The next command EVENT the identity `phone` signed for `machine`,
/// with its payload decrypted as from `payload_key` (the phone's
/// identity or its session key). Every EVENT is ACKed on the way.
pub(super) async fn next_command_via(
    mock: &mut MockRelay,
    phone: &Keypair,
    payload_key: &str,
    machine: &Keypair,
) -> Option<PhoneToBridge> {
    for _ in 0..16 {
        let frame = mock.next_frame().await;
        let v: Vec<serde_json::Value> = serde_json::from_str(&frame).unwrap();
        if v[0] != "EVENT" {
            continue;
        }
        mock.push(format!(r#"["OK","{}",true,""]"#, v[1]["id"].as_str().unwrap()));
        let ev: nostr::Event = serde_json::from_value(v[1].clone()).unwrap();
        assert!(ev.verify().is_ok());
        assert_eq!(ev.pubkey.to_hex(), phone.pubkey_hex, "every event is signed by the identity");
        let plaintext = protocol::crypto::decrypt_from(&machine.secret_key, payload_key, &ev.content).ok()?;
        return protocol::codec::decode_phone_to_bridge(&plaintext).ok();
    }
    None
}

/// Mark `machine` as a bridge already heard from that does not honour
/// session keys: it is talked to with the identity, as a test of anything
/// else expects.
pub(super) fn heard_without_session_keys(state: &mut client_core::stores::machines::MachinesState, machine: &str) {
    let m = state.machines.get_mut(machine).unwrap();
    m.capabilities = vec![protocol::capabilities::FILES.to_string()];
    m.last_heartbeat_at = Some(1);
}

/// A host's secret store for the session keys, in memory.
#[derive(Default, Clone)]
pub(super) struct MemoryKeyStore(Rc<RefCell<Option<String>>>);

impl SessionKeyStore for MemoryKeyStore {
    fn load(&self) -> crate::ports::LocalBoxFuture<'_, Option<String>> {
        let ring = self.0.borrow().clone();
        Box::pin(async move { ring })
    }
    fn save(&self, ring: &str) -> crate::ports::LocalBoxFuture<'_, ()> {
        *self.0.borrow_mut() = Some(ring.to_string());
        Box::pin(async {})
    }
}

impl MemoryKeyStore {
    fn ring(&self) -> SessionKeyRing {
        SessionKeyRing::load(self.0.borrow().as_deref(), 1_000_000).0
    }
}

/// A started core that `machine` knows by the session key `key`.
pub(super) async fn core_watched_by(mock: &MockRelay, phone: &Keypair, key: &SessionKey, machine: &Keypair) -> Core {
    let store = MemoryKeyStore::default();
    *store.0.borrow_mut() = Some(SessionKeyRing::single(key.clone()).encode());
    let mut state = client_core::stores::machines::MachinesState::default();
    state.register_machine(&machine.pubkey_hex, "bridge", None, None, &[]);
    state.machines.get_mut(&machine.pubkey_hex).unwrap().session_grant = Some(SessionGrant {
        pubkey_hex: key.pubkey_hex().to_string(),
        expires_at: key.expires_at,
        sent_at: key.expires_at - 100,
    });
    let kv = MemoryKv::seeded([(
        crate::stores::MACHINES_KEY,
        client_core::stores::machines::serialize_machines(&state.machines),
    )]);
    let core = core_for_ports(
        mock,
        phone,
        Rc::new(Spy::default()),
        CorePorts { kv: Rc::new(kv), session_keys: Some(Rc::new(store)), ..CorePorts::default() },
    )
    .await;
    core.start();
    core
}

/// Every `presence` this client sends `machine` within `wait`.
pub(super) async fn presences_within(
    mock: &mut MockRelay,
    payload_key: &str,
    machine: &Keypair,
    wait: Duration,
) -> Vec<PresenceMsg> {
    let deadline = std::time::Instant::now() + wait;
    let mut sent = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        let Some(frame) = mock.frame_within(left).await else { break };
        let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(&frame) else { continue };
        if v[0] != "EVENT" {
            continue;
        }
        let Ok(ev) = serde_json::from_value::<nostr::Event>(v[1].clone()) else { continue };
        let Ok(plain) = protocol::crypto::decrypt_from(&machine.secret_key, payload_key, &ev.content) else { continue };
        if let Ok(PhoneToBridge::Presence(m)) = protocol::codec::decode_phone_to_bridge(&plain) {
            sent.push(m);
        }
    }
    sent
}
