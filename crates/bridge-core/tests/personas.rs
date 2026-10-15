//! Personas: an agent's own named configurations a session runs as —
//! listed for a session or the whole machine, chosen when a session is
//! created, switched while it runs, and reported back by the agent.

mod support;

use agent_protocol::{BridgeMessage, HostMessage, SessionEvent};
use protocol::common::{Persona, SessionOption};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

/// The personas a batch of phone messages says were confirmed.
fn confirmed_personas(msgs: &[BridgeToPhone]) -> Vec<String> {
    msgs.iter()
        .filter_map(|m| match m {
            BridgeToPhone::OptionConfirmed(o) if o.option == SessionOption::Persona => Some(o.value.clone()),
            _ => None,
        })
        .collect()
}

/// The personas the session list in a batch says the session runs as.
fn listed_persona(msgs: &[BridgeToPhone]) -> Option<String> {
    last_heartbeat(msgs).sessions[0].persona.clone()
}

fn personas_reply(msgs: &[BridgeToPhone]) -> Option<protocol::events::PersonasMsg> {
    msgs.iter().find_map(|m| match m {
        BridgeToPhone::Personas(x) => Some(x.clone()),
        _ => None,
    })
}

fn info_persona(persona: &str) -> SessionEvent {
    SessionEvent::Info {
        native_session_id: None,
        model: None,
        mode: None,
        title: None,
        persona: Some(persona.into()),
        context_window: None,
        context_percentage: None,
    }
}

/// Send a `set-option` and return the host frame it produced, if any.
fn set_option(rig: &mut Rig, s: &str, option: &str, value: &str) -> Option<(String, BridgeMessage)> {
    rig.send(json!({"v":12,"type":"set-option","sessionId":s,"option":option,"value":value}));
    rig.host_frames()
        .into_iter()
        .find(|f| matches!(f.message, BridgeMessage::SetOption { .. }))
        .map(|f| (f.id.unwrap_or_default(), f.message))
}

#[test]
fn personas_are_asked_of_the_agent_or_the_phone_is_told_why_not() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    let p = rig.ready_session("persona");

    let list = vec![
        Persona { id: "build".into(), label: "Build".into(), description: None, color: None },
        Persona {
            id: "review".into(),
            label: "review".into(),
            description: Some("Reviews code".into()),
            color: Some("#E5C07B".into()),
        },
    ];
    rig.send(json!({"v":12,"type":"personas-request","agent":"persona","sessionId":p}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::ListPersonas { .. }));
    assert!(matches!(msg, BridgeMessage::ListPersonas { ref session_id, .. } if session_id.as_deref() == Some(p.as_str())));
    rig.host_reply(&id, HostMessage::Personas { personas: list.clone() });
    let reply = personas_reply(&rig.messages()).expect("personas published");
    assert_eq!(
        (reply.agent.as_str(), reply.session_id.as_deref(), reply.personas, reply.error),
        ("persona", Some(p.as_str()), list, None)
    );

    // Without a session the whole machine's personas are asked for, and an
    // empty answer is a reason, not silence.
    rig.send(json!({"v":12,"type":"personas-request","agent":"persona"}));
    let (id, msg) = rig.host_request(|m| matches!(m, BridgeMessage::ListPersonas { .. }));
    assert!(matches!(msg, BridgeMessage::ListPersonas { session_id: None, .. }));
    rig.host_reply(&id, HostMessage::Personas { personas: vec![] });
    assert!(personas_reply(&rig.messages()).and_then(|r| r.error).is_some_and(|e| e.contains("lists no personas")));

    // A host that could not answer carries its reason.
    rig.send(json!({"v":12,"type":"personas-request","agent":"persona"}));
    let (id, _) = rig.host_request(|m| matches!(m, BridgeMessage::ListPersonas { .. }));
    rig.host_reply(&id, HostMessage::Error { message: "boom".into() });
    assert!(personas_reply(&rig.messages()).and_then(|r| r.error).is_some_and(|e| e.contains("Could not list the personas: boom")));
}

#[test]
fn a_personas_request_the_agent_or_session_cannot_answer_never_reaches_the_host() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    let a = rig.ready_session("alpha");
    let ended = rig.ready_session("persona");
    rig.host_event(&ended, SessionEvent::Ended { error: None, resume_lost: false });

    // (agent, sessionId, a word from the reason)
    let cases: [(&str, Option<&str>, &str); 5] = [
        ("alpha", None, "has no personas"),
        ("ghost", None, "no agent"),
        ("persona", Some("nope"), "no such session"),
        ("persona", Some(a.as_str()), "does not run on"),
        ("persona", Some(ended.as_str()), "not running"),
    ];
    for (agent, session, needle) in cases {
        let mut m = json!({"v":12,"type":"personas-request","agent":agent});
        if let Some(session) = session {
            m["sessionId"] = json!(session);
        }
        rig.send(m);
        assert!(!rig.has_host_request(|x| matches!(x, BridgeMessage::ListPersonas { .. })), "{agent}/{session:?}");
        let reply = personas_reply(&rig.messages()).unwrap_or_else(|| panic!("{agent}/{session:?} was answered at once"));
        assert!(reply.personas.is_empty(), "{agent}/{session:?}");
        assert!(reply.error.as_deref().is_some_and(|e| e.contains(needle)), "{agent}/{session:?}: {:?}", reply.error);
    }
}

#[test]
fn a_session_created_with_a_persona_starts_as_it_and_is_listed_once_the_agent_says() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    rig.send(json!({"v":12,"type":"create-session","agent":"persona","persona":"review"}));
    let (id, params) = rig.start_request();
    assert_eq!(params.persona.as_deref(), Some("review"));
    rig.host_reply(&id, HostMessage::Ack);
    rig.host_event(&params.session_id, SessionEvent::Ready {});
    // The agent has not said which persona runs yet: nothing is recorded.
    let msgs = rig.messages();
    assert_eq!(listed_persona(&msgs), None);
    assert_eq!(confirmed_personas(&msgs), Vec::<String>::new());

    rig.host_event(&params.session_id, info_persona("review"));
    let msgs = rig.messages();
    assert_eq!(confirmed_personas(&msgs), ["review"]);
    assert_eq!(listed_persona(&msgs).as_deref(), Some("review"));

    // A later restart resumes as the persona the agent reported.
    rig.host_event(&params.session_id, SessionEvent::Ended { error: Some("boom".into()), resume_lost: false });
    let (_, params) = rig.start_request();
    assert_eq!(params.persona.as_deref(), Some("review"));
}

#[test]
fn a_persona_the_agent_does_not_have_leaves_the_session_on_the_default_it_reports() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    rig.send(json!({"v":12,"type":"create-session","agent":"persona","persona":"gone"}));
    let (id, params) = rig.start_request();
    assert_eq!(params.persona.as_deref(), Some("gone"));
    rig.host_reply(&id, HostMessage::Ack);
    // The agent fell back to its own default and said so.
    rig.host_event(&params.session_id, SessionEvent::Ready {});
    rig.host_event(&params.session_id, info_persona("build"));
    let msgs = rig.messages();
    assert_eq!(confirmed_personas(&msgs), ["build"]);
    assert_eq!(listed_persona(&msgs).as_deref(), Some("build"));
    // The request is spent: a restart carries the persona in force.
    rig.host_event(&params.session_id, SessionEvent::Ended { error: Some("boom".into()), resume_lost: false });
    let (_, params) = rig.start_request();
    assert_eq!(params.persona.as_deref(), Some("build"));
}

#[test]
fn a_persona_on_an_agent_without_them_is_ignored() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.send(json!({"v":12,"type":"create-session","agent":"alpha","persona":"review"}));
    let (_, params) = rig.start_request();
    assert_eq!(params.persona, None);
}

#[test]
fn set_option_switches_the_persona_only_for_an_agent_that_has_them() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    let p = rig.ready_session("persona");

    let (id, msg) = set_option(&mut rig, &p, "persona", "review").expect("forwarded to the host");
    assert!(matches!(msg, BridgeMessage::SetOption { option: SessionOption::Persona, ref value, .. } if value == "review"));
    rig.host_reply(&id, HostMessage::Ack);
    let msgs = rig.messages();
    assert_eq!(confirmed_personas(&msgs), ["review"]);
    assert_eq!(listed_persona(&msgs).as_deref(), Some("review"));

    // A persona the agent refuses confirms nothing: the phone keeps what it
    // knew, and the list still shows the persona in force.
    let (id, _) = set_option(&mut rig, &p, "persona", "nope").expect("forwarded");
    rig.host_reply(&id, HostMessage::Error { message: "no such agent".into() });
    assert!(rig.messages().is_empty(), "a refused persona publishes nothing");

    // An agent without personas refuses it here: the host never hears of it.
    let a = rig.ready_session("alpha");
    assert_eq!(set_option(&mut rig, &a, "persona", "review"), None);
}

#[test]
fn the_agent_catalog_advertises_which_persona_is_the_default() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![persona(), alpha()]);
    let agents = last_heartbeat(&rig.messages()).agents;
    let p = agents.iter().find(|a| a.id == "persona").expect("the persona agent is listed");
    assert!(p.supports.personas);
    assert_eq!(p.default_persona.as_deref(), Some("build"));
    assert_eq!(agents.iter().find(|a| a.id == "alpha").expect("alpha listed").default_persona, None);
}

#[test]
fn the_agent_switching_its_own_persona_reaches_the_phone_like_a_mode() {
    let mut rig = Rig::new();
    rig.host_up_with(vec![alpha(), persona()]);
    let p = rig.ready_session("persona");

    rig.host_event(&p, info_persona("build"));
    let msgs = rig.messages();
    assert_eq!(confirmed_personas(&msgs), ["build"]);
    assert_eq!(listed_persona(&msgs).as_deref(), Some("build"));

    // The same persona again is not a change.
    rig.host_event(&p, info_persona("build"));
    assert_eq!(confirmed_personas(&rig.messages()), Vec::<String>::new());

    rig.host_event(&p, info_persona("review"));
    let msgs = rig.messages();
    assert_eq!(confirmed_personas(&msgs), ["review"]);
    assert_eq!(listed_persona(&msgs).as_deref(), Some("review"));
}
