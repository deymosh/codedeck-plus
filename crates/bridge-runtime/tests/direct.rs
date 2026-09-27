//! The direct link over a real socket: the bridge's server, first against a
//! hand-driven client (the frames), then against the phone's `DirectLink`.

use std::sync::Arc;
use std::time::Duration;

use bridge_core::{Input, Via};
use bridge_runtime::config::DirectConfig;
use bridge_runtime::direct;
use futures_util::{SinkExt, StreamExt};
use protocol::crypto::{generate_keypair, Keypair};
use protocol::direct::{decode_direct_frame, encode_direct_frame, DirectFrame};
use protocol::kinds::COMMAND_KIND;
use protocol::nip42::build_auth_event;
use protocol::nostr_event::SignedEvent;
use rustls::pki_types::ServerName;
use std::cell::RefCell;
use std::rc::Rc;
use tokio::sync::mpsc;
use tokio::task::LocalSet;
use tokio_tungstenite::tungstenite::Message;

type Ws = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

async fn connect(endpoint: &str, pin: &str) -> Result<Ws, String> {
    let config = nostr_transport::direct::pinned_client_config(pin);
    let addr = endpoint.strip_prefix("wss://").unwrap();
    let tcp = tokio::net::TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("codedeck-bridge").unwrap(), tcp)
        .await
        .map_err(|e| e.to_string())?;
    let (ws, _) = tokio_tungstenite::client_async(endpoint, tls).await.map_err(|e| e.to_string())?;
    Ok(ws)
}

async fn next_frame(ws: &mut Ws) -> DirectFrame {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("a frame in time").expect("open").unwrap();
        if let Message::Text(text) = msg {
            return decode_direct_frame(&text).unwrap();
        }
    }
}

async fn send(ws: &mut Ws, frame: DirectFrame) {
    ws.send(Message::Text(encode_direct_frame(&frame))).await.unwrap();
}

/// Connect as `phone` and say HELLO; returns the socket and the answer.
async fn hello(endpoint: &str, pin: &str, phone: &Keypair, since: u64) -> (Ws, DirectFrame) {
    let mut ws = connect(endpoint, pin).await.unwrap();
    let DirectFrame::Challenge(challenge) = next_frame(&mut ws).await else { panic!("expected a challenge") };
    let auth = build_auth_event(phone, endpoint, &challenge, now_secs() * 1000).unwrap();
    send(&mut ws, DirectFrame::Hello { auth, since }).await;
    let answer = next_frame(&mut ws).await;
    (ws, answer)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn event(from: &Keypair, kind: u16, to: &str, content: &str) -> SignedEvent {
    let keys = nostr::Keys::new(from.secret_key.clone());
    let tag = nostr::Tag::public_key(nostr::PublicKey::from_hex(to).unwrap());
    SignedEvent::from_nostr(&nostr::EventBuilder::new(nostr::Kind::Custom(kind), content).tag(tag).sign_with_keys(&keys).unwrap())
}

#[tokio::test]
async fn a_paired_phone_gets_its_events_and_sends_commands_over_the_pinned_link() {
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let (bridge, phone, stranger) = (generate_keypair(), generate_keypair(), generate_keypair());
            let (inputs, mut engine) = mpsc::unbounded_channel();
            let config = DirectConfig { listen: Some("127.0.0.1:0".parse().unwrap()), ..Default::default() };
            let mut link = direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs).await.unwrap().expect("enabled");
            let endpoint = link.info.endpoints[0].clone();
            let pin = link.info.cert_sha256.clone().expect("a wss listener advertises its pin");
            assert!(endpoint.starts_with("wss://127.0.0.1:"), "{endpoint}");

            // Another certificate is refused by the pin.
            assert!(connect(&endpoint, &"00".repeat(32)).await.is_err());

            link.hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));
            // A stranger is not let in.
            let (_, answer) = hello(&endpoint, &pin, &stranger, 0).await;
            assert_eq!(answer, DirectFrame::Closed("not paired".into()));

            // Published before it connects: replayed after READY.
            let earlier = event(&bridge, 4516, &phone.pubkey_hex, "earlier");
            link.hub.deliver(&phone.pubkey_hex, &earlier);
            let (mut ws, answer) = hello(&endpoint, &pin, &phone, now_secs() - 60).await;
            assert_eq!(answer, DirectFrame::Ready);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(earlier));

            // Published while connected: pushed at once.
            let live = event(&bridge, 24515, &phone.pubkey_hex, "live");
            link.hub.deliver(&phone.pubkey_hex, &live);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(live));

            // A command goes to the engine as a relay's would, and is OKed.
            let command = event(&phone, COMMAND_KIND, &bridge.pubkey_hex, "cmd");
            send(&mut ws, DirectFrame::Event(command.clone())).await;
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Ok { id: command.id.clone(), accepted: true, message: String::new() });
            match engine.recv().await {
                Some(Input::RelayEvent { event, via: Via::Commands }) => assert_eq!(event.id, command.id),
                _ => panic!("expected the command"),
            }
            // One the phone did not author is refused.
            let forged = event(&stranger, COMMAND_KIND, &bridge.pubkey_hex, "cmd");
            send(&mut ws, DirectFrame::Event(forged.clone())).await;
            assert!(matches!(next_frame(&mut ws).await, DirectFrame::Ok { accepted: false, .. }));

            // Unpairing closes it.
            link.hub.set_paired(&[]);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Closed("closed".into()));
            link.shutdown();
        })
        .await;
}

async fn wait_until(cond: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The phone's link against the real server: up on the pinned endpoint,
/// events in, a command out and acknowledged, down when unpaired; never up
/// with the wrong pin.
#[tokio::test]
async fn the_phone_link_talks_to_the_bridge() {
    use nostr_transport::direct::{DirectConfig as LinkConfig, DirectHandlers, DirectLink};
    use nostr_transport::PublishVerdict;
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let (bridge, phone) = (generate_keypair(), generate_keypair());
            let (inputs, mut engine) = mpsc::unbounded_channel();
            let config = DirectConfig { listen: Some("127.0.0.1:0".parse().unwrap()), ..Default::default() };
            let mut server = direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs).await.unwrap().unwrap();
            server.hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));

            let start = |pin: String| {
                let events = Rc::new(RefCell::new(Vec::new()));
                let states = Rc::new(RefCell::new(Vec::new()));
                let (e, s) = (Rc::clone(&events), Rc::clone(&states));
                let link = DirectLink::start(
                    LinkConfig {
                        endpoints: server.info.endpoints.clone(),
                        cert_sha256: Some(pin),
                        proxy: None,
                        auth: Rc::new(phone.clone()),
                    },
                    DirectHandlers {
                        on_event: Rc::new(move |ev| e.borrow_mut().push(ev)),
                        on_state: Rc::new(move |st| s.borrow_mut().push(st)),
                    },
                );
                (link, events, states)
            };

            // The wrong pin never gets it up.
            let (wrong, _, wrong_states) = start("00".repeat(32));
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(wrong_states.borrow().is_empty() && wrong.endpoint().is_none());
            wrong.stop();

            let (link, events, states) = start(server.info.cert_sha256.clone().unwrap());
            wait_until(|| link.endpoint().is_some()).await;
            assert_eq!(states.borrow().as_slice(), [Some(server.info.endpoints[0].clone())]);

            let live = event(&bridge, 24515, &phone.pubkey_hex, "live");
            server.hub.deliver(&phone.pubkey_hex, &live);
            wait_until(|| !events.borrow().is_empty()).await;
            assert_eq!(events.borrow()[0].id, live.id);

            let command = event(&phone, COMMAND_KIND, &bridge.pubkey_hex, "cmd");
            let result = link.publish(&command, Duration::from_secs(5)).await.expect("answered");
            assert_eq!(result.verdict, PublishVerdict::Accepted);
            assert!(matches!(engine.recv().await, Some(Input::RelayEvent { event, .. }) if event.id == command.id));

            server.hub.set_paired(&[]);
            wait_until(|| link.endpoint().is_none()).await;
            assert_eq!(states.borrow().last(), Some(&None));
            assert!(link.publish(&command, Duration::from_secs(1)).await.is_none(), "down: the caller uses the relays");
            link.stop();
            server.shutdown();
        })
        .await;
}
