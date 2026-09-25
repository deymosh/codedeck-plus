//! A scriptable one-connection mock relay on loopback TCP, shared by the
//! `ws` and `core` integration tests. Speaks enough of the Nostr relay wire to
//! drive the real [`super::ws::WsTransport`] over a genuine socket.

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use std::time::Duration;

pub struct MockRelay {
    /// `ws://127.0.0.1:<port>` — feed to `WsConfig::relays`.
    pub url: String,
    inbound: mpsc::UnboundedReceiver<String>,
    outbound: mpsc::UnboundedSender<String>,
}

impl MockRelay {
    /// The next text frame the client sent us (panics after 2s).
    pub async fn next_frame(&mut self) -> String {
        tokio::time::timeout(Duration::from_secs(2), self.inbound.recv())
            .await
            .expect("client sent a frame within 2s")
            .expect("mock channel open")
    }

    /// Push a text frame to the client.
    pub fn push(&self, frame: impl Into<String>) {
        let _ = self.outbound.send(frame.into());
    }

    /// Drop the socket (surfaces to the client as a non-deliberate close).
    pub fn close(&self) {
        let _ = self.outbound.send("__CLOSE__".to_string());
    }
}

/// Bind a loopback listener and spawn the accept + echo task.
pub async fn mock_relay() -> MockRelay {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (in_tx, inbound) = mpsc::unbounded_channel::<String>();
    let (outbound, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        loop {
            tokio::select! {
                msg = ws.next() => match msg {
                    Some(Ok(Message::Text(t))) => { let _ = in_tx.send(t); }
                    Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                    Some(Ok(_)) => {}
                    _ => break,
                },
                cmd = out_rx.recv() => match cmd {
                    Some(c) if c == "__CLOSE__" => { let _ = ws.close(None).await; break; }
                    Some(c) => { let _ = ws.send(Message::Text(c)).await; }
                    None => break,
                }
            }
        }
    });
    MockRelay {
        url: format!("ws://127.0.0.1:{port}"),
        inbound,
        outbound,
    }
}
