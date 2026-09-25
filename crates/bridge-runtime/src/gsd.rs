//! GSD workflow state for a session's directory, so the phone can show its
//! stage strip.
//!
//! GSD keeps its state under `<project>/.planning/`, but that markdown is not
//! parsed here: GSD ships a machine-readable CLI (`gsd-tools.cjs`, run with
//! node) and that is the supported contract. The queries are staged because
//! they fail differently:
//! 1. `smart-entry --json` — the gate; clean JSON even off a GSD project;
//! 2. `query init.manager` — the per-phase matrix; fails unless ROADMAP.md
//!    and STATE.md exist, so it is guarded;
//! 3. `progress` — percentage and milestone, and the phase list when (2)
//!    is unavailable;
//! 4. `query phase-plan-index N` — per-plan detail, for a few phases only;
//! 5. `git log` — GSD commits each task as `type(phase-plan): desc`, the
//!    only thing that moves during a parallel wave.
//!
//! Everything degrades to a blank snapshot: a missing or broken GSD must
//! never break a session. gsd-tools writes warnings to stderr, so only
//! stdout is parsed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use protocol::common::{GsdAction, GsdExecution, GsdPhase, GsdState};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(5);
/// A runaway roadmap must not bloat one relay event.
const MAX_PHASES: usize = 40;
const MAX_PREFLIGHT_PHASES: usize = 3;
const TASK_COMMIT_SCAN: usize = 80;

fn blank(installed: bool) -> GsdState {
    GsdState {
        installed,
        available: false,
        has_git: false,
        situation: if installed { "unknown" } else { "not-installed" }.into(),
        summary: String::new(),
        milestone: None,
        current_phase: None,
        total_phases: None,
        percent: 0.0,
        phases: vec![],
        actions: vec![],
        recommended: None,
        paused: false,
        blockers: vec![],
        verify_failed: false,
        execution: None,
    }
}

/// Where `gsd-tools.cjs` is: `CODEDECK_GSD_TOOLS_PATH`, else the install
/// locations the GSD installer uses. GSD is installed by `npx`, so there is
/// no binary on PATH.
pub fn find_tools(home: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CODEDECK_GSD_TOOLS_PATH") {
        let p = PathBuf::from(explicit);
        return p.exists().then_some(p);
    }
    [home.join(".claude/gsd-core/bin/gsd-tools.cjs"), home.join(".config/opencode/gsd-core/bin/gsd-tools.cjs")]
        .into_iter()
        .find(|p| p.exists())
}

/// smart-entry emits namespaced commands (`/gsd:plan-phase`); a flat install
/// needs `/gsd-plan-phase`, or every tapped command is unknown.
pub fn normalize_command(command: &str, namespaced: bool) -> String {
    if namespaced {
        command.to_string()
    } else {
        command.strip_prefix("/gsd:").map_or_else(|| command.to_string(), |rest| format!("/gsd-{rest}"))
    }
}

/// Reconcile GSD's two phase counts: prefer ROADMAP.md's, and scale the
/// percentage by the share of the roadmap GSD can see on disk (a finished
/// phase 1 of 5 is 20%, not 100%).
pub fn resolve_phase_totals(roadmap: Option<i64>, disk: Option<i64>, raw_percent: f64) -> (Option<i64>, f64) {
    let total = roadmap.or(disk);
    let scale = match (roadmap, disk) {
        (Some(r), Some(d)) if r > d && r > 0 => d as f64 / r as f64,
        _ => 1.0,
    };
    (total, (raw_percent * scale).round())
}

#[derive(Debug, PartialEq, Eq)]
pub struct TaskCommit {
    pub phase: String,
    pub plan: String,
    pub desc: String,
}

/// GSD's task commits (`feat(04-01): …`, phases may be `2.1`), newest first.
pub fn parse_task_commits(subjects: &[String]) -> Vec<TaskCommit> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^\w+\((\d+(?:\.\d+)*)-(\d+)\):\s*(.+)$").expect("valid"));
    subjects
        .iter()
        .filter_map(|s| re.captures(s))
        .map(|c| TaskCommit { phase: c[1].into(), plan: c[2].into(), desc: c[3].into() })
        .collect()
}

/// Phase ids appear as both `2` and `02`: compare numerically when both are numbers.
fn same_phase(a: &str, b: &str) -> bool {
    match (a.parse::<f64>(), b.parse::<f64>()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

#[derive(Default, Deserialize)]
struct Signals {
    current_phase: Option<Value>,
    total_phases: Option<i64>,
    roadmap_total_phases: Option<i64>,
    has_planning: Option<bool>,
    has_roadmap: Option<bool>,
    has_git: Option<bool>,
    paused: Option<bool>,
    #[serde(default)]
    blockers: Vec<Value>,
    verify_failed: Option<bool>,
}

#[derive(Deserialize)]
struct RawAction {
    id: Option<String>,
    label: Option<String>,
    command: Option<String>,
    recommended: Option<bool>,
}

#[derive(Deserialize)]
struct SmartEntry {
    situation: Option<String>,
    recommended: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    signals: Signals,
    #[serde(default)]
    actions: Vec<RawAction>,
}

#[derive(Deserialize, Clone)]
struct PlanEntry {
    id: Option<String>,
    autonomous: Option<bool>,
    task_count: Option<i64>,
    has_summary: Option<bool>,
}

#[derive(Deserialize, Clone)]
struct PlanIndex {
    plans: Option<Vec<PlanEntry>>,
    incomplete: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ManagerPhase {
    number: Option<Value>,
    name: Option<String>,
    display_name: Option<String>,
    disk_status: Option<String>,
    plan_count: Option<u64>,
    summary_count: Option<u64>,
    is_active: Option<bool>,
}

#[derive(Deserialize)]
struct RecommendedAction {
    phase: Option<Value>,
    action: Option<String>,
    command: Option<String>,
}

#[derive(Deserialize)]
struct Manager {
    #[serde(default)]
    phases: Vec<ManagerPhase>,
    #[serde(default)]
    recommended_actions: Vec<RecommendedAction>,
    phase_count: Option<i64>,
}

#[derive(Deserialize)]
struct ProgressPhase {
    number: Option<Value>,
    name: Option<String>,
    status: Option<String>,
    plans: Option<u64>,
    summaries: Option<u64>,
}

#[derive(Deserialize)]
struct Progress {
    milestone_version: Option<String>,
    milestone_name: Option<String>,
    percent: Option<f64>,
    #[serde(default)]
    phases: Vec<ProgressPhase>,
}

fn text_of(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Reads GSD state with one node binary and one gsd-tools install.
pub struct Gsd {
    node: String,
    tools: Option<PathBuf>,
    namespaced: bool,
}

impl Gsd {
    pub fn new(node: String, home: &Path) -> Self {
        Self { node, tools: find_tools(home), namespaced: home.join(".claude/commands/gsd").is_dir() }
    }

    async fn query<T: for<'de> Deserialize<'de>>(&self, tools: &Path, args: &[&str], cwd: &str) -> Option<T> {
        let run = Command::new(&self.node).arg(tools).args(args).args(["--cwd", cwd]).kill_on_drop(true).output();
        let out = tokio::time::timeout(TIMEOUT, run).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        serde_json::from_slice(String::from_utf8_lossy(&out.stdout).trim().as_bytes()).ok()
    }

    async fn git_subjects(cwd: &str) -> Vec<String> {
        let scan = format!("-n{TASK_COMMIT_SCAN}");
        let run = Command::new("git").args(["-C", cwd, "log", "--no-merges", &scan, "--pretty=format:%s"]).kill_on_drop(true).output();
        match tokio::time::timeout(TIMEOUT, run).await {
            Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.is_empty()).map(str::to_string).collect(),
            _ => Vec::new(),
        }
    }

    fn actions(&self, entry: &SmartEntry) -> Vec<GsdAction> {
        entry
            .actions
            .iter()
            .filter_map(|a| {
                let (id, command) = (a.id.clone()?, a.command.clone()?);
                Some(GsdAction {
                    label: a.label.clone().filter(|l| !l.is_empty()).unwrap_or_else(|| id.clone()),
                    command: normalize_command(&command, self.namespaced),
                    recommended: a.recommended == Some(true),
                    id,
                })
            })
            .collect()
    }

    /// The snapshot for `cwd`; `available: false` off a GSD project.
    pub async fn state(&self, cwd: &str) -> GsdState {
        let Some(tools) = self.tools.clone() else { return blank(false) };
        let Some(entry) = self.query::<SmartEntry>(&tools, &["smart-entry", "--json"], cwd).await else { return blank(true) };
        let signals = &entry.signals;
        if signals.has_planning != Some(true) {
            // Not a GSD project yet: still offer GSD's own start actions.
            return GsdState {
                has_git: signals.has_git == Some(true),
                situation: entry.situation.clone().unwrap_or_else(|| "no-project".into()),
                summary: entry.summary.clone().unwrap_or_default(),
                actions: self.actions(&entry),
                recommended: entry.recommended.clone(),
                ..blank(true)
            };
        }
        let manager = if signals.has_roadmap == Some(true) {
            self.query::<Manager>(&tools, &["query", "init.manager"], cwd).await
        } else {
            None
        };
        let progress = self.query::<Progress>(&tools, &["progress"], cwd).await;
        let mut phases = match &manager {
            Some(m) if !m.phases.is_empty() => phases_from_manager(m),
            _ => phases_from_progress(progress.as_ref()),
        };
        // STATE.md's current phase arrives as a number; the phone matches strings.
        let current_phase = match &signals.current_phase {
            None | Some(Value::Null) => None,
            v => Some(text_of(v)),
        };

        let mut wanted: Vec<String> = phases
            .iter()
            .filter(|p| p.action.as_deref() == Some("execute"))
            .map(|p| p.number.clone())
            .take(MAX_PREFLIGHT_PHASES)
            .collect();
        if let Some(cur) = &current_phase {
            if !wanted.iter().any(|w| same_phase(w, cur)) {
                wanted.insert(0, cur.clone());
                wanted.truncate(MAX_PREFLIGHT_PHASES);
            }
        }
        let mut index: BTreeMap<String, PlanIndex> = BTreeMap::new();
        for n in &wanted {
            if let Some(i) = self.query::<PlanIndex>(&tools, &["query", "phase-plan-index", n], cwd).await {
                index.insert(n.clone(), i);
            }
        }
        for p in &mut phases {
            if let Some(plans) = index.get(&p.number).and_then(|i| i.plans.as_ref()) {
                p.plan_count = Some(plans.len() as i64);
                // "Needs you" = plans GSD marks as not autonomous.
                p.needs_you = Some(plans.iter().filter(|pl| pl.autonomous == Some(false)).count() as i64);
            }
        }
        let execution = build_execution(current_phase.as_deref(), &index, &Self::git_subjects(cwd).await, entry.situation.as_deref());
        let disk = signals.total_phases.or(manager.as_ref().and_then(|m| m.phase_count)).or((!phases.is_empty()).then_some(phases.len() as i64));
        let (total_phases, percent) =
            resolve_phase_totals(signals.roadmap_total_phases, disk, progress.as_ref().and_then(|p| p.percent).unwrap_or(0.0));
        GsdState {
            installed: true,
            available: true,
            has_git: signals.has_git == Some(true),
            situation: entry.situation.clone().unwrap_or_else(|| "unknown".into()),
            summary: entry.summary.clone().unwrap_or_default(),
            milestone: progress.as_ref().and_then(milestone),
            current_phase,
            total_phases,
            percent,
            phases,
            actions: self.actions(&entry),
            recommended: entry.recommended.clone(),
            paused: signals.paused == Some(true),
            blockers: signals.blockers.iter().map(|b| b.as_str().map_or_else(|| b.to_string(), str::to_string)).take(5).collect(),
            verify_failed: signals.verify_failed == Some(true),
            execution,
        }
    }
}

fn milestone(p: &Progress) -> Option<String> {
    let version = p.milestone_version.clone().unwrap_or_default();
    let name = p.milestone_name.clone().filter(|n| n != "milestone").unwrap_or_default();
    let label = [version, name].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" — ");
    (!label.is_empty()).then_some(label)
}

/// Live progress inside the phase being executed — None unless there is
/// something real to show; a strip that invents progress is worse than one
/// that admits it does not know.
fn build_execution(current: Option<&str>, index: &BTreeMap<String, PlanIndex>, subjects: &[String], situation: Option<&str>) -> Option<GsdExecution> {
    let current = current?;
    let idx = index.iter().find(|(n, _)| same_phase(n, current)).map(|(_, v)| v)?;
    let plans = idx.plans.as_ref().filter(|p| !p.is_empty())?;
    let commits: Vec<TaskCommit> = parse_task_commits(subjects).into_iter().filter(|c| same_phase(&c.phase, current)).collect();
    if commits.is_empty() && situation != Some("executing") {
        return None;
    }
    let current_plan = idx
        .incomplete
        .as_ref()
        .and_then(|i| i.first().cloned())
        .or_else(|| commits.first().map(|c| format!("{current}-{}", c.plan)));
    let suffix = current_plan.as_ref().and_then(|p| p.rsplit('-').next().map(str::to_string));
    let tasks_done = suffix.as_ref().map_or(0, |s| commits.iter().filter(|c| &c.plan == s).count());
    let declared = current_plan.as_ref().and_then(|id| plans.iter().find(|p| p.id.as_deref() == Some(id))).and_then(|p| p.task_count);
    Some(GsdExecution {
        phase: current.to_string(),
        plans_total: plans.len() as u64,
        plans_done: plans.iter().filter(|p| p.has_summary == Some(true)).count() as u64,
        current_plan,
        tasks_done: tasks_done as u64,
        tasks_total: declared.filter(|d| *d > 0),
        last_task: commits.first().map(|c| c.desc.clone()),
    })
}

fn phases_from_manager(m: &Manager) -> Vec<GsdPhase> {
    // recommended_actions' commands already use the flat `/gsd-…` form.
    let by_phase: BTreeMap<String, &RecommendedAction> = m.recommended_actions.iter().map(|a| (text_of(&a.phase), a)).collect();
    m.phases
        .iter()
        .take(MAX_PHASES)
        .map(|p| {
            let number = text_of(&p.number);
            let rec = by_phase.get(&number);
            GsdPhase {
                name: p.display_name.clone().filter(|n| !n.is_empty()).or_else(|| p.name.clone()).unwrap_or_default(),
                disk_status: p.disk_status.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "empty".into()),
                plans: p.plan_count.unwrap_or(0),
                summaries: p.summary_count.unwrap_or(0),
                recently_touched: p.is_active == Some(true),
                action: rec.and_then(|r| r.action.clone()),
                command: rec.and_then(|r| r.command.clone()),
                plan_count: None,
                needs_you: None,
                number,
            }
        })
        .collect()
}

fn phases_from_progress(p: Option<&Progress>) -> Vec<GsdPhase> {
    let disk = |status: &str| match status {
        "Complete" => "complete",
        "Needs Review" | "Executed" => "executed",
        "In Progress" => "partial",
        "Planned" => "planned",
        _ => "empty",
    };
    p.map(|p| p.phases.as_slice())
        .unwrap_or_default()
        .iter()
        .take(MAX_PHASES)
        .map(|ph| GsdPhase {
            number: text_of(&ph.number),
            name: ph.name.clone().unwrap_or_default(),
            disk_status: disk(ph.status.as_deref().unwrap_or("")).into(),
            plans: ph.plans.unwrap_or(0),
            summaries: ph.summaries.unwrap_or(0),
            recently_touched: false,
            action: None,
            command: None,
            plan_count: None,
            needs_you: None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_flattened_for_a_flat_install() {
        assert_eq!(normalize_command("/gsd:plan-phase 2", false), "/gsd-plan-phase 2");
        assert_eq!(normalize_command("/gsd:plan-phase 2", true), "/gsd:plan-phase 2");
        assert_eq!(normalize_command("/other", false), "/other");
    }

    #[test]
    fn the_roadmap_count_wins_and_scales_the_percentage() {
        assert_eq!(resolve_phase_totals(Some(5), Some(1), 100.0), (Some(5), 20.0));
        assert_eq!(resolve_phase_totals(None, Some(3), 50.0), (Some(3), 50.0));
        assert_eq!(resolve_phase_totals(None, None, 0.0), (None, 0.0));
    }

    #[test]
    fn task_commits_follow_the_gsd_convention() {
        let subjects: Vec<String> = ["feat(04-01): add payments", "fix: unrelated", "test(2.1-03): cover edge"].iter().map(|s| s.to_string()).collect();
        let commits = parse_task_commits(&subjects);
        assert_eq!(commits.len(), 2);
        assert_eq!((commits[0].phase.as_str(), commits[0].plan.as_str(), commits[0].desc.as_str()), ("04", "01", "add payments"));
        assert_eq!(commits[1].phase, "2.1");
        assert!(same_phase("04", "4") && !same_phase("4", "5"));
    }

    #[test]
    fn execution_is_reported_only_when_there_is_evidence() {
        let mut index = BTreeMap::new();
        index.insert(
            "4".to_string(),
            PlanIndex {
                plans: Some(vec![
                    PlanEntry { id: Some("4-01".into()), autonomous: Some(true), task_count: Some(3), has_summary: Some(true) },
                    PlanEntry { id: Some("4-02".into()), autonomous: Some(false), task_count: Some(4), has_summary: None },
                ]),
                incomplete: Some(vec!["4-02".into()]),
            },
        );
        let subjects = vec!["feat(04-02): step two".to_string(), "feat(04-02): step one".to_string()];
        let e = build_execution(Some("04"), &index, &subjects, None).unwrap();
        assert_eq!((e.plans_total, e.plans_done, e.tasks_done, e.tasks_total), (2, 1, 2, Some(4)));
        assert_eq!(e.last_task.as_deref(), Some("step two"));
        assert!(build_execution(Some("4"), &index, &[], None).is_none(), "nothing committed, not executing");
    }

    #[tokio::test]
    async fn without_gsd_the_snapshot_says_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let gsd = Gsd { node: "node".into(), tools: None, namespaced: false };
        let s = gsd.state(&dir.path().to_string_lossy()).await;
        assert!(!s.installed && !s.available);
        assert_eq!(s.situation, "not-installed");
    }
}
