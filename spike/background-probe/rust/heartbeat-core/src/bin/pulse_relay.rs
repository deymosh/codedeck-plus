//! Throwaway stand-in for "a bridge publishing kind-30515 heartbeats": a WS
//! server that, per connected client, reads one REQ then emits a minimal 30515
//! EVENT every PULSE_SECS. The emulator app connects to ws://10.0.2.2:7447.
//!
//!   PULSE_SECS=15 cargo run --bin pulse-relay

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let addr = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:7447".into());
    let secs: u64 = std::env::var("PULSE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(15);
    let listener = TcpListener::bind(&addr).await.expect("bind");
    eprintln!("pulse-relay on ws://{addr}  every {secs}s");

    loop {
        let (stream, peer) = listener.accept().await.expect("accept");
        tokio::spawn(async move {
            let Ok(ws) = accept_async(stream).await else { return };
            let (mut tx, mut rx) = ws.split();
            let _req = rx.next().await; // consume REQ
            eprintln!("client {peer} subscribed");
            let mut n: u64 = 0;
            let mut ticker = tokio::time::interval(Duration::from_secs(secs));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        n += 1;
                        let ev = format!(
                            r#"["EVENT","hb",{{"kind":30515,"id":"{n:064x}","pubkey":"aa","created_at":{},"tags":[["d","m"],["p","bb"]],"content":"","sig":""}}]"#,
                            n
                        );
                        if tx.send(Message::Text(ev)).await.is_err() { break; }
                        eprintln!("client {peer} <- heartbeat {n}");
                    }
                    msg = rx.next() => match msg {
                        None | Some(Err(_)) => break,
                        Some(Ok(Message::Close(_))) => break,
                        Some(Ok(Message::Ping(p))) => { let _ = tx.send(Message::Pong(p)).await; }
                        _ => {}
                    }
                }
            }
            eprintln!("client {peer} gone");
        });
    }
}
