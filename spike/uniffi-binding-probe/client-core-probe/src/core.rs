//! A toy `Core` with the exact *shape* the real client-runtime will expose:
//! `subscribe` (foreign callback), `dispatch` (async command, typed error),
//! `snapshot` (plain-data view), `start`/`stop` (lifecycle + bg task).
//! Behaviour is fake; the FFI ergonomics are real.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;

// Spike finding: `uniffi` and `serde` derives compose on the same type, so ONE
// definition of a boundary type serves both the Kotlin (UniFFI) and the Tauri
// (serde/JSON) binding. The real client-core relies on this.
#[derive(Debug, thiserror::Error, uniffi::Error, Serialize)]
pub enum CoreError {
    #[error("core not started")]
    NotStarted,
    #[error("bridge rejected the intent: {reason}")]
    Rejected { reason: String },
    // field is `detail`, not `message` — see the note in crypto.rs
    #[error("internal error: {detail}")]
    Internal { detail: String },
}

/// Semantic events only — no UI strings. The UI decides how to surface them.
#[derive(Debug, Clone, PartialEq, uniffi::Enum, Serialize, Deserialize)]
pub enum CoreEvent {
    /// a view slice changed; the UI re-reads that slice
    StateChanged { slice: String },
    /// transcript rows appended (a delta, never a full snapshot)
    TranscriptAppended { session: String, from_seq: u64 },
    /// a semantic failure the UI turns into a toast/banner/inline message
    ActionFailed { kind: String },
}

#[derive(Debug, Clone, uniffi::Enum, Serialize, Deserialize)]
pub enum Intent {
    SendInput { session: String, text: String },
    Interrupt { session: String },
    /// forces a typed `Err(CoreError::Rejected)` — exercises `Result` over FFI
    ForceReject { reason: String },
}

/// Foreign types (Kotlin/Swift/JS) implement this; Rust calls back into them.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    fn on_event(&self, event: CoreEvent);
}

/// Read-only projection handed to the UI as plain data (the `*_view` pattern).
#[derive(Debug, Clone, uniffi::Record, Serialize, Deserialize)]
pub struct ProbeView {
    pub running: bool,
    pub seq: u64,
    pub listener_count: u32,
}

#[derive(uniffi::Object)]
pub struct Core {
    seq: AtomicU64,
    running: AtomicBool,
    listeners: Mutex<Vec<Arc<dyn CoreListener>>>,
    rt: Mutex<Option<Runtime>>,
    socket_task: Mutex<Option<JoinHandle<()>>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl Core {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            seq: AtomicU64::new(0),
            running: AtomicBool::new(false),
            listeners: Mutex::new(Vec::new()),
            rt: Mutex::new(None),
            socket_task: Mutex::new(None),
        })
    }

    /// Register a foreign listener. Sync — the UI never awaits this.
    pub fn subscribe(&self, listener: Arc<dyn CoreListener>) {
        self.listeners.lock().unwrap().push(listener);
    }

    /// Lifecycle: spin up the reactor + a dummy "socket" task that emits every 200ms.
    pub fn start(self: Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let rt = Runtime::new().expect("tokio runtime");
        let me = Arc::clone(&self);
        let handle = rt.spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(200));
            loop {
                ticker.tick().await;
                if !me.running.load(Ordering::SeqCst) {
                    break;
                }
                let from = me.seq.fetch_add(1, Ordering::SeqCst) + 1;
                me.emit(CoreEvent::TranscriptAppended {
                    session: "probe".into(),
                    from_seq: from,
                });
            }
        });
        *self.rt.lock().unwrap() = Some(rt);
        *self.socket_task.lock().unwrap() = Some(handle);
    }

    /// Lifecycle: stop cleanly. After this, no further events reach listeners
    /// and the worker threads are released.
    pub fn stop(self: Arc<Self>) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(h) = self.socket_task.lock().unwrap().take() {
            h.abort();
        }
        // shutdown_background: returns immediately, never panics even if called
        // from inside an async context (unlike `drop(Runtime)`).
        if let Some(rt) = self.rt.lock().unwrap().take() {
            rt.shutdown_background();
        }
    }

    pub fn snapshot(&self) -> ProbeView {
        ProbeView {
            running: self.running.load(Ordering::SeqCst),
            seq: self.seq.load(Ordering::SeqCst),
            listener_count: self.listeners.lock().unwrap().len() as u32,
        }
    }

    /// The async command path — becomes `suspend fun dispatch(...)` in Kotlin.
    pub async fn dispatch(self: Arc<Self>, intent: Intent) -> Result<(), CoreError> {
        if !self.running.load(Ordering::SeqCst) {
            return Err(CoreError::NotStarted);
        }
        // genuinely yield so we exercise the real async bridge, not a sync fast path
        tokio::time::sleep(Duration::from_millis(1)).await;
        match intent {
            Intent::ForceReject { reason } => Err(CoreError::Rejected { reason }),
            Intent::Interrupt { session } => {
                self.emit(CoreEvent::StateChanged { slice: format!("session:{session}") });
                Ok(())
            }
            Intent::SendInput { session, .. } => {
                self.seq.fetch_add(1, Ordering::SeqCst);
                self.emit(CoreEvent::StateChanged { slice: format!("session:{session}") });
                Ok(())
            }
        }
    }
}

impl Core {
    fn emit(&self, event: CoreEvent) {
        let listeners = self.listeners.lock().unwrap().clone();
        for l in listeners {
            l.on_event(event.clone());
        }
    }
}
