//! `display_entries` — pure transform from the flat transcript (`seq` +
//! typed [`OutputEntry`]) to grouped, render-ready rows. Clients render these
//! rows; they never interpret wire entries themselves.
//!
//! - `text` role=user → user message bubble; role=agent → agent markdown,
//!   which splits the tool activity around it into separate groups — the
//!   agent narrating what it does next reads between the steps. A
//!   sub-agent's text is not the conversation: it folds into the group.
//! - `plan` → plan markdown (stays visible).
//! - `tool_call` / `tool_result` / `thinking` → one collapsed group per run,
//!   summarized the way a person would say it ("Ran 3 commands, read a
//!   file"). A call carries its result wherever the result landed in the
//!   transcript (a permission card between the two does not split them); a
//!   result whose call is unknown stays a step of its own.
//! - `diff` → folded into the call that made it (its lines and +/− counts
//!   ride the call, and the counts add up on the group); a diff no known
//!   call claims is a standalone card.
//! - `permission_request` / `plan_approval` → a card each; consecutive
//!   `question` entries sharing a `request_id` → one question card.
//! - `resolved` marks the card with that `request_id` answered (its summary is
//!   the outcome shown) and renders nothing itself.
//! - `notice` → a lifecycle / notice line; `status` → a status line; `error` →
//!   an error row; `turn_complete` and empty status lines → hidden.

use std::collections::{BTreeSet, HashMap, HashSet};

use protocol::common::{
    DiffLine, DiffLineType, EntryBody, NoticeKind, OptionChoice, OutputEntry, PermissionOption,
    QuestionOption, Role, ToolKind,
};
use serde::Serialize;

// These rows cross to the UI as one JSON blob per session (`crates/client-ffi`'s
// `UniffiTranscriptRowsView.display_entries_json`). `tag = "kind"` gives
// Kotlin's polymorphic decoder a discriminant to match its sealed classes on,
// which is why the tool / notice kinds are named `toolKind` / `notice` here.

#[derive(Debug, Clone, PartialEq)]
pub struct SeqEntry {
    pub seq: u64,
    pub entry: OutputEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultView {
    pub text: String,
    pub is_error: bool,
}

/// One file a call changed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffView {
    pub path: String,
    pub lines: Vec<DiffLine>,
    pub truncated: bool,
    pub added: u32,
    pub removed: u32,
}

impl FileDiffView {
    fn new(path: &str, lines: &[DiffLine], truncated: bool) -> Self {
        let count = |k: DiffLineType| lines.iter().filter(|l| l.kind == k).count() as u32;
        Self {
            path: path.to_string(),
            lines: lines.to_vec(),
            truncated,
            added: count(DiffLineType::Add),
            removed: count(DiffLineType::Del),
        }
    }
}

/// One step inside a collapsed tool group. A call is most of the steps, so
/// boxing it to shrink the rarer variants would cost an allocation on the
/// common one for nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "step", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolStep {
    Call {
        seq: u64,
        call_id: String,
        tool_name: String,
        tool_kind: ToolKind,
        title: String,
        /// The call's whole input, when it says more than `title`.
        input: Option<String>,
        /// What the call did, for a line naming it: `Ran`, `Read`, `Edited`.
        verb: String,
        /// The same while it runs: `Running`, `Reading`, `Editing`.
        active_verb: String,
        /// Label of the sub-agent that made the call, if one did.
        subagent: Option<String>,
        is_sub_agent: bool,
        result: Option<ToolResultView>,
        /// The files the call changed, in the order their diffs arrived.
        diffs: Vec<FileDiffView>,
    },
    /// A result whose call is not in the transcript.
    Result { seq: u64, text: String, is_error: bool },
    Thinking { seq: u64, text: String, redacted: bool },
    /// Text a sub-agent wrote while it worked.
    Text { seq: u64, text: String },
}

/// How a group names one kind of call: the verb of a lone call (`Ran` +
/// its command), the verb while it runs, and the clause for one or `{n}` of
/// them in a summary ("ran 3 commands").
struct Phrase {
    verb: &'static str,
    active: &'static str,
    one: &'static str,
    many: &'static str,
}

fn phrase(kind: ToolKind) -> Phrase {
    let p = |verb, active, one, many| Phrase { verb, active, one, many };
    match kind {
        ToolKind::Read => p("Read", "Reading", "read a file", "read {n} files"),
        ToolKind::Edit => p("Edited", "Editing", "edited a file", "edited {n} files"),
        ToolKind::Delete => p("Deleted", "Deleting", "deleted a file", "deleted {n} files"),
        ToolKind::Move => p("Moved", "Moving", "moved a file", "moved {n} files"),
        ToolKind::Search => p("Searched", "Searching", "searched for a pattern", "searched for {n} patterns"),
        ToolKind::Execute => p("Ran", "Running", "ran a command", "ran {n} commands"),
        ToolKind::Think => p("Planned", "Planning", "updated the plan", "updated the plan {n} times"),
        ToolKind::Fetch => p("Fetched", "Fetching", "fetched a page", "fetched {n} pages"),
        ToolKind::SwitchMode => p("Switched mode", "Switching mode", "switched mode", "switched mode {n} times"),
        ToolKind::Agent => p("Agent", "Agent working on", "ran an agent", "ran {n} agents"),
        ToolKind::Other => p("Used", "Using", "used a tool", "used {n} tools"),
    }
}

fn capitalized(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

/// A group's headline and the totals its row shows.
struct GroupSummary {
    summary: String,
    subject: Option<String>,
    added: u32,
    removed: u32,
    failed: u32,
}

/// "Ran 3 commands, read a file": each kind of call in the order it first
/// appears; how many failed is counted apart, for the row to show as it
/// shows failure. A lone call is its verb and `subject` its title (an
/// `other` tool, whose title is raw arguments, shows its name). Thinking
/// alone is "Thought".
fn summarize(steps: &[ToolStep]) -> GroupSummary {
    let mut counts: Vec<(ToolKind, usize)> = Vec::new();
    let (mut added, mut removed, mut failed, mut results, mut thinking) = (0, 0, 0, 0, false);
    let mut lone: Option<&ToolStep> = None;
    for step in steps {
        match step {
            ToolStep::Call { tool_kind, result, diffs, .. } => {
                match counts.iter_mut().find(|(k, _)| k == tool_kind) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((*tool_kind, 1)),
                }
                failed += u32::from(result.as_ref().is_some_and(|r| r.is_error));
                added += diffs.iter().map(|d| d.added).sum::<u32>();
                removed += diffs.iter().map(|d| d.removed).sum::<u32>();
                lone = Some(step);
            }
            ToolStep::Result { is_error, .. } => {
                results += 1;
                failed += u32::from(*is_error);
            }
            ToolStep::Thinking { .. } => thinking = true,
            ToolStep::Text { .. } => {}
        }
    }
    let calls: usize = counts.iter().map(|(_, n)| n).sum();
    let (summary, subject) = match (calls, lone) {
        (1, Some(ToolStep::Call { tool_kind, title, tool_name, .. })) if results == 0 => {
            let subject = if *tool_kind == ToolKind::Other { tool_name } else { title };
            (phrase(*tool_kind).verb.to_string(), Some(subject.clone()))
        }
        (0, _) if results == 0 => ((if thinking { "Thought" } else { "Worked" }).to_string(), None),
        _ => {
            let mut parts: Vec<String> = counts
                .iter()
                .map(|(kind, n)| {
                    let p = phrase(*kind);
                    if *n == 1 { p.one.to_string() } else { p.many.replace("{n}", &n.to_string()) }
                })
                .collect();
            if results > 0 {
                parts.push(if results == 1 { "got a result".into() } else { format!("got {results} results") });
            }
            (capitalized(&parts.join(", ")), None)
        }
    };
    GroupSummary { summary, subject, added, removed, failed }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionView {
    pub index: u32,
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

/// One rendered row. `seq` is the stable key — the seq of the first entry
/// making up this item.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DisplayEntry {
    UserMessage {
        seq: u64,
        text: String,
    },
    AgentMessage {
        seq: u64,
        text: String,
        /// A `plan` entry: rendered framed as a plan document.
        is_plan: bool,
    },
    ToolGroup {
        seq: u64,
        steps: Vec<ToolStep>,
        /// "Ran 3 commands, read a file"; for a lone call, its verb ("Ran"),
        /// with `subject` what it acted on ("npm test").
        summary: String,
        subject: Option<String>,
        /// Lines the group's calls added and removed, over every file.
        added: u32,
        removed: u32,
        /// Calls whose result is an error.
        failed: u32,
    },
    Diff {
        seq: u64,
        path: String,
        lines: Vec<DiffLine>,
        truncated: bool,
    },
    Error {
        seq: u64,
        text: String,
    },
    Status {
        seq: u64,
        text: String,
    },
    Notice {
        seq: u64,
        notice: NoticeKind,
        text: String,
    },
    PlanApproval {
        seq: u64,
        request_id: String,
        options: Vec<OptionChoice>,
        /// The outcome, once a `resolved` entry answered it.
        answered: Option<String>,
    },
    Question {
        seq: u64,
        request_id: String,
        /// Sorted by `index`; one element for a single question.
        questions: Vec<QuestionView>,
        answered: Option<String>,
    },
    PermissionRequest {
        seq: u64,
        request_id: String,
        tool_name: String,
        tool_kind: ToolKind,
        title: String,
        description: Option<String>,
        locations: Vec<String>,
        options: Vec<PermissionOption>,
        /// Why the agent asks, when it says.
        reason: Option<String>,
        /// The hook that asked, when one did.
        hook: Option<String>,
        /// The plugin that hook comes from, when known.
        hook_plugin: Option<String>,
        is_sub_agent: bool,
        agent_label: Option<String>,
        answered: Option<String>,
    },
}

impl DisplayEntry {
    /// The seq of the first transcript entry this row is built from: each
    /// entry lands in at most one row, so it keys the row across rebuilds
    /// (a later result or answer changes a row's content, never its key).
    pub fn seq(&self) -> u64 {
        match self {
            DisplayEntry::UserMessage { seq, .. }
            | DisplayEntry::AgentMessage { seq, .. }
            | DisplayEntry::ToolGroup { seq, .. }
            | DisplayEntry::Diff { seq, .. }
            | DisplayEntry::Error { seq, .. }
            | DisplayEntry::Status { seq, .. }
            | DisplayEntry::Notice { seq, .. }
            | DisplayEntry::PlanApproval { seq, .. }
            | DisplayEntry::Question { seq, .. }
            | DisplayEntry::PermissionRequest { seq, .. } => *seq,
        }
    }
}

/// Entries the transcript never shows as a row of their own.
pub fn is_hidden_entry(entry: &OutputEntry) -> bool {
    match &entry.body {
        EntryBody::TurnComplete {} | EntryBody::Resolved { .. } => true,
        EntryBody::Status { text } => text.trim().is_empty(),
        _ => false,
    }
}

/// `request_id` → outcome summary, from `resolved` entries (the latest wins).
pub fn collect_resolved(entries: &[SeqEntry]) -> HashMap<String, String> {
    let mut resolved = HashMap::new();
    for item in entries {
        if let EntryBody::Resolved { request_id, summary } = &item.entry.body {
            resolved.insert(request_id.clone(), summary.clone());
        }
    }
    resolved
}

fn subagent_label(entry: &OutputEntry) -> Option<String> {
    entry.subagent.as_ref().and_then(|s| s.label.clone())
}

struct Builder {
    display: Vec<DisplayEntry>,
    resolved: HashMap<String, String>,
    steps: Vec<ToolStep>,
    group_seq: u64,
    questions: Vec<QuestionView>,
    question_request: Option<String>,
    question_seq: u64,
}

impl Builder {
    fn push_step(&mut self, seq: u64, step: ToolStep) {
        self.flush_questions();
        if self.steps.is_empty() {
            self.group_seq = seq;
        }
        self.steps.push(step);
    }

    fn flush_group(&mut self) {
        if self.steps.is_empty() {
            return;
        }
        let steps = std::mem::take(&mut self.steps);
        let GroupSummary { summary, subject, added, removed, failed } = summarize(&steps);
        self.display.push(DisplayEntry::ToolGroup {
            seq: self.group_seq,
            steps,
            summary,
            subject,
            added,
            removed,
            failed,
        });
    }

    fn flush_questions(&mut self) {
        let Some(request_id) = self.question_request.take() else {
            return;
        };
        let mut questions = std::mem::take(&mut self.questions);
        questions.sort_by_key(|q| q.index);
        self.display.push(DisplayEntry::Question {
            seq: self.question_seq,
            answered: self.resolved.get(&request_id).cloned(),
            request_id,
            questions,
        });
    }

    /// Everything that is not a tool step or a question ends both open runs.
    fn flush_all(&mut self) {
        self.flush_group();
        self.flush_questions();
    }
}

pub fn build_display_entries(source: &[SeqEntry]) -> Vec<DisplayEntry> {
    // Results by call id, and the calls that exist, so a call carries its
    // result wherever it landed and a paired result never renders twice.
    let mut results: HashMap<&str, ToolResultView> = HashMap::new();
    let mut calls: HashSet<&str> = HashSet::new();
    let mut diffs: HashMap<&str, Vec<FileDiffView>> = HashMap::new();
    for item in source {
        match &item.entry.body {
            EntryBody::ToolResult { call_id, text, is_error } => {
                results.insert(
                    call_id,
                    ToolResultView {
                        text: text.clone(),
                        is_error: *is_error,
                    },
                );
            }
            EntryBody::ToolCall { call_id, .. } => {
                calls.insert(call_id);
            }
            _ => {}
        }
    }
    // Only diffs whose call is known fold into it; the rest stay cards.
    for item in source {
        if let EntryBody::Diff { path, lines, truncated, call_id: Some(call_id) } = &item.entry.body {
            if calls.contains(call_id.as_str()) {
                diffs.entry(call_id).or_default().push(FileDiffView::new(path, lines, *truncated));
            }
        }
    }

    let mut b = Builder {
        display: Vec::new(),
        resolved: collect_resolved(source),
        steps: Vec::new(),
        group_seq: 0,
        questions: Vec::new(),
        question_request: None,
        question_seq: 0,
    };

    for item in source.iter().filter(|e| !is_hidden_entry(&e.entry)) {
        let seq = item.seq;
        let entry = &item.entry;
        match &entry.body {
            EntryBody::ToolCall {
                call_id,
                tool_name,
                kind,
                title,
                input,
                ..
            } => {
                let subagent = subagent_label(entry);
                let p = phrase(*kind);
                b.push_step(
                    seq,
                    ToolStep::Call {
                        seq,
                        call_id: call_id.clone(),
                        tool_name: tool_name.clone(),
                        tool_kind: *kind,
                        title: title.clone(),
                        input: input.clone(),
                        verb: p.verb.to_string(),
                        active_verb: p.active.to_string(),
                        is_sub_agent: entry.subagent.is_some(),
                        subagent,
                        result: results.get(call_id.as_str()).cloned(),
                        diffs: diffs.remove(call_id.as_str()).unwrap_or_default(),
                    },
                );
            }
            EntryBody::ToolResult { call_id, text, is_error } => {
                if !calls.contains(call_id.as_str()) {
                    b.push_step(
                        seq,
                        ToolStep::Result {
                            seq,
                            text: text.clone(),
                            is_error: *is_error,
                        },
                    );
                }
            }
            EntryBody::Thinking { text, redacted } => b.push_step(
                seq,
                ToolStep::Thinking {
                    seq,
                    text: text.clone(),
                    redacted: *redacted,
                },
            ),
            EntryBody::Text { role: Role::Agent, text, .. } if entry.subagent.is_some() => {
                b.push_step(seq, ToolStep::Text { seq, text: text.clone() })
            }
            EntryBody::Question {
                request_id,
                index,
                header,
                question,
                options,
                multi_select,
                ..
            } => {
                b.flush_group();
                if b.question_request.as_deref() != Some(request_id.as_str()) {
                    b.flush_questions();
                    b.question_request = Some(request_id.clone());
                    b.question_seq = seq;
                }
                b.questions.push(QuestionView {
                    index: *index,
                    header: header.clone(),
                    question: question.clone(),
                    options: options.clone(),
                    multi_select: *multi_select,
                });
            }
            EntryBody::Text { role, text, .. } => {
                b.flush_all();
                b.display.push(match role {
                    Role::User => DisplayEntry::UserMessage { seq, text: text.clone() },
                    Role::Agent => DisplayEntry::AgentMessage {
                        seq,
                        text: text.clone(),
                        is_plan: false,
                    },
                });
            }
            EntryBody::Plan { text } => {
                b.flush_all();
                b.display.push(DisplayEntry::AgentMessage {
                    seq,
                    text: text.clone(),
                    is_plan: true,
                });
            }
            // Folded into its call above.
            EntryBody::Diff { call_id: Some(call_id), .. } if calls.contains(call_id.as_str()) => {}
            EntryBody::Diff {
                path, lines, truncated, ..
            } => {
                b.flush_all();
                b.display.push(DisplayEntry::Diff {
                    seq,
                    path: path.clone(),
                    lines: lines.clone(),
                    truncated: *truncated,
                });
            }
            EntryBody::PermissionRequest {
                request_id,
                tool_name,
                kind,
                title,
                description,
                locations,
                options,
                reason,
                hook,
                hook_plugin,
                ..
            } => {
                b.flush_all();
                b.display.push(DisplayEntry::PermissionRequest {
                    seq,
                    answered: b.resolved.get(request_id).cloned(),
                    request_id: request_id.clone(),
                    tool_name: tool_name.clone(),
                    tool_kind: *kind,
                    title: title.clone(),
                    description: description.clone(),
                    locations: locations.clone(),
                    options: options.clone(),
                    reason: reason.clone(),
                    hook: hook.clone(),
                    hook_plugin: hook_plugin.clone(),
                    is_sub_agent: entry.subagent.is_some(),
                    agent_label: subagent_label(entry),
                });
            }
            EntryBody::PlanApproval { request_id, options } => {
                b.flush_all();
                b.display.push(DisplayEntry::PlanApproval {
                    seq,
                    answered: b.resolved.get(request_id).cloned(),
                    request_id: request_id.clone(),
                    options: options.clone(),
                });
            }
            EntryBody::Notice { kind, text } => {
                b.flush_all();
                b.display.push(DisplayEntry::Notice {
                    seq,
                    notice: *kind,
                    text: text.clone(),
                });
            }
            EntryBody::Status { text } => {
                b.flush_all();
                b.display.push(DisplayEntry::Status { seq, text: text.clone() });
            }
            EntryBody::Error { text } => {
                b.flush_all();
                b.display.push(DisplayEntry::Error { seq, text: text.clone() });
            }
            // Filtered above; listed so a new entry kind is a compile error here.
            EntryBody::Resolved { .. } | EntryBody::TurnComplete {} => {}
        }
    }

    b.flush_all();
    b.display
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionSummary {
    pub request_id: String,
    pub tool_name: String,
    pub title: String,
    pub description: Option<String>,
    pub options: Vec<PermissionOption>,
    pub reason: Option<String>,
    pub hook: Option<String>,
    pub hook_plugin: Option<String>,
    pub is_sub_agent: bool,
    pub agent_label: Option<String>,
}

/// Latest still-pending permission request (not resolved, not optimistically
/// responded). Drives the always-visible bar above the input — an inline card
/// buried under a collapsed sub-agent group is exactly how a permission
/// prompt goes unseen and deadlocks the session.
pub fn find_pending_permission(
    source: &[SeqEntry],
    responded_cards: Option<&BTreeSet<String>>,
) -> Option<PendingPermissionSummary> {
    let resolved = collect_resolved(source);
    source.iter().rev().find_map(|item| {
        let EntryBody::PermissionRequest {
            request_id,
            tool_name,
            title,
            description,
            options,
            reason,
            hook,
            hook_plugin,
            ..
        } = &item.entry.body
        else {
            return None;
        };
        if resolved.contains_key(request_id) || responded_cards.is_some_and(|s| s.contains(request_id)) {
            return None;
        }
        Some(PendingPermissionSummary {
            request_id: request_id.clone(),
            tool_name: tool_name.clone(),
            title: title.clone(),
            description: description.clone(),
            options: options.clone(),
            reason: reason.clone(),
            hook: hook.clone(),
            hook_plugin: hook_plugin.clone(),
            is_sub_agent: item.entry.subagent.is_some(),
            agent_label: subagent_label(&item.entry),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::Subagent;
    use serde_json::json;

    /// Entries from their exact wire JSON — keeps the tests honest against
    /// the protocol's own decoder.
    fn seq(entries: &[serde_json::Value]) -> Vec<SeqEntry> {
        entries
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let mut v = v.clone();
                v["timestamp"] = json!("2026-08-05T00:00:00.000Z");
                SeqEntry {
                    seq: i as u64 + 1,
                    entry: serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v} -> {e}")),
                }
            })
            .collect()
    }

    fn kinds(d: &[DisplayEntry]) -> Vec<&'static str> {
        d.iter()
            .map(|x| match x {
                DisplayEntry::UserMessage { .. } => "user",
                DisplayEntry::AgentMessage { is_plan: true, .. } => "plan",
                DisplayEntry::AgentMessage { .. } => "agent",
                DisplayEntry::ToolGroup { .. } => "tools",
                DisplayEntry::Diff { .. } => "diff",
                DisplayEntry::Error { .. } => "error",
                DisplayEntry::Status { .. } => "status",
                DisplayEntry::Notice { .. } => "notice",
                DisplayEntry::PlanApproval { .. } => "plan_approval",
                DisplayEntry::Question { .. } => "question",
                DisplayEntry::PermissionRequest { .. } => "permission",
            })
            .collect()
    }

    fn call(id: &str) -> serde_json::Value {
        json!({"entryType":"tool_call","callId":id,"toolName":"Bash","kind":"execute","title":format!("run {id}")})
    }
    fn result(id: &str, text: &str) -> serde_json::Value {
        json!({"entryType":"tool_result","callId":id,"text":text})
    }
    fn perm(id: &str) -> serde_json::Value {
        json!({"entryType":"permission_request","requestId":id,"toolName":"Bash","kind":"execute","title":"rm x",
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}]})
    }

    fn summary_of(d: &DisplayEntry) -> (String, Option<String>) {
        let DisplayEntry::ToolGroup { summary, subject, .. } = d else { panic!("{d:?}") };
        (summary.clone(), subject.clone())
    }

    #[test]
    fn the_agents_narration_splits_its_actions_into_groups() {
        let d = build_display_entries(&seq(&[
            json!({"entryType":"text","role":"user","text":"fix it"}),
            json!({"entryType":"thinking","text":"hmm"}),
            json!({"entryType":"text","role":"agent","text":"Checking.","collapsible":true}),
            call("c1"),
            result("c1", "ok"),
            json!({"entryType":"text","role":"agent","text":"Done."}),
            json!({"entryType":"turn_complete"}),
        ]));
        assert_eq!(kinds(&d), ["user", "tools", "agent", "tools", "agent"]);
        assert_eq!(summary_of(&d[1]), ("Thought".into(), None));
        let DisplayEntry::ToolGroup { steps, seq, .. } = &d[3] else { panic!() };
        assert_eq!(*seq, 4);
        // the result rides its call
        assert_eq!(steps.len(), 1);
        assert!(matches!(&steps[0], ToolStep::Call { result: Some(r), verb, active_verb, .. }
            if r.text == "ok" && verb == "Ran" && active_verb == "Running"));
    }

    #[test]
    fn a_group_is_summarized_by_what_its_calls_did() {
        let read = |id: &str| json!({"entryType":"tool_call","callId":id,"toolName":"Read","kind":"read","title":"a.rs"});
        let d = build_display_entries(&seq(&[call("c1")]));
        assert_eq!(summary_of(&d[0]), ("Ran".into(), Some("run c1".into())));

        let d = build_display_entries(&seq(&[
            call("c1"),
            read("r1"),
            call("c2"),
            json!({"entryType":"tool_result","callId":"c2","text":"boom","isError":true}),
            call("c3"),
        ]));
        assert_eq!(summary_of(&d[0]), ("Ran 3 commands, read a file".into(), None));
        let DisplayEntry::ToolGroup { failed, .. } = &d[0] else { panic!() };
        assert_eq!(*failed, 1);

        // an `other` tool alone is named by its tool, not its raw arguments
        let d = build_display_entries(&seq(&[json!({"entryType":"tool_call","callId":"m","toolName":"mcp__gh__issue","kind":"other","title":"{\"n\":1}"})]));
        assert_eq!(summary_of(&d[0]), ("Used".into(), Some("mcp__gh__issue".into())));
    }

    #[test]
    fn a_diff_folds_into_its_call_and_counts_on_the_group() {
        let edit = json!({"entryType":"tool_call","callId":"e1","toolName":"Edit","kind":"edit","title":"a.rs"});
        let diff = |call: &str| json!({"entryType":"diff","path":"a.rs","callId":call,"lines":[
            {"type":"del","text":"x"},{"type":"add","text":"y"},{"type":"add","text":"z"},{"type":"context","text":"w"}]});
        let d = build_display_entries(&seq(&[edit, diff("e1"), result("e1", "ok"), diff("nobody")]));
        assert_eq!(kinds(&d), ["tools", "diff"]);
        let DisplayEntry::ToolGroup { steps, added, removed, .. } = &d[0] else { panic!() };
        assert_eq!((*added, *removed), (2, 1));
        let ToolStep::Call { diffs, .. } = &steps[0] else { panic!() };
        assert_eq!(diffs.len(), 1);
        assert_eq!((diffs[0].added, diffs[0].removed, diffs[0].lines.len()), (2, 1, 4));
    }

    #[test]
    fn a_sub_agents_text_folds_into_the_group() {
        let d = build_display_entries(&seq(&[
            call("c1"),
            json!({"entryType":"text","role":"agent","text":"looking","subagent":{}}),
            call("c2"),
        ]));
        assert_eq!(kinds(&d), ["tools"]);
        assert_eq!(summary_of(&d[0]).0, "Ran 2 commands");
    }

    #[test]
    fn a_result_after_a_permission_card_still_joins_its_call() {
        let d = build_display_entries(&seq(&[
            call("c1"),
            perm("c1"),
            json!({"entryType":"resolved","requestId":"c1","summary":"Allowed"}),
            result("c1", "removed"),
        ]));
        // the result renders with its call, not as a second group
        assert_eq!(kinds(&d), ["tools", "permission"]);
        let DisplayEntry::ToolGroup { steps, .. } = &d[0] else { panic!() };
        assert!(matches!(&steps[0], ToolStep::Call { result: Some(r), .. } if r.text == "removed"));
        let DisplayEntry::PermissionRequest { answered, options, .. } = &d[1] else { panic!() };
        assert_eq!(answered.as_deref(), Some("Allowed"));
        assert_eq!(options.len(), 2);
    }

    #[test]
    fn a_result_without_a_known_call_is_its_own_step() {
        let d = build_display_entries(&seq(&[result("ghost", "orphan")]));
        let DisplayEntry::ToolGroup { steps, summary, .. } = &d[0] else { panic!() };
        assert!(matches!(&steps[0], ToolStep::Result { text, .. } if text == "orphan"));
        assert_eq!(summary, "Got a result");
    }

    #[test]
    fn diffs_notices_status_and_errors_break_a_group_and_render_alone() {
        let d = build_display_entries(&seq(&[
            call("c1"),
            json!({"entryType":"diff","path":"a.rs","lines":[{"type":"add","text":"x"}]}),
            call("c2"),
            json!({"entryType":"notice","kind":"session_restart","text":"restarted"}),
            json!({"entryType":"status","text":"compacting"}),
            json!({"entryType":"status","text":"   "}),
            json!({"entryType":"error","text":"boom"}),
            json!({"entryType":"plan","text":"1. x"}),
        ]));
        assert_eq!(kinds(&d), ["tools", "diff", "tools", "notice", "status", "error", "plan"]);
    }

    #[test]
    fn questions_sharing_a_request_become_one_card_in_index_order() {
        let q = |i: u32| json!({"entryType":"question","requestId":"q","index":i,"count":2,"header":format!("H{i}"),"question":"?","options":[{"label":"A"}]});
        let d = build_display_entries(&seq(&[
            q(1),
            q(0),
            json!({"entryType":"question","requestId":"other","index":0,"count":1,"question":"?"}),
            json!({"entryType":"resolved","requestId":"q","summary":"Answered"}),
        ]));
        assert_eq!(kinds(&d), ["question", "question"]);
        let DisplayEntry::Question { questions, answered, request_id, .. } = &d[0] else { panic!() };
        assert_eq!(request_id, "q");
        assert_eq!(questions.iter().map(|q| q.index).collect::<Vec<_>>(), [0, 1]);
        assert_eq!(answered.as_deref(), Some("Answered"));
        let DisplayEntry::Question { answered, .. } = &d[1] else { panic!() };
        assert_eq!(*answered, None);
    }

    #[test]
    fn plan_approval_carries_its_options_and_outcome() {
        let d = build_display_entries(&seq(&[
            json!({"entryType":"plan_approval","requestId":"p","options":[{"id":"approve","label":"Approve"}]}),
            json!({"entryType":"resolved","requestId":"p","summary":"Plan approved"}),
        ]));
        let DisplayEntry::PlanApproval { options, answered, .. } = &d[0] else { panic!() };
        assert_eq!(options[0].id, "approve");
        assert_eq!(answered.as_deref(), Some("Plan approved"));
    }

    #[test]
    fn sub_agent_calls_and_requests_are_labelled() {
        let mut entries = seq(&[call("c1"), perm("r1")]);
        for e in &mut entries {
            e.entry.subagent = Some(Subagent { label: Some("explorer".into()) });
        }
        let d = build_display_entries(&entries);
        let DisplayEntry::ToolGroup { steps, .. } = &d[0] else { panic!() };
        assert!(matches!(&steps[0], ToolStep::Call { is_sub_agent: true, subagent: Some(l), .. } if l == "explorer"));
        let DisplayEntry::PermissionRequest { is_sub_agent, agent_label, .. } = &d[1] else { panic!() };
        assert!(*is_sub_agent);
        assert_eq!(agent_label.as_deref(), Some("explorer"));
    }

    #[test]
    fn pending_permission_is_the_latest_unresolved_unresponded_request() {
        let entries = seq(&[
            perm("r1"),
            perm("r2"),
            json!({"entryType":"resolved","requestId":"r2","summary":"Denied"}),
            perm("r3"),
        ]);
        assert_eq!(find_pending_permission(&entries, None).unwrap().request_id, "r3");
        let responded: BTreeSet<String> = ["r3".to_string()].into();
        assert_eq!(find_pending_permission(&entries, Some(&responded)).unwrap().request_id, "r1");
        let all: BTreeSet<String> = ["r1".to_string(), "r3".to_string()].into();
        assert_eq!(find_pending_permission(&entries, Some(&all)), None);
        assert_eq!(find_pending_permission(&[], None), None);
    }

    #[test]
    fn rows_serialize_with_the_kind_discriminant_the_ui_decodes() {
        let d = build_display_entries(&seq(&[call("c1"), json!({"entryType":"notice","kind":"auth_error","text":"bad key"})]));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v[0]["kind"], "toolGroup");
        assert_eq!(v[0]["steps"][0]["step"], "call");
        assert_eq!(v[0]["steps"][0]["toolKind"], "execute");
        assert_eq!(v[1]["kind"], "notice");
        assert_eq!(v[1]["notice"], "auth_error");
    }
}
