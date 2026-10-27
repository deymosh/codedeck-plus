//! Test-only network stand-ins for the transport's socket paths: a minimal
//! SOCKS5 proxy that reports the CONNECT it was asked for (so a test can see
//! where a proxied dial really went), and a TCP listener that counts
//! connections (so a test can see that a dial did NOT go somewhere).

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// Poll a condition until it holds, yielding between checks. The alternative,
/// a flat sleep, is both slower than needed and a race with however long the
/// event it stands for takes on a loaded machine.
pub(crate) async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..300 {
        if cond() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("condition never became true");
}

/// What a SOCKS5 client asked the proxy to CONNECT to.
pub(crate) struct Socks5Request {
    /// The SOCKS5 address type: 1 IPv4, 3 domain name, 4 IPv6.
    pub atyp: u8,
    pub host: String,
    pub port: u16,
}

/// Bind a minimal SOCKS5 proxy (no authentication, CONNECT only) on
/// loopback. It accepts one client, reports the CONNECT it was asked for over
/// the returned channel, then answers success and closes. Not relaying is
/// deliberate: the test only needs to observe the target, and a dial that
/// reached the relay bypassing the proxy is then visible on the relay's own
/// listener instead.
pub(crate) async fn socks5_proxy() -> (SocketAddr, oneshot::Receiver<Socks5Request>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the SOCKS5 proxy");
    let addr = listener.local_addr().expect("the SOCKS5 proxy's address");
    let (report, request) = oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut conn, _)) = listener.accept().await else { return };
        let Some(asked) = read_connect(&mut conn).await else { return };
        // Report before answering: a dial that gets a reply and then fails at
        // the WebSocket handshake (the socket closes here) is still observed.
        let _ = report.send(asked);
        // Success, with an all-zero IPv4 bound address.
        let _ = conn.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        let _ = conn.flush().await;
    });
    (addr, request)
}

/// Read a SOCKS5 greeting and one CONNECT request, answering the greeting
/// with "no authentication". `None` if the peer does not speak SOCKS5.
async fn read_connect(conn: &mut TcpStream) -> Option<Socks5Request> {
    let mut greeting = [0u8; 2];
    conn.read_exact(&mut greeting).await.ok()?;
    if greeting[0] != 5 {
        return None;
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    conn.read_exact(&mut methods).await.ok()?;
    conn.write_all(&[0x05, 0x00]).await.ok()?;

    let mut head = [0u8; 4];
    conn.read_exact(&mut head).await.ok()?;
    if head[0] != 5 || head[1] != 1 {
        return None; // only CONNECT is implemented
    }
    let host = match head[3] {
        1 => {
            let mut raw = [0u8; 4];
            conn.read_exact(&mut raw).await.ok()?;
            Ipv4Addr::from(raw).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            conn.read_exact(&mut len).await.ok()?;
            let mut raw = vec![0u8; len[0] as usize];
            conn.read_exact(&mut raw).await.ok()?;
            String::from_utf8(raw).ok()?
        }
        4 => {
            let mut raw = [0u8; 16];
            conn.read_exact(&mut raw).await.ok()?;
            Ipv6Addr::from(raw).to_string()
        }
        _ => return None,
    };
    let mut port = [0u8; 2];
    conn.read_exact(&mut port).await.ok()?;
    Some(Socks5Request { atyp: head[3], host, port: u16::from_be_bytes(port) })
}

/// Bind a loopback listener that counts every connection it accepts and then
/// drops it at once. A dial that ignores the proxy and connects directly
/// shows up in the count; a dial routed through the proxy does not.
pub(crate) async fn counting_listener() -> (SocketAddr, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the counting listener");
    let addr = listener.local_addr().expect("the counting listener's address");
    let seen = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&seen);
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else { return };
            counted.fetch_add(1, Ordering::SeqCst);
            drop(socket);
        }
    });
    (addr, seen)
}
