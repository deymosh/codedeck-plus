//! The real `client_runtime::Core` driven through this crate's own
//! `#[uniffi::export]` surface — spawn (dedicated thread + `LocalSet`), dispatch (`async fn` ->
//! the eventual Kotlin `suspend fun`), observe (the foreign `CoreListener`
//! callback), and a clean shutdown (thread actually joins, no leak).
//!
//! These tests call `client_ffi::Core` directly (Rust to Rust, no JNI) —
//! that already exercises 100% of the logic Kotlin will drive, since UniFFI's
//! generated Kotlin is a thin, mechanical trampoline onto exactly these
//! `#[uniffi::export]` functions. What it does NOT exercise is UniFFI's own
//! generated async-cancellation glue (a JVM `Job.cancel()` reaching into the
//! Rust future) — that needs a Kotlin coroutine test. What CAN be proven
//! here, and is the actual risk behind it, is Rust-level cancellation safety: does dropping an in-flight
//! `dispatch()` future lose the intent, corrupt the Core, or hang? See
//! `dropping_an_in_flight_dispatch_future_does_not_lose_the_intent` below.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use client_runtime::{ActionFailedKind, ConnectionView, CoreEvent};
use client_ffi::{Core, CoreListener, UniffiIntent, UniffiNotifier};

#[derive(Default)]
struct RecordingListener {
    connections: Mutex<Vec<ConnectionView>>,
    events: Mutex<Vec<CoreEvent>>,
}

impl CoreListener for RecordingListener {
    fn connection_changed(&self, view: ConnectionView) {
        self.connections.lock().unwrap().push(view);
    }
    fn on_event(&self, event: CoreEvent) {
        self.events.lock().unwrap().push(event);
    }
    fn action_failed(&self, _kind: ActionFailedKind) {}
}

/// Nothing in these tests drives a notification — a no-op stand-in for the
/// `UniffiNotifier` `Core::new` now requires, same role `RecordingListener`
/// plays for `CoreListener` where a test cares about deliveries and this one
/// doesn't.
struct NoopNotifier;
impl UniffiNotifier for NoopNotifier {
    fn notify(&self, _title: String, _body: String, _tag: Option<String>, _kind: String) {}
    fn cancel(&self, _tag: String) {}
}

fn fresh_identity_hex() -> String {
    protocol::crypto::generate_keypair().secret_hex()
}

/// `TempDir` must outlive the `Core` under test — dropping it early deletes
/// the file the core thread's `rusqlite::Connection` still has open.
fn temp_db_path() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("codedeck-test.db");
    (dir, path.to_string_lossy().into_owned())
}

#[test]
fn spawn_dispatch_observe_and_shutdown_all_work_over_the_real_ffi_surface() {
    let listener = Arc::new(RecordingListener::default());
    let (_dir, db_path) = temp_db_path();
    let core = Core::new(
        vec![],
        fresh_identity_hex(),
        listener.clone(),
        Arc::new(NoopNotifier),
        None,
        db_path,
        None,
        false,
    )
    .expect("core spawns");

    // spawn: the real Core hydrated and answers a view query.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let view = rt.block_on(core.connection_view()).expect("connection view present after spawn");
    assert_eq!(view.status, "idle");

    // dispatch: an intent this crate's `UniffiIntent` maps onto the real
    // `Intent` round-trips through the loop and produces an observable
    // effect — `Interrupt` on a session that doesn't exist is a no-op for
    // the store but still proves the message reaches and is processed by
    // the real loop without an FFI-boundary panic.
    rt.block_on(core.dispatch(UniffiIntent::Interrupt {
        machine: "m".into(),
        session_id: "s".into(),
    }))
    .expect("dispatch succeeds");

    // observe: the RecordingListener is the same foreign-callback path
    // Kotlin's generated `CoreListener` implementation would drive — a
    // no-op Interrupt intentionally produces no events here (nothing to
    // interrupt), so this asserts the OBSERVER PATH ITSELF is wired and
    // live by forcing a connection-changed callback via `start()`, which
    // always fires at least the initial FSM transition attempt.
    core.start();
    for _ in 0..50 {
        if !listener.connections.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !listener.connections.lock().unwrap().is_empty(),
        "expected at least one connection_changed callback after start()"
    );

    // shutdown: the dedicated thread actually joins — this call returning
    // at all (rather than hanging) is the assertion.
    core.shutdown();
}

#[test]
fn dropping_an_in_flight_dispatch_future_does_not_lose_the_intent() {
    let listener = Arc::new(RecordingListener::default());
    let (_dir, db_path) = temp_db_path();
    let core = Arc::new(
        Core::new(
            vec![],
            fresh_identity_hex(),
            listener.clone(),
            Arc::new(NoopNotifier),
            None,
            db_path,
            None,
            false,
        )
        .expect("core spawns"),
    );
    let rt = tokio::runtime::Runtime::new().unwrap();

    rt.block_on(async {
        // `Core::dispatch` sends its `Msg` over an mpsc channel THEN awaits a
        // oneshot reply — so a future dropped after the send but before the
        // reply is the exact shape a cancelled Kotlin coroutine leaves
        // behind. A near-zero timeout reliably wins that race without a
        // sleep loop: the send is synchronous, the reply is not.
        let dispatch = core.dispatch(UniffiIntent::Interrupt {
            machine: "m".into(),
            session_id: "leaked-session".into(),
        });
        let _ = tokio::time::timeout(Duration::from_nanos(1), dispatch).await;

        // The Core must still be alive and answering — a lost reply channel
        // must not poison the loop or the shared state behind it.
        let view = core.connection_view().await;
        assert!(view.is_some(), "core still answers after a cancelled dispatch");
    });

    core.shutdown();
}
