//! Native (`cargo test`, host target) checks of the toy Core's semantics — the
//! same behaviour the Kotlin/JVM harness then verifies *through the FFI*.

use std::sync::{Arc, Mutex};

use client_core_probe::*;

struct Collector(Mutex<Vec<CoreEvent>>);
impl CoreListener for Collector {
    fn on_event(&self, event: CoreEvent) {
        self.0.lock().unwrap().push(event);
    }
}
impl Collector {
    fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(Vec::new())))
    }
    fn events(&self) -> Vec<CoreEvent> {
        self.0.lock().unwrap().clone()
    }
}

#[test]
fn nip44_roundtrip_and_typed_error() {
    let a = generate_keypair();
    let b = generate_keypair();

    let ct = encrypt_to(a.secret_hex.clone(), b.public_hex.clone(), "hola mundo".into()).unwrap();
    let pt = decrypt_from(b.secret_hex.clone(), a.public_hex.clone(), ct).unwrap();
    assert_eq!(pt, "hola mundo");

    match keypair_from_secret("not-hex".into()) {
        Err(CryptoError::BadKey { .. }) => {}
        other => panic!("expected BadKey, got {other:?}"),
    }
}

#[test]
fn lifecycle_starts_and_stops_with_no_leak() {
    let core = Core::new();
    let col = Collector::new();
    core.subscribe(col.clone());

    core.clone().start();
    std::thread::sleep(std::time::Duration::from_millis(700));
    core.clone().stop();

    let after_stop = col.events().len();
    assert!(after_stop >= 2, "bg task should have emitted a few, got {after_stop}");

    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(col.events().len(), after_stop, "no events must arrive after stop()");

    assert!(!core.snapshot().running);
}

#[test]
fn async_dispatch_typed_error_and_concurrency() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let core = Core::new();
    let col = Collector::new();
    core.subscribe(col.clone());

    // dispatch before start -> typed NotStarted
    assert!(matches!(
        rt.block_on(core.clone().dispatch(Intent::Interrupt { session: "s".into() })),
        Err(CoreError::NotStarted)
    ));

    core.clone().start();

    // typed Rejected via the async path
    assert!(matches!(
        rt.block_on(core.clone().dispatch(Intent::ForceReject { reason: "busy".into() })),
        Err(CoreError::Rejected { .. })
    ));

    // 50 concurrent dispatches while the bg "socket" task emits in parallel
    rt.block_on(async {
        let mut set = tokio::task::JoinSet::new();
        for i in 0..50 {
            let c = core.clone();
            set.spawn(async move {
                c.dispatch(Intent::SendInput { session: "s".into(), text: format!("m{i}") })
                    .await
            });
        }
        while let Some(r) = set.join_next().await {
            r.unwrap().unwrap();
        }
    });

    core.clone().stop();

    let events = col.events();
    let state_changes = events.iter().filter(|e| matches!(e, CoreEvent::StateChanged { .. })).count();
    let appended = events.iter().filter(|e| matches!(e, CoreEvent::TranscriptAppended { .. })).count();
    assert_eq!(state_changes, 50, "one StateChanged per SendInput, no lost/dup under contention");
    assert!(appended >= 1, "bg task emitted during the dispatch storm");
}
