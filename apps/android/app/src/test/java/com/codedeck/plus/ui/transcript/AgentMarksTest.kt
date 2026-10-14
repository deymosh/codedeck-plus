package com.codedeck.plus.ui.transcript

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentMarksTest {
    @Test
    fun counts_read_like_the_cli() {
        assertEquals("950", compactCount(950))
        assertEquals("1k", compactCount(1_000))
        assertEquals("1.2k", compactCount(1_234))
        assertEquals("12.3k", compactCount(12_345))
        assertEquals("1.5m", compactCount(1_500_000))
    }

    @Test
    fun the_counter_waits_for_five_seconds_and_some_reply() {
        assertNull(workingCounterText(5, 100))
        assertNull(workingCounterText(30, 0))
        assertEquals("(12s · ↓ 1.2k tokens)", workingCounterText(12, 1_234))
    }

    @Test
    fun the_turn_counts_only_what_came_after_the_users_last_message() {
        val entries = listOf(
            DisplayEntry.AgentMessage(1, "x".repeat(400)),
            DisplayEntry.UserMessage(2, "go"),
            DisplayEntry.AgentMessage(3, "y".repeat(40)),
            DisplayEntry.ToolGroup(4, listOf(ToolStep.Thinking(4, "z".repeat(20))), "Thought"),
        )
        val live = listOf(DisplayEntry.AgentMessage(-1, "w".repeat(20)))
        assertEquals(20L, turnTokens(entries, live))
    }

    private fun call(kind: String, result: String?, error: Boolean = false, diffs: List<FileDiffView> = emptyList()) =
        ToolStep.Call(0, "c", kind, kind, "t", verb = "Did", activeVerb = "Doing", result = result?.let { ToolResultView(it, error) }, diffs = diffs)

    @Test
    fun a_result_says_what_the_call_came_to() {
        assertNull(resultSummary(call("execute", null)))
        assertEquals("No output", resultSummary(call("execute", "")))
        assertEquals("ok", resultSummary(call("execute", "ok\n")))
        assertEquals("running 9 tests … +2 lines", resultSummary(call("execute", "running 9 tests\na\nb")))
        assertEquals("Read 3 lines", resultSummary(call("read", "a\nb\nc")))
        assertEquals("Read 1 line", resultSummary(call("read", "a")))
        assertEquals("Found 2 results", resultSummary(call("search", "a\nb")))
        assertEquals("Nothing found", resultSummary(call("search", "  ")))
        assertEquals("boom", resultSummary(call("execute", "\nboom\nmore", error = true)))
        assertNull(resultSummary(call("agent", "done")))
        val diff = FileDiffView("a.kt", emptyList(), added = 3, removed = 1)
        assertEquals("Added 3 lines, removed 1 line", resultSummary(call("edit", "ok", diffs = listOf(diff))))
    }
}
