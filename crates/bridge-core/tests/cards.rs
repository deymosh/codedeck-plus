//! Cards (permission, question, plan approval), session options
//! and the smaller phone requests, through the engine.

mod support;

use agent_protocol::{
    BridgeMessage, HostMessage, PermissionRequest, PlanApprovalRequest, PlanOutcome, QuestionOutcome, QuestionRequest,
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
        reason: None,
        hook: None,
        hook_plugin: None,
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
        revise: Some("revise".into()),
    }));
    assert!(matches!(
        &outputs(&rig.messages())[0].1.body,
        EntryBody::PlanApproval { options, revise: Some(revise), .. } if options.len() == 2 && revise == "revise"
    ));
    // Feedback is what changes are wanted: an approval carries none.
    rig.send(json!({"type":"plan-response","sessionId":s,"requestId":"p1","optionId":"yolo","feedback":"ignored"}));
    assert_eq!(
        reply_to(&mut rig, &h),
        BridgeMessage::PlanOutcome(PlanOutcome::Selected { option_id: "yolo".into(), feedback: None })
    );
    assert_eq!(resolved(&rig.messages()), ["YOLO"]);

    rig.host_event(&s, SessionEvent::Info { native_session_id: None, model: None, mode: Some("yolo".into()), title: None, context_window: None, context_percentage: None });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::OptionConfirmed(o) if o.value == "yolo")));
    assert_eq!(last_heartbeat(&msgs).sessions[0].mode.as_deref(), Some("yolo"));
}

#[test]
fn feedback_on_a_plan_goes_to_the_agent_with_the_revise_choice_and_into_the_transcript() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(HostMessage::RequestPlanApproval(PlanApprovalRequest {
        session_id: s.clone(),
        request_id: "p1".into(),
        options: vec![choice("yolo"), choice("revise")],
        revise: Some("revise".into()),
    }));
    rig.messages();
    rig.send(json!({"type":"plan-response","sessionId":s,"requestId":"p1","optionId":"revise","feedback":"  Fewer steps.  "}));
    assert_eq!(
        reply_to(&mut rig, &h),
        BridgeMessage::PlanOutcome(PlanOutcome::Selected { option_id: "revise".into(), feedback: Some("Fewer steps.".into()) })
    );
    let msgs = rig.messages();
    assert_eq!(resolved(&msgs), ["REVISE"]);
    // The user's words, after the card's resolution, as a typed message is.
    assert!(outputs(&msgs).iter().any(|(_, e)| matches!(&e.body, EntryBody::Text { text, .. } if text == "Fewer steps.")));
}

#[test]
fn a_revise_option_the_card_does_not_offer_is_no_revise_option() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    rig.host_ask(HostMessage::RequestPlanApproval(PlanApprovalRequest {
        session_id: s,
        request_id: "p1".into(),
        options: vec![choice("yolo")],
        revise: Some("missing".into()),
    }));
    assert!(matches!(&outputs(&rig.messages())[0].1.body, EntryBody::PlanApproval { revise: None, .. }));
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
fn stop_task_reaches_the_host_for_a_running_session_only() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    let h = rig.host_ask(permission(&s, "r1"));
    rig.send(json!({"type":"stop-task","sessionId":s,"taskId":"b1"}));
    assert!(rig.has_host_request(|m| matches!(m, BridgeMessage::StopTask { task_id, .. } if task_id == "b1")));
    // Stopping a background task leaves the turn and its cards alone.
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::Interrupt { .. })));
    let _ = h;

    rig.send(json!({"type":"stop-task","sessionId":"nope","taskId":"b1"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StopTask { session_id, .. } if session_id == "nope")));
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

    // Beta lists no levels of its own: its levels are per model, so the
    // agent judges one — and its refusal confirms nothing new.
    let b = rig.ready_session("beta");
    let id = set_option(&mut rig, &b, "effort", "max").expect("left to the agent");
    rig.host_reply(&id, HostMessage::Error { message: "not a level of this model".into() });
    assert!(!confirmed(&mut rig).contains(&"max".to_string()));
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

fn commands_reply(rig: &mut Rig) -> Option<protocol::events::CommandsMsg> {
    rig.messages().into_iter().find_map(|m| match m {
        BridgeToPhone::Commands(x) => Some(x),
        _ => None,
    })
}

#[test]
fn commands_are_asked_of_the_agent_or_the_phone_is_told_why_not() {
    let mut rig = Rig::new();
    let s = ready(&mut rig);
    rig.send(json!({"type":"commands-request","sessionId":s}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::ListCommands { .. }));
    assert!(matches!(msg, BridgeMessage::ListCommands { ref session_id } if *session_id == s));
    let compact = protocol::events::SlashCommand { name: "compact".into(), description: None, argument_hint: None };
    rig.host_reply(&id, HostMessage::Commands { commands: vec![compact.clone()] });
    let reply = commands_reply(&mut rig).expect("commands published");
    assert_eq!((reply.session_id.as_str(), reply.commands, reply.error), (s.as_str(), vec![compact], None));

    rig.send(json!({"type":"commands-request","sessionId":s}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::ListCommands { .. }));
    rig.host_reply(&id, HostMessage::Error { message: "boom".into() });
    assert!(commands_reply(&mut rig).and_then(|r| r.error).is_some_and(|e| e.contains("boom")));

    // An agent without commands, or an unknown session, is answered at once.
    let b = rig.ready_session("beta");
    rig.send(json!({"type":"commands-request","sessionId":b}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::ListCommands { .. })));
    assert!(commands_reply(&mut rig).is_some_and(|r| r.commands.is_empty() && r.error.is_some()));
    rig.send(json!({"type":"commands-request","sessionId":"nope"}));
    assert!(commands_reply(&mut rig).is_some_and(|r| r.error.is_some()));
}

#[test]
fn plugins_are_listed_and_changed_by_the_agent_host() {
    use protocol::common::{InstalledPlugin, PluginAction};
    let mut rig = Rig::new();
    rig.host_up();
    let plugin = InstalledPlugin {
        id: "c@m".into(),
        name: "c".into(),
        marketplace: Some("m".into()),
        version: None,
        description: None,
        enabled: true,
    };
    let plugins =
        || HostMessage::Plugins { installed: vec![plugin.clone()], marketplaces: Some(vec![]), toggles: true, available: None, message: None };

    rig.send(json!({"type":"plugins-request","agent":"alpha","available":true}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::ListPlugins { .. }));
    assert!(matches!(msg, BridgeMessage::ListPlugins { ref agent, available: true } if agent == "alpha"));
    rig.host_reply(&id, plugins());
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::Plugins(p) if p.installed.len() == 1 && p.error.is_none())));

    // Done: acknowledged, then the new list for every phone.
    rig.send(json!({"type":"plugin-action","agent":"alpha","action":"disable","target":" c@m "}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::PluginAction { .. }));
    assert!(matches!(msg, BridgeMessage::PluginAction { action: PluginAction::Disable, ref target, .. } if target == "c@m"));
    rig.host_reply(&id, plugins());
    let msgs = rig.messages();
    let ack = msgs.iter().position(|m| matches!(m, BridgeToPhone::PluginAck(a) if a.success && a.target == "c@m"));
    let list = msgs.iter().position(|m| matches!(m, BridgeToPhone::Plugins(_)));
    assert!(ack.is_some() && ack < list, "{msgs:?}");

    // A marketplace change comes with what was done and the fresh catalog;
    // the phone would otherwise keep showing the old one.
    rig.send(json!({"type":"plugin-action","agent":"alpha","action":"update-marketplace","target":"m"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::PluginAction { .. }));
    rig.host_reply(&id, HostMessage::Plugins {
        installed: vec![plugin.clone()],
        marketplaces: Some(vec![]),
        toggles: true,
        available: Some(vec![]),
        message: Some("Updated from 0.1.0 to 0.2.0.".into()),
    });
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::PluginAck(a) if a.success && a.message.as_deref() == Some("Updated from 0.1.0 to 0.2.0."))));
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::Plugins(p) if p.available.is_some())));

    // Refused by the agent: the reason goes back.
    rig.send(json!({"type":"plugin-action","agent":"alpha","action":"install","target":"nope@m"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::PluginAction { .. }));
    rig.host_reply(&id, HostMessage::Error { message: "Plugin nope not found".into() });
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::PluginAck(a) if !a.success && a.error.as_deref() == Some("Plugin nope not found"))));

    // A target that would read as an option, or an agent without plugins,
    // never reaches the host.
    rig.send(json!({"type":"plugin-action","agent":"alpha","action":"uninstall","target":"--prune"}));
    rig.send(json!({"type":"plugins-request","agent":"beta"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::PluginAction { .. } | BridgeMessage::ListPlugins { .. })));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::PluginAck(a) if !a.success && a.target == "--prune")));
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::Plugins(p) if p.agent == "beta" && p.error.is_some())));
}

#[test]
fn mcp_servers_are_managed_by_the_agent_host_and_never_echo_secrets() {
    use protocol::common::{McpAction, McpServerInfo, McpStatus, McpTransportKind, SessionMcpServer};
    let mut rig = Rig::new();
    rig.host_up();
    let listed = || HostMessage::McpServers {
        servers: vec![McpServerInfo {
            name: "github".into(),
            transport: McpTransportKind::Http,
            target: "https://api.githubcopilot.com/mcp/".into(),
            env_keys: vec![],
            header_keys: vec!["Authorization".into()],
            enabled: true,
        }],
        toggles: false,
    };

    rig.send(json!({"type":"mcp-request","agent":"alpha"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::ListMcp { agent } if agent == "alpha"));
    rig.host_reply(&id, listed());
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::McpServers(s) if s.servers.len() == 1 && s.error.is_none())));

    // Added: the host gets the values as secrets; the phones get an ack,
    // then the list — which names the header, never its value.
    rig.send(json!({"type":"mcp-action","agent":"alpha","action":"add","servers":[
        {"name":"github","transport":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ghp_secret"}}}]}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::McpAction { .. }));
    assert!(!format!("{msg:?}").contains("ghp_secret"), "a logged host request hides the token");
    match &msg {
        BridgeMessage::McpAction { action: McpAction::Add, servers, .. } => match &servers[0].setup {
            agent_protocol::McpServerSetup::Http { headers, .. } => assert_eq!(headers["Authorization"].expose(), "Bearer ghp_secret"),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    rig.host_reply(&id, listed());
    let msgs = rig.messages();
    let ack = msgs.iter().position(|m| matches!(m, BridgeToPhone::McpAck(a) if a.success && a.names == ["github"]));
    let list = msgs.iter().position(|m| matches!(m, BridgeToPhone::McpServers(_)));
    assert!(ack.is_some() && ack < list, "{msgs:?}");
    assert!(!format!("{msgs:?}").contains("ghp_secret"));

    // Refused before the host: a bad server, a bad name, an agent without MCP.
    rig.send(json!({"type":"mcp-action","agent":"alpha","action":"add","servers":[
        {"name":"x","transport":{"type":"http","url":"ftp://x"}}]}));
    rig.send(json!({"type":"mcp-action","agent":"alpha","action":"remove","names":["../etc"]}));
    rig.send(json!({"type":"mcp-request","agent":"beta"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::McpAction { .. } | BridgeMessage::ListMcp { .. })));
    let msgs = rig.messages();
    assert_eq!(msgs.iter().filter(|m| matches!(m, BridgeToPhone::McpAck(a) if !a.success)).count(), 2, "{msgs:?}");
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::McpServers(s) if s.agent == "beta" && s.error.is_some())));

    // A running session's servers, and a toggle answered by its new status.
    let s = rig.ready_session("alpha");
    rig.send(json!({"type":"session-mcp-toggle","sessionId":s,"name":"github","enabled":false}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::SessionMcpToggle { .. }));
    assert!(matches!(msg, BridgeMessage::SessionMcpToggle { enabled: false, ref name, .. } if name == "github"));
    rig.host_reply(&id, HostMessage::SessionMcp {
        servers: vec![SessionMcpServer { name: "github".into(), status: McpStatus::Disabled, error: None, tools: None }],
        toggles: true,
        project_wide: false,
    });
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::SessionMcp(x)
        if x.session_id == s && x.toggles && x.servers[0].status == McpStatus::Disabled)));

    // An unknown session is answered at once.
    rig.send(json!({"type":"session-mcp-request","sessionId":"nope"}));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::SessionMcp { .. })));
    assert!(rig.messages().iter().any(|m| matches!(m, BridgeToPhone::SessionMcp(x) if x.session_id == "nope" && x.error.is_some())));
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
    rig.host_reply(&id, HostMessage::Models { models: vec![protocol::events::ModelEntry { id: "m1".into(), ..Default::default() }], default_model: Some("m1".into()) });
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
            title: "git status && \\".into(),
            locations: vec![],
            input: Some("git status && \\\n  git commit -m x".into()),
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
