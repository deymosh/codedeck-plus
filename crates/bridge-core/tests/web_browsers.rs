//! Listing and ending the browsers signed in to the bridge's web page, through
//! the engine: the phone asks, and the runtime's page — which alone holds the
//! list — answers. The engine only turns each command into the effect that
//! names the asking client.

mod support;

use bridge_core::{Effect, Via};
use protocol::crypto::generate_keypair;
use serde_json::json;
use support::*;

/// The client a `web-browsers-request` asked the runtime to answer, if any.
fn requested(rig: &mut Rig) -> Option<Vec<String>> {
    rig.send(json!({"v":12,"type":"web-browsers-request"}));
    rig.take().into_iter().find_map(|e| match e {
        Effect::WebBrowsers { client } => Some(vec![client.phone]),
        _ => None,
    })
}

#[test]
fn a_request_asks_the_runtime_for_the_list_for_the_asking_client() {
    let mut rig = Rig::new();
    let phone = rig.phone.pubkey_hex.clone();
    assert_eq!(requested(&mut rig), Some(vec![phone]));
}

#[test]
fn a_sign_out_names_the_browser_for_the_runtime_to_end() {
    let mut rig = Rig::new();
    let phone = rig.phone.pubkey_hex.clone();
    rig.send(json!({"v":12,"type":"web-browser-sign-out","id":"0123456789abcdef"}));
    let (id, to) = rig
        .take()
        .into_iter()
        .find_map(|e| match e {
            Effect::WebBrowserSignOut { id, client } => Some((id, vec![client.phone])),
            _ => None,
        })
        .expect("a sign-out effect");
    assert_eq!(id, "0123456789abcdef");
    assert_eq!(to, vec![phone]);
}

#[test]
fn an_unpaired_identity_gets_no_list_and_ends_no_browser() {
    let mut rig = Rig::new();
    let stranger = generate_keypair();
    rig.phone_event(&stranger, json!({"v":12,"type":"web-browsers-request"}), Via::Relay);
    rig.phone_event(&stranger, json!({"v":12,"type":"web-browser-sign-out","id":"0123456789abcdef"}), Via::Relay);
    assert!(
        rig.take().iter().all(|e| !matches!(e, Effect::WebBrowsers { .. } | Effect::WebBrowserSignOut { .. })),
        "a stranger's commands reach no page"
    );
}
