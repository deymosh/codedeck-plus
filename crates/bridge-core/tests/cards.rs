//! Cards (permission, question, plan approval), host tools, session options
//! and the smaller phone requests, through the engine.

mod support;

use agent_protocol::{
    BridgeMessage, HostMessage, HostToolCall, PermissionRequest, PlanApprovalRequest, QuestionOutcome, QuestionRequest,
    QuestionSpec, SelectOutcome, SessionEvent,
};
use bridge_core::{Effect, Input};
use protocol::common::{
    EntryBody, OutputEntry, PermissionOption, PermissionOptionKind, QuestionOption, SessionState, ToolKind, UsageData,
};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

fn option(id: &str, kind: PermissionOptionKind) -> PermissionOption {
    PermissionOption { id: id.into(), label: id.into(), kind }
}

fn permission(session: &str, request: &str) -> HostMessage {
    HostMessage::RequestPermission(PermissionRequest {
        session_id: session.into(),
        request_id: request.into(),
        tool_name: "Bash".into(),
        kind: ToolKind::Execute,
        title: "rm -rf build".into(),
        description: None,
        locations: vec![],
        raw_input: Some(json!({"command":"rm -rf build"})),
        options: vec![
            option("allow", PermissionOptionKind::AllowOnce),
            option("always", PermissionOptionKind::AllowAlways),
            option("deny", PermissionOptionKind::RejectOnce),
        ],
        subagent: None,
    })
}

fn resolved(msgs: &[BridgeToPhone]) -> Vec<String> {
    outputs(msgs)
        .into_iter()
        .filter_map(|(_, e)| match e.body {
            EntryBody::Resolved { summary, .. } => Some(summary),
            _ => None,
        })
        .collect()
}

/// The reply sent to host request `id`.
fn reply_to(rig: &mut Rig, id: &str) -> BridgeMessage {
    let frames = rig.host_frames();
    frames.into_iter().find(|f| f.id.as_deref() == Some(id)).unwrap_or_else(|| panic!("no reply to {id}")).message
}

fn ready(rig: &mut Rig) -> String {
    rig.host_up();
    rig.ready_session("alpha")
}

#[test]
fn a_permission_card_round_trips_through_the_phone() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(permission(&s, "r1"));
    let msgs = rig.messages();
    assert!(matches!(&outputs(&msgs)[0].1.body, EntryBody::PermissionRequest { request_id, options, .. } if request_id == "r1" && options.len() == 3));
    assert_eq!(last_heartbeat(&msgs).sessions[0].state, Some(SessionState::WaitingPermission));

    rig.send(json!({"type":"permission-response","sessionId":s,"requestId":"r1","optionId":"nope"}));
    assert!(rig.host_frames().is_empty(), "an option the card does not offer changes nothing");

    rig.send(json!({"type":"permission-response","sessionId":s,"requestId":"r1","optionId":"always"}));
    assert_eq!(reply_to(&mut rig, &h), BridgeMessage::PermissionOutcome(SelectOutcome::Selected { option_id: "always".into() }));
    let msgs = rig.messages();
    assert_eq!(resolved(&msgs), ["Always allowed"]);
    assert_eq!(last_heartbeat(&msgs).sessions[0].state, Some(SessionState::Idle));

    rig.send(json!({"type":"permission-response","sessionId":s,"requestId":"r1","optionId":"allow"}));
    assert!(rig.host_frames().is_empty(), "answered once");
}

#[test]
fn an_unanswered_card_times_out_after_an_hour() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(permission(&s, "r1"));
    rig.take();
    rig.advance(3_599_000);
    assert!(rig.host_frames().is_empty());
    rig.advance(1_000);
    assert_eq!(reply_to(&mut rig, &h), BridgeMessage::PermissionOutcome(SelectOutcome::Cancelled { reason: "timed out".into() }));
    assert_eq!(resolved(&rig.messages()), ["Timed out"]);
}

fn questions(session: &str) -> HostMessage {
    HostMessage::AskQuestion(QuestionRequest {
        session_id: session.into(),
        request_id: "q1".into(),
        questions: vec![
            QuestionSpec {
                header: Some("Color".into()),
                question: "Which color?".into(),
                options: vec![QuestionOption { label: "Red".into(), description: None }, QuestionOption { label: "Blue".into(), description: None }],
                multi_select: false,
            },
            QuestionSpec { header: None, question: "Which role?".into(), options: vec![], multi_select: false },
        ],
    })
}

#[test]
fn questions_are_answered_by_index_in_any_order_then_resolved_together() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(questions(&s));
    let msgs = rig.messages();
    let asked: Vec<(u32, u32)> = outputs(&msgs)
        .iter()
        .filter_map(|(_, e)| match e.body {
            EntryBody::Question { index, count, .. } => Some((index, count)),
            _ => None,
        })
        .collect();
    assert_eq!(asked, [(0, 2), (1, 2)]);
    assert_eq!(last_heartbeat(&msgs).sessions[0].state, Some(SessionState::WaitingQuestion));

    rig.send(json!({"type":"question-response","sessionId":s,"requestId":"q1","index":1,"answer":{"kind":"text","text":"Dev"}}));
    assert!(rig.host_frames().is_empty());
    rig.send(json!({"type":"question-response","sessionId":s,"requestId":"q1","index":0,"answer":{"kind":"options","selected":[5]}}));
    assert!(rig.host_frames().is_empty(), "an out-of-range option answers nothing");
    rig.send(json!({"type":"question-response","sessionId":s,"requestId":"q1","index":0,"answer":{"kind":"options","selected":[1]}}));
    assert_eq!(
        reply_to(&mut rig, &h),
        BridgeMessage::QuestionOutcome(QuestionOutcome::Answered { answers: vec!["Blue".into(), "Dev".into()] })
    );
    assert_eq!(resolved(&rig.messages()), ["Blue · Dev"]);
}

#[test]
fn plain_input_while_a_question_waits_answers_it() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(questions(&s));
    rig.send(json!({"type":"input","sessionId":s,"text":"Green","inputId":"i"}));
    rig.send(json!({"type":"input","sessionId":s,"text":"Ops"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::Prompt { .. })));
    assert_eq!(
        reply_to(&mut rig, &h),
        BridgeMessage::QuestionOutcome(QuestionOutcome::Answered { answers: vec!["Green".into(), "Ops".into()] })
    );
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::InputAck(_))));
}

#[test]
fn a_plan_answer_and_the_agents_mode_switch_reach_the_phone() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(HostMessage::RequestPlanApproval(PlanApprovalRequest {
        session_id: s.clone(),
        request_id: "p1".into(),
        options: vec![choice("yolo"), choice("revise")],
    }));
    assert!(matches!(&outputs(&rig.messages())[0].1.body, EntryBody::PlanApproval { options, .. } if options.len() == 2));
    rig.send(json!({"type":"plan-response","sessionId":s,"requestId":"p1","optionId":"yolo"}));
    assert_eq!(reply_to(&mut rig, &h), BridgeMessage::PlanOutcome(SelectOutcome::Selected { option_id: "yolo".into() }));
    assert_eq!(resolved(&rig.messages()), ["YOLO"]);

    rig.host_event(&s, SessionEvent::Info { native_session_id: None, model: None, mode: Some("yolo".into()), context_window: None, context_percentage: None });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::OptionConfirmed(o) if o.value == "yolo")));
    assert_eq!(last_heartbeat(&msgs).sessions[0].mode.as_deref(), Some("yolo"));
}

#[test]
fn interrupt_stops_the_turn_and_cancels_what_waits() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(permission(&s, "r1"));
    rig.send(json!({"type":"interrupt","sessionId":s}));
    assert!(rig.has_host_request(|m| matches!(m, BridgeMessage::Interrupt { .. })));
    assert_eq!(
        reply_to(&mut rig, &h),
        BridgeMessage::PermissionOutcome(SelectOutcome::Cancelled { reason: "Interrupted by user".into() })
    );
}

#[test]
fn cards_waiting_when_the_agent_dies_are_cancelled() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(permission(&s, "r1"));
    rig.host_event(&s, SessionEvent::Ended { error: Some("boom".into()), resume_lost: false });
    assert!(matches!(reply_to(&mut rig, &h), BridgeMessage::PermissionOutcome(SelectOutcome::Cancelled { reason }) if reason.contains("restarted")));
}

#[test]
fn a_card_for_a_session_that_is_not_running_is_cancelled_at_once() {
    let mut rig = Rig::new();
    rig.host_up();
    let h = rig.host_ask(permission("ghost", "r1"));
    assert!(matches!(reply_to(&mut rig, &h), BridgeMessage::PermissionOutcome(SelectOutcome::Cancelled { .. })));
}

#[test]
fn a_host_tool_call_runs_in_the_runtime_and_its_result_goes_back() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(HostMessage::CallHostTool(HostToolCall { session_id: s.clone(), tool: "list_devices".into(), args: json!({}) }));
    let run = rig.take().into_iter().find_map(|e| match e {
        Effect::RunHostTool { call_id, tool, .. } => Some((call_id, tool)),
        _ => None,
    });
    assert_eq!(run, Some((h.clone(), "list_devices".to_string())));
    rig.input(Input::HostToolDone { call_id: h.clone(), text: "none".into(), is_error: false });
    assert_eq!(reply_to(&mut rig, &h), BridgeMessage::HostToolResult { text: "none".into(), is_error: false });
}

fn set_option(rig: &mut Rig, s: &str, option: &str, value: &str) -> Option<String> {
    rig.send(json!({"type":"set-option","sessionId":s,"option":option,"value":value}));
    rig.host_frames().into_iter().find(|f| matches!(f.message, BridgeMessage::SetOption { .. })).and_then(|f| f.id)
}

fn confirmed(rig: &mut Rig) -> Vec<String> {
    rig.messages()
        .into_iter()
        .filter_map(|m| match m {
            BridgeToPhone::OptionConfirmed(o) => Some(o.value),
            _ => None,
        })
        .collect()
}

#[test]
fn set_option_is_checked_against_the_catalog_then_confirmed() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    assert_eq!(set_option(&mut rig, &s, "mode", "warp"), None, "not an alpha mode");
    let id = set_option(&mut rig, &s, "mode", "plan").expect("sent");
    rig.host_reply(&id, HostMessage::Ack);
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::OptionConfirmed(o) if o.value == "plan")));
    assert_eq!(last_heartbeat(&msgs).sessions[0].mode.as_deref(), Some("plan"));

    let id = set_option(&mut rig, &s, "effort", "high").unwrap();
    rig.host_reply(&id, HostMessage::Error { message: "no".into() });
    assert_eq!(confirmed(&mut rig), ["high"], "the agent's default effort stays in force");
    let id = set_option(&mut rig, &s, "effort", "low").unwrap();
    rig.host_reply(&id, HostMessage::Ack);
    assert_eq!(confirmed(&mut rig), ["low"]);
    let id = set_option(&mut rig, &s, "effort", "high").unwrap();
    rig.host_reply(&id, HostMessage::Error { message: "no".into() });
    assert_eq!(confirmed(&mut rig), ["low"], "a refused change confirms the effort in force");

    let b = rig.ready_session("beta");
    assert_eq!(set_option(&mut rig, &b, "effort", "low"), None, "beta has no efforts");
}

#[test]
fn usage_is_asked_only_of_agents_that_report_it() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    rig.send(json!({"type":"usage-request","sessionId":s}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::GetUsage { .. }));
    let usage = UsageData { available: true, plan: None, windows: vec![], session_cost_usd: None, fetched_at: "t".into() };
    rig.host_reply(&id, HostMessage::Usage { usage: Some(usage) });
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::Usage(u) if u.session_id == s)));

    let b = rig.ready_session("beta");
    rig.send(json!({"type":"usage-request","sessionId":b}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::GetUsage { .. })));
}

fn models_error(rig: &mut Rig) -> Option<String> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::Models(x) => Some(x.error.unwrap_or_default()),
        _ => None,
    })
}

#[test]
fn models_are_listed_or_the_phone_is_told_why_not() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"models-request","agent":"alpha"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::ListModels { .. }));
    rig.host_reply(&id, HostMessage::Models { models: vec![protocol::events::ModelEntry { id: "m1".into(), label: None }], default_model: Some("m1".into()) });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::Models(x) if x.models.len() == 1 && x.error.is_none() && x.default_model.as_deref() == Some("m1"))));

    rig.send(json!({"type":"models-request","agent":"alpha"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::ListModels { .. }));
    rig.host_reply(&id, HostMessage::Models { models: vec![], default_model: None });
    assert!(models_error(&mut rig).unwrap().contains("Alpha reported no models"));

    rig.send(json!({"type":"models-request","agent":"gamma"}));
    assert!(models_error(&mut rig).unwrap().contains("not configured"));
}

#[test]
fn git_commits_mark_the_session() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"type":"create-session","agent":"alpha"}));
    assert!(rig.effects.iter().any(|e| matches!(e, Effect::ReadGitHead { cwd, .. } if cwd == "/w")), "the start HEAD is read");
    let s = rig.start_request().1.session_id;
    rig.host_event(&s, SessionEvent::Ready {});
    rig.input(Input::GitHead { session_id: s.clone(), head: Some("aaa".into()) });
    rig.take();

    rig.advance(10_000);
    assert!(rig.take().iter().any(|e| matches!(e, Effect::ReadGitHead { session_id, .. } if *session_id == s)), "polled");

    let call = OutputEntry::new(
        "t",
        EntryBody::ToolCall {
            call_id: "c".into(),
            tool_name: "Bash".into(),
            kind: ToolKind::Execute,
            title: "commit".into(),
            locations: vec![],
            raw_input: Some(json!({"command":"git commit -m x"})),
        },
    );
    rig.host_event(&s, SessionEvent::Entries { entries: vec![call] });
    assert!(rig.take().iter().any(|e| matches!(e, Effect::ReadGitHead { .. })), "checked at once");
    rig.input(Input::GitHead { session_id: s.clone(), head: Some("aaa".into()) });
    rig.input(Input::GitHead { session_id: s.clone(), head: Some("bbb".into()) });
    let hb = last_heartbeat(&rig.messages());
    assert_eq!(hb.sessions.iter().find(|x| x.id == s).unwrap().committed, Some(true));
}

#[test]
fn folders_are_created_inside_the_workspace_only() {
    let mut rig = Rig::new();
    rig.take();
    rig.send(json!({"type":"create-folder","path":"new","requestId":"r1"}));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::FolderAck(a) if a.success && a.path.as_deref() == Some("new"))));
    assert!(last_heartbeat(&msgs).folders.unwrap().contains(&"new".to_string()));
    rig.send(json!({"type":"create-folder","path":"../escape","requestId":"r2"}));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::FolderAck(a) if !a.success)));
}

#[test]
fn a_sync_request_is_answered_to_that_phone_only() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    for t in ["a", "b", "c"] {
        rig.say(&s, t);
    }
    rig.take();
    rig.send(json!({"type":"sync-request","sessionId":s,"haveRanges":[[1,1]]}));
    let published = rig.published();
    assert!(published.iter().all(|(to, _)| *to == [rig.phone.pubkey_hex.clone()]));
    assert!(matches!(&published[0].1, BridgeToPhone::SyncBegin(b) if b.ranges == [(2, 3)] && b.seq_high == 3));
    assert!(matches!(&published[1].1, BridgeToPhone::SyncChunk(c) if c.entries.len() == 2));
}

#[test]
fn gsd_state_is_read_in_the_session_directory() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    rig.send(json!({"type":"gsd-request","sessionId":s}));
    assert!(rig.take().iter().any(|e| matches!(e, Effect::ReadGsd { cwd, .. } if cwd == "/w")));
}
