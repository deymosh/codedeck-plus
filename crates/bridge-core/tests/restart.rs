//! What a bridge restart must not lose or repeat: a command the relay
//! replays into a bridge that came back, and a session the phone was told was
//! being created when the bridge went away.

mod support;

use bridge_core::{InboundEvent, Input, Via};
use protocol::events::BridgeToPhone;
use serde_json::json;
use support::*;

/// A create command, so a second run shows up as a second `session-pending`.
fn create_session(rig: &mut Rig) -> InboundEvent {
    let phone = rig.phone.clone();
    rig.phone_event(&phone, json!({"v":12,"type":"create-session","agent":"alpha"}), Via::Relay)
}

fn pending_ids(msgs: &[BridgeToPhone]) -> Vec<String> {
    msgs.iter()
        .filter_map(|m| match m {
            BridgeToPhone::SessionPending(p) => Some(p.pending_id.clone()),
            _ => None,
        })
        .collect()
}

/// The engine persists the ingest cursor on its heartbeat, not per command,
/// so a crash between a command and the next heartbeat must still leave the
/// id durable: the relay's `since` replay would otherwise run it again.
#[test]
fn a_command_is_not_run_twice_when_the_bridge_restarts_before_a_heartbeat() {
    let mut rig = Rig::with(RigOptions {
        configure: |c| {
            c.heartbeat_interval_ms = 1_000;
            c.git_poll_interval_ms = 0;
            c.retention_interval_ms = 0;
        },
        ..Default::default()
    });
    rig.host_up();
    rig.take();

    let event = create_session(&mut rig);
    assert_eq!(pending_ids(&rig.messages()).len(), 1, "the command ran once before the restart");

    // A crash: no shutdown and no heartbeat since the command.
    let mut rig = rig.restart();
    rig.take();
    rig.input(Input::RelayEvent { event, via: Via::Relay });
    assert_eq!(
        pending_ids(&rig.messages()),
        Vec::<String>::new(),
        "the relay's replay of an already-run command must create no second session"
    );
}

/// The same replay after a heartbeat, whose cursor flush is what makes the
/// id durable today; the two paths must agree.
#[test]
fn a_command_is_not_run_twice_when_the_bridge_restarts_after_a_heartbeat() {
    let mut rig = Rig::with(RigOptions {
        configure: |c| {
            c.heartbeat_interval_ms = 1_000;
            c.git_poll_interval_ms = 0;
            c.retention_interval_ms = 0;
        },
        ..Default::default()
    });
    rig.host_up();
    rig.take();

    let event = create_session(&mut rig);
    assert_eq!(pending_ids(&rig.messages()).len(), 1, "the command ran once");

    rig.advance(1_000);
    assert_eq!(rig.store.snapshot().get("processedEventIds").map(|ids| ids.contains(&event.id)), Some(true), "the heartbeat stored the id");

    let mut rig = rig.restart();
    rig.take();
    rig.input(Input::RelayEvent { event, via: Via::Relay });
    assert_eq!(pending_ids(&rig.messages()), Vec::<String>::new(), "the heartbeat's stored id dedups the replay");
}
