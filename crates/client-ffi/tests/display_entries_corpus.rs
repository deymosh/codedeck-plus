//! Generates/verifies `fixtures/display_entries_corpus.json` — the exact
//! grouped-transcript JSON shape `crates/client-ffi/src/views.rs`'s
//! `build_uniffi_transcript_view` produces for `display_entries_json`/
//! `pending_permission_json`, and `apps/android`'s Kotlin `DisplayEntries.kt`
//! decodes on the other side of the FFI boundary. One committed fixture, two
//! consumers (this test's default run, and a Kotlin JVM test reading the
//! same bytes copied to `apps/android/app/src/test/resources/`) — the same
//! anti-drift shape `crates/protocol/fixtures/corpus.json` uses for the
//! phone-bridge wire.
//!
//! Regenerate after a deliberate shape change:
//! `cargo test -p client-ffi --test display_entries_corpus -- --ignored regenerate_the_fixture`
//! then copy the file to the Android test resources path above and re-run
//! both sides' tests.

use client_runtime::client_core::presentation::activity::build_activity;
use client_runtime::client_core::presentation::display_entries::{
    build_display_entries, find_pending_permission, SeqEntry,
};
use protocol::common::OutputEntry;
use serde_json::json;

/// One flat transcript, as v11 wire entries, exercising every `DisplayEntry`
/// kind: a user message, agent text, tool groups (thinking alone, split from
/// the next by the agent's narration; a call whose result lands after a
/// permission card beside a sub-agent call; an edit carrying its diff and a
/// failed multi-line command; a sub-agent with one finished and one running
/// step, a checklist and a background command), a diff card no call claims,
/// a background task that failed, an error, a
/// status line, a notice, a plan, a plan approval, a single question, a
/// two-question ask, a resolved permission and a pending one a hook asked
/// for.
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
        json!({"entryType":"tool_call","callId":"tu-edit","toolName":"Edit","kind":"edit","title":"packages/core/src/nostr/pool.ts",
            "locations":["packages/core/src/nostr/pool.ts"]}),
        json!({"entryType":"diff","path":"packages/core/src/nostr/pool.ts","callId":"tu-edit","lines":[
            {"type":"context","text":"  const pool = new SimplePool();"},
            {"type":"del","text":"  pool.trackRelays = true;"},
            {"type":"add","text":"  pool.idleTimeout = 0x7fffffff; // CDX-020"}
        ]}),
        json!({"entryType":"tool_result","callId":"tu-edit","text":"The file has been updated."}),
        json!({"entryType":"tool_call","callId":"tu-test","toolName":"Bash","kind":"execute","title":"cargo test -p core \\…",
            "input":"cargo test -p core \\\n  -- reconnect"}),
        json!({"entryType":"tool_result","callId":"tu-test","text":"test reconnect ... FAILED\n\nfailures:\n    reconnect","isError":true}),
        json!({"entryType":"diff","path":"Cargo.lock","lines":[
            {"type":"del","text":"version = \"0.1.0\""},
            {"type":"add","text":"version = \"0.2.0\""}
        ]}),
        json!({"entryType":"tool_call","callId":"tu-agent","toolName":"Agent","kind":"agent","title":"Audit the reconnect path",
            "input":"Find every place a socket reconnects and report which ones reset the backoff."}),
        json!({"entryType":"tool_call","callId":"tu-sub-grep","toolName":"Grep","kind":"search","title":"reconnect",
            "subagent":{"label":"Explore","parentCallId":"tu-agent"}}),
        json!({"entryType":"tool_result","callId":"tu-sub-grep","text":"7 matches"}),
        json!({"entryType":"tool_call","callId":"tu-sub-read","toolName":"Read","kind":"read","title":"relay.rs",
            "subagent":{"label":"Explore","parentCallId":"tu-agent"}}),
        json!({"entryType":"tool_call","callId":"tu-todo","toolName":"TodoWrite","kind":"think","title":"Update the plan"}),
        json!({"entryType":"todos","callId":"tu-todo","items":[
            {"text":"Audit reconnects","status":"in_progress","activeText":"Auditing reconnects"},
            {"text":"Fix the backoff","status":"pending"},
            {"text":"Read the pool","status":"completed"}
        ]}),
        json!({"entryType":"tool_result","callId":"tu-todo","text":"Todos updated"}),
        json!({"entryType":"tool_call","callId":"tu-bg","toolName":"Bash","kind":"execute","title":"npm run dev"}),
        json!({"entryType":"background_task","taskId":"bg-1","kind":"shell","title":"npm run dev","status":"running","callId":"tu-bg"}),
        json!({"entryType":"tool_result","callId":"tu-bg","text":"Command running in background with ID: bg-1"}),
        json!({"entryType":"background_task","taskId":"bg-0","kind":"shell","title":"cargo watch","status":"failed","summary":"exit code 101"}),
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
            "options":[{"id":"allow","label":"Allow","kind":"allow_once"},{"id":"deny","label":"Deny","kind":"reject_once"}],
            "reason":"Tests need a human while CI is red","hook":"PreToolUse:Bash","hookPlugin":"guard-rails"}),
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
    let activity = build_activity(&entries, &display);
    let combined = json!({
        "displayEntries": display,
        "pendingPermission": pending,
        "activity": activity,
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
