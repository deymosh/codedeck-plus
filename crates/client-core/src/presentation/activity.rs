//! `activity` — what a session has going on beside the conversation: the
//! agent's checklist, the sub-agents it started, and the work it left
//! running in the background. The data behind the session's activity sheet,
//! built from the same transcript as its rows.

use std::collections::HashMap;

use protocol::common::{EntryBody, TaskKind, TaskStatus, TodoItem, ToolKind};
use serde::Serialize;

use super::display_entries::{DisplayEntry, SeqEntry, ToolStep};

/// Finished sub-agents kept beside the running ones: enough to see what just
/// came back, without the list growing with the session.
const FINISHED_AGENTS_SHOWN: usize = 3;
/// Ended background tasks kept beside the running ones, likewise.
const ENDED_TASKS_SHOWN: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityView {
    /// The agent's latest checklist; empty when it keeps none.
    pub todos: Vec<TodoItem>,
    /// Every running sub-agent, then the last few that finished, in the
    /// order they started.
    pub agents: Vec<AgentView>,
    /// Every running background task, then the last few that ended.
    pub tasks: Vec<TaskView>,
}

/// One sub-agent, as the `agent` call that started it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    /// The row holding the call, and the call's own step: where to open it.
    pub group_seq: u64,
    pub call_seq: u64,
    pub title: String,
    /// Its kind (`Explore`), when known.
    pub label: Option<String>,
    /// It reported back (with `failed` when that was an error).
    pub finished: bool,
    pub failed: bool,
    /// How many tools it has used.
    pub tool_uses: u32,
    /// What it is doing, or did last: "Reading a.rs".
    pub current: Option<String>,
}

/// One background task, as its latest entry says.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub task_id: String,
    pub task_kind: TaskKind,
    pub title: String,
    pub status: TaskStatus,
    pub summary: Option<String>,
    pub call_id: Option<String>,
}

/// A sub-agent's latest step, as a line: the call it waits on, else the one
/// it made last.
fn current_of(children: &[ToolStep]) -> Option<String> {
    match children.last()? {
        ToolStep::Call { active_verb, verb, title, result, .. } => {
            Some(format!("{} {title}", if result.is_none() { active_verb } else { verb }))
        }
        ToolStep::Thinking { .. } => Some("Thinking".into()),
        ToolStep::Text { text, .. } => text.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()),
        ToolStep::Result { .. } => None,
    }
}

fn agents_of(display: &[DisplayEntry]) -> Vec<AgentView> {
    let mut all = Vec::new();
    for row in display {
        let DisplayEntry::ToolGroup { seq: group_seq, steps, .. } = row else { continue };
        for step in steps {
            let ToolStep::Call { seq, tool_kind: ToolKind::Agent, title, result, children, .. } = step else { continue };
            let label = children.iter().find_map(|c| match c {
                ToolStep::Call { subagent: Some(label), .. } => Some(label.clone()),
                _ => None,
            });
            all.push(AgentView {
                group_seq: *group_seq,
                call_seq: *seq,
                title: title.clone(),
                label,
                finished: result.is_some(),
                failed: result.as_ref().is_some_and(|r| r.is_error),
                tool_uses: children.iter().filter(|c| matches!(c, ToolStep::Call { .. })).count() as u32,
                current: current_of(children),
            });
        }
    }
    keep_running_and_last(all, |a| !a.finished, FINISHED_AGENTS_SHOWN)
}

fn tasks_of(source: &[SeqEntry]) -> Vec<TaskView> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<String, TaskView> = HashMap::new();
    for item in source {
        let EntryBody::BackgroundTask { task_id, kind, title, status, call_id, summary } = &item.entry.body else {
            continue;
        };
        if !latest.contains_key(task_id) {
            order.push(task_id.clone());
        }
        latest.insert(
            task_id.clone(),
            TaskView {
                task_id: task_id.clone(),
                task_kind: *kind,
                title: title.clone(),
                status: *status,
                summary: summary.clone(),
                call_id: call_id.clone(),
            },
        );
    }
    let all: Vec<TaskView> = order.into_iter().filter_map(|id| latest.remove(&id)).collect();
    keep_running_and_last(all, |t| t.status == TaskStatus::Running, ENDED_TASKS_SHOWN)
}

/// The live ones first, then the last `ended` of the rest, each in order.
fn keep_running_and_last<T>(all: Vec<T>, live: impl Fn(&T) -> bool, ended: usize) -> Vec<T> {
    let (mut running, done): (Vec<T>, Vec<T>) = all.into_iter().partition(|x| live(x));
    let skip = done.len().saturating_sub(ended);
    running.extend(done.into_iter().skip(skip));
    running
}

/// The session's activity, or `None` when it has none to show.
pub fn build_activity(source: &[SeqEntry], display: &[DisplayEntry]) -> Option<ActivityView> {
    let todos = source
        .iter()
        .rev()
        .find_map(|e| match &e.entry.body {
            EntryBody::Todos { items, .. } => Some(items.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let view = ActivityView { todos, agents: agents_of(display), tasks: tasks_of(source) };
    (!view.todos.is_empty() || !view.agents.is_empty() || !view.tasks.is_empty()).then_some(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presentation::display_entries::build_display_entries;
    use serde_json::json;

    fn seq(entries: &[serde_json::Value]) -> Vec<SeqEntry> {
        entries
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let mut v = v.clone();
                v["timestamp"] = json!("t");
                SeqEntry { seq: i as u64 + 1, entry: serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v} -> {e}")) }
            })
            .collect()
    }

    fn activity(entries: &[serde_json::Value]) -> Option<ActivityView> {
        let source = seq(entries);
        build_activity(&source, &build_display_entries(&source))
    }

    fn agent_call(id: &str) -> serde_json::Value {
        json!({"entryType":"tool_call","callId":id,"toolName":"Agent","kind":"agent","title":format!("job {id}")})
    }
    fn sub_read(id: &str, parent: &str) -> serde_json::Value {
        json!({"entryType":"tool_call","callId":id,"toolName":"Read","kind":"read","title":format!("{id}.rs"),
            "subagent":{"label":"Explore","parentCallId":parent}})
    }
    fn result(id: &str) -> serde_json::Value {
        json!({"entryType":"tool_result","callId":id,"text":"done"})
    }
    fn task(id: &str, status: &str) -> serde_json::Value {
        json!({"entryType":"background_task","taskId":id,"kind":"shell","title":format!("cmd {id}"),"status":status})
    }

    #[test]
    fn nothing_going_on_is_no_activity() {
        assert_eq!(activity(&[json!({"entryType":"text","role":"user","text":"hi"})]), None);
    }

    #[test]
    fn a_running_sub_agent_says_what_it_is_doing() {
        let a = activity(&[agent_call("a1"), sub_read("r1", "a1"), result("r1"), sub_read("r2", "a1")]).unwrap();
        let agent = &a.agents[0];
        assert_eq!(agent.title, "job a1");
        assert_eq!(agent.label.as_deref(), Some("Explore"));
        assert!(!agent.finished);
        assert_eq!(agent.tool_uses, 2);
        assert_eq!(agent.current.as_deref(), Some("Reading r2.rs"));
    }

    #[test]
    fn finished_agents_are_capped_but_running_ones_never_are() {
        let mut entries = Vec::new();
        for i in 0..6 {
            let id = format!("a{i}");
            entries.push(agent_call(&id));
            if i != 1 {
                entries.push(result(&id));
            }
        }
        let a = activity(&entries).unwrap();
        let titles: Vec<&str> = a.agents.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, ["job a1", "job a3", "job a4", "job a5"]);
    }

    #[test]
    fn a_task_is_its_latest_state_and_running_ones_come_first() {
        let a = activity(&[task("b1", "running"), task("b2", "running"), task("b1", "completed")]).unwrap();
        let tasks: Vec<(&str, TaskStatus)> = a.tasks.iter().map(|t| (t.task_id.as_str(), t.status)).collect();
        assert_eq!(tasks, [("b2", TaskStatus::Running), ("b1", TaskStatus::Completed)]);
    }

    #[test]
    fn the_latest_checklist_wins() {
        let a = activity(&[
            json!({"entryType":"todos","items":[{"text":"a","status":"pending"}]}),
            json!({"entryType":"todos","items":[{"text":"a","status":"completed"},{"text":"b","status":"in_progress"}]}),
        ])
        .unwrap();
        assert_eq!(a.todos.len(), 2);
        assert_eq!(a.todos[1].text, "b");
    }
}
