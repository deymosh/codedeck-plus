//! THROWAWAY F0 probe-3 — NOT production code.
//!
//! The networking half of the plan's central thesis: a Nostr relay client that
//! lives in a Rust core (here consumed by a foreground Service via UniFFI, the
//! pattern probe-1 validated), subscribes to kind-30515 heartbeats, counts
//! deliveries, and reconnects with backoff. The Android app around it measures
//! whether those deliveries keep arriving while the app is backgrounded / Dozed.

uniffi::setup_scaffolding!();

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum ProbeEvent {
    Connected,
    Disconnected { reason: String },
    Heartbeat { received: u64, at_ms: i64 },
    Reconnecting { attempt: u32, delay_ms: u64 },
}

#[uniffi::export(with_foreign)]
pub trait ProbeListener: Send + Sync {
    fn on_event(&self, event: ProbeEvent);
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ProbeStats {
    pub connected: bool,
    pub received: u64,
    /// UNIX ms of the last heartbeat; 0 = never.
    pub last_heartbeat_ms: i64,
    pub reconnects: u64,
    pub started_ms: i64,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ProbeError {
    #[error("{detail}")]
    Bad { detail: String },
}

struct Cfg {
    relay: String,
    author: String,
    phone_p: String,
}

#[derive(uniffi::Object)]
pub struct HeartbeatProbe {
    running: AtomicBool,
    connected: AtomicBool,
    received: AtomicU64,
    reconnects: AtomicU64,
    last_hb_ms: AtomicI64,
    started_ms: AtomicI64,
    listeners: Mutex<Vec<Arc<dyn ProbeListener>>>,
    rt: Mutex<Option<Runtime>>,
    task: Mutex<Option<JoinHandle<()>>>,
    cfg: Mutex<Option<Cfg>>,
}

// All public methods are sync; the probe owns its own tokio runtime internally
// (created in `start`). No `async_runtime` attr needed here — unlike probe-1,
// which exercised the async-command path deliberately.
#[uniffi::export]
impl HeartbeatProbe {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            received: AtomicU64::new(0),
            reconnects: AtomicU64::new(0),
            last_hb_ms: AtomicI64::new(0),
            started_ms: AtomicI64::new(0),
            listeners: Mutex::new(Vec::new()),
            rt: Mutex::new(None),
            task: Mutex::new(None),
            cfg: Mutex::new(None),
        })
    }

    pub fn subscribe(&self, listener: Arc<dyn ProbeListener>) {
        self.listeners.lock().unwrap().push(listener);
    }

    /// Filter is `{kinds:[30515], authors:[author_hex], #p:[phone_pubkey_hex]}`.
    pub fn start(
        self: Arc<Self>,
        relay_url: String,
        author_hex: String,
        phone_pubkey_hex: String,
    ) -> Result<(), ProbeError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.started_ms.store(now_ms(), Ordering::SeqCst);
        *self.cfg.lock().unwrap() = Some(Cfg {
            relay: relay_url,
            author: author_hex,
            phone_p: phone_pubkey_hex,
        });
        let rt = Runtime::new().map_err(|e| ProbeError::Bad { detail: e.to_string() })?;
        let me = Arc::clone(&self);
        let handle = rt.spawn(async move { me.run_loop().await });
        *self.rt.lock().unwrap() = Some(rt);
        *self.task.lock().unwrap() = Some(handle);
        Ok(())
    }

    pub fn stop(self: Arc<Self>) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(h) = self.task.lock().unwrap().take() {
            h.abort();
        }
        if let Some(rt) = self.rt.lock().unwrap().take() {
            rt.shutdown_background();
        }
        self.connected.store(false, Ordering::SeqCst);
    }

    pub fn stats(&self) -> ProbeStats {
        ProbeStats {
            connected: self.connected.load(Ordering::SeqCst),
            received: self.received.load(Ordering::SeqCst),
            last_heartbeat_ms: self.last_hb_ms.load(Ordering::SeqCst),
            reconnects: self.reconnects.load(Ordering::SeqCst),
            started_ms: self.started_ms.load(Ordering::SeqCst),
        }
    }
}

impl HeartbeatProbe {
    fn emit(&self, event: ProbeEvent) {
        let listeners = self.listeners.lock().unwrap().clone();
        for l in listeners {
            l.on_event(event.clone());
        }
    }

    async fn run_loop(self: Arc<Self>) {
        let (relay, author, phone_p) = {
            let g = self.cfg.lock().unwrap();
            let c = g.as_ref().unwrap();
            (c.relay.clone(), c.author.clone(), c.phone_p.clone())
        };
        let mut attempt: u32 = 0;
        while self.running.load(Ordering::SeqCst) {
            match self.session(&relay, &author, &phone_p).await {
                Ok(()) => attempt = 0, // clean exit only happens on stop()
                Err(reason) => {
                    self.connected.store(false, Ordering::SeqCst);
                    if !self.running.load(Ordering::SeqCst) {
                        break;
                    }
                    self.emit(ProbeEvent::Disconnected { reason });
                    let delay = (2u64.saturating_pow(attempt.min(5))).saturating_mul(1000).min(30_000);
                    attempt = attempt.saturating_add(1);
                    self.reconnects.fetch_add(1, Ordering::SeqCst);
                    self.emit(ProbeEvent::Reconnecting { attempt, delay_ms: delay });
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
    }

    async fn session(&self, relay: &str, author: &str, phone_p: &str) -> Result<(), String> {
        let (ws, _) = tokio_tungstenite::connect_async(relay).await.map_err(|e| e.to_string())?;
        let (mut tx, mut rx) = ws.split();

        let req = serde_json::json!([
            "REQ", "hb",
            { "kinds": [30515], "authors": [author], "#p": [phone_p] }
        ]);
        tx.send(Message::Text(req.to_string())).await.map_err(|e| e.to_string())?;
        self.connected.store(true, Ordering::SeqCst);
        self.emit(ProbeEvent::Connected);

        let mut ping = tokio::time::interval(Duration::from_secs(25));
        ping.tick().await; // consume the immediate first tick

        loop {
            if !self.running.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::select! {
                _ = ping.tick() => {
                    tx.send(Message::Ping(Vec::new())).await.map_err(|e| e.to_string())?;
                }
                msg = rx.next() => match msg {
                    None => return Err("socket closed".into()),
                    Some(Err(e)) => return Err(e.to_string()),
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                            if v.get(0).and_then(|x| x.as_str()) == Some("EVENT") {
                                let n = self.received.fetch_add(1, Ordering::SeqCst) + 1;
                                let ts = now_ms();
                                self.last_hb_ms.store(ts, Ordering::SeqCst);
                                self.emit(ProbeEvent::Heartbeat { received: n, at_ms: ts });
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = tx.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) => return Err("relay closed".into()),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}
