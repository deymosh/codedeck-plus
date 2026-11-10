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

/// The relay replays from the cursor minus a five-second grace after a
/// reconnect, so a command the bridge already ran reaches it again once it
/// is back. A restart before the next heartbeat must not lose the id it was
/// remembered under: the replay would create a second session.
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

/// The same replay when a heartbeat also ran before the restart and stored
/// the cursor; the two paths must agree.
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

/// A session the phone asked for is not in the registry until the agent
/// answers (`listed` turns true at `session-ready`), and a restart before
/// that answer ends its creation. The phone was already shown a placeholder,
/// so it must be told — not left to its own ten-minute sweep.
#[test]
fn a_create_pending_at_a_restart_is_answered_not_lost() {
    let mut rig = Rig::new();
    rig.host_up();
    rig.take();
    rig.send(json!({"v":12,"type":"create-session","agent":"alpha"}));
    let pending = pending_ids(&rig.messages()).pop().expect("the phone saw session-pending");
    let registry: serde_json::Value = serde_json::from_str(&rig.store.snapshot()["registry"]).expect("the registry is JSON");
    assert!(
        !registry["sessions"].as_array().expect("sessions").iter().any(|s| s["sessionId"] == pending.as_str()),
        "a pending session is deliberately not listed in the registry"
    );

    // A crash and restart before the agent ever answered.
    let mut rig = rig.restart();
    rig.take();
    rig.host_up();
    rig.advance(60_000);
    let msgs = rig.messages();
    // The placeholder resolves only through session-failed: an id that
    // merely showed up in a list or a tombstone would leave it waiting.
    assert!(
        msgs.iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.pending_id == pending)),
        "the phone was told nothing about pending session {pending}: it saw session-pending before the restart"
    );

    // Answered once: a later restart does not answer it again.
    let mut rig = rig.restart();
    rig.take();
    rig.advance(60_000);
    assert!(
        !rig.messages().iter().any(|m| matches!(m, BridgeToPhone::SessionFailed(f) if f.pending_id == pending)),
        "pending session {pending} was answered again after a second restart"
    );
}
