//! Host checks: the probe counts kind-30515 deliveries and reconnects when the
//! relay drops the socket — against a throwaway in-process WS "relay".

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use heartbeat_core::*;
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

const EV: &str = r#"["EVENT","hb",{"kind":30515,"id":"x","pubkey":"aa","created_at":0,"tags":[],"content":"","sig":""}]"#;

/// A fake relay. Each accepted connection: read one REQ, then push a 30515 every
/// 40ms; if `drop_after` is set, close the socket after that many pushes.
async fn fake_relay(drop_after: Option<usize>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            tokio::spawn(async move {
                let ws = accept_async(stream).await.unwrap();
                let (mut tx, mut rx) = ws.split();
                let _req = rx.next().await; // consume REQ
                let mut sent = 0usize;
                let mut ticker = tokio::time::interval(Duration::from_millis(40));
                loop {
                    ticker.tick().await;
                    if let Some(d) = drop_after {
                        if sent >= d {
                            let _ = tx.close().await;
                            return;
                        }
                    }
                    if tx.send(Message::Text(EV.into())).await.is_err() {
                        return;
                    }
                    sent += 1;
                }
            });
        }
    });
    addr
}

struct Sink(Mutex<Vec<ProbeEvent>>);
impl ProbeListener for Sink {
    fn on_event(&self, event: ProbeEvent) {
        self.0.lock().unwrap().push(event);
    }
}

async fn until<F: Fn() -> bool>(f: F, ms: u64, label: &str) {
    let start = std::time::Instant::now();
    while !f() {
        if start.elapsed() > Duration::from_millis(ms) {
            panic!("timed out: {label}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn counts_heartbeat_deliveries() {
    let addr = fake_relay(None).await;
    let probe = HeartbeatProbe::new();
    let sink = Arc::new(Sink(Mutex::new(Vec::new())));
    probe.subscribe(sink.clone());
    probe
        .clone()
        .start(format!("ws://{addr}"), "aa".into(), "bb".into())
        .unwrap();

    until(|| probe.stats().received >= 5, 4000, "5 heartbeats").await;
    probe.clone().stop();

    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|e| *e == ProbeEvent::Connected));
    assert!(events.iter().filter(|e| matches!(e, ProbeEvent::Heartbeat { .. })).count() >= 5);
    assert!(probe.stats().last_heartbeat_ms > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnects_after_socket_drop_and_resumes() {
    let addr = fake_relay(Some(3)).await;
    let probe = HeartbeatProbe::new();
    let sink = Arc::new(Sink(Mutex::new(Vec::new())));
    probe.subscribe(sink.clone());
    probe
        .clone()
        .start(format!("ws://{addr}"), "aa".into(), "bb".into())
        .unwrap();

    // first session gives 3, drops; backoff reconnects; next session gives more
    until(|| probe.stats().reconnects >= 1, 5000, "a reconnect").await;
    until(|| probe.stats().received >= 6, 8000, "resumed deliveries").await;
    probe.clone().stop();

    let events = sink.0.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, ProbeEvent::Disconnected { .. })));
    assert!(events.iter().any(|e| matches!(e, ProbeEvent::Reconnecting { .. })));
    assert!(events.iter().filter(|e| **e == ProbeEvent::Connected).count() >= 2, "reconnected");
}
