//! Signing a browser in to the bridge's web page, through the engine: the
//! page's code is let in once, only by a paired phone, only before it lapses.

mod support;

use bridge_core::{Effect, Input};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

/// The page shows `code` for five minutes.
fn show(rig: &mut Rig, code: &str) {
    let expires_ms = rig.system_now() + 5 * 60 * 1000;
    rig.input(Input::WebSignInPending { code: code.into(), expires_ms });
    rig.take();
}

/// What the engine did with one `web-sign-in`: the browser it let in (by
/// its code), and the answer the phone got (code as echoed, signed in).
fn sign_in(rig: &mut Rig, sent: &str) -> (Option<String>, Option<(String, bool)>) {
    rig.send(json!({"v":12,"type":"web-sign-in","code":sent}));
    let effects = rig.take();
    let let_in = effects.iter().find_map(|e| match e {
        Effect::WebSignedIn { code, .. } => Some(code.clone()),
        _ => None,
    });
    let answer = effects.iter().find_map(|e| match e {
        Effect::Publish { message: BridgeToPhone::WebSignInResult(r), .. } => Some((r.code.clone(), r.signed_in)),
        _ => None,
    });
    (let_in, answer)
}

#[test]
fn a_code_the_page_shows_signs_its_browser_in_once() {
    let mut rig = Rig::new();
    show(&mut rig, "K7QM-4XPA");
    assert_eq!(sign_in(&mut rig, "K7QM-4XPA"), (Some("K7QM-4XPA".into()), Some(("K7QM-4XPA".into(), true))));
    assert_eq!(sign_in(&mut rig, "K7QM-4XPA"), (None, Some(("K7QM-4XPA".into(), false))), "used up");
}

#[test]
fn a_typed_code_matches_in_any_case_and_its_answer_echoes_what_was_typed() {
    let mut rig = Rig::new();
    show(&mut rig, "K7QM-4XPA");
    // The phone matches the answer to the code it sent, so the echo is the
    // phone's own spelling, not the page's.
    assert_eq!(sign_in(&mut rig, "k7qm4xpa"), (Some("K7QM-4XPA".into()), Some(("k7qm4xpa".into(), true))));
}

#[test]
fn a_lapsed_or_unknown_code_signs_nothing_in() {
    let mut rig = Rig::new();
    show(&mut rig, "K7QM-4XPA");
    assert_eq!(sign_in(&mut rig, "AAAA-BBBB"), (None, Some(("AAAA-BBBB".into(), false))));
    rig.advance(5 * 60 * 1000 + 1);
    rig.take();
    assert_eq!(sign_in(&mut rig, "K7QM-4XPA"), (None, Some(("K7QM-4XPA".into(), false))), "lapsed");
}
