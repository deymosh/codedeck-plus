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
use protocol::kinds::{COMMAND_KIND, LIVE_KIND};
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

/// The recipient tag the test client reads.
const MINE: &str = "mine";

/// Connect as `phone` and say HELLO, reading [`MINE`]; returns the socket
/// and the answer.
async fn hello(endpoint: &str, pin: &str, phone: &Keypair, since: u64) -> (Ws, DirectFrame) {
    hello_reading(endpoint, pin, phone, &[MINE.into()], since).await
}

/// Connect as `phone`, telling the bridge which copy recipient tags it reads.
async fn hello_reading(endpoint: &str, pin: &str, phone: &Keypair, recipients: &[String], since: u64) -> (Ws, DirectFrame) {
    let mut ws = connect(endpoint, pin).await.unwrap();
    let DirectFrame::Challenge(challenge) = next_frame(&mut ws).await else { panic!("expected a challenge") };
    let auth = build_auth_event(phone, endpoint, &challenge, now_secs() * 1000).unwrap();
    send(&mut ws, DirectFrame::Hello { auth, since, recipients: recipients.to_vec() }).await;
    let answer = next_frame(&mut ws).await;
    (ws, answer)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn event(from: &Keypair, kind: u16, to: &str, content: &str) -> SignedEvent {
    copy(from, kind, to, MINE, content)
}

/// An event for `to`, the copy for the client reading `recipient`.
fn copy(from: &Keypair, kind: u16, to: &str, recipient: &str, content: &str) -> SignedEvent {
    let keys = nostr::Keys::new(from.secret_key.clone());
    let tags = [
        nostr::Tag::public_key(nostr::PublicKey::from_hex(to).unwrap()),
        nostr::Tag::custom(nostr::TagKind::custom("c"), [recipient]),
    ];
    SignedEvent::from_nostr(&nostr::EventBuilder::new(nostr::Kind::Custom(kind), content).tags(tags).sign_with_keys(&keys).unwrap())
}

#[tokio::test]
async fn a_paired_phone_gets_its_events_and_sends_commands_over_the_pinned_link() {
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let (bridge, phone, stranger) = (generate_keypair(), generate_keypair(), generate_keypair());
            let (inputs, mut engine) = mpsc::unbounded_channel();
            let config = DirectConfig { listen: Some("127.0.0.1:0".parse().unwrap()), ..Default::default() };
            let mut link = direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs, Default::default()).await.unwrap().expect("enabled");
            let endpoint = link.info.endpoints[0].clone();
            let pin = link.info.cert_sha256.clone().expect("a wss listener advertises its pin");
            assert!(endpoint.starts_with("wss://127.0.0.1:"), "{endpoint}");

            // Another certificate is refused by the pin.
            assert!(connect(&endpoint, &"00".repeat(32)).await.is_err());

            link.hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));
            // A stranger is not let in.
            let (_, answer) = hello(&endpoint, &pin, &stranger, 0).await;
            assert_eq!(answer, DirectFrame::Closed("not paired".into()));

            // Published before it connects: replayed after READY — its own
            // copy, not another client's of the same identity.
            let theirs = copy(&bridge, 4516, &phone.pubkey_hex, "theirs", "earlier");
            let earlier = event(&bridge, 4516, &phone.pubkey_hex, "earlier");
            link.hub.deliver(&phone.pubkey_hex, &theirs, false);
            link.hub.deliver(&phone.pubkey_hex, &earlier, false);
            let (mut ws, answer) = hello(&endpoint, &pin, &phone, now_secs() - 60).await;
            assert_eq!(answer, DirectFrame::Ready);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(earlier));

            // Published while connected: pushed at once, again only its own.
            link.hub.deliver(&phone.pubkey_hex, &copy(&bridge, 24515, &phone.pubkey_hex, "theirs", "live"), false);
            let live = event(&bridge, 24515, &phone.pubkey_hex, "live");
            link.hub.deliver(&phone.pubkey_hex, &live, false);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(live));

            // A command goes to the engine as a relay's would, and is OKed.
            let command = event(&phone, COMMAND_KIND, &bridge.pubkey_hex, "cmd");
            send(&mut ws, DirectFrame::Event(command.clone())).await;
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Ok { id: command.id.clone(), accepted: true, message: String::new() });
            match engine.recv().await {
                Some(Input::RelayEvent { event, via: Via::Direct }) => assert_eq!(event.id, command.id),
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

/// The live kind carries a phone's keystrokes into the engine the same way a
/// command does, and terminal output reaches the phone on a lane that never
/// overtakes a normal frame.
#[tokio::test]
async fn a_paired_phone_sends_live_input_and_terminal_output_never_jumps_a_normal_frame() {
    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let (bridge, phone) = (generate_keypair(), generate_keypair());
            let (inputs, mut engine) = mpsc::unbounded_channel();
            let config = DirectConfig { listen: Some("127.0.0.1:0".parse().unwrap()), ..Default::default() };
            let mut link = direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs, Default::default()).await.unwrap().unwrap();
            let endpoint = link.info.endpoints[0].clone();
            let pin = link.info.cert_sha256.clone().unwrap();
            link.hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));
            let (mut ws, answer) = hello(&endpoint, &pin, &phone, now_secs() - 60).await;
            assert_eq!(answer, DirectFrame::Ready);

            // Terminal input on the live kind: accepted, and the engine is
            // told which kind it was.
            let input = event(&phone, LIVE_KIND, &bridge.pubkey_hex, "keystrokes");
            send(&mut ws, DirectFrame::Event(input.clone())).await;
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Ok { id: input.id.clone(), accepted: true, message: String::new() });
            match engine.recv().await {
                Some(Input::RelayEvent { event, via: Via::Direct }) => assert_eq!((event.id, event.kind), (input.id, LIVE_KIND)),
                _ => panic!("expected the live event"),
            }

            // A normal frame and a terminal one queued together: the normal
            // one goes first, the terminal one after — a terminal never
            // overtakes the phone's other traffic.
            let normal = event(&bridge, 4516, &phone.pubkey_hex, "normal");
            let output = copy(&bridge, LIVE_KIND, &phone.pubkey_hex, MINE, "output");
            link.hub.deliver(&phone.pubkey_hex, &normal, false);
            link.hub.deliver(&phone.pubkey_hex, &output, true);
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(normal));
            assert_eq!(next_frame(&mut ws).await, DirectFrame::Event(output));

            link.shutdown();
        })
        .await;
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
            let mut server = direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs, Default::default()).await.unwrap().unwrap();
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
                        recipients: vec![MINE.into()],
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
            server.hub.deliver(&phone.pubkey_hex, &live, false);
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

/// A message the direct link carried goes to the phone at once even while a
/// configured relay is down: publishing is not the direct link's turn to
/// wait, since the phone already has the event.
#[tokio::test]
async fn a_phone_on_the_direct_link_gets_every_message_while_its_relay_is_down() {
    use bridge_core::Addressee;
    use bridge_runtime::relay::Relays;
    use protocol::events::{BridgeToPhone, InputAckMsg};

    LocalSet::new()
        .run_until(async {
            let home = tempfile::tempdir().unwrap();
            let (bridge, phone) = (generate_keypair(), generate_keypair());
            let (inputs, _engine) = mpsc::unbounded_channel();
            let config = DirectConfig { listen: Some("127.0.0.1:0".parse().unwrap()), ..Default::default() };
            let mut server =
                direct::start(&config, home.path(), bridge.pubkey_hex.clone(), inputs.clone(), Default::default()).await.unwrap().unwrap();
            server.hub.set_paired(std::slice::from_ref(&phone.pubkey_hex));
            let endpoint = server.info.endpoints[0].clone();
            let pin = server.info.cert_sha256.clone().expect("a wss listener advertises its pin");

            // A relay configured on a port nothing listens on: it is on the
            // list, but no relay will ever answer.
            let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let relay = format!("ws://{}", dead.local_addr().unwrap());
            drop(dead);
            let mut relays = Relays::start(vec![relay], bridge.clone(), None, inputs, Some(Rc::clone(&server.hub)));

            // The phone reads its own copy tag, which is the one the bridge
            // tags a copy to its identity with.
            let recipient = protocol::recipients::recipient_tag(&bridge.pubkey_hex, &phone.pubkey_hex);
            let (mut ws, answer) = hello_reading(&endpoint, &pin, &phone, std::slice::from_ref(&recipient), now_secs()).await;
            assert_eq!(answer, DirectFrame::Ready);

            // Responses have no lane, so each publish is awaited before the
            // next one starts: a publish that waits on the dead relay is a
            // dead relay in front of every message after it.
            let addressee = Addressee { phone: phone.pubkey_hex.clone(), key: phone.pubkey_hex.clone() };
            let acks: Vec<BridgeToPhone> = (0..4)
                .map(|i| BridgeToPhone::InputAck(InputAckMsg { session_id: "s".into(), input_id: format!("i{i}") }))
                .collect();
            for ack in &acks {
                relays.publish(vec![addressee.clone()], ack.clone());
            }

            // Well under the 12 s a publish waits for a relay coming up.
            tokio::time::timeout(Duration::from_secs(2), async {
                for ack in &acks {
                    let DirectFrame::Event(event) = next_frame(&mut ws).await else { panic!("expected the event") };
                    let plain = protocol::crypto::decrypt_from(&phone.secret_key, &bridge.pubkey_hex, &event.content).unwrap();
                    assert_eq!(protocol::decode_bridge_to_phone(&plain).unwrap(), *ack);
                }
            })
            .await
            .expect("the direct link got every message without waiting on the dead relay");

            relays.shutdown();
            server.shutdown();
        })
        .await;
}
