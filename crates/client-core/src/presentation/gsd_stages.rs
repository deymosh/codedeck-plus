//! GSD phase status → the Discuss / Plan / Execute stage triple + strip lines.
//! Port of `apps/mobile/src/ui/gsd/gsdStages.ts` (CD-052).
//!
//! The vocabulary is GSD's own (`gsd-core/workflows/manager.md` renders the same
//! three columns) — phone and desktop must describe a phase identically. All of
//! this renders bridge-computed state from `gsd-tools`; the phone never parses
//! `.planning/` markdown.
//!
//! The three marks read left→right as Discuss, Plan, Execute:
//!   `✓` done · `◆` in flight / needs you · `○` ready to start · `·` not reached

use protocol::common::{GsdAction, GsdPhase, GsdState};

pub type StageMark = char;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaseStages {
    /// `[Discuss, Plan, Execute]`.
    pub marks: [StageMark; 3],
    pub label: String,
}

impl PhaseStages {
    fn new(marks: [char; 3], label: &str) -> Self {
        Self {
            marks,
            label: label.to_string(),
        }
    }
}

/// `disk_status` → the fixed stage triple. `None` = no table entry ("Up next"
/// unless the phase carries a reachable action).
fn stages_for(disk_status: &str) -> Option<PhaseStages> {
    let s = match disk_status {
        "complete" => PhaseStages::new(['✓', '✓', '✓'], "Complete"),
        "executed" => PhaseStages::new(['✓', '✓', '◆'], "Verification required"),
        "partial" => PhaseStages::new(['✓', '✓', '◆'], "Executing…"),
        "planned" => PhaseStages::new(['✓', '✓', '○'], "Ready to execute"),
        "discussed" | "researched" => PhaseStages::new(['✓', '○', '·'], "Ready to plan"),
        "empty" => PhaseStages::new(['·', '·', '·'], "Up next"),
        _ => return None,
    };
    Some(s)
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|v| !v.is_empty())
}

pub fn phase_stages(phase: &GsdPhase) -> PhaseStages {
    match stages_for(&phase.disk_status) {
        Some(base) => base,
        // A phase GSD has an action for is reachable now — say so, not "Up next".
        None => match nonempty(&phase.action) {
            Some(action) => PhaseStages::new(['·', '·', '·'], &format!("Ready to {action}")),
            None => PhaseStages::new(['·', '·', '·'], "Up next"),
        },
    }
}

/// Human label for `GsdState.situation`, for the collapsed one-liner.
pub fn situation_label(situation: &str) -> &'static str {
    match situation {
        "no-project" => "No project",
        "needs-first-phase" => "Plan first phase",
        "planning" => "Planning",
        "executing" => "Executing",
        "verify-pending" => "Verify",
        "verify-failed" => "Verify failed",
        "paused" => "Paused",
        "blocked" => "Blocked",
        "idle-stranded" => "Idle",
        "complete" => "Complete",
        _ => "GSD",
    }
}

/// The one-line summary for the collapsed strip, e.g.
/// `v1.0 — MVP · Phase 2/3 · Executing · 50%`. Unresolved parts are dropped
/// rather than rendered as "null" or "0".
pub fn strip_summary(gsd: &GsdState) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(milestone) = nonempty(&gsd.milestone) {
        parts.push(milestone.to_string());
    }

    // `total_phases ?? (phases.len() || null)` — a zero is not a real total.
    let total: Option<i64> = match gsd.total_phases {
        Some(t) => Some(t),
        None => match gsd.phases.len() as i64 {
            0 => None,
            n => Some(n),
        },
    };
    let has_total = total.is_some_and(|t| t != 0);
    let current_phase = nonempty(&gsd.current_phase);

    match (current_phase, has_total) {
        (Some(cp), true) => parts.push(format!("Phase {cp}/{}", total.unwrap())),
        (Some(cp), false) => parts.push(format!("Phase {cp}")),
        (None, true) => parts.push(format!("{} phases", total.unwrap())),
        (None, false) => {}
    }

    parts.push(situation_label(&gsd.situation).to_string());
    parts.push(format!("{}%", fmt_num(gsd.percent)));
    parts.join(" · ")
}

/// Match JS `${n}` number stringification: integers print without a decimal.
fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The action the strip offers as a tappable chip, or `None`.
pub fn recommended_action(gsd: &GsdState) -> Option<&GsdAction> {
    if gsd.actions.is_empty() {
        return None;
    }
    gsd.recommended
        .as_deref()
        .and_then(|id| gsd.actions.iter().find(|a| a.id == id))
        .or_else(|| gsd.actions.iter().find(|a| a.recommended))
        .or_else(|| gsd.actions.first())
}

/// The live line shown while a phase is executing, e.g.
/// `Phase 2 · plan 1/2 · task 2/3 · cover the build step`. The ordinary readout
/// is FROZEN during an execute, so this exists. `None` when there is nothing
/// real to report.
pub fn execution_line(gsd: &GsdState) -> Option<String> {
    let e = gsd.execution.as_ref()?;

    let mut parts = vec![format!("Phase {}", e.phase)];
    if e.plans_total > 0 {
        parts.push(format!(
            "plan {}/{}",
            (e.plans_done + 1).min(e.plans_total),
            e.plans_total
        ));
    }
    match e.tasks_total {
        Some(t) if t != 0 => parts.push(format!("task {}/{}", e.tasks_done, t)),
        _ if e.tasks_done > 0 => parts.push(format!("task {}", e.tasks_done)),
        _ => {}
    }
    if let Some(last) = nonempty(&e.last_task) {
        parts.push(last.to_string());
    }
    Some(parts.join(" · "))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryChip {
    pub id: &'static str,
    pub label: String,
    pub command: &'static str,
}

/// Recovery states are first-class in GSD; each gets a visible way out.
pub fn recovery_chips(gsd: &GsdState) -> Vec<RecoveryChip> {
    let mut chips = Vec::new();
    if gsd.paused {
        chips.push(RecoveryChip {
            id: "resume",
            label: "Resume".to_string(),
            command: "/gsd-resume-work",
        });
    }
    if gsd.verify_failed {
        chips.push(RecoveryChip {
            id: "reverify",
            label: "Re-verify".to_string(),
            command: "/gsd-verify-work",
        });
    }
    if !gsd.blockers.is_empty() {
        chips.push(RecoveryChip {
            id: "debug",
            label: if gsd.blockers.len() > 1 {
                format!("{} blockers", gsd.blockers.len())
            } else {
                "Blocked".to_string()
            },
            command: "/gsd-debug",
        });
    }
    chips
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::GsdExecution;

    fn phase(disk_status: &str, action: Option<&str>) -> GsdPhase {
        GsdPhase {
            number: "2".into(),
            name: "MVP".into(),
            disk_status: disk_status.into(),
            plans: 0,
            summaries: 0,
            recently_touched: false,
            action: action.map(str::to_string),
            command: None,
            plan_count: None,
            needs_you: None,
        }
    }

    fn gsd() -> GsdState {
        GsdState {
            installed: true,
            available: true,
            has_git: true,
            situation: "executing".into(),
            summary: String::new(),
            milestone: Some("v1.0 — MVP".into()),
            current_phase: Some("2".into()),
            total_phases: Some(3),
            percent: 50.0,
            phases: vec![],
            actions: vec![],
            recommended: None,
            paused: false,
            blockers: vec![],
            verify_failed: false,
            execution: None,
        }
    }

    fn action(id: &str, recommended: bool) -> GsdAction {
        GsdAction {
            id: id.into(),
            label: id.into(),
            command: format!("/{id}"),
            recommended,
        }
    }

    #[test]
    fn phase_stages_table_and_the_action_fallback() {
        assert_eq!(phase_stages(&phase("complete", None)).marks, ['✓', '✓', '✓']);
        assert_eq!(phase_stages(&phase("planned", None)).label, "Ready to execute");
        assert_eq!(phase_stages(&phase("researched", None)).marks, ['✓', '○', '·']);

        // no table entry, no action → "Up next"
        assert_eq!(phase_stages(&phase("weird", None)).label, "Up next");
        // no table entry but a reachable action → "Ready to <action>"
        assert_eq!(
            phase_stages(&phase("weird", Some("plan"))).label,
            "Ready to plan"
        );
        // an "empty" phase is a real table entry — the action fallback does NOT apply
        assert_eq!(phase_stages(&phase("empty", Some("plan"))).label, "Up next");
    }

    #[test]
    fn strip_summary_joins_resolved_parts_and_drops_the_rest() {
        assert_eq!(
            strip_summary(&gsd()),
            "v1.0 — MVP · Phase 2/3 · Executing · 50%"
        );

        let mut g = gsd();
        g.milestone = None;
        g.total_phases = None; // and no phases → no total
        g.current_phase = Some("2".into());
        assert_eq!(strip_summary(&g), "Phase 2 · Executing · 50%");

        let mut g = gsd();
        g.milestone = None;
        g.current_phase = None;
        g.total_phases = Some(0); // a zero is not a real total
        assert_eq!(strip_summary(&g), "Executing · 50%");

        let mut g = gsd();
        g.situation = "no-project".into();
        g.percent = 12.5;
        assert!(strip_summary(&g).ends_with("No project · 12.5%"));
    }

    #[test]
    fn recommended_action_precedence_id_then_flag_then_first() {
        let mut g = gsd();
        assert_eq!(recommended_action(&g), None); // no actions

        g.actions = vec![action("a", false), action("b", true), action("c", false)];
        g.recommended = Some("c".into());
        assert_eq!(recommended_action(&g).unwrap().id, "c"); // id wins

        g.recommended = None;
        assert_eq!(recommended_action(&g).unwrap().id, "b"); // then the flag

        g.actions = vec![action("x", false), action("y", false)];
        assert_eq!(recommended_action(&g).unwrap().id, "x"); // then the first
    }

    #[test]
    fn execution_line_reports_only_what_is_real() {
        let mut g = gsd();
        assert_eq!(execution_line(&g), None); // no execution block

        g.execution = Some(GsdExecution {
            phase: "2".into(),
            plans_total: 2,
            plans_done: 0,
            current_plan: None,
            tasks_done: 2,
            tasks_total: Some(3),
            last_task: Some("cover the build step".into()),
        });
        assert_eq!(
            execution_line(&g).unwrap(),
            "Phase 2 · plan 1/2 · task 2/3 · cover the build step"
        );

        // no plans, a bare task count, no last task
        g.execution = Some(GsdExecution {
            phase: "1".into(),
            plans_total: 0,
            plans_done: 0,
            current_plan: None,
            tasks_done: 4,
            tasks_total: None,
            last_task: None,
        });
        assert_eq!(execution_line(&g).unwrap(), "Phase 1 · task 4");
    }

    #[test]
    fn recovery_chips_one_per_active_recovery_state() {
        let mut g = gsd();
        assert!(recovery_chips(&g).is_empty());

        g.paused = true;
        g.verify_failed = true;
        g.blockers = vec!["a".into(), "b".into()];
        let chips = recovery_chips(&g);
        assert_eq!(
            chips.iter().map(|c| c.id).collect::<Vec<_>>(),
            ["resume", "reverify", "debug"]
        );
        assert_eq!(chips[2].label, "2 blockers");

        g.blockers = vec!["only-one".into()];
        assert_eq!(recovery_chips(&g)[2].label, "Blocked");
    }
}
