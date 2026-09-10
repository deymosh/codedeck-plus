//! Mode cycle controller (CDX-046) — the tappable PLAN → YOLO → EDITS button.
//! Port of `apps/mobile/src/core/modeCycle.ts` (framework-free; the revert
//! timer is a runtime seam via [`ModeCycleEffect`]).
//!
//! - tap cycles `plan → default → acceptEdits → plan` and sends the change;
//! - a 600 ms cooldown between taps;
//! - while awaiting confirmation the button shows the REQUESTED mode;
//! - no confirmation within ~8 s → the display reverts to the last CONFIRMED
//!   mode (the request may have been lost; the button must not lie).

use crate::wire::common::PermissionMode;

/// Legacy cycle order.
pub const MODE_CYCLE: [PermissionMode; 3] = [
    PermissionMode::Plan,
    PermissionMode::Default,
    PermissionMode::AcceptEdits,
];

/// Legacy display labels (compacted for the box).
pub fn mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "PLAN",
        PermissionMode::Default => "YOLO",
        PermissionMode::AcceptEdits => "EDITS",
    }
}

pub const MODE_TAP_COOLDOWN_MS: u64 = 600;
pub const MODE_CONFIRM_TIMEOUT_MS: u64 = 8_000;

/// What a `tap` / `note_confirmed` asks the runtime to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModeCycleEffect {
    /// Send the mode command to the bridge.
    Send(PermissionMode),
    /// (Re)arm the revert timer — only the LATEST request's outcome decides the
    /// display. Fire [`ModeCycle::revert_fired`] when it elapses.
    ArmRevertTimer { ms: u64 },
    /// Cancel a pending revert timer.
    ClearRevertTimer,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeCycle {
    pending: Option<PermissionMode>,
    last_tap_at: Option<u64>,
    pub cooldown_ms: u64,
    pub confirm_timeout_ms: u64,
}

impl Default for ModeCycle {
    fn default() -> Self {
        Self {
            pending: None,
            last_tap_at: None,
            cooldown_ms: MODE_TAP_COOLDOWN_MS,
            confirm_timeout_ms: MODE_CONFIRM_TIMEOUT_MS,
        }
    }
}

impl ModeCycle {
    pub fn with_timings(cooldown_ms: u64, confirm_timeout_ms: u64) -> Self {
        Self {
            cooldown_ms,
            confirm_timeout_ms,
            ..Self::default()
        }
    }

    /// The button's display: the pending request, else the confirmed mode, else
    /// `plan`.
    pub fn displayed(&self, confirmed: Option<PermissionMode>) -> PermissionMode {
        self.pending.or(confirmed).unwrap_or(PermissionMode::Plan)
    }

    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Cycle to the next mode and send it. A no-op inside the tap cooldown.
    pub fn tap(&mut self, now: u64, confirmed: Option<PermissionMode>) -> Vec<ModeCycleEffect> {
        if self.last_tap_at.is_some_and(|at| now.saturating_sub(at) < self.cooldown_ms) {
            return vec![];
        }
        self.last_tap_at = Some(now);
        let current = self.displayed(confirmed);
        let idx = MODE_CYCLE.iter().position(|m| *m == current).unwrap_or(0);
        let next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.len()];
        self.pending = Some(next);
        vec![
            ModeCycleEffect::ClearRevertTimer,
            ModeCycleEffect::ArmRevertTimer { ms: self.confirm_timeout_ms },
            ModeCycleEffect::Send(next),
        ]
    }

    /// The revert timer elapsed with no matching confirmation.
    pub fn revert_fired(&mut self) {
        self.pending = None;
    }

    /// The store's confirmed mode may have changed. Only the MATCHING
    /// confirmation settles the pending request (a stale one for an earlier tap
    /// must not clear a newer pending one).
    pub fn note_confirmed(&mut self, confirmed: Option<PermissionMode>) -> Vec<ModeCycleEffect> {
        if self.pending.is_some() && confirmed == self.pending {
            self.pending = None;
            return vec![ModeCycleEffect::ClearRevertTimer];
        }
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ModeCycleEffect as E;
    use PermissionMode::*;

    #[test]
    fn tap_cycles_plan_yolo_edits_plan_and_sends() {
        let mut c = ModeCycle::default();
        let e = c.tap(0, Some(Plan));
        assert_eq!(e[0], E::ClearRevertTimer);
        assert_eq!(e[1], E::ArmRevertTimer { ms: MODE_CONFIRM_TIMEOUT_MS });
        assert_eq!(e[2], E::Send(Default));
        assert_eq!(c.displayed(Some(Plan)), Default);
        assert!(c.is_pending());

        c.note_confirmed(Some(Default));
        assert_eq!(c.tap(MODE_TAP_COOLDOWN_MS, Some(Default))[2], E::Send(AcceptEdits));
        c.note_confirmed(Some(AcceptEdits));
        assert_eq!(c.tap(MODE_TAP_COOLDOWN_MS * 2, Some(AcceptEdits))[2], E::Send(Plan));
    }

    #[test]
    fn a_tap_inside_the_cooldown_is_ignored() {
        let mut c = ModeCycle::default();
        c.tap(1000, Some(Plan));
        assert!(c.tap(1000 + MODE_TAP_COOLDOWN_MS - 1, Some(Plan)).is_empty());
        assert_eq!(c.displayed(Some(Plan)), Default); // still the first tap's request
        assert!(!c.tap(1000 + MODE_TAP_COOLDOWN_MS, Some(Plan)).is_empty());
    }

    #[test]
    fn the_matching_confirmation_clears_pending_a_stale_one_does_not() {
        let mut c = ModeCycle::default();
        c.tap(0, Some(Plan)); // pending = Default
        assert!(c.note_confirmed(Some(Plan)).is_empty()); // stale — still pending
        assert!(c.is_pending());
        assert_eq!(c.note_confirmed(Some(Default)), vec![E::ClearRevertTimer]);
        assert!(!c.is_pending());
    }

    #[test]
    fn no_confirmation_reverts_to_the_confirmed_mode_on_timer_fire() {
        let mut c = ModeCycle::default();
        c.tap(0, Some(Plan)); // pending = Default
        c.revert_fired();
        assert!(!c.is_pending());
        assert_eq!(c.displayed(Some(Plan)), Plan);
    }

    #[test]
    fn labels() {
        assert_eq!(mode_label(Plan), "PLAN");
        assert_eq!(mode_label(Default), "YOLO");
        assert_eq!(mode_label(AcceptEdits), "EDITS");
    }
}
