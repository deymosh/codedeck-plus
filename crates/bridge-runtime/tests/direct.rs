//! The direct link server over a real socket: wss with the pinned
//! certificate, the handshake, events both ways, and unpairing.

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
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::task::LocalSet;
use tokio_tungstenite::tungstenite::Message;

/// Accepts exactly the certificate with this SHA-256, as a phone does.
#[derive(Debug)]
struct Pinned(String, Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if hex::encode(Sha256::digest(end_entity.as_ref())) == self.0 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate does not match the pin".into()))
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.1.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.1.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.1.signature_verification_algorithms.supported_schemes()
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

async fn connect(endpoint: &str, pin: &str) -> Result<Ws, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(pin.to_string(), provider)))
        .with_no_client_auth();
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
