package com.codedeck.plus.ui.transcript

import com.codedeck.plus.ui.transcript.rows.sheetBack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Where Back goes in a tool group's sheet: up a step, out to the sheet it
 *  was opened from, or nowhere — then the sheet closes. */
class ToolSheetBackTest {
    private fun call(seq: Long, children: List<ToolStep> = emptyList()) = ToolStep.Call(
        seq = seq, callId = "c$seq", toolName = "Task", toolKind = "agent", title = "Explore", verb = "Ran", activeVerb = "Running",
        children = children,
    )

    private val agent = call(2, children = listOf(ToolStep.Thinking(3, "hm"), call(4)))
    private val group = DisplayEntry.ToolGroup(seq = 1, steps = listOf(ToolStep.Thinking(1, "plan"), agent), summary = "Thought, ran a task")
    private val lone = DisplayEntry.ToolGroup(seq = 9, steps = listOf(call(9)), summary = "Ran", subject = "Explore")

    private fun backFrom(g: DisplayEntry.ToolGroup, path: List<Long>, entry: List<Long>, out: (() -> Unit)? = null): List<Long>? {
        var went: List<Long>? = null
        val back = sheetBack(g, path, entry, out) { went = it } ?: return null
        back()
        return went
    }

    @Test
    fun the_timeline_has_nothing_to_go_back_to() {
        assertNull(sheetBack(group, emptyList(), emptyList(), null) {})
    }

    @Test
    fun a_step_goes_back_to_the_steps_it_was_opened_from() {
        assertEquals(emptyList<Long>(), backFrom(group, listOf(2), emptyList()))
        assertEquals(listOf(2L), backFrom(group, listOf(2, 4), emptyList()))
    }

    @Test
    fun a_lone_calls_own_page_closes_but_its_sub_steps_go_back_to_it() {
        assertNull(sheetBack(lone, listOf(9), listOf(9), null) {})
        assertEquals(listOf(9L), backFrom(lone, listOf(9, 4), listOf(9)))
    }

    @Test
    fun the_page_opened_from_the_activity_sheet_goes_back_to_it() {
        var outs = 0
        val back = sheetBack(group, listOf(2), listOf(2), { outs++ }) {}
        back!!()
        assertEquals(1, outs)
        // Deeper in, Back still steps up first.
        assertEquals(listOf(2L), backFrom(group, listOf(2, 4), listOf(2)) { outs++ })
        assertTrue(outs == 1)
    }
}
