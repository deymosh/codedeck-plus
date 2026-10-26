//! The bridge's Tor rule, exercised end to end with in-test SOCKS5 and HTTP
//! servers: with a proxy configured, every relay dial and every Blossom
//! download goes through it; without one, Nostr HTTP goes direct, loopback is
//! reached directly even with a proxy set, and a `.onion` service is refused
//! rather than dialled directly.
//!
//! These are the only tests that make the wiring in `runtime.rs` and
//! `relay.rs` carry a real proxy: everything else passes `None`, so a dropped
//! proxy argument would otherwise go unnoticed.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use bridge_runtime::config::{AuditSettings, Config, DirectConfig, TerminalSettings};
use bridge_runtime::relay::Relays;
use bridge_runtime::uploads::fetch_blossom;
use bridge_runtime::work::{NostrHttp, NostrTransports};
use protocol::capabilities::BridgeHostKind;
use protocol::commands::UploadFileBlossomMsg;
use protocol::crypto::generate_keypair;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::LocalSet;

/// Waits for something the rule says must happen.
const HAPPENS: Duration = Duration::from_secs(10);
/// Gives something the rule says must not happen every chance to. A failure
/// guard, not pacing: the positive assertion of the same test already proves
/// the request took the proxied path.
const NEVER: Duration = Duration::from_millis(300);

fn config(proxy: Option<SocketAddr>, relays: Vec<String>) -> Config {
    let home = std::env::temp_dir().join("codedeck-tor-routing-test");
    Config {
        config_file: home.join("config.json"),
        config_file_exists: false,
        home,
        machine: "test".into(),
        host_kind: BridgeHostKind::Cli,
        relays,
        workspace_roots: vec![std::env::temp_dir()],
        tor_proxy: proxy.map(|a| a.to_string()),
        transcript_keep_last: None,
        node_path: "node".into(),
        agent_host_path: "agent-host/dist/main.js".into(),
        test_mode: true,
        host_env: Default::default(),
        direct: DirectConfig::default(),
        terminal: TerminalSettings::default(),
        audit: AuditSettings::default(),
        overridden: Default::default(),
    }
}

/// The destination of one SOCKS5 `CONNECT`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Connect {
    host: String,
    port: u16,
}

/// An in-test SOCKS5 server on loopback (no authentication) that reports
/// every `CONNECT` target it is asked for. With `forward` set it opens that
/// TCP stream and pipes the bytes, so a whole dial — a WebSocket handshake,
/// an HTTP download — completes through the proxy; without one it refuses,
/// which is what a client that asked the proxy gets instead of a direct
/// connection.
struct Socks5 {
    addr: SocketAddr,
    connects: mpsc::UnboundedReceiver<Connect>,
}

async fn socks5(forward: Option<SocketAddr>) -> Socks5 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("the in-test SOCKS5 proxy binds");
    let addr = listener.local_addr().expect("the in-test SOCKS5 proxy has an address");
    let (seen, connects) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let Ok(target) = read_connect(&mut socket).await else { return };
                let _ = seen.send(target);
                let Some(dest) = forward else {
                    // General failure: the client learns nothing was dialled.
                    let _ = socket.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                    return;
                };
                let Ok(mut upstream) = TcpStream::connect(dest).await else {
                    let _ = socket.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                    return;
                };
                // Success. The bound address is never read by these clients.
                if socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_ok() {
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
                }
            });
        }
    });
    Socks5 { addr, connects }
}

/// Complete the SOCKS5 greeting, then read the `CONNECT` request. The caller
/// sends the reply, once it knows where the connection goes.
async fn read_connect(socket: &mut TcpStream) -> io::Result<Connect> {
    let mut greeting = [0u8; 2];
    socket.read_exact(&mut greeting).await?;
    if greeting[0] != 5 {
        return Err(invalid("not SOCKS5"));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    socket.read_exact(&mut methods).await?;
    socket.write_all(&[5, 0]).await?; // no authentication
    let mut head = [0u8; 4];
    socket.read_exact(&mut head).await?;
    if head[0] != 5 || head[1] != 1 {
        return Err(invalid("not a SOCKS5 CONNECT"));
    }
    let host = match head[3] {
        1 => {
            let mut bytes = [0u8; 4];
            socket.read_exact(&mut bytes).await?;
            Ipv4Addr::from(bytes).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut bytes = vec![0u8; len[0] as usize];
            socket.read_exact(&mut bytes).await?;
            String::from_utf8(bytes).map_err(|_| invalid("the CONNECT host is not UTF-8"))?
        }
        4 => {
            let mut bytes = [0u8; 16];
            socket.read_exact(&mut bytes).await?;
            Ipv6Addr::from(bytes).to_string()
        }
        other => return Err(invalid(&format!("unknown SOCKS5 address type {other}"))),
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await?;
    Ok(Connect { host, port: u16::from_be_bytes(port) })
}

fn invalid(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason.to_string())
}

/// A loopback HTTP server that answers every request with `body` and reports
/// each request line it saw. `Connection: close`, so a client's connection
/// ends with the response.
async fn http_serving(body: Vec<u8>) -> (SocketAddr, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("the in-test HTTP server binds");
    let addr = listener.local_addr().expect("the in-test HTTP server has an address");
    let (requests, seen) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let body = body.clone();
            let requests = requests.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 1024];
                // A GET carries no body; read up to the end of the headers.
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let Ok(n) = socket.read(&mut buf).await else { return };
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let line = String::from_utf8_lossy(&raw).lines().next().unwrap_or_default().to_string();
                let _ = requests.send(line);
                let mut response =
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                response.extend_from_slice(&body);
                let _ = socket.write_all(&response).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (addr, seen)
}

/// An encrypted blob and the key material a phone sends beside its URL.
struct Encrypted {
    bytes: Vec<u8>,
    hash: String,
    key: String,
    iv: String,
}

/// Encrypt `plaintext` the way the phone does before uploading it to
/// Blossom: AES-256-GCM, the tag at the end.
fn encrypted(plaintext: &[u8]) -> Encrypted {
    let (key, iv) = ([7u8; 32], [9u8; 12]);
    let bytes = Aes256Gcm::new_from_slice(&key)
        .expect("a 256-bit key")
        .encrypt(Nonce::from_slice(&iv), plaintext)
        .expect("the blob encrypts");
    Encrypted { hash: hex::encode(Sha256::digest(&bytes)), bytes, key: hex::encode(key), iv: hex::encode(iv) }
}

/// The Blossom message the phone would send for `url` holding `blob`.
fn blossom_message(url: String, blob: &Encrypted) -> UploadFileBlossomMsg {
    UploadFileBlossomMsg {
        session_id: "s".into(),
        hash: blob.hash.clone(),
        url,
        key: blob.key.clone(),
        iv: blob.iv.clone(),
        filename: "photo.png".into(),
        mime_type: "image/png".into(),
        text: String::new(),
        size_bytes: blob.bytes.len() as u64,
    }
}

/// With a proxy configured, the relay transport must reach its relay through
/// it — the CONNECT names the relay's host and port — and must not have
/// dialled the relay itself.
#[tokio::test]
async fn a_configured_tor_proxy_carries_every_relay_dial() {
    LocalSet::new()
        .run_until(async {
            // The relay. Its listener is the only way to reach it; the proxy
            // is told to forward there, so a connection at its front door can
            // only have come through the proxy.
            let relay = TcpListener::bind("127.0.0.1:0").await.expect("the in-test relay binds");
            let relay_addr = relay.local_addr().expect("the in-test relay has an address");
            let mut proxy = socks5(Some(relay_addr)).await;

            let config = config(Some(proxy.addr), vec![format!("ws://{relay_addr}")]);
            let nostr = NostrTransports::from_config(&config).expect("the configured proxy builds");
            let (inputs, _events) = mpsc::unbounded_channel();
            let _relays = Relays::start_with(&nostr, generate_keypair(), inputs, None);

            // The proxy is what the transport reached, and it was asked for
            // the relay the config names.
            let target = tokio::time::timeout(HAPPENS, proxy.connects.recv())
                .await
                .expect("the bridge dialled its relay through the configured proxy")
                .expect("the proxy reports the CONNECT");
            assert_eq!((target.host.as_str(), target.port), ("127.0.0.1", relay_addr.port()), "the proxy was asked for the configured relay");

            // And the proxied connection is the one that arrives: complete
            // its handshake so the transport stays on it.
            let (tcp, _) = tokio::time::timeout(HAPPENS, relay.accept())
                .await
                .expect("the proxied connection reaches the relay")
                .expect("the relay accepts");
            tokio::time::timeout(HAPPENS, tokio_tungstenite::accept_async(tcp))
                .await
                .expect("the relay's WebSocket handshake completes")
                .expect("the relay accepts the WebSocket handshake");

            assert!(
                tokio::time::timeout(NEVER, relay.accept()).await.is_err(),
                "a second connection reached the relay directly; every dial must go through the proxy"
            );
        })
        .await;
}

/// With a proxy configured, a Blossom download must be made through it: the
/// proxy sees the ONION host the message names, and the download succeeds
/// only because the proxy carried it.
#[tokio::test]
async fn a_configured_tor_proxy_carries_a_blossom_download() {
    let blob = encrypted(b"photo bytes");
    let (http_addr, mut requests) = http_serving(blob.bytes.clone()).await;
    let mut proxy = socks5(Some(http_addr)).await;
    let config = config(Some(proxy.addr), vec![]);
    let nostr = NostrTransports::from_config(&config).expect("the configured proxy builds");

    // An onion URL cannot resolve on this machine: only the proxy can carry
    // it, so a successful download proves the proxy was used.
    let url = format!("http://abcdefghijklmnop.onion:{}/blob", http_addr.port());
    let msg = blossom_message(url, &blob);
    let data = tokio::time::timeout(HAPPENS, fetch_blossom(&nostr.http, &msg))
        .await
        .expect("the download finishes")
        .expect("the proxied Blossom download succeeds");
    assert_eq!(data, b"photo bytes", "the blob decrypts to what the phone encrypted");

    let target = tokio::time::timeout(HAPPENS, proxy.connects.recv())
        .await
        .expect("the Blossom request went through the configured proxy")
        .expect("the proxy reports the CONNECT");
    assert_eq!(
        (target.host.as_str(), target.port),
        ("abcdefghijklmnop.onion", http_addr.port()),
        "the proxy was asked for the Blossom host the message names"
    );
    let line = tokio::time::timeout(HAPPENS, requests.recv())
        .await
        .expect("the Blossom server answered")
        .expect("the Blossom server saw the request");
    assert_eq!(line, "GET /blob HTTP/1.1", "the request crossed the proxy unchanged");
    assert!(
        tokio::time::timeout(NEVER, requests.recv()).await.is_err(),
        "a second request reached the Blossom server; the download must go through the proxy once"
    );
}

/// Without a proxy, Nostr HTTP goes direct — and an onion service is refused
/// instead of being dialled directly.
#[tokio::test]
async fn without_a_proxy_nostr_http_goes_direct_and_refuses_onion() {
    let (http_addr, mut requests) = http_serving(b"direct".to_vec()).await;
    let mut unused_proxy = socks5(None).await;
    let http = NostrHttp::new(None).expect("a direct client builds");

    // Loopback is reachable over plain HTTP, and with no proxy it is the
    // direct client that carries the request.
    let url = format!("http://{http_addr}/x");
    let client = http.for_url(&url).expect("loopback needs no proxy");
    let body = client.get(&url).send().await.expect("the direct request reaches the server").text().await.expect("the body reads");
    assert_eq!(body, "direct");
    assert_eq!(tokio::time::timeout(HAPPENS, requests.recv()).await.expect("the server saw the request").as_deref(), Some("GET /x HTTP/1.1"));
    assert!(
        tokio::time::timeout(NEVER, unused_proxy.connects.recv()).await.is_err(),
        "no proxy was configured, so no CONNECT may have been made"
    );

    // A .onion service is out of reach without Tor: an error, never a direct
    // attempt at the name.
    let onion = blossom_message("http://abcdefghijklmnop.onion/blob".into(), &encrypted(b"x"));
    let err = fetch_blossom(&http, &onion).await.expect_err("an onion download without Tor is refused");
    assert!(err.contains("Tor proxy"), "the refusal names the missing Tor proxy: {err}");
}

/// Loopback is the one Nostr destination that skips the proxy: it never
/// leaves the machine, so a configured proxy must not carry it, and a
/// loopback request still succeeds while the proxy is set.
#[tokio::test]
async fn loopback_nostr_http_skips_the_proxy_even_when_one_is_configured() {
    let (http_addr, mut requests) = http_serving(b"local".to_vec()).await;
    let mut proxy = socks5(None).await;
    let proxy_addr = proxy.addr.to_string();
    let http = NostrHttp::new(Some(&proxy_addr)).expect("the configured proxy builds");

    let url = format!("http://{http_addr}/loopback");
    let client = http.for_url(&url).expect("loopback needs no proxy");
    let body = client.get(&url).send().await.expect("the loopback request reaches the server").text().await.expect("the body reads");
    assert_eq!(body, "local");
    assert_eq!(tokio::time::timeout(HAPPENS, requests.recv()).await.expect("the server saw the request").as_deref(), Some("GET /loopback HTTP/1.1"));
    assert!(
        tokio::time::timeout(NEVER, proxy.connects.recv()).await.is_err(),
        "loopback must not be routed through the configured proxy"
    );
}
