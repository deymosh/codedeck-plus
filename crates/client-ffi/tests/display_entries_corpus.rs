//! Generates/verifies `fixtures/display_entries_corpus.json` — the exact
//! grouped-transcript JSON shape `crates/client-ffi/src/views.rs`'s
//! `build_uniffi_transcript_view` produces for `display_entries_json`/
//! `pending_permission_json`, and `apps/android`'s Kotlin `DisplayEntries.kt`
//! decodes on the other side of the FFI boundary. One committed fixture, two
//! consumers (this test's default run, and a Kotlin JVM test reading the
//! same bytes copied to `apps/android/app/src/test/resources/`) — the same
//! anti-drift shape `packages/protocol/fixtures/corpus.json` uses for the
//! phone-bridge wire.
//!
//! Regenerate after a deliberate shape change:
//! `cargo test -p client-ffi --test display_entries_corpus -- --ignored regenerate_the_fixture`
//! then copy the file to the Android test resources path above and re-run
//! both sides' tests.

use client_runtime::client_core::presentation::display_entries::{
    build_display_entries, find_pending_permission, SeqEntry,
};
use protocol::common::OutputEntry;
use serde_json::json;

/// One flat transcript, as v11 wire entries, exercising every `DisplayEntry`
/// kind: a user message, agent text, a tool group (thinking, folded agent
/// text, a call whose result lands after a permission card, a sub-agent
/// call), a diff card, an error, a status line, a notice, a plan, a plan
/// approval, a single question, a two-question ask, a resolved permission
/// and a pending one.
fn corpus() -> Vec<SeqEntry> {
    let wire = [
        json!({"entryType":"text","role":"user","text":"port the connection reducer to rust"}),
        json!({"entryType":"text","role":"agent","text":"## Refactor plan\n\nHere's what I'll do, in order."}),
        json!({"entryType":"thinking","text":"Start with the pool."}),
        json!({"entryType":"text","role":"agent","text":"Reading the pool first.","collapsible":true}),
        json!({"entryType":"tool_call","callId":"tu-read","toolName":"Read","kind":"read","title":"pool.ts","locations":["packages/core/src/nostr/pool.ts"]}),
        json!({"entryType":"tool_call","callId":"tu-grep","toolName":"Grep","kind":"search","title":"SimplePool","subagent":{"label":"explorer"}}),
        json!({"entryType":"tool_result","callId":"tu-grep","text":"3 matches"}),
        json!({"entryType":"permission_request","requestId":"tu-read","toolName":"Read","kind":"read","title":"pool.ts",
            "description":"Read packages/core/src/nostr/pool.ts",
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"allow_always","label":"Always allow","kind":"allow_always"},{"id":"deny","label":"Deny","kind":"reject_once"}]}),
        json!({"entryType":"resolved","requestId":"tu-read","summary":"Allowed"}),
        json!({"entryType":"tool_result","callId":"tu-read","text":"42 lines"}),
        json!({"entryType":"diff","path":"packages/core/src/nostr/pool.ts","lines":[
            {"type":"context","text":"  const pool = new SimplePool();"},
            {"type":"del","text":"  pool.trackRelays = true;"},
            {"type":"add","text":"  pool.idleTimeout = 0x7fffffff; // CDX-020"}
        ]}),
        json!({"entryType":"error","text":"bridge disconnected"}),
        json!({"entryType":"status","text":"status: idle"}),
        json!({"entryType":"notice","kind":"session_restart","text":"restarted"}),
        json!({"entryType":"plan","text":"1. Extract the reducer\n2. Wire the effects interpreter"}),
        json!({"entryType":"plan_approval","requestId":"tu-plan","options":[
            {"id":"acceptEdits","label":"Approve, auto-accept edits"},
            {"id":"default","label":"Approve"},
            {"id":"revise","label":"Keep planning","description":"Stay in plan mode and send feedback"}
        ]}),
        json!({"entryType":"question","requestId":"tu-solo-question","index":0,"count":1,"header":"Direction","question":"Which approach?",
            "options":[{"label":"Extract first"},{"label":"Rewrite in one pass"}]}),
        json!({"entryType":"question","requestId":"tu-question-group","index":0,"count":2,"header":"Scope","question":"How wide?",
            "options":[{"label":"Narrow"},{"label":"Wide"}]}),
        json!({"entryType":"question","requestId":"tu-question-group","index":1,"count":2,"header":"Timeline","question":"When?",
            "options":[{"label":"This week"},{"label":"Next sprint"}],"multiSelect":true}),
        json!({"entryType":"permission_request","requestId":"tu-permission","toolName":"Bash","kind":"execute","title":"cargo test",
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}]}),
        json!({"entryType":"turn_complete"}),
    ];
    wire.into_iter()
        .enumerate()
        .map(|(i, mut v)| {
            v["timestamp"] = json!("2026-09-16T00:00:00Z");
            SeqEntry {
                seq: i as u64 + 1,
                entry: serde_json::from_value::<OutputEntry>(v).expect("a valid v11 entry"),
            }
        })
        .collect()
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
