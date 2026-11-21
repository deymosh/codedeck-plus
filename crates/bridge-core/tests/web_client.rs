//! A browser on the bridge's web page as a client of the identity that let it
//! in: what it may send, what it gets, and what ends it. The runtime has
//! already checked each command's signature; the engine decides what a
//! browser's command may do.

mod support;

use agent_protocol::{BridgeMessage, SessionEvent};
use bridge_core::{Addressee, Effect, Input};
use protocol::commands::PhoneToBridge;
use protocol::common::PartialKind;
use protocol::events::BridgeToPhone;
use serde_json::{json, Value};
use support::*;

const BROWSER: &str = "0123456789abcdef";
const OTHER_BROWSER: &str = "fedcba9876543210";

fn command(msg: Value) -> Box<PhoneToBridge> {
    let mut msg = msg;
    msg["v"] = json!(protocol::capabilities::PROTOCOL_VERSION);
    Box::new(serde_json::from_value(msg).expect("a command"))
}

/// A browser `id` of the rig's phone, with its stream open.
fn online(rig: &mut Rig, id: &str) {
    let by = rig.phone.npub.clone();
    rig.input(Input::WebBrowserOnline { id: id.into(), by });
}

/// A command from browser `id`, let in by the rig's phone; its effects.
fn from_browser(rig: &mut Rig, id: &str, msg: Value) -> Vec<Effect> {
    rig.take();
    let by = rig.phone.npub.clone();
    rig.input(Input::WebCommand { id: id.into(), by, msg: command(msg) });
    rig.take()
}

/// Every publish's addressees, with the message.
fn publishes(effects: &[Effect]) -> Vec<(Vec<Addressee>, BridgeToPhone)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Publish { to, message } => Some((to.clone(), message.clone())),
            _ => None,
        })
        .collect()
}

fn to_browser(rig: &Rig, id: &str) -> Addressee {
    Addressee::browser(&rig.phone.pubkey_hex, id)
}

#[test]
fn a_browser_online_gets_a_heartbeat_of_its_own() {
    let mut rig = Rig::new();
    rig.take();
    online(&mut rig, BROWSER);
    let sent = publishes(&rig.take());
    assert!(
        sent.iter().any(|(to, m)| matches!(m, BridgeToPhone::Sessions(_)) && to.contains(&to_browser(&rig, BROWSER))),
        "{sent:#?}"
    );
}

#[test]
fn a_browser_drives_a_session_as_its_identity() {
    let mut rig = Rig::new();
    rig.host_up();
    online(&mut rig, BROWSER);
    rig.take();
    let by = rig.phone.npub.clone();
    rig.input(Input::WebCommand { id: BROWSER.into(), by, msg: command(json!({"type":"create-session","agent":"alpha"})) });
    let (id, params) = rig.start_request();
    rig.host_reply(&id, agent_protocol::HostMessage::Ack);
    rig.host_event(&params.session_id, SessionEvent::Ready {});
    rig.take();

    let effects = from_browser(&mut rig, BROWSER, json!({"type":"input","sessionId":params.session_id,"text":"hi","inputId":"i1"}));
    assert!(
        effects.iter().any(|e| matches!(e, Effect::Host(f) if matches!(&f.message, BridgeMessage::Prompt { .. }))),
        "the input reached the agent: {effects:#?}"
    );
    let acks: Vec<_> = publishes(&effects).into_iter().filter(|(_, m)| matches!(m, BridgeToPhone::InputAck(_))).collect();
    assert!(acks.iter().any(|(to, _)| to.contains(&to_browser(&rig, BROWSER))), "the browser hears its ack: {acks:#?}");
}

#[test]
fn a_reply_goes_to_the_asking_browser_alone() {
    let mut rig = Rig::new();
    online(&mut rig, BROWSER);
    online(&mut rig, OTHER_BROWSER);
    let sent = publishes(&from_browser(&mut rig, BROWSER, json!({"type":"refresh-sessions"})));
    let lists: Vec<_> = sent.into_iter().filter(|(_, m)| matches!(m, BridgeToPhone::Sessions(_))).collect();
    assert_eq!(lists.len(), 1, "{lists:#?}");
    assert_eq!(lists[0].0, vec![to_browser(&rig, BROWSER)]);
}

#[test]
fn a_command_a_browser_may_not_send_does_nothing() {
    let mut rig = Rig::new();
    rig.input(Input::WebSignInPending { code: "K7QM-4XPA".into(), expires_ms: T0 + 60_000 });
    online(&mut rig, BROWSER);
    for msg in [
        json!({"type":"web-sign-in","code":"K7QM-4XPA"}),
        json!({"type":"set-credentials","agent":"alpha","values":{"anthropic_api_key":"sk-ant-x"}}),
        json!({"type":"mcp-action","agent":"alpha","action":"remove","names":["github"]}),
        json!({"type":"terminal-open","openId":"o1","cols":80,"rows":24}),
        // A file from a URL: the bridge would download whatever a page names.
        json!({"type":"upload-file","sessionId":"s1","hash":"00","url":"https://blossom.example/00","key":"k","iv":"i",
               "filename":"a.png","mimeType":"image/png","text":"","sizeBytes":1}),
    ] {
        let Ok(parsed) = serde_json::from_value::<PhoneToBridge>({
            let mut m = msg.clone();
            m["v"] = json!(protocol::capabilities::PROTOCOL_VERSION);
            m
        }) else {
            panic!("not a command: {msg}")
        };
        assert!(!bridge_core::browser_may_send(&parsed), "{msg}");
        let effects = from_browser(&mut rig, BROWSER, msg.clone());
        assert!(effects.is_empty(), "{msg} did something: {effects:#?}");
    }
}

#[test]
fn a_browser_attaches_a_file_in_chunks() {
    let mut rig = Rig::new();
    rig.host_up();
    let session = rig.ready_session("alpha");
    online(&mut rig, BROWSER);
    let chunk = json!({"type":"upload-file","sessionId":session,"uploadId":"u1","filename":"notes.md","mimeType":"text/markdown",
                       "base64Data":"aGk=","text":"read this","chunkIndex":0,"totalChunks":1});
    let effects = from_browser(&mut rig, BROWSER, chunk);
    assert!(
        effects.iter().any(|e| matches!(e, Effect::HandleFileUpload(protocol::commands::UploadFileMsg::Chunk(c)) if c.upload_id == "u1")),
        "the chunk went to the runtime: {effects:#?}"
    );
}

#[test]
fn live_text_reaches_only_a_browser_watching_that_session() {
    let mut rig = Rig::new();
    rig.host_up();
    let s1 = rig.ready_session("alpha");
    let s2 = rig.ready_session("alpha");
    online(&mut rig, BROWSER);
    online(&mut rig, OTHER_BROWSER);
    from_browser(&mut rig, BROWSER, json!({"type":"presence","watching":s1}));
    from_browser(&mut rig, OTHER_BROWSER, json!({"type":"presence","watching":s2}));
    rig.take();

    let partial = SessionEvent::Partial { key: "p1".into(), entry_type: PartialKind::Text, subagent: None, offset: 0, text: "x".into() };
    rig.host_event(&s1, partial);
    let to: Vec<Addressee> = publishes(&rig.take())
        .into_iter()
        .filter(|(_, m)| matches!(m, BridgeToPhone::Partial(_)))
        .flat_map(|(to, _)| to)
        .filter(|a| a.browser_id().is_some())
        .collect();
    assert_eq!(to, vec![to_browser(&rig, BROWSER)]);
}

#[test]
fn a_browser_offline_gets_nothing() {
    let mut rig = Rig::new();
    online(&mut rig, BROWSER);
    rig.input(Input::WebBrowserOffline { id: BROWSER.into() });
    rig.take();
    rig.input(Input::WorkspaceChanged);
    let sent = publishes(&rig.take());
    assert!(!sent.is_empty(), "a heartbeat went out");
    assert!(sent.iter().all(|(to, _)| to.iter().all(|a| a.browser_id().is_none())), "{sent:#?}");
}

#[test]
fn unpairing_ends_the_browsers_it_let_in() {
    let mut rig = Rig::new();
    online(&mut rig, BROWSER);
    rig.take();
    let identity = rig.phone.pubkey_hex.clone();
    rig.input(Input::Unpaired { identity });
    let npub = rig.phone.npub.clone();
    assert!(rig.take().iter().any(|e| matches!(e, Effect::WebEndBrowsers { by } if *by == npub)));

    // A command still in flight from one of them does nothing but end them.
    let effects = from_browser(&mut rig, BROWSER, json!({"type":"refresh-sessions"}));
    assert!(effects.iter().all(|e| matches!(e, Effect::WebEndBrowsers { .. })), "{effects:#?}");
    assert!(!effects.is_empty());
}
