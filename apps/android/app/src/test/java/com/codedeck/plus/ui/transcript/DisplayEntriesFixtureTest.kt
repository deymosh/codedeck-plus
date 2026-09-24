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
 * The fixture wraps both real FFI payloads (`displayEntriesJson`,
 * `pendingPermissionJson` — two SEPARATE strings crossing the boundary) in
 * one object purely for convenience of a single committed file; this test
 * splits them back apart before calling the real `parseDisplayEntries`/
 * `parsePendingPermission` entry points, so it exercises exactly what
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

        assertEquals(13, entries.size)
        assertTrue(entries[0] is DisplayEntry.UserMessage)
        assertEquals(false, (entries[1] as DisplayEntry.AgentMessage).isPlan)

        val toolGroup = entries[2] as DisplayEntry.ToolGroup
        assertEquals(4, toolGroup.steps.size)
        assertEquals("3 actions", toolGroup.summary)
        assertTrue(toolGroup.steps[0] is ToolStep.Thinking)
        assertTrue(toolGroup.steps[1] is ToolStep.Text)
        val grep = toolGroup.steps[3] as ToolStep.Call
        assertEquals("search", grep.toolKind)
        assertEquals("explorer", grep.subagent)
        assertEquals("3 matches", grep.result?.text)

        val resolved = entries[3] as DisplayEntry.PermissionRequest
        assertEquals("Allowed", resolved.answered)
        assertEquals(listOf(false, false, true), resolved.options.map { it.isReject })

        val diff = entries[4] as DisplayEntry.Diff
        assertEquals("packages/core/src/nostr/pool.ts", diff.path)
        assertEquals(3, diff.lines.size)
        assertEquals("del", diff.lines[1].type)

        assertTrue(entries[5] is DisplayEntry.Error)
        assertTrue(entries[6] is DisplayEntry.Status)
        assertEquals("session_restart", (entries[7] as DisplayEntry.Notice).notice)
        assertEquals(true, (entries[8] as DisplayEntry.AgentMessage).isPlan)

        val planApproval = entries[9] as DisplayEntry.PlanApproval
        assertEquals("tu-plan", planApproval.requestId)
        assertEquals(3, planApproval.options.size)
        assertEquals("Stay in plan mode and send feedback", planApproval.options[2].description)

        val question = entries[10] as DisplayEntry.Question
        assertEquals(1, question.questions.size)
        assertEquals("Direction", question.questions[0].header)
        assertEquals(2, question.questions[0].options.size)

        val questionGroup = entries[11] as DisplayEntry.Question
        assertEquals(listOf("Scope", "Timeline"), questionGroup.questions.map { it.header })
        assertEquals(true, questionGroup.questions[1].multiSelect)

        val permission = entries[12] as DisplayEntry.PermissionRequest
        assertEquals("Bash", permission.toolName)
        assertEquals("execute", permission.toolKind)
        assertEquals("tu-permission", permission.requestId)

        assertEquals("tu-permission", pending.requestId)
        assertEquals("Bash", pending.toolName)
        assertEquals(false, pending.isSubAgent)
    }

    @Test
    fun question_card_keys_match_the_core() {
        assertEquals("tu-question-group:q1", questionCardKey("tu-question-group", 1))
    }
}
