//! `display_entries` — pure transform from the flat transcript (`seq` +
//! `OutputEntry`) to grouped display items, one per rendered row. Port of
//! `apps/mobile/src/ui/transcript/displayEntries.ts`, on the v10 wire entry
//! vocabulary the bridge actually produces.
//!
//! - `text` role=user → user message bubble.
//! - `text` role=assistant → assistant markdown, or absorbed into a tool group
//!   when `display_hint` is `collapse`.
//! - `text` special=plan → plan markdown (stays visible).
//! - `tool_use` / `tool_result` / `progress` / `thinking` → collapsed
//!   "N actions" group.
//! - `system` special=plan_approval → plan approval card.
//! - `system` special=ask_question → question card (grouped by `tool_use_id`
//!   for a multi-question turn).
//! - `system` special=permission_request → permission card.
//! - `system` special=session_restart → lifecycle marker.
//! - `error` → error row.
//! - `system` init banner / token counts / result summaries / `stream_end`
//!   markers → filtered out; the rest are status lines.
//!
//! CDX-085: `thinking` is folded into the action group and counted with the
//! rest — a turn no longer renders as an alternating `Thinking` / `N actions`
//! stack. A lone thinking step reads as "1 action". `diff` deliberately stays
//! OUT: it flushes the group and renders standalone (the point of a diff card
//! is to be seen).
//!
//! Answered-state detection: a `tool_result` whose `tool_use_id` matches a
//! card's id means the card was resolved.

use std::collections::{BTreeSet, HashMap};

use protocol::common::{OutputEntry, OutputEntryType};

#[derive(Debug, Clone, PartialEq)]
pub struct SeqEntry {
    pub seq: u64,
    pub entry: OutputEntry,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct QuestionSpecView {
    pub entry: OutputEntry,
    pub header: Option<String>,
    pub options: Option<Vec<QuestionOption>>,
    pub multi_select: Option<bool>,
}

/// One rendered row. `seq` is the stable key — the seq of the first entry
/// making up this item.
#[derive(Debug, Clone, PartialEq)]
pub enum DisplayEntry {
    UserMessage {
        seq: u64,
        entry: OutputEntry,
    },
    AssistantMessage {
        seq: u64,
        entry: OutputEntry,
        /// `true` for `special=plan` entries (plan markdown).
        is_plan: bool,
    },
    ToolGroup {
        seq: u64,
        entries: Vec<SeqEntry>,
        summary: String,
    },
    Diff {
        seq: u64,
        entry: OutputEntry,
    },
    Error {
        seq: u64,
        entry: OutputEntry,
    },
    System {
        seq: u64,
        entry: OutputEntry,
    },
    Lifecycle {
        seq: u64,
        entry: OutputEntry,
    },
    PlanApproval {
        seq: u64,
        entry: OutputEntry,
        tool_use_id: Option<String>,
        has_plan: bool,
        /// Set (`"Plan approved"`) when a matching `tool_result` resolved it.
        answered: Option<String>,
    },
    Question {
        seq: u64,
        tool_use_id: Option<String>,
        question: QuestionSpecView,
        answered: Option<String>,
    },
    QuestionGroup {
        seq: u64,
        tool_use_id: String,
        questions: Vec<QuestionSpecView>,
        answered: Option<String>,
    },
    PermissionRequest {
        seq: u64,
        entry: OutputEntry,
        tool_name: String,
        description: String,
        request_id: String,
        is_sub_agent: bool,
        agent_label: Option<String>,
        /// Set when a matching `tool_result` resolved the request.
        answered: Option<String>,
    },
}

// --- metadata helpers (OutputEntry.metadata is Option<serde_json::Value>) ---

fn meta<'a>(entry: &'a OutputEntry, key: &str) -> Option<&'a serde_json::Value> {
    entry.metadata.as_ref()?.get(key)
}

fn meta_str<'a>(entry: &'a OutputEntry, key: &str) -> Option<&'a str> {
    meta(entry, key)?.as_str()
}

fn meta_bool(entry: &OutputEntry, key: &str) -> Option<bool> {
    meta(entry, key)?.as_bool()
}

fn meta_f64(entry: &OutputEntry, key: &str) -> Option<f64> {
    meta(entry, key)?.as_f64()
}

/// JS `!!value` on a metadata field.
fn meta_truthy(entry: &OutputEntry, key: &str) -> bool {
    match meta(entry, key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(serde_json::Value::Array(_)) | Some(serde_json::Value::Object(_)) => true,
        Some(serde_json::Value::Null) | None => false,
    }
}

/// `metadata.special`, treating `""` as absent (JS truthiness).
fn special_of(entry: &OutputEntry) -> Option<&str> {
    meta_str(entry, "special").filter(|s| !s.is_empty())
}

fn tool_use_id_of(entry: &OutputEntry) -> Option<&str> {
    meta_str(entry, "tool_use_id").filter(|s| !s.is_empty())
}

fn parse_options(entry: &OutputEntry) -> Option<Vec<QuestionOption>> {
    let arr = meta(entry, "options")?.as_array()?;
    Some(
        arr.iter()
            .map(|v| QuestionOption {
                label: v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                description: v
                    .get("description")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
            })
            .collect(),
    )
}

/// CDX-085: what folds into the action group. `diff` is NOT here — it renders
/// standalone. Do not generalise this set.
fn is_action_entry(entry: &OutputEntry) -> bool {
    matches!(
        entry.entry_type,
        OutputEntryType::ToolUse
            | OutputEntryType::ToolResult
            | OutputEntryType::Progress
            | OutputEntryType::Thinking
    )
}

/// Assistant text accompanying tool calls collapses into the tool group.
fn should_collapse_text(entry: &OutputEntry) -> bool {
    if special_of(entry).is_some() {
        return false;
    }
    if entry.entry_type != OutputEntryType::Text {
        return false;
    }
    if meta_str(entry, "role") == Some("user") {
        return false;
    }
    meta_str(entry, "display_hint") == Some("collapse")
}

/// Per-turn metadata noise the transcript hides.
pub fn is_hidden_system_entry(entry: &OutputEntry) -> bool {
    if entry.entry_type != OutputEntryType::System {
        return false;
    }
    if special_of(entry).is_some() {
        return false;
    }
    if meta_truthy(entry, "stream_end") {
        return true;
    }
    let t = &entry.content;
    t.is_empty()
        || t.starts_with("Claude Code")
        || t.starts_with("Session complete")
        || t.starts_with("Tokens:")
}

/// Count of ACTIONS, not of absorbed entries — a collapsed assistant text rides
/// in `entries` without being an action. CDX-085 added thinking steps to the
/// tally; the rest is unchanged.
fn build_tool_summary(entries: &[SeqEntry]) -> String {
    let count = entries.iter().filter(|e| is_action_entry(&e.entry)).count();
    format!("{count} action{}", if count == 1 { "" } else { "s" })
}

/// `tool_use_id` → answering `tool_result` content (resolved-card detection).
pub fn collect_answered_tool_use_ids(entries: &[SeqEntry]) -> HashMap<String, String> {
    let mut answered = HashMap::new();
    for item in entries {
        if item.entry.entry_type != OutputEntryType::ToolResult {
            continue;
        }
        if let Some(id) = tool_use_id_of(&item.entry) {
            answered.insert(id.to_string(), item.entry.content.clone());
        }
    }
    answered
}

struct Builder {
    display: Vec<DisplayEntry>,
    answered: HashMap<String, String>,
    tool_group: Vec<SeqEntry>,
    tool_group_seq: u64,
    questions: Vec<QuestionSpecView>,
    question_tool_use_id: Option<String>,
    question_seq: u64,
}

impl Builder {
    fn flush_tool_group(&mut self) {
        if self.tool_group.is_empty() {
            return;
        }
        let entries = std::mem::take(&mut self.tool_group);
        let summary = build_tool_summary(&entries);
        self.display.push(DisplayEntry::ToolGroup {
            seq: self.tool_group_seq,
            entries,
            summary,
        });
    }

    fn flush_question_group(&mut self) {
        if self.questions.is_empty() {
            return;
        }
        let questions = std::mem::take(&mut self.questions);
        let tool_use_id = self.question_tool_use_id.take();
        let answered = tool_use_id
            .as_deref()
            .and_then(|id| self.answered.get(id).cloned());

        let expected = meta_f64(&questions[0].entry, "question_count");
        let is_multi = match expected {
            Some(n) => n > 1.0,
            None => questions.len() > 1,
        };

        if !is_multi {
            self.display.push(DisplayEntry::Question {
                seq: self.question_seq,
                tool_use_id,
                question: questions.into_iter().next().expect("non-empty"),
                answered,
            });
        } else {
            // Robust against out-of-order delivery: sort by question_index.
            let mut sorted = questions;
            sorted.sort_by(|a, b| {
                let ai = meta_f64(&a.entry, "question_index").unwrap_or(0.0);
                let bi = meta_f64(&b.entry, "question_index").unwrap_or(0.0);
                ai.total_cmp(&bi)
            });
            self.display.push(DisplayEntry::QuestionGroup {
                seq: self.question_seq,
                tool_use_id: tool_use_id.unwrap_or_else(|| self.question_seq.to_string()),
                questions: sorted,
                answered,
            });
        }
    }
}

pub fn build_display_entries(source: &[SeqEntry]) -> Vec<DisplayEntry> {
    let mut b = Builder {
        display: Vec::new(),
        answered: collect_answered_tool_use_ids(source),
        tool_group: Vec::new(),
        tool_group_seq: 0,
        questions: Vec::new(),
        question_tool_use_id: None,
        question_seq: 0,
    };

    let filtered: Vec<SeqEntry> = source
        .iter()
        .filter(|e| !is_hidden_system_entry(&e.entry))
        .cloned()
        .collect();

    for item in &filtered {
        let entry = &item.entry;
        let seq = item.seq;

        if is_action_entry(entry) {
            b.flush_question_group();
            if b.tool_group.is_empty() {
                b.tool_group_seq = seq;
            }
            b.tool_group.push(item.clone());
            continue;
        }
        if should_collapse_text(entry) {
            if b.tool_group.is_empty() {
                b.tool_group_seq = seq;
            }
            b.tool_group.push(item.clone());
            continue;
        }
        b.flush_tool_group();

        let special = special_of(entry);
        let tool_use_id = tool_use_id_of(entry);

        if special == Some("ask_question") {
            let current = b.question_tool_use_id.clone();
            if let Some(current) = current {
                if tool_use_id != Some(current.as_str()) {
                    b.flush_question_group();
                }
            }
            if b.questions.is_empty() {
                b.question_seq = seq;
                b.question_tool_use_id = tool_use_id.map(str::to_string);
            }
            b.questions.push(QuestionSpecView {
                entry: entry.clone(),
                header: meta_str(entry, "header").map(str::to_string),
                options: parse_options(entry),
                multi_select: meta_bool(entry, "multiSelect"),
            });
            continue;
        }
        b.flush_question_group();

        if special == Some("plan") {
            b.display.push(DisplayEntry::AssistantMessage {
                seq,
                entry: entry.clone(),
                is_plan: true,
            });
            continue;
        }
        if special == Some("plan_approval") {
            let answered = tool_use_id
                .and_then(|id| b.answered.get(id))
                .map(|_| "Plan approved".to_string());
            b.display.push(DisplayEntry::PlanApproval {
                seq,
                entry: entry.clone(),
                tool_use_id: tool_use_id.map(str::to_string),
                has_plan: meta_bool(entry, "has_plan") != Some(false),
                answered,
            });
            continue;
        }
        if special == Some("permission_request") {
            let answered = tool_use_id.and_then(|id| b.answered.get(id).cloned());
            b.display.push(DisplayEntry::PermissionRequest {
                seq,
                entry: entry.clone(),
                tool_name: meta_str(entry, "tool_name").unwrap_or("").to_string(),
                description: meta_str(entry, "description")
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&entry.content)
                    .to_string(),
                request_id: tool_use_id.unwrap_or("").to_string(),
                is_sub_agent: meta_truthy(entry, "subagent"),
                agent_label: meta_str(entry, "agent_label").map(str::to_string),
                answered,
            });
            continue;
        }
        if special == Some("session_restart") {
            b.display.push(DisplayEntry::Lifecycle {
                seq,
                entry: entry.clone(),
            });
            continue;
        }

        match entry.entry_type {
            OutputEntryType::Text => {
                if meta_str(entry, "role") == Some("user") {
                    b.display.push(DisplayEntry::UserMessage {
                        seq,
                        entry: entry.clone(),
                    });
                } else {
                    b.display.push(DisplayEntry::AssistantMessage {
                        seq,
                        entry: entry.clone(),
                        is_plan: false,
                    });
                }
            }
            // `thinking` never reaches here — is_action_entry absorbs it (CDX-085).
            OutputEntryType::Diff => b.display.push(DisplayEntry::Diff {
                seq,
                entry: entry.clone(),
            }),
            OutputEntryType::Error => b.display.push(DisplayEntry::Error {
                seq,
                entry: entry.clone(),
            }),
            OutputEntryType::System => b.display.push(DisplayEntry::System {
                seq,
                entry: entry.clone(),
            }),
            _ => b.display.push(DisplayEntry::AssistantMessage {
                seq,
                entry: entry.clone(),
                is_plan: false,
            }),
        }
    }

    b.flush_question_group();
    b.flush_tool_group();
    b.display
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingPermissionSummary {
    pub request_id: String,
    pub tool_name: String,
    pub description: String,
    pub is_sub_agent: bool,
    pub agent_label: Option<String>,
}

/// Latest still-pending permission request (no answering `tool_result`, not
/// optimistically responded). Drives the always-visible bar above the input —
/// an inline card buried under a collapsed sub-agent group is exactly how a
/// permission prompt goes unseen and deadlocks the session.
pub fn find_pending_permission(
    source: &[SeqEntry],
    responded_cards: Option<&BTreeSet<String>>,
) -> Option<PendingPermissionSummary> {
    if source.is_empty() {
        return None;
    }
    let answered = collect_answered_tool_use_ids(source);
    for item in source.iter().rev() {
        let entry = &item.entry;
        if special_of(entry) != Some("permission_request") {
            continue;
        }
        let Some(tool_use_id) = tool_use_id_of(entry) else {
            continue;
        };
        if answered.contains_key(tool_use_id)
            || responded_cards.is_some_and(|s| s.contains(tool_use_id))
        {
            continue;
        }
        return Some(PendingPermissionSummary {
            request_id: tool_use_id.to_string(),
            tool_name: meta_str(entry, "tool_name").unwrap_or("").to_string(),
            description: meta_str(entry, "description")
                .filter(|s| !s.is_empty())
                .unwrap_or(&entry.content)
                .to_string(),
            is_sub_agent: meta_truthy(entry, "subagent"),
            agent_label: meta_str(entry, "agent_label").map(str::to_string),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn e(entry_type: OutputEntryType, content: &str, metadata: serde_json::Value) -> OutputEntry {
        OutputEntry {
            entry_type,
            content: content.to_string(),
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            metadata: if metadata.is_null() { None } else { Some(metadata) },
            diff: None,
        }
    }

    /// Sequential-seq builder mirroring the TS test helper.
    struct Seqr(u64);
    impl Seqr {
        fn n(&mut self, entry: OutputEntry) -> SeqEntry {
            self.0 += 1;
            SeqEntry { seq: self.0, entry }
        }
    }

    fn kinds(d: &[DisplayEntry]) -> Vec<&'static str> {
        d.iter()
            .map(|x| match x {
                DisplayEntry::UserMessage { .. } => "user_message",
                DisplayEntry::AssistantMessage { .. } => "assistant_message",
                DisplayEntry::ToolGroup { .. } => "tool_group",
                DisplayEntry::Diff { .. } => "diff",
                DisplayEntry::Error { .. } => "error",
                DisplayEntry::System { .. } => "system",
                DisplayEntry::Lifecycle { .. } => "lifecycle",
                DisplayEntry::PlanApproval { .. } => "plan_approval",
                DisplayEntry::Question { .. } => "question",
                DisplayEntry::QuestionGroup { .. } => "question_group",
                DisplayEntry::PermissionRequest { .. } => "permission_request",
            })
            .collect()
    }

    #[test]
    fn maps_each_bridge_entry_kind_to_its_display_row() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::Text, "hello from user", json!({ "role": "user" }))),
            s.n(e(
                OutputEntryType::Text,
                "assistant standalone answer",
                json!({ "role": "assistant", "display_hint": "show" }),
            )),
            s.n(e(OutputEntryType::Error, "boom", json!({ "error_type": "error_during_execution" }))),
            s.n(e(OutputEntryType::System, "some status line", json!(null))),
            s.n(e(
                OutputEntryType::System,
                "Session interrupted — restarting (attempt 1)...",
                json!({ "special": "session_restart" }),
            )),
        ]);
        assert_eq!(
            kinds(&d),
            ["user_message", "assistant_message", "error", "system", "lifecycle"]
        );
    }

    #[test]
    fn groups_consecutive_tool_entries_plus_collapsed_text_into_one_tool_group() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::Text, "let me look", json!({ "role": "assistant", "display_hint": "collapse" }))),
            s.n(e(OutputEntryType::ToolUse, "Bash: ls", json!({ "tool_name": "Bash", "tool_use_id": "t1" }))),
            s.n(e(OutputEntryType::ToolResult, "file.txt", json!({ "tool_use_id": "t1" }))),
            s.n(e(OutputEntryType::Progress, "working…", json!(null))),
            s.n(e(OutputEntryType::Text, "done — here is the answer", json!({ "role": "assistant", "display_hint": "show" }))),
        ]);
        assert_eq!(kinds(&d), ["tool_group", "assistant_message"]);
        match &d[0] {
            DisplayEntry::ToolGroup { entries, summary, .. } => {
                assert_eq!(entries.len(), 4);
                assert_eq!(summary, "3 actions"); // collapsed text does not count
            }
            _ => panic!("expected tool_group"),
        }
    }

    #[test]
    fn plan_text_and_plan_approval_are_separate_rows_sharing_the_tool_use_id() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::Text, "# The plan\n1. do things", json!({ "role": "assistant", "special": "plan", "tool_use_id": "p1" }))),
            s.n(e(OutputEntryType::System, "Plan approval needed", json!({ "special": "plan_approval", "tool_use_id": "p1", "has_plan": true }))),
        ]);
        assert_eq!(kinds(&d), ["assistant_message", "plan_approval"]);
        assert!(matches!(&d[0], DisplayEntry::AssistantMessage { is_plan: true, .. }));
        match &d[1] {
            DisplayEntry::PlanApproval { has_plan, answered, .. } => {
                assert!(*has_plan);
                assert_eq!(*answered, None);
            }
            _ => panic!("expected plan_approval"),
        }
    }

    #[test]
    fn plan_approval_without_a_plan_carries_has_plan_false() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[s.n(e(
            OutputEntryType::System,
            "Plan approval needed",
            json!({ "special": "plan_approval", "tool_use_id": "p1", "has_plan": false }),
        ))]);
        assert!(matches!(&d[0], DisplayEntry::PlanApproval { has_plan: false, .. }));
    }

    #[test]
    fn a_tool_result_answering_the_plan_tool_use_id_marks_the_approval_answered() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::System, "Plan approval needed", json!({ "special": "plan_approval", "tool_use_id": "p1", "has_plan": true }))),
            s.n(e(OutputEntryType::ToolResult, "User approved the plan", json!({ "tool_use_id": "p1" }))),
        ]);
        let approval = d.iter().find(|x| matches!(x, DisplayEntry::PlanApproval { .. })).unwrap();
        match approval {
            DisplayEntry::PlanApproval { answered, .. } => {
                assert_eq!(answered.as_deref(), Some("Plan approved"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn single_ask_question_becomes_a_question_card_with_options() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[s.n(e(
            OutputEntryType::System,
            "Which color?",
            json!({
                "special": "ask_question", "tool_use_id": "q1", "header": "Color",
                "options": [{ "label": "red" }, { "label": "blue", "description": "cool" }],
                "multiSelect": false, "question_index": 0, "question_count": 1
            }),
        ))]);
        assert_eq!(d.len(), 1);
        match &d[0] {
            DisplayEntry::Question { tool_use_id, question, .. } => {
                assert_eq!(tool_use_id.as_deref(), Some("q1"));
                assert_eq!(question.header.as_deref(), Some("Color"));
                assert_eq!(question.options.as_ref().unwrap().len(), 2);
                assert_eq!(question.options.as_ref().unwrap()[1].description.as_deref(), Some("cool"));
            }
            _ => panic!("expected question"),
        }
    }

    #[test]
    fn multi_question_group_buffers_and_sorts_by_index() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::System, "Second?", json!({ "special": "ask_question", "tool_use_id": "q1", "header": "B", "question_index": 1, "question_count": 2 }))),
            s.n(e(OutputEntryType::System, "First?", json!({ "special": "ask_question", "tool_use_id": "q1", "header": "A", "question_index": 0, "question_count": 2 }))),
        ]);
        assert_eq!(d.len(), 1);
        match &d[0] {
            DisplayEntry::QuestionGroup { tool_use_id, questions, .. } => {
                assert_eq!(tool_use_id, "q1");
                assert_eq!(
                    questions.iter().map(|q| q.header.as_deref().unwrap()).collect::<Vec<_>>(),
                    ["A", "B"]
                );
            }
            _ => panic!("expected question_group"),
        }
    }

    #[test]
    fn permission_request_card_fields_and_tool_result_resolution() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[s.n(e(
            OutputEntryType::System,
            "Permission needed: Bash",
            json!({
                "special": "permission_request", "tool_name": "Bash", "tool_use_id": "perm1",
                "tool_input": { "command": "rm -rf build" }, "description": "Run rm -rf build",
                "subagent": true, "agent_label": "Plan"
            }),
        ))]);
        match &d[0] {
            DisplayEntry::PermissionRequest {
                tool_name, request_id, description, is_sub_agent, agent_label, answered, ..
            } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(request_id, "perm1");
                assert_eq!(description, "Run rm -rf build");
                assert!(*is_sub_agent);
                assert_eq!(agent_label.as_deref(), Some("Plan"));
                assert_eq!(*answered, None);
            }
            _ => panic!("expected permission_request"),
        }

        let mut s = Seqr(0);
        let resolved = build_display_entries(&[
            s.n(e(OutputEntryType::System, "Permission needed: Bash", json!({ "special": "permission_request", "tool_name": "Bash", "tool_use_id": "perm1" }))),
            s.n(e(OutputEntryType::ToolResult, "User denied", json!({ "tool_use_id": "perm1" }))),
        ]);
        let card = resolved.iter().find(|x| matches!(x, DisplayEntry::PermissionRequest { .. })).unwrap();
        match card {
            DisplayEntry::PermissionRequest { answered, .. } => {
                assert_eq!(answered.as_deref(), Some("User denied"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn filters_per_turn_noise() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::System, "", json!({ "stream_end": true }))),
            s.n(e(OutputEntryType::System, "Tokens: 10 in / 20 out", json!({ "usage": {} }))),
            s.n(e(OutputEntryType::System, "Claude Code 2.0.1 (claude-opus-4)", json!({ "subtype": "init" }))),
            s.n(e(OutputEntryType::System, "Session complete — 3 turns, $0.0421", json!({ "subtype": "result" }))),
            s.n(e(OutputEntryType::Text, "visible", json!({ "role": "assistant" }))),
        ]);
        assert_eq!(kinds(&d), ["assistant_message"]);
    }

    #[test]
    fn is_hidden_system_entry_never_hides_special_cards() {
        let entry = e(
            OutputEntryType::System,
            "",
            json!({ "special": "permission_request", "tool_use_id": "x" }),
        );
        assert!(!is_hidden_system_entry(&entry));
    }

    #[test]
    fn find_pending_permission_returns_latest_unanswered_unresponded() {
        let mut s = Seqr(0);
        let entries = [
            s.n(e(OutputEntryType::System, "perm A", json!({ "special": "permission_request", "tool_name": "Bash", "tool_use_id": "a" }))),
            s.n(e(OutputEntryType::ToolResult, "User denied", json!({ "tool_use_id": "a" }))),
            s.n(e(OutputEntryType::System, "perm B", json!({ "special": "permission_request", "tool_name": "Edit", "tool_use_id": "b" }))),
        ];
        assert_eq!(
            find_pending_permission(&entries, None).unwrap().request_id,
            "b"
        );
        let responded: BTreeSet<String> = ["b".to_string()].into_iter().collect();
        assert_eq!(find_pending_permission(&entries, Some(&responded)), None);
    }

    #[test]
    fn thinking_is_absorbed_into_the_action_group_and_counts_cdx_085() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::ToolUse, "Bash: ls", json!({ "tool_name": "Bash", "tool_use_id": "t1" }))),
            s.n(e(OutputEntryType::Thinking, "hmm", json!({ "role": "assistant" }))),
            s.n(e(OutputEntryType::ToolUse, "Bash: pwd", json!({ "tool_name": "Bash", "tool_use_id": "t2" }))),
        ]);
        assert_eq!(kinds(&d), ["tool_group"]);
        match &d[0] {
            DisplayEntry::ToolGroup { entries, summary, .. } => {
                assert_eq!(entries.len(), 3);
                assert_eq!(summary, "3 actions");
                assert_eq!(
                    entries.iter().map(|x| x.entry.entry_type).collect::<Vec<_>>(),
                    [OutputEntryType::ToolUse, OutputEntryType::Thinking, OutputEntryType::ToolUse]
                );
            }
            _ => panic!("expected tool_group"),
        }
    }

    #[test]
    fn a_lone_thinking_step_is_one_action_and_owns_the_group_seq() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::Thinking, "let me reason…", json!({ "role": "assistant" }))),
            s.n(e(OutputEntryType::Text, "the answer", json!({ "role": "assistant", "display_hint": "show" }))),
        ]);
        assert_eq!(kinds(&d), ["tool_group", "assistant_message"]);
        match &d[0] {
            DisplayEntry::ToolGroup { seq, entries, summary } => {
                assert_eq!(summary, "1 action");
                assert_eq!(entries[0].entry.content, "let me reason…");
                assert_eq!(*seq, entries[0].seq);
            }
            _ => panic!("expected tool_group"),
        }
    }

    #[test]
    fn redacted_thinking_is_carried_into_the_group() {
        let mut s = Seqr(0);
        let d = build_display_entries(&[s.n(e(
            OutputEntryType::Thinking,
            "",
            json!({ "role": "assistant", "redacted": true }),
        ))]);
        assert_eq!(d.len(), 1);
        match &d[0] {
            DisplayEntry::ToolGroup { entries, summary, .. } => {
                assert_eq!(summary, "1 action");
                assert_eq!(
                    entries[0].entry.metadata.as_ref().unwrap().get("redacted"),
                    Some(&json!(true))
                );
            }
            _ => panic!("expected tool_group"),
        }
    }

    #[test]
    fn diff_routes_to_its_own_row_and_is_never_absorbed() {
        let diff_entry = |seq: u64| SeqEntry {
            seq,
            entry: OutputEntry {
                entry_type: OutputEntryType::Diff,
                content: "-const a = 1;\n+const a = 2;".to_string(),
                timestamp: "2026-08-08T00:00:00.000Z".to_string(),
                metadata: Some(json!({ "role": "assistant", "tool_name": "Edit", "tool_use_id": "toolu_d1" })),
                diff: None,
            },
        };

        let d = build_display_entries(&[diff_entry(1)]);
        assert_eq!(kinds(&d), ["diff"]);

        let mut s = Seqr(1);
        let d = build_display_entries(&[
            s.n(e(OutputEntryType::ToolUse, "Edit: src/app.ts", json!({ "tool_name": "Edit", "tool_use_id": "toolu_d1" }))),
            diff_entry(3),
            s.n(e(OutputEntryType::ToolResult, "ok", json!({ "tool_use_id": "toolu_d1" }))),
        ]);
        // the diff splits the tool entries into two groups around a visible card
        assert_eq!(kinds(&d), ["tool_group", "diff", "tool_group"]);
    }
}
