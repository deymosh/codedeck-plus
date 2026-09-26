//! Session lifecycle through the engine: creation, output, input, restarts,
//! the agent host going away, and resume after a bridge restart.

mod support;

use agent_protocol::{BridgeMessage, HostMessage, SessionEvent, TurnState};
use bridge_core::{Effect, Input};
use protocol::common::{EntryBody, NoticeKind, Role, SessionState};
use protocol::events::{BridgeToPhone, InputFailedReason};
use serde_json::json;
use support::*;

fn notices(msgs: &[BridgeToPhone]) -> Vec<(NoticeKind, String)> {
    outputs(msgs)
        .into_iter()
        .filter_map(|(_, e)| match e.body {
            EntryBody::Notice { kind, text } => Some((kind, text)),
            _ => None,
        })
        .collect()
}

#[test]
fn start_publishes_a_heartbeat_then_the_catalog_once_the_host_reports() {
    let mut rig = Rig::new();
    let hb = last_heartbeat(&rig.messages());
    assert_eq!((hb.machine.as_str(), hb.protocol_version), ("laptop", 11));
    assert!(hb.capabilities.unwrap().contains(&"sync/1".to_string()));
    assert_eq!(hb.folders.unwrap(), ["app", "lib"]);
    assert_eq!(hb.roots.unwrap(), ["/w"]);
    assert!(hb.agents.is_empty());
    assert_eq!(hb.credentials[0].id, "github_pat");

    rig.host_up();
    let hb = last_heartbeat(&rig.messages());
    let ids: Vec<_> = hb.agents.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, ["alpha", "beta"], "an unavailable agent is not advertised");
    assert_eq!(hb.agents[0].credentials[0].id, "alpha_key");
    assert!(!hb.agents[0].credentials[0].present);
}

#[test]
fn without_a_paired_phone_nothing_is_published() {
    let mut rig = Rig::with(RigOptions { paired: false, ..Default::default() });
    assert!(rig.messages().is_empty());
}

#[test]
fn the_command_subscription_follows_the_paired_phones_and_the_cursor() {
    let rig = Rig::new();
    let filter = rig.engine.commands_filter();
    assert_eq!(filter.authors, std::slice::from_ref(&rig.phone.pubkey_hex));
    assert_eq!(filter.since, T0 / 1000 - 300);
}

#[test]
fn create_session_is_pending_then_ready_then_listed() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.take();
    rig.send(json!({"type":"create-session","agent":"alpha","cwd":"app","effort":"high","model":"m1"}));
    let msgs = rig.messages();
    let BridgeToPhone::SessionPending(pending) = &msgs[0] else { panic!("{msgs:?}") };
    let (id, p) = rig.start_request();
    assert_eq!(p.session_id, pending.pending_id);
    assert_eq!((p.agent.as_str(), p.cwd.as_str()), ("alpha", "/w/app"));
    assert_eq!((p.mode.as_deref(), p.effort.as_deref(), p.model.as_deref()), (Some("ask"), Some("high"), Some("m1")));
    assert_eq!(p.resume, None);
    assert!(!p.deny_secret_paths && p.host_tools.is_empty());

    rig.host_reply(&id, HostMessage::Ack);
    assert!(heartbeats(&rig.messages()).iter().all(|h| h.sessions.is_empty()), "not listed while pending");
    rig.host_event(&p.session_id, SessionEvent::Ready {});
    let msgs = rig.messages();
    let ready = msgs.iter().find_map(|m| match m {
        BridgeToPhone::SessionReady(r) => Some(r.clone()),
        _ => None,
    });
    let ready = ready.expect("session-ready");
    assert_eq!((ready.pending_id.as_str(), ready.session.project.as_str()), (p.session_id.as_str(), "app"));
    assert_eq!(last_heartbeat(&msgs).sessions.len(), 1);
    assert!(rig.store.snapshot()["registry"].contains(&p.session_id));
}

#[test]
fn a_session_on_an_agent_that_cannot_run_fails_at_once() {
    let mut rig = Rig::new();
    rig.host_up();
    for (agent, why) in [("nope", "no agent 'nope'"), ("gamma", "not configured")] {
        rig.take();
        rig.send(json!({"type":"create-session","agent":agent}));
        let msgs = rig.messages();
        assert!(matches!(&msgs[0], BridgeToPhone::SessionPending(_)));
        assert!(matches!(&msgs[1], BridgeToPhone::SessionFailed(f) if f.reason.contains(why)), "{msgs:?}");
        assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
    }
}

#[test]
fn before_the_host_reports_a_session_fails_with_a_reason() {
    let mut rig = Rig::new();
    rig.take();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.reason.contains("not running"))));
}

#[test]
fn a_start_the_host_refuses_fails_the_session_with_its_reason() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    let (id, p) = rig.start_request();
    rig.take();
    rig.host_reply(&id, HostMessage::Error { message: "bad cwd".into() });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.pending_id == p.session_id && f.reason == "bad cwd")));
    assert_eq!(notices(&msgs), [(NoticeKind::SessionFailed, "Session creation failed: bad cwd".into())]);
    assert!(heartbeats(&msgs).iter().all(|h| h.sessions.is_empty()));
}

#[test]
fn an_agent_that_stops_before_ready_fails_the_session() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    let (id, p) = rig.start_request();
    rig.host_reply(&id, HostMessage::Ack);
    rig.take();
    rig.host_event(&p.session_id, SessionEvent::Ended { error: Some("spawn ENOENT".into()), resume_lost: false });
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.reason == "spawn ENOENT")));
}

#[test]
fn an_unknown_mode_or_effort_falls_back_to_the_agent_default() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha","mode":"warp","effort":"max"}));
    let (_, p) = rig.start_request();
    assert_eq!((p.mode.as_deref(), p.effort.as_deref()), (Some("ask"), Some("high")));
}

#[test]
fn a_session_without_mode_or_effort_records_the_agent_defaults() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    let (_, p) = rig.start_request();
    assert_eq!((p.mode.as_deref(), p.effort.as_deref()), (Some("ask"), Some("high")));
    // An agent with no default effort leaves it unset.
    rig.send(json!({"type":"create-session","agent":"beta"}));
    let (_, p) = rig.start_request();
    assert_eq!((p.mode.as_deref(), p.effort), (Some("ask"), None));
}

#[test]
fn a_session_started_on_the_default_model_is_listed_with_it() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    let (id, p) = rig.start_request();
    assert_eq!(p.model, None);
    rig.host_reply(&id, HostMessage::Ack);
    rig.host_event(&p.session_id, SessionEvent::Info {
        native_session_id: None,
        model: Some("m-default".into()),
        mode: None,
        context_window: None,
        context_percentage: None,
    });
    rig.host_event(&p.session_id, SessionEvent::Ready {});
    let ready = rig
        .messages()
        .into_iter()
        .find_map(|m| match m {
            BridgeToPhone::SessionReady(r) => Some(r),
            _ => None,
        })
        .expect("session-ready");
    assert_eq!(ready.session.model.as_deref(), Some("m-default"));
}

#[test]
fn agent_output_gets_seqs_is_stored_and_sent_live() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.say(&s, "one");
    rig.say(&s, "two");
    let seqs: Vec<u64> = outputs(&rig.messages()).iter().map(|(seq, _)| *seq).collect();
    assert_eq!(seqs, [1, 2]);
    assert_eq!(rig.transcripts.entries(&s).iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
}

fn prompt_text(rig: &mut Rig) -> String {
    let (_, msg) = rig.host_request(|m| matches!(m, BridgeMessage::Prompt { .. }));
    let BridgeMessage::Prompt { text, .. } = msg else { unreachable!() };
    text
}

#[test]
fn input_is_written_acked_and_prompted_with_the_meta_request_once() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.send(json!({"type":"input","sessionId":s,"text":"fix the build","inputId":"i1"}));
    let first = prompt_text(&mut rig);
    assert!(first.starts_with("fix the build") && first.contains("emit-session-meta"));
    let msgs = rig.messages();
    let (seq, entry) = outputs(&msgs).remove(0);
    assert_eq!(seq, 1);
    assert!(matches!(entry.body, EntryBody::Text { role: Role::User, ref text, .. } if text == "fix the build"));
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::InputAck(a) if a.input_id == "i1")));
    assert_eq!(last_heartbeat(&msgs).sessions[0].title.as_deref(), Some("fix the build"));

    rig.send(json!({"type":"input","sessionId":s,"text":"second"}));
    assert_eq!(prompt_text(&mut rig), "second");
}

#[test]
fn a_slash_command_is_never_given_the_meta_request() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.send(json!({"type":"input","sessionId":s,"text":"/compact"}));
    assert_eq!(prompt_text(&mut rig), "/compact");
    rig.send(json!({"type":"input","sessionId":s,"text":"hello"}));
    assert!(prompt_text(&mut rig).contains("emit-session-meta"));
}

#[test]
fn an_echo_of_sent_input_is_dropped() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.send(json!({"type":"input","sessionId":s,"text":"hi"}));
    let sent = prompt_text(&mut rig);
    rig.take();
    let echo = protocol::common::OutputEntry::new("t", EntryBody::Text { role: Role::User, text: sent, collapsible: false });
    rig.host_event(&s, SessionEvent::Entries { entries: vec![echo] });
    assert!(outputs(&rig.messages()).is_empty());
}

#[test]
fn the_meta_tag_titles_the_session_once_and_is_always_stripped() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.say(&s, "Done.\n<!-- session-meta: {\"topic\": \"Fix login\", \"project\": \"web\"} -->");
    let msgs = rig.messages();
    assert!(matches!(&outputs(&msgs)[0].1.body, EntryBody::Text { text, .. } if text == "Done."));
    let hb = last_heartbeat(&msgs);
    assert_eq!((hb.sessions[0].title.as_deref(), hb.sessions[0].project.as_str()), (Some("Fix login"), "web"));

    rig.say(&s, "<!-- session-meta: {\"topic\": \"Other\"} -->");
    let msgs = rig.messages();
    assert!(outputs(&msgs).is_empty(), "a bare repeated tag leaves nothing to show");
    assert!(heartbeats(&msgs).iter().all(|h| h.sessions[0].title.as_deref() == Some("Fix login")));
}

#[test]
fn input_to_an_unknown_session_is_no_session_and_to_an_ended_one_error() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"input","sessionId":"ghost","text":"x"}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::InputFailed(f) if f.reason == InputFailedReason::NoSession)));
    let s = rig.ready_session("alpha");
    rig.host_event(&s, SessionEvent::Ended { error: None, resume_lost: false });
    rig.send(json!({"type":"input","sessionId":s,"text":"x"}));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::InputFailed(f) if f.reason == InputFailedReason::Error)));
    assert_eq!(last_heartbeat(&msgs).sessions.len(), 1, "a clean end keeps the session listed");
}

#[test]
fn turn_events_drive_the_listed_state() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.host_event(&s, SessionEvent::Turn { state: TurnState::Running });
    assert_eq!(last_heartbeat(&rig.messages()).sessions[0].state, Some(SessionState::Running));
    rig.host_event(&s, SessionEvent::Turn { state: TurnState::Idle });
    assert_eq!(last_heartbeat(&rig.messages()).sessions[0].state, Some(SessionState::Idle));
}

fn info_native(rig: &mut Rig, s: &str, id: &str) {
    rig.host_event(
        s,
        SessionEvent::Info { native_session_id: Some(id.into()), model: None, mode: None, context_window: None, context_percentage: None },
    );
}

fn crash(rig: &mut Rig, s: &str, resume_lost: bool) {
    rig.host_event(s, SessionEvent::Ended { error: Some("boom".into()), resume_lost });
}

#[test]
fn a_crashed_agent_is_restarted_with_its_conversation_twice_then_ended() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    info_native(&mut rig, &s, "n1");
    for attempt in 1..=2 {
        rig.take();
        crash(&mut rig, &s, false);
        let (id, p) = rig.start_request();
        assert_eq!(p.resume.as_deref(), Some("n1"));
        let msgs = rig.messages();
        assert_eq!(notices(&msgs), [(NoticeKind::SessionRestart, format!("Session interrupted — restarting (attempt {attempt})..."))]);
        rig.host_reply(&id, HostMessage::Ack);
    }
    rig.take();
    crash(&mut rig, &s, false);
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
    let msgs = rig.messages();
    assert_eq!(notices(&msgs)[0].0, NoticeKind::SessionDied);
    assert_eq!(last_heartbeat(&msgs).sessions.len(), 1, "the record stays");
}

#[test]
fn a_lost_conversation_is_dropped_but_kept_and_the_restart_is_fresh() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    info_native(&mut rig, &s, "n1");
    rig.take();
    crash(&mut rig, &s, true);
    let (_, p) = rig.start_request();
    assert_eq!(p.resume, None);
    assert!(notices(&rig.messages())[0].1.contains("was missing"));
    let registry = &rig.store.snapshot()["registry"];
    assert!(registry.contains("\"previousNativeSessionId\":\"n1\"") && !registry.contains("\"nativeSessionId\""), "{registry}");
}

#[test]
fn when_the_host_dies_sessions_restart_once_it_is_back_and_queued_input_follows() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    info_native(&mut rig, &s, "n1");
    rig.send(json!({"type":"create-session","agent":"beta"}));
    let (id, pending) = rig.start_request();
    rig.host_reply(&id, HostMessage::Ack);
    rig.take();

    rig.input(Input::HostDown { reason: "exit 1".into() });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.pending_id == pending.session_id)));
    assert_eq!(notices(&msgs).iter().filter(|(k, _)| *k == NoticeKind::SessionRestart).count(), 1);
    assert!(rig.host_frames().is_empty());

    rig.send(json!({"type":"input","sessionId":s,"text":"later","inputId":"i"}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::InputAck(_))));
    assert!(rig.host_frames().is_empty(), "queued while the host is down");

    rig.host_up();
    let frames = rig.host_frames();
    let kinds: Vec<_> = frames.iter().map(|f| std::mem::discriminant(&f.message)).collect();
    assert!(matches!(&frames[0].message, BridgeMessage::StartSession(p) if p.resume.as_deref() == Some("n1")));
    assert!(matches!(&frames[1].message, BridgeMessage::Prompt { text, .. } if text.starts_with("later")));
    assert_eq!(kinds.len(), 2);
}

#[test]
fn requests_in_flight_when_the_host_dies_are_answered() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"models-request","agent":"alpha"}));
    rig.take();
    rig.input(Input::HostDown { reason: "exit 1".into() });
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::Models(x) if x.error.as_deref().is_some_and(|e| e.contains("stopped")))));
}

#[test]
fn a_restarted_bridge_resumes_every_session_and_seqs_continue() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha","testSession":true}));
    let (id, p) = rig.start_request();
    assert!(p.deny_secret_paths);
    rig.host_reply(&id, HostMessage::Ack);
    rig.host_event(&p.session_id, SessionEvent::Ready {});
    info_native(&mut rig, &p.session_id, "n1");
    rig.say(&p.session_id, "x");

    let mut rig = rig.restart();
    let hb = last_heartbeat(&rig.messages());
    assert_eq!(hb.sessions.len(), 1);
    assert_eq!(hb.sessions[0].seq_high, Some(1));
    rig.host_up();
    let (_, resumed) = rig.start_request();
    assert_eq!(resumed.resume.as_deref(), Some("n1"));
    assert!(resumed.deny_secret_paths, "a test session keeps its boundary across restarts");
    rig.say(&p.session_id, "y");
    assert_eq!(outputs(&rig.messages())[0].0, 2);
}

#[test]
fn a_resumed_session_whose_agent_is_gone_ends_with_a_notice() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("beta");
    let mut rig = rig.restart();
    rig.host_up_with(vec![alpha()]);
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
    let msgs = rig.messages();
    let died = notices(&msgs);
    assert_eq!(died[0].0, NoticeKind::SessionDied);
    assert!(died[0].1.starts_with("Session could not be resumed: This bridge has no agent 'beta'"), "{died:?} for {s}");
}

#[test]
fn close_session_ends_it_tombstones_it_and_forgets_its_transcript() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.say(&s, "x");
    rig.send(json!({"type":"close-session","sessionId":s}));
    assert!(rig.has_host_request(|m| matches!(m, BridgeMessage::EndSession { .. })));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::CloseSessionAck(a) if a.success)));
    let hb = last_heartbeat(&msgs);
    assert!(hb.sessions.is_empty());
    assert_eq!(hb.removed_sessions, Some(vec![s.clone()]));
    assert!(rig.transcripts.entries(&s).is_empty());
}

#[test]
fn shutdown_publishes_every_session_offline_and_stops() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    rig.input(Input::Shutdown);
    let effects = rig.take();
    assert!(matches!(effects.last(), Some(Effect::Stopped)));
    let ends = effects.iter().filter(|e| matches!(e, Effect::Host(f) if matches!(f.message, BridgeMessage::EndSession { .. }))).count();
    assert_eq!(ends, 1);
    let hb = effects
        .iter()
        .find_map(|e| match e {
            Effect::Publish { message: BridgeToPhone::Sessions(h), .. } => Some(h.clone()),
            _ => None,
        })
        .expect("offline heartbeat");
    assert_eq!(hb.machine_offline, Some(true));
    assert_eq!((hb.sessions[0].id.as_str(), hb.sessions[0].state), (s.as_str(), Some(SessionState::Offline)));
    rig.send(json!({"type":"refresh-sessions"}));
    assert!(rig.take().is_empty(), "a stopped engine does nothing");
}

#[test]
fn output_alone_does_not_rewrite_the_state_store_until_the_heartbeat() {
    let mut rig = Rig::new();
    rig.host_up();
    let s = rig.ready_session("alpha");
    let before = rig.store.snapshot()["registry"].clone();

    rig.advance(5_000);
    rig.say(&s, "busy");
    rig.say(&s, "still busy");
    assert_eq!(rig.store.snapshot()["registry"], before, "only lastActivity changed: not stored per batch");

    rig.advance(60_000); // the default heartbeat interval
    let after = rig.store.snapshot()["registry"].clone();
    assert_ne!(after, before, "the heartbeat stores the new lastActivity");
    assert!(after.contains(&s));
}
