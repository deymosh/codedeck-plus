//! The effect buffer every part of the engine writes into, and the record of
//! which timer is for what.

use std::collections::BTreeMap;

use agent_protocol::{BridgeFrame, BridgeMessage, Frame};
use protocol::events::BridgeToPhone;

use crate::io::{Effect, TimerId};

/// What an armed timer is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TimerKind {
    Heartbeat,
    GitPoll,
    Retention,
    /// A permission / question / plan card waiting too long.
    Card { session_id: String, request_id: String },
    SyncAck(String),
    SyncIdle(String),
    PairingExpiry { epoch: u64 },
}

#[derive(Default)]
pub(crate) struct Out {
    pub effects: Vec<Effect>,
    pub timers: BTreeMap<TimerId, TimerKind>,
    delays: BTreeMap<TimerId, u64>,
    next_timer: u64,
}

impl Out {
    pub fn push(&mut self, effect: Effect) {
        self.effects.push(effect);
    }

    pub fn publish(&mut self, to: Vec<String>, message: BridgeToPhone) {
        if !to.is_empty() {
            self.effects.push(Effect::Publish { to, message });
        }
    }

    pub fn host(&mut self, id: Option<String>, message: BridgeMessage) {
        let frame: BridgeFrame = match id {
            Some(id) => Frame::request(id, message),
            None => Frame::notification(message),
        };
        self.effects.push(Effect::Host(frame));
    }

    pub fn set_timer(&mut self, after_ms: u64, kind: TimerKind) -> TimerId {
        self.next_timer += 1;
        let id = TimerId(self.next_timer);
        self.timers.insert(id, kind);
        self.delays.insert(id, after_ms);
        self.effects.push(Effect::SetTimer { id, after_ms });
        id
    }

    pub fn cancel_timer(&mut self, id: TimerId) {
        if self.timers.remove(&id).is_some() {
            self.delays.remove(&id);
            self.effects.push(Effect::CancelTimer(id));
        }
    }

    /// A timer fired: forget it and say what it was for (None = cancelled
    /// already, or not ours).
    pub fn take_timer(&mut self, id: TimerId) -> Option<TimerKind> {
        self.delays.remove(&id);
        self.timers.remove(&id)
    }

    /// The delay a still-armed timer was set with.
    #[cfg(test)]
    pub fn delay_of(&self, id: TimerId) -> u64 {
        self.delays[&id]
    }
}
