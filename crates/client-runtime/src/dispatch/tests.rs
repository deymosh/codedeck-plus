use super::*;
use crate::ports::MemoryTranscriptStore;
use crate::stores::{hydrate, StoresConfig};
use crate::ports::MemoryKv;
use client_core::stores::outbox::{OutboxItemState, OutboxState};
use client_core::stores::machines::CLOSE_RETRY_MS;
use protocol::events::{
    CloseSessionAckMsg, InputAckMsg, InputFailedMsg, OutputMsg, SessionListMsg, SessionReadyMsg, SyncChunkMsg,
    SyncEndMsg,
};
use protocol::common::{EntryBody, OutputEntry, RemoteSessionInfo, SessionState};
use serde_json::json;

const MACHINE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn info(id: &str, state: Option<SessionState>, seq_high: Option<u64>) -> RemoteSessionInfo {
    RemoteSessionInfo {
        id: id.into(),
        agent: "claude-code".into(),
        slug: format!("slug-{id}"),
        cwd: "/w".into(),
        last_activity: "t".into(),
        line_count: 0,
        title: None,
        project: "p".into(),
        mode: None,
        effort: None,
        model: None,
        persona: None,
        context_window: None,
        context_percentage: None,
        committed: None,
        state,
        seq_high,
        provider_id: None,
        provider_label: None,
        turn_started_at: None,
    }
}

fn sessions_msg(sessions: Vec<RemoteSessionInfo>) -> SessionListMsg {
    SessionListMsg {
        machine: "laptop".into(),
        host: None,
        sessions,
        agents: Vec::new(),
        credentials: Vec::new(),
        capabilities: None,
        folders: None,
        roots: None,
        removed_sessions: None,
        machine_offline: None,
        direct: None,
        terminals: None,
        rev: None,
    }
}

async fn stores() -> (CoreStores, MemoryTranscriptStore, PhoneKeys) {
    let (stores, ts) = crate::test_support::stores_with_transcript().await;
    (stores, ts, crate::test_support::phone_keys())
}

fn text_entry(content: &str) -> OutputEntry {
    OutputEntry::new(
        "t",
        EntryBody::Text {
            role: protocol::common::Role::Agent,
            text: content.to_string(),
        },
    )
}

#[tokio::test]
async fn live_text_shows_in_the_session_on_screen_until_its_entry_lands() {
    let (mut s, ts, kp) = stores().await;
    s.ui.selected_machine = Some(MACHINE.into());
    s.ui.selected_session = Some("s1".into());
    let piece = |session: &str, offset: u64, text: &str| {
        BridgeToPhone::Partial(protocol::events::PartialMsg {
            session_id: session.into(),
            key: "k".into(),
            entry_type: protocol::common::PartialKind::Text,
            subagent: None,
            offset,
            text: text.into(),
        })
    };
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let shown = r.route(MACHINE, &piece("s1", 0, "All tests")).await.live_text;
    assert_eq!(shown, vec![(MACHINE.into(), "s1".into(), LiveChange { key: "k".into(), text: Some("All tests".into()) })]);
    // Another session's reply is not kept live.
    assert!(r.route(MACHINE, &piece("s2", 0, "x")).await.live_text.is_empty());

    let mut done = text_entry("All tests pass.");
    done.part = Some("k".into());
    let out = r
        .route(MACHINE, &BridgeToPhone::Output(OutputMsg { session_id: "s1".into(), seq: 1, entries: vec![done] }))
        .await;
    assert_eq!(out.live_text, vec![(MACHINE.into(), "s1".into(), LiveChange { key: "k".into(), text: None })]);
    assert!(r.route(MACHINE, &piece("s1", 9, " pass")).await.live_text.is_empty(), "a late piece is dropped");
}

#[tokio::test]
async fn output_stores_the_row_and_advances_coverage() {
    let (mut s, ts, kp) = stores().await;
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 1,
                entries: vec![text_entry("hello")],
            }),
        )
        .await;
    assert_eq!(
        out,
        RouteResult {
            transcript_appended: Some((MACHINE.to_string(), "s1".to_string())),
            ..RouteResult::default()
        }
    );
    assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1]);
    assert!(s.transcript.has_contiguous(MACHINE, "s1", Some(1)));
}

#[tokio::test]
async fn a_live_permission_card_marks_unread_and_notifies_then_agent_activity_clears_it() {
    let (mut s, ts, kp) = stores().await;
    let card: OutputEntry = serde_json::from_value(json!({
        "timestamp": "t", "entryType": "permission_request", "requestId": "r1",
        "toolName": "Bash", "kind": "execute", "title": "ls", "options": []
    }))
    .unwrap();
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.visible = false; // backgrounded → OS notify
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Output(OutputMsg {
                    session_id: "s1".into(),
                    seq: 1,
                    entries: vec![card],
                }),
            )
            .await;
        assert!(matches!(out.notifies.as_slice(), [NotifyEffect::Notify { .. }]));
    }
    assert!(s.ui.is_session_unread(MACHINE, "s1"));

    // a plain assistant text entry = the agent working → clears the dot
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    r.route(
        MACHINE,
        &BridgeToPhone::Output(OutputMsg {
            session_id: "s1".into(),
            seq: 2,
            entries: vec![text_entry("working on it")],
        }),
    )
    .await;
    assert!(!s.ui.is_session_unread(MACHINE, "s1"));
}

#[tokio::test]
async fn a_replayed_turn_end_the_transcript_already_holds_does_not_notify_again() {
    let (mut s, ts, kp) = stores().await;
    let turn_end = || BridgeToPhone::Output(OutputMsg {
        session_id: "s1".into(),
        seq: 7,
        entries: vec![serde_json::from_value(json!({ "timestamp": "t", "entryType": "turn_complete" })).unwrap()],
    });
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.visible = false;
        let out = r.route(MACHINE, &turn_end()).await;
        assert!(matches!(out.notifies.as_slice(), [NotifyEffect::Notify { .. }]));
    }
    s.ui.clear_session_unread(MACHINE, "s1");

    // The app was killed and restarted (a fresh notification cooldown), and
    // a direct link resuming from an older cursor sends the same entry.
    s.notifications = Default::default();
    let mut r = Router::new(&mut s, &ts, &kp, 60_000);
    r.visible = false;
    let out = r.route(MACHINE, &turn_end()).await;
    assert!(out.notifies.is_empty());
    assert!(!s.ui.is_session_unread(MACHINE, "s1"));
}

#[tokio::test]
async fn a_deleted_sessions_replayed_output_is_dropped_after_a_restart() {
    let kv = MemoryKv::new();
    let ts = MemoryTranscriptStore::new();
    let identity = protocol::crypto::generate_keypair();
    let (ring, _) = client_core::stores::session_key::SessionKeyRing::load(None, 1_000);
    let kp = PhoneKeys::new(&identity.pubkey_hex, &ring.current, None);

    // Deleted (and acked: no rows left), then the app was killed.
    let mut before = hydrate(&kv, &ts, &StoresConfig::default()).await.stores;
    before.machines.dismiss_session(MACHINE, "s1", 1_000);
    crate::stores::Persister::new(&kv).save_machines(&before.machines).await;

    // A fresh start; the direct link resumes and re-sends the turn end.
    let mut s = hydrate(&kv, &ts, &StoresConfig::default()).await.stores;
    let mut r = Router::new(&mut s, &ts, &kp, 60_000);
    r.visible = false;
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 7,
                entries: vec![serde_json::from_value(json!({ "timestamp": "t", "entryType": "turn_complete" })).unwrap()],
            }),
        )
        .await;
    assert_eq!(out, RouteResult::default());
    assert!(ts.seqs(MACHINE, "s1").await.is_empty());
    assert!(!s.ui.is_session_unread(MACHINE, "s1"));
}

#[tokio::test]
async fn a_re_delivered_seq_with_different_content_is_a_recorded_conflict() {
    let (mut s, ts, kp) = stores().await;
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 1,
                entries: vec![text_entry("first")],
            }),
        )
        .await;
    }
    {
        let mut r = Router::new(&mut s, &ts, &kp, 2_000);
        r.route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 1,
                entries: vec![text_entry("REWRITTEN")],
            }),
        )
        .await;
    }
    assert_eq!(s.transcript.seq_conflicts.len(), 1);
    assert_eq!(s.transcript.seq_conflicts[0].seq, 1);
    // the stored row is untouched — the first content wins
    let rows = ts.read_range(MACHINE, "s1", 1, 1).await;
    assert_eq!(rows[0].entry, json!({ "timestamp": "t", "entryType": "text", "role": "agent", "text": "first" }));
}

#[tokio::test]
async fn sync_chunk_stores_then_acks_after_the_write() {
    let (mut s, ts, kp) = stores().await;
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::SyncChunk(SyncChunkMsg {
                session_id: "s1".into(),
                sync_id: "sy1".into(),
                range: (1, 2),
                entries: vec![
                    protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                    protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
                ],
            }),
        )
        .await;
    assert_eq!(ts.seqs(MACHINE, "s1").await, vec![1, 2]);
    assert_eq!(
        out.sends,
        vec![Send {
            machine: MACHINE.to_string(),
            msg: PhoneToBridge::SyncAck(SyncAckMsg {
                sync_id: "sy1".into(),
                ranges: vec![(1, 2)],
            }),
        }]
    );
}

/// A store whose writes fail, as a full disk or a failed commit would:
/// nothing it is given is stored.
struct FailingStore(MemoryTranscriptStore);

impl TranscriptStore for FailingStore {
    fn insert_ignore(
        &self,
        _machine: &str,
        _session: &str,
        _rows: &[TranscriptRow],
    ) -> crate::ports::LocalBoxFuture<'_, Result<Vec<u64>, StoreError>> {
        Box::pin(async { Err(StoreError::new("disk full")) })
    }
    fn seqs(&self, machine: &str, session: &str) -> crate::ports::LocalBoxFuture<'_, Vec<u64>> {
        self.0.seqs(machine, session)
    }
    fn read_range(
        &self,
        machine: &str,
        session: &str,
        from: u64,
        to: u64,
    ) -> crate::ports::LocalBoxFuture<'_, Vec<TranscriptRow>> {
        self.0.read_range(machine, session, from, to)
    }
    fn remove(&self, machine: &str, session: &str) -> crate::ports::LocalBoxFuture<'_, ()> {
        self.0.remove(machine, session)
    }
}

#[tokio::test]
async fn a_duplicate_chunk_still_counts_as_progress_for_the_stall_deadline() {
    let (mut s, ts, kp) = stores().await;
    s.transcript.apply_sync_begin(MACHINE, "s1", "sy1", 2, 0);
    let chunk = || {
        BridgeToPhone::SyncChunk(SyncChunkMsg {
            session_id: "s1".into(),
            sync_id: "sy1".into(),
            range: (1, 2),
            entries: vec![
                protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
            ],
        })
    };
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.route(MACHINE, &chunk()).await;
    }
    // Every row is already present; the bridge is still serving the
    // cycle, so a stall sweep must not restart it.
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    r.route(MACHINE, &chunk()).await;
    assert_eq!(s.transcript.session(MACHINE, "s1").unwrap().sync.in_flight_since, Some(2_000));
}

#[tokio::test]
async fn a_failed_output_write_still_delivers_the_live_attention_signal() {
    let (mut s, ts, kp) = stores().await;
    let failing = FailingStore(ts.clone());
    let card: OutputEntry = serde_json::from_value(json!({
        "timestamp": "t", "entryType": "permission_request", "requestId": "r1",
        "toolName": "Bash", "kind": "execute", "title": "ls", "options": []
    }))
    .unwrap();
    let mut r = Router::new(&mut s, &failing, &kp, 1_000);
    r.visible = false;
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Output(OutputMsg {
                session_id: "s1".into(),
                seq: 1,
                entries: vec![card],
            }),
        )
        .await;

    // The entries are not stored and stay uncovered for sync...
    assert!(ts.seqs(MACHINE, "s1").await.is_empty());
    assert!(!s.transcript.has_contiguous(MACHINE, "s1", Some(1)));
    // ...but they arrived: the user still gets the card's signal.
    assert!(matches!(out.notifies.as_slice(), [NotifyEffect::Notify { .. }]));
    assert!(s.ui.is_session_unread(MACHINE, "s1"));
    assert_eq!(out.transcript_appended, Some((MACHINE.to_string(), "s1".to_string())));
}

#[tokio::test]
async fn a_chunk_that_failed_to_store_is_not_acked_and_stays_uncovered() {
    let (mut s, ts, kp) = stores().await;
    let failing = FailingStore(ts.clone());
    let mut r = Router::new(&mut s, &failing, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::SyncChunk(SyncChunkMsg {
                session_id: "s1".into(),
                sync_id: "sy1".into(),
                range: (1, 2),
                entries: vec![
                    protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                    protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
                ],
            }),
        )
        .await;
    // An ack is a claim of durable storage: with the write rolled back,
    // the bridge must keep the chunk unacked and resend it.
    assert!(out.sends.is_empty(), "no ack for rows that were not stored");
    assert!(out.transcript_appended.is_none());
    assert!(ts.seqs(MACHINE, "s1").await.is_empty());
    assert!(!s.transcript.has_contiguous(MACHINE, "s1", Some(2)));
}

#[tokio::test]
async fn sync_end_with_a_gap_re_requests() {
    let (mut s, ts, kp) = stores().await;
    // seq 5 is advertised but only 1..=2 are covered
    s.transcript.apply_sync_begin(MACHINE, "s1", "sy1", 5, 0);
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.route(
            MACHINE,
            &BridgeToPhone::SyncChunk(SyncChunkMsg {
                session_id: "s1".into(),
                sync_id: "sy1".into(),
                range: (1, 2),
                entries: vec![
                    protocol::events::SyncEntry { seq: 1, entry: text_entry("a") },
                    protocol::events::SyncEntry { seq: 2, entry: text_entry("b") },
                ],
            }),
        )
        .await;
    }
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::SyncEnd(SyncEndMsg {
                session_id: "s1".into(),
                sync_id: "sy1".into(),
                delivered_ranges: vec![(1, 2)],
            }),
        )
        .await;
    assert!(matches!(
        out.sends.as_slice(),
        [Send { msg: PhoneToBridge::SyncRequest(m), .. }] if m.session_id == "s1"
    ));
}

#[tokio::test]
async fn input_ack_confirms_the_outbox_item_and_asks_for_a_persist() {
    let (mut s, ts, kp) = stores().await;
    let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
    s.outbox.begin_publish(item);
    s.outbox.settle_publish("in-1", true, None, 600);

    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::InputAck(InputAckMsg {
                session_id: "s1".into(),
                input_id: "in-1".into(),
            }),
        )
        .await;
    assert_eq!(out.persist, vec![StoreId::Outbox]);
    assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Confirmed);
}

fn live_piece(offset: u64, text: &str) -> BridgeToPhone {
    BridgeToPhone::Partial(protocol::events::PartialMsg {
        session_id: "s1".into(),
        key: "k".into(),
        entry_type: protocol::common::PartialKind::Text,
        subagent: None,
        offset,
        text: text.into(),
    })
}

#[tokio::test]
async fn a_session_opened_again_mid_reply_shows_the_reply_whole() {
    let (mut s, ts, kp) = stores().await;
    s.ui.selected_machine = Some(MACHINE.into());
    s.ui.selected_session = Some("other".into());
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        assert!(r.route(MACHINE, &live_piece(0, "All ")).await.live_text.is_empty());
    }
    s.ui.selected_session = Some("s1".into());
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    let shown = r.route(MACHINE, &live_piece(4, "tests")).await.live_text;
    assert_eq!(shown, vec![(MACHINE.into(), "s1".into(), LiveChange { key: "k".into(), text: Some("All tests".into()) })]);
}

#[tokio::test]
async fn a_session_that_stops_running_drops_its_live_rows() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.ui.selected_machine = Some(MACHINE.into());
    s.ui.selected_session = Some("s1".into());
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    r.route(MACHINE, &live_piece(0, "Half a rep")).await;
    // An error or an interrupt ends the turn with no `turn_complete`.
    let out = r
        .route(MACHINE, &BridgeToPhone::Sessions(sessions_msg(vec![info("s1", Some(SessionState::Idle), None)])))
        .await;
    assert_eq!(out.live_text, vec![(MACHINE.into(), "s1".into(), LiveChange { key: "k".into(), text: None })]);
}

/// A style is asked for once, for the session on screen, and kept.
#[tokio::test]
async fn the_style_of_the_agent_on_screen_is_fetched_once() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    let style = protocol::common::AgentStyle { accent: Some("#D77757".into()), ..Default::default() };
    let mut list = sessions_msg(vec![info("s1", None, None)]);
    list.agents = vec![serde_json::from_value(serde_json::json!({
        "id": "claude-code", "displayName": "Claude Code", "styleHash": style.hash()
    }))
    .unwrap()];
    let heartbeat = |rev: u64| {
        let mut l = list.clone();
        l.rev = Some(rev);
        BridgeToPhone::Sessions(l)
    };
    let asks = |out: &RouteResult| out.sends.iter().filter(|c| matches!(c.msg, PhoneToBridge::AgentStyleRequest(_))).count();

    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    assert_eq!(asks(&r.route(MACHINE, &heartbeat(1)).await), 0, "no session on screen");
    r.stores.ui.selected_machine = Some(MACHINE.into());
    r.stores.ui.selected_session = Some("s1".into());
    assert_eq!(asks(&r.route(MACHINE, &heartbeat(2)).await), 1);
    assert_eq!(asks(&r.route(MACHINE, &heartbeat(3)).await), 0, "already asked");

    let answer = BridgeToPhone::AgentStyle(protocol::events::AgentStyleMsg {
        agent: "claude-code".into(),
        style_hash: Some(style.hash()),
        style: Some(style.clone()),
    });
    assert_eq!(r.route(MACHINE, &answer).await.persist, vec![StoreId::AgentStyles]);
    let mut r = Router::new(&mut s, &ts, &kp, 1_000 + client_core::stores::fetches::FETCH_RETRY_AFTER_MS);
    assert_eq!(asks(&r.route(MACHINE, &heartbeat(4)).await), 0, "cached");
    assert_eq!(s.machines.agent_styles.get(&style.hash()), Some(&style));
}

#[tokio::test]
async fn a_session_list_from_an_unpaired_machine_is_dropped() {
    let (mut s, ts, kp) = stores().await;
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Sessions(sessions_msg(vec![info("s1", None, None)])),
        )
        .await;
    assert_eq!(out, RouteResult::default());
    assert!(s.machines.machine(MACHINE).is_none());
}

#[tokio::test]
async fn a_heartbeat_transition_into_waiting_marks_unread_notifies_and_feeds_the_fsm() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    // first sight: running — no transition
    {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        let out = r
            .route(
                MACHINE,
                &BridgeToPhone::Sessions(sessions_msg(vec![info(
                    "s1",
                    Some(SessionState::Running),
                    None,
                )])),
            )
            .await;
        assert!(out.notifies.is_empty());
        assert_eq!(out.heartbeat, Some((MACHINE.to_string(), 1_000)));
        assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    }
    // now it enters waiting_permission while the phone is backgrounded →
    // mark + OS notify
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    r.visible = false;
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Sessions(sessions_msg(vec![info(
                "s1",
                Some(SessionState::WaitingPermission),
                None,
            )])),
        )
        .await;
    assert!(s.ui.is_session_unread(MACHINE, "s1"));
    assert!(matches!(
        out.notifies.as_slice(),
        [NotifyEffect::Notify { .. }]
    ));
    assert!(out.persist.contains(&StoreId::Machines));
}

#[tokio::test]
async fn a_session_list_older_than_the_one_applied_changes_nothing_and_tells_nothing() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    let list = |state, rev| {
        let mut m = sessions_msg(vec![info("s1", Some(state), None)]);
        m.rev = Some(rev);
        BridgeToPhone::Sessions(m)
    };
    let route = async |s: &mut CoreStores, msg: BridgeToPhone, now| {
        let mut r = Router::new(s, &ts, &kp, now);
        r.visible = false;
        r.route(MACHINE, &msg).await
    };
    assert!(route(&mut s, list(SessionState::Running, 10), 1_000).await.notifies.is_empty());
    let finished = route(&mut s, list(SessionState::Idle, 20), 2_000).await;
    assert_eq!(finished.notifies.len(), 1, "the turn's end is told once");

    // A Running list from before it, late over another relay or the
    // direct link, and the Idle one replayed after a restart: nothing.
    for (late, now) in [(list(SessionState::Running, 15), 3_000), (list(SessionState::Idle, 20), 4_000)] {
        let out = route(&mut s, late, now).await;
        assert_eq!(out, RouteResult::default());
    }
    assert_eq!(s.machines.session(MACHINE, "s1").unwrap().info.state, Some(SessionState::Idle));

    // The rev survives the store, so a restarted phone still ignores them.
    let stored = serde_json::to_string(&s.machines.machines).unwrap();
    let back: std::collections::BTreeMap<String, client_core::stores::machines::MachineView> =
        serde_json::from_str(&stored).unwrap();
    assert_eq!(back[MACHINE].list_rev, Some(20));

    // A newer turn is told again (past the notification cooldown).
    route(&mut s, list(SessionState::Running, 30), 15_000).await;
    assert_eq!(route(&mut s, list(SessionState::Idle, 40), 16_000).await.notifies.len(), 1);
}

#[tokio::test]
async fn the_same_session_failure_is_told_once() {
    let (mut s, ts, kp) = stores().await;
    let failed = BridgeToPhone::SessionFailed(protocol::events::SessionFailedMsg {
        pending_id: "p1".into(),
        reason: "no such folder".into(),
    });
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    r.visible = false;
    assert_eq!(r.route(MACHINE, &failed).await.notifies.len(), 1);
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    r.visible = false;
    assert!(r.route(MACHINE, &failed).await.notifies.is_empty());
}

#[tokio::test]
async fn the_foreground_watched_session_is_never_marked_or_notified() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.ui.select_session(MACHINE, Some("s1"), true);
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Sessions(sessions_msg(vec![info(
                "s1",
                Some(SessionState::WaitingPermission),
                None,
            )])),
        )
        .await;
    assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    assert!(out.notifies.is_empty());
}

#[tokio::test]
async fn session_ready_upserts_the_session_and_sends_nothing() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);

    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::SessionReady(SessionReadyMsg {
                pending_id: "s1".into(),
                session: Box::new(info("s1", Some(SessionState::Idle), None)),
            }),
        )
        .await;
    assert!(s.machines.session(MACHINE, "s1").is_some());
    // The new session's mode rides create-session itself; nothing follows.
    assert!(out.sends.is_empty());
    assert_eq!(out.persist, vec![StoreId::Machines]);
}

#[tokio::test]
async fn credentials_ack_updates_the_ui_ack_and_the_stored_statuses() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::CredentialsAck(protocol::events::CredentialsAckMsg {
                machine: "laptop".into(),
                agent: None,
                success: true,
                credentials: vec![protocol::common::CredentialStatus {
                    id: "github_pat".into(),
                    label: "GitHub token".into(),
                    present: true,
                    from_env: false,
                    valid: Some(true),
                }],
                error: None,
            }),
        )
        .await;
    assert!(out.ui_changed);
    assert_eq!(out.persist, vec![StoreId::Machines]);
    let ack = &s.ui.credentials_status[MACHINE];
    assert_eq!(ack.state, client_core::stores::ui::AckState::Saved);
    assert_eq!(s.machines.machine(MACHINE).unwrap().credentials[0].valid, Some(true));
}

#[tokio::test]
async fn a_web_sign_in_result_moves_the_code_it_answers_and_no_other() {
    let (mut s, ts, kp) = stores().await;
    s.ui.note_web_sign_in_sent(MACHINE, "K7QM-4XPA");

    // The answer names a code other than the one on screen — the screen
    // closed and reopened, or the user retyped — so it is not about this
    // attempt and the entry stays where it is.
    let stale = BridgeToPhone::WebSignInResult(protocol::events::WebSignInResultMsg {
        code: "OLD1-CODE".into(),
        signed_in: true,
    });
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r.route(MACHINE, &stale).await;
    assert!(!out.ui_changed);
    assert_eq!(
        s.ui.web_sign_in[MACHINE].state,
        client_core::stores::ui::WebSignInState::Sending
    );

    let answered = BridgeToPhone::WebSignInResult(protocol::events::WebSignInResultMsg {
        code: "K7QM-4XPA".into(),
        signed_in: true,
    });
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    let out = r.route(MACHINE, &answered).await;
    assert!(out.ui_changed);
    assert_eq!(
        s.ui.web_sign_in[MACHINE].state,
        client_core::stores::ui::WebSignInState::SignedIn
    );

    // The screen closed before the answer came back: nothing to report.
    s.ui.clear_web_sign_in(MACHINE);
    let mut r = Router::new(&mut s, &ts, &kp, 3_000);
    assert!(!r.route(MACHINE, &answered).await.ui_changed);
}

#[tokio::test]
async fn a_web_browsers_answer_replaces_that_machines_list_whole() {
    let (mut s, ts, kp) = stores().await;
    let browser = protocol::events::WebBrowserInfo {
        id: "0123456789abcdef".into(),
        by: "npub1owner".into(),
        since_ms: 1,
        last_seen_ms: 2,
        expires_ms: 3,
        peer: "192.168.1.20".into(),
        agent: "Mozilla/5.0".into(),
    };
    let message = BridgeToPhone::WebBrowsers(protocol::events::WebBrowsersMsg {
        browsers: vec![browser.clone()],
    });

    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r.route(MACHINE, &message).await;
    assert!(out.ui_changed, "the screen redraws from the new list");
    assert_eq!(s.ui.web_browsers[MACHINE], vec![browser]);

    // A later, shorter answer is the whole list, not an addition.
    let empty = BridgeToPhone::WebBrowsers(protocol::events::WebBrowsersMsg { browsers: vec![] });
    let mut r = Router::new(&mut s, &ts, &kp, 2_000);
    assert!(r.route(MACHINE, &empty).await.ui_changed);
    assert!(s.ui.web_browsers[MACHINE].is_empty());
}

#[tokio::test]
async fn models_updates_the_agents_list_and_asks_for_a_persist() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::Models(protocol::events::ModelsMsg {
                agent: "claude-code".into(),
                models: vec![protocol::events::ModelEntry {
                    id: "sonnet".into(),
                    label: Some("Sonnet".into()),
                    ..Default::default()
                }],
                default_model: Some("sonnet".into()),
                error: None,
            }),
        )
        .await;
    assert_eq!(out.persist, vec![StoreId::Machines]);
    assert_eq!(
        s.machines.machine(MACHINE).unwrap().models["claude-code"].models.as_ref().unwrap()[0].id,
        "sonnet"
    );
}

/// A new profile list must reach the open providers page at once: the
/// machines persist is the views' refresh signal, even though the
/// profiles themselves are never written.
#[tokio::test]
async fn provider_profiles_refresh_the_machines_view() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::ProviderProfiles(protocol::events::ProviderProfilesMsg {
                machine: MACHINE.into(),
                profiles: vec![protocol::common::ProviderProfileInfo {
                    id: "home".into(),
                    agent: "opencode".into(),
                    label: "Home".into(),
                    base_url: "http://192.168.1.2:3456".into(),
                    models: vec![],
                    models_from_provider: false,
                    default_model: None,
                    has_token: true,
                    error: None,
                }],
            }),
        )
        .await;
    assert_eq!(out.persist, vec![StoreId::Machines]);
    assert_eq!(s.machines.machine(MACHINE).unwrap().provider_profiles.as_ref().unwrap()[0].id, "home");
}

#[tokio::test]
async fn option_confirmed_writes_through_to_the_session_info() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.machines.apply_session_upsert(MACHINE, &info("s1", None, None), 0);
    for (option, value) in [
        (protocol::common::SessionOption::Mode, "acceptEdits"),
        (protocol::common::SessionOption::Effort, "high"),
        (protocol::common::SessionOption::Model, "opus"),
    ] {
        let mut r = Router::new(&mut s, &ts, &kp, 1_000);
        r.route(
            MACHINE,
            &BridgeToPhone::OptionConfirmed(protocol::events::OptionConfirmedMsg {
                session_id: "s1".into(),
                option,
                value: value.into(),
            }),
        )
        .await;
    }
    let info = &s.machines.session(MACHINE, "s1").unwrap().info;
    assert_eq!(info.mode.as_deref(), Some("acceptEdits"));
    assert_eq!(info.effort.as_deref(), Some("high"));
    assert_eq!(info.model.as_deref(), Some("opus"));
}

#[tokio::test]
async fn input_failed_marks_the_item_failed_with_the_wire_reason() {
    let (mut s, ts, kp) = stores().await;
    let item = OutboxState::new_input("in-1", MACHINE, "s1", "hi", 500);
    s.outbox.begin_publish(item);
    s.outbox.settle_publish("in-1", true, None, 600);

    let mut r = Router::new(&mut s, &ts, &kp, 1_000);
    let out = r
        .route(
            MACHINE,
            &BridgeToPhone::InputFailed(InputFailedMsg {
                session_id: "s1".into(),
                reason: protocol::events::InputFailedReason::NoSession,
                input_id: Some("in-1".into()),
                detail: None,
            }),
        )
        .await;
    assert_eq!(out.persist, vec![StoreId::Outbox]);
    assert_eq!(s.outbox.items["in-1"].state, OutboxItemState::Failed);
    assert_eq!(s.outbox.items["in-1"].error.as_deref(), Some("no-session"));
}

fn closes_of(out: &RouteResult, session: &str) -> usize {
    out.sends.iter().filter(|x| matches!(&x.msg, PhoneToBridge::CloseSession(m) if m.session_id == session)).count()
}

/// `s1` listed by MACHINE, then deleted here at 1 000 (removed, dismissed,
/// its close sent).
async fn deleted_while_listed() -> (CoreStores, MemoryTranscriptStore, PhoneKeys) {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.machines.apply_session_list(MACHINE, &sessions_msg(vec![info("s1", None, None)]), 500);
    s.machines.user_remove_session(MACHINE, "s1");
    s.machines.dismiss_session(MACHINE, "s1", 1_000);
    s.machines.note_close_sent("s1", 1_000);
    (s, ts, kp)
}

#[tokio::test]
async fn a_deleted_session_its_bridge_still_lists_gets_its_close_again_until_acked() {
    let (mut s, ts, kp) = deleted_while_listed().await;
    let heartbeat = BridgeToPhone::Sessions(sessions_msg(vec![info("s1", None, None)]));
    let out = Router::new(&mut s, &ts, &kp, 2_000).route(MACHINE, &heartbeat).await;
    assert_eq!(closes_of(&out, "s1"), 0, "it just went");
    let later = 1_000 + CLOSE_RETRY_MS;
    let out = Router::new(&mut s, &ts, &kp, later).route(MACHINE, &heartbeat).await;
    assert_eq!(closes_of(&out, "s1"), 1, "the bridge never heard it");
    assert!(s.machines.session(MACHINE, "s1").is_none());
    // A failed close is tried again; a done one is not.
    let ack = |success| BridgeToPhone::CloseSessionAck(CloseSessionAckMsg { session_id: "s1".into(), success });
    Router::new(&mut s, &ts, &kp, later + 1).route(MACHINE, &ack(false)).await;
    let out = Router::new(&mut s, &ts, &kp, later + CLOSE_RETRY_MS).route(MACHINE, &heartbeat).await;
    assert_eq!(closes_of(&out, "s1"), 1);
    Router::new(&mut s, &ts, &kp, later + CLOSE_RETRY_MS + 1).route(MACHINE, &ack(true)).await;
    let out = Router::new(&mut s, &ts, &kp, later + 3 * CLOSE_RETRY_MS).route(MACHINE, &heartbeat).await;
    assert_eq!(closes_of(&out, "s1"), 0);
    assert!(s.machines.session(MACHINE, "s1").is_none());
}

#[tokio::test]
async fn no_close_goes_out_while_the_delete_can_be_undone() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.machines.apply_session_list(MACHINE, &sessions_msg(vec![info("s1", None, None)]), 500);
    let snapshot = s.machines.session(MACHINE, "s1").cloned();
    let effects = s.delete_controller.request_delete(MACHINE, "s1", snapshot, None, 1_000);
    crate::intent::apply_delete_effects(&mut s, effects, 1_000, &mut crate::intent::IntentResult::default());
    let heartbeat = BridgeToPhone::Sessions(sessions_msg(vec![info("s1", None, None)]));
    let out = Router::new(&mut s, &ts, &kp, 1_000 + CLOSE_RETRY_MS).route(MACHINE, &heartbeat).await;
    assert_eq!(closes_of(&out, "s1"), 0);
    assert!(s.machines.session(MACHINE, "s1").is_none(), "hidden all the same");
}

#[tokio::test]
async fn a_session_deleted_on_the_bridge_leaves_no_dot_unsent_message_or_notification() {
    let (mut s, ts, kp) = stores().await;
    s.machines.register_machine(MACHINE, "laptop", None, None, &[]);
    s.machines.apply_session_list(MACHINE, &sessions_msg(vec![info("s1", None, None)]), 500);
    s.ui.mark_session_unread(MACHINE, "s1");
    s.outbox.begin_publish(OutboxState::new_input("in-1", MACHINE, "s1", "hi", 600));
    let mut gone = sessions_msg(vec![]);
    gone.removed_sessions = Some(vec!["s1".into()]);
    let out = Router::new(&mut s, &ts, &kp, 1_000).route(MACHINE, &BridgeToPhone::Sessions(gone.clone())).await;
    assert!(s.machines.session(MACHINE, "s1").is_none());
    assert!(!s.ui.is_session_unread(MACHINE, "s1"));
    assert!(s.outbox.items.is_empty());
    assert!(out.persist.contains(&StoreId::Outbox));
    assert_eq!(out.ui_effects, vec![UiEffect::SessionDeleted { machine: MACHINE.into(), session_id: "s1".into() }]);
    // The tombstone rides the next heartbeat too: nothing left to cancel.
    let out = Router::new(&mut s, &ts, &kp, 2_000).route(MACHINE, &BridgeToPhone::Sessions(gone)).await;
    assert!(out.ui_effects.is_empty());
}
