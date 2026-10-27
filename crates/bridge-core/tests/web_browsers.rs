//! Listing and ending the browsers signed in to the bridge's web page, through
//! the engine: the phone asks, and the runtime's page — which alone holds the
//! list — answers. The engine only turns each command into the effect that
//! names the asking client.

mod support;

use bridge_core::{Effect, Via};
use protocol::crypto::generate_keypair;
use serde_json::json;
use support::*;

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
