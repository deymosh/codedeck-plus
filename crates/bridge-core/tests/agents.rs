//! Agents that are not on the machine: listed with their install state,
//! installed and removed when the phone asks, and the sessions that wait
//! for an install.

mod support;

use agent_protocol::{AgentInfo, BridgeMessage, Frame, HostMessage};
use bridge_core::Input;
use protocol::common::{AgentInstall, AgentSupports};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

/// "omega" as a host reports it before it is installed: a name and a state.
fn omega(install: AgentInstall) -> AgentInfo {
    AgentInfo {
        id: "omega".into(),
        display_name: "Omega".into(),
        modes: vec![],
        efforts: vec![],
        default_mode: None,
        default_effort: None,
        supports: AgentSupports::default(),
        credentials: vec![],
        unavailable_reason: None,
        install,
    }
}

/// "omega" once installed: everything a driver reports.
fn omega_ready() -> AgentInfo {
    AgentInfo { id: "omega".into(), display_name: "Omega".into(), install: AgentInstall::Ready { removable: true }, ..beta() }
}

fn agent_changed(rig: &mut Rig, agent: AgentInfo) {
    rig.input(Input::HostFrame(Frame::notification(HostMessage::AgentChanged { agent })));
}

fn listed_install(msgs: &[BridgeToPhone], id: &str) -> AgentInstall {
    last_heartbeat(msgs).agents.into_iter().find(|a| a.id == id).expect("the agent is listed").install
}

fn agent_ack(msgs: &[BridgeToPhone]) -> (bool, Option<String>) {
    msgs.iter()
        .find_map(|m| match m {
            BridgeToPhone::AgentAck(a) => Some((a.success, a.error.clone())),
            _ => None,
        })
        .expect("an agent-ack")
}

#[test]
fn an_agent_not_installed_is_listed_and_runs_no_session() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), omega(AgentInstall::NotInstalled {})]);
    rig.advance(1_000);
    assert_eq!(listed_install(&rig.messages(), "omega"), AgentInstall::NotInstalled {});

    rig.send(json!({"v":11,"type":"create-session","agent":"omega"}));
    let msgs = rig.messages();
    assert!(msgs.iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.reason.contains("Omega is not installed"))), "{msgs:?}");
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
}

#[test]
fn installing_an_agent_shows_its_progress_then_runs_sessions() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), omega(AgentInstall::NotInstalled {})]);
    rig.take();

    rig.send(json!({"v":11,"type":"agent-action","agent":"omega","action":"install"}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::InstallAgent { .. }));
    assert_eq!(msg, BridgeMessage::InstallAgent { agent: "omega".into() });
    rig.host_reply(&id, HostMessage::Ack);
    assert_eq!(agent_ack(&rig.messages()), (true, None));

    agent_changed(&mut rig, omega(AgentInstall::Installing {}));
    rig.advance(1_000);
    assert_eq!(listed_install(&rig.messages(), "omega"), AgentInstall::Installing {});

    agent_changed(&mut rig, omega_ready());
    rig.advance(1_000);
    let msgs = rig.messages();
    assert_eq!(listed_install(&msgs, "omega"), AgentInstall::Ready { removable: true });
    assert!(last_heartbeat(&msgs).agents.iter().any(|a| a.id == "omega" && a.modes.len() == 1));
    rig.ready_session("omega");
}

#[test]
fn a_session_waits_while_its_agent_installs() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), omega_ready()]);
    let s = rig.ready_session("omega");

    // The host comes back with the agent being installed again (its files
    // were gone): the session's restart waits for it rather than fail.
    rig.input(Input::HostDown { reason: "exit 1".into() });
    rig.host_up_with(vec![alpha(), omega(AgentInstall::Installing {})]);
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));

    agent_changed(&mut rig, omega_ready());
    let (_, params) = rig.start_request();
    assert_eq!(params.session_id, s);
}

#[test]
fn a_waiting_session_fails_when_the_install_does() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), omega_ready()]);
    rig.ready_session("omega");
    rig.input(Input::HostDown { reason: "exit 1".into() });
    rig.host_up_with(vec![alpha(), omega(AgentInstall::Installing {})]);
    rig.take();

    agent_changed(&mut rig, omega(AgentInstall::Failed { reason: "HTTP 503".into() }));
    assert!(!rig.has_host_request(|m| matches!(m, BridgeMessage::StartSession(_))));
    let msgs = rig.messages();
    let texts: Vec<String> = outputs(&msgs).into_iter().map(|(_, e)| format!("{:?}", e.body)).collect();
    assert!(texts.iter().any(|t| t.contains("Omega could not be installed: HTTP 503")), "{texts:?}");
}

#[test]
fn a_refused_removal_is_reported_with_the_reason() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), omega_ready()]);
    rig.take();
    rig.send(json!({"v":11,"type":"agent-action","agent":"alpha","action":"remove"}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::RemoveAgent { .. }));
    assert_eq!(msg, BridgeMessage::RemoveAgent { agent: "alpha".into() });
    rig.host_reply(&id, HostMessage::Error { message: "Alpha is on this machine outside CodeDeck.".into() });
    assert_eq!(agent_ack(&rig.messages()), (false, Some("Alpha is on this machine outside CodeDeck.".into())));
}

#[test]
fn an_agent_action_without_a_host_is_refused() {
    let mut rig = Rig::new();
    rig.send(json!({"v":11,"type":"agent-action","agent":"omega","action":"install"}));
    let (success, error) = agent_ack(&rig.messages());
    assert!(!success);
    assert!(error.unwrap().contains("not running yet"));

    rig.host_up_with(vec![alpha(), omega(AgentInstall::NotInstalled {})]);
    rig.send(json!({"v":11,"type":"agent-action","agent":"omega","action":"install"}));
    rig.take();
    rig.input(Input::HostDown { reason: "exit 1".into() });
    let (success, error) = agent_ack(&rig.messages());
    assert!(!success);
    assert!(error.unwrap().contains("stopped"));
}
