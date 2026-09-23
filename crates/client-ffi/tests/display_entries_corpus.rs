//! Generates/verifies `fixtures/display_entries_corpus.json` — the exact
//! grouped-transcript JSON shape `crates/client-ffi/src/views.rs`'s
//! `build_uniffi_transcript_view` produces for `display_entries_json`/
//! `pending_permission_json`, and `apps/android`'s Kotlin `DisplayEntries.kt`
//! decodes on the other side of the FFI boundary. One committed fixture, two
//! consumers (this test's default run, and a Kotlin JVM test reading the
//! same bytes copied to `apps/android/app/src/test/resources/`) — the same
//! anti-drift shape `packages/protocol/fixtures/corpus.json` already uses
//! for the phone-bridge wire.
//!
//! Regenerate after a deliberate shape change:
//! `cargo test -p client-ffi --test display_entries_corpus -- --ignored regenerate_the_fixture`
//! then copy the file to the Android test resources path above and re-run
//! both sides' tests.

use client_runtime::client_core::presentation::display_entries::{
    build_display_entries, find_pending_permission, SeqEntry,
};
use protocol::common::{DiffData, DiffLine, DiffLineType, OutputEntry, OutputEntryType};
use serde_json::json;

fn entry(entry_type: OutputEntryType, content: &str, metadata: Option<serde_json::Value>) -> OutputEntry {
    OutputEntry {
        entry_type,
        content: content.to_string(),
        timestamp: "2026-09-16T00:00:00Z".to_string(),
        metadata,
        diff: None,
    }
}

/// One flat transcript exercising every `DisplayEntry` kind: a user message,
/// an assistant message, a tool group (tool_use + tool_result), a diff card,
/// an error row, a plain system row, a lifecycle marker, a plan-approval
/// card, a single question, a two-question group, and a permission request
/// — the same corpus shape `apps/mobile/src/ui/transcript/__tests__/
/// displayEntries.test.ts` exercises, rebuilt directly against the real
/// `OutputEntry`/`build_display_entries` this crate's FFI surface actually
/// crosses.
fn corpus() -> Vec<SeqEntry> {
    let mut entries = Vec::new();
    let mut seq = 1u64;
    let mut push = |entries: &mut Vec<SeqEntry>, e: OutputEntry| {
        entries.push(SeqEntry { seq, entry: e });
        seq += 1;
    };

    push(
        &mut entries,
        entry(OutputEntryType::Text, "port the connection reducer to rust", Some(json!({"role": "user"}))),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::Text,
            "## Refactor plan\n\nHere's what I'll do, in order.",
            Some(json!({"role": "assistant"})),
        ),
    );
    push(&mut entries, entry(OutputEntryType::ToolUse, "Read pool.ts", None));
    push(
        &mut entries,
        entry(OutputEntryType::ToolResult, "42 lines", Some(json!({"tool_use_id": "tu-read"}))),
    );
    let mut diff = entry(OutputEntryType::Diff, "", None);
    diff.diff = Some(DiffData {
        path: "packages/core/src/nostr/pool.ts".to_string(),
        lines: vec![
            DiffLine { kind: DiffLineType::Context, text: "  const pool = new SimplePool();".to_string() },
            DiffLine { kind: DiffLineType::Del, text: "  pool.trackRelays = true;".to_string() },
            DiffLine { kind: DiffLineType::Add, text: "  pool.idleTimeout = 0x7fffffff; // CDX-020".to_string() },
        ],
        truncated: None,
    });
    push(&mut entries, diff);
    push(
        &mut entries,
        entry(OutputEntryType::Error, "session_died: bridge disconnected", Some(json!({"special": "session_died"}))),
    );
    push(&mut entries, entry(OutputEntryType::System, "status: idle", None));
    push(
        &mut entries,
        entry(OutputEntryType::System, "restarted", Some(json!({"special": "session_restart"}))),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::Text,
            "1. Extract the reducer\n2. Wire the effects interpreter",
            Some(json!({"special": "plan_approval", "tool_use_id": "tu-plan", "has_plan": true})),
        ),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::System,
            "Which approach?",
            Some(json!({
                "special": "ask_question",
                "tool_use_id": "tu-solo-question",
                "header": "Direction",
                "options": [
                    {"label": "Extract first"},
                    {"label": "Rewrite in one pass"},
                ],
            })),
        ),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::System,
            "How wide?",
            Some(json!({
                "special": "ask_question",
                "tool_use_id": "tu-question-group",
                "question_count": 2,
                "question_index": 0,
                "header": "Scope",
                "options": [{"label": "Narrow"}, {"label": "Wide"}],
            })),
        ),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::System,
            "When?",
            Some(json!({
                "special": "ask_question",
                "tool_use_id": "tu-question-group",
                "question_count": 2,
                "question_index": 1,
                "header": "Timeline",
                "options": [{"label": "This week"}, {"label": "Next sprint"}],
            })),
        ),
    );
    push(
        &mut entries,
        entry(
            OutputEntryType::System,
            "Read pool.ts",
            Some(json!({
                "special": "permission_request",
                "tool_use_id": "tu-permission",
                "tool_name": "Read",
                "description": "Read packages/core/src/nostr/pool.ts",
            })),
        ),
    );

    entries
}

fn corpus_json() -> String {
    let entries = corpus();
    let display = build_display_entries(&entries);
    let pending = find_pending_permission(&entries, None);
    let combined = json!({
        "displayEntries": display,
        "pendingPermission": pending,
    });
    serde_json::to_string_pretty(&combined).unwrap()
}

#[test]
fn matches_the_committed_fixture() {
    let actual = corpus_json();
    let expected = include_str!("../fixtures/display_entries_corpus.json");
    assert_eq!(actual.trim(), expected.trim());
}

/// `cargo test -p client-ffi --test display_entries_corpus -- --ignored
/// regenerate_the_fixture` after a deliberate shape change.
#[test]
#[ignore]
fn regenerate_the_fixture() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/display_entries_corpus.json");
    std::fs::write(path, corpus_json() + "\n").unwrap();
}
