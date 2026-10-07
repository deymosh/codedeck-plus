package com.codedeck.plus.ui.transcript

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes `crates/client-ffi/fixtures/display_entries_corpus.json` — the
 * same fixture `display_entries_corpus.rs`'s `matches_the_committed_fixture`
 * test asserts the real Rust serializer still produces. A shape change on
 * either side that isn't mirrored on the other shows up here as a decode
 * failure, or there as a fixture diff — not a silent divergence.
 *
 * The fixture wraps the real FFI payloads (`displayEntriesJson`,
 * `pendingPermissionJson`, `activityJson` — SEPARATE strings crossing the boundary) in
 * one object purely for convenience of a single committed file; this test
 * splits them back apart before calling the real `parseDisplayEntries`/
 * `parsePendingPermission`/`parseActivity` entry points, so it exercises exactly what
 * `CoreHost`'s `transcriptFlow` actually hands a screen.
 */
class DisplayEntriesFixtureTest {

    private fun loadFixture(): String =
        javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!
            .bufferedReader()
            .readText()

    @Test
    fun decodes_the_shared_corpus_fixture_into_every_display_kind() {
        val root = displayEntriesJson.parseToJsonElement(loadFixture()).jsonObject
        val entries = parseDisplayEntries(root.getValue("displayEntries").toString())
        val pending = parsePendingPermission(root.getValue("pendingPermission").toString())

        assertEquals(18, entries.size)
        assertTrue(entries[0] is DisplayEntry.UserMessage)
        assertEquals(false, (entries[1] as DisplayEntry.AgentMessage).isPlan)

        // Thinking alone, then the agent's narration splits it from the calls.
        val thought = entries[2] as DisplayEntry.ToolGroup
        assertEquals("Thought", thought.summary)
        assertTrue(thought.steps.single() is ToolStep.Thinking)
        assertEquals("Reading the pool first.", (entries[3] as DisplayEntry.AgentMessage).text)

        val toolGroup = entries[4] as DisplayEntry.ToolGroup
        assertEquals("Read a file, searched for a pattern", toolGroup.summary)
        val grep = toolGroup.steps[1] as ToolStep.Call
        assertEquals("search", grep.toolKind)
        assertEquals("Searched", grep.verb)
        assertEquals("explorer", grep.subagent)
        assertEquals("3 matches", grep.result?.text)

        val resolved = entries[5] as DisplayEntry.PermissionRequest
        assertEquals("Allowed", resolved.answered)
        assertEquals(listOf(false, false, true), resolved.options.map { it.isReject })

        // An edit carries its diff; a failed command its whole input.
        val work = entries[6] as DisplayEntry.ToolGroup
        assertEquals("Edited a file, ran a command", work.summary)
        assertEquals(Triple(1, 1, 1), Triple(work.added, work.removed, work.failed))
        val edit = work.steps[0] as ToolStep.Call
        assertEquals("packages/core/src/nostr/pool.ts", edit.diffs.single().path)
        assertEquals("del", edit.diffs.single().lines[1].type)
        val test = work.steps[1] as ToolStep.Call
        assertEquals("cargo test -p core \\\n  -- reconnect", test.input)
        assertTrue(test.failed)

        val diff = entries[7] as DisplayEntry.Diff
        assertEquals("Cargo.lock", diff.path)
        assertEquals(2, diff.lines.size)

        // A sub-agent's steps nest under its call; a call carries the
        // checklist it wrote and the background task it started.
        val agents = entries[8] as DisplayEntry.ToolGroup
        val agent = agents.steps[0] as ToolStep.Call
        assertEquals("agent", agent.toolKind)
        assertEquals(listOf("Grep", "Read"), agent.children.map { (it as ToolStep.Call).toolName })
        val todo = agents.steps[1] as ToolStep.Call
        assertEquals(listOf("in_progress", "pending", "completed"), todo.todos.map { it.status })
        assertEquals("Auditing reconnects", todo.todos[0].activeText)
        assertEquals("running", (agents.steps[2] as ToolStep.Call).background)

        val task = entries[9] as DisplayEntry.Task
        assertEquals(Triple("bg-0", "shell", "failed"), Triple(task.taskId, task.taskKind, task.status))
        assertEquals("exit code 101", task.summary)

        assertTrue(entries[10] is DisplayEntry.Error)
        assertTrue(entries[11] is DisplayEntry.Status)
        assertEquals("session_restart", (entries[12] as DisplayEntry.Notice).notice)
        assertEquals(true, (entries[13] as DisplayEntry.AgentMessage).isPlan)

        val planApproval = entries[14] as DisplayEntry.PlanApproval
        assertEquals("tu-plan", planApproval.requestId)
        assertEquals(3, planApproval.options.size)
        assertEquals("Stay in plan mode and send feedback", planApproval.options[2].description)
        assertEquals("revise", planApproval.revise)

        val question = entries[15] as DisplayEntry.Question
        assertEquals(1, question.questions.size)
        assertEquals("Direction", question.questions[0].header)
        assertEquals(2, question.questions[0].options.size)

        val questionGroup = entries[16] as DisplayEntry.Question
        assertEquals(listOf("Scope", "Timeline"), questionGroup.questions.map { it.header })
        assertEquals(true, questionGroup.questions[1].multiSelect)

        val permission = entries[17] as DisplayEntry.PermissionRequest
        assertEquals("Bash", permission.toolName)
        assertEquals("execute", permission.toolKind)
        assertEquals("tu-permission", permission.requestId)

        assertEquals("tu-permission", pending.requestId)
        assertEquals("Bash", pending.toolName)
        assertEquals(false, pending.isSubAgent)

        val activity = parseActivity(root.getValue("activity").toString())
        assertEquals(3, activity.todos.size)
        val running = activity.agents.single()
        assertEquals(Triple(17L, "Explore", "Reading relay.rs"), Triple(running.callSeq, running.label, running.current))
        assertEquals(listOf(true, false), activity.tasks.map { it.running })
    }

    @Test
    fun question_card_keys_match_the_core() {
        assertEquals("tu-question-group:q1", questionCardKey("tu-question-group", 1))
    }
}
