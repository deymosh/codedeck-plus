package com.codedeck.plus.ui.session

import com.codedeck.plus.ui.DesignFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ContextFiguresTest {
    // 84 200 of 200 000 tokens: 42.1 %.
    private val snapshot = DesignFixtures.contextBreakdown

    @Test
    fun the_sessions_own_figure_leads_and_a_breakdown_that_agrees_goes_with_it() {
        val (shown, parts) = contextFigures(42.0, snapshot)
        assertEquals(42.0, shown!!, 0.0)
        assertSame(snapshot, parts)
    }

    @Test
    fun a_breakdown_left_behind_by_the_turn_is_not_shown_until_a_new_one_comes() {
        val (shown, parts) = contextFigures(57.0, snapshot)
        assertEquals(57.0, shown!!, 0.0)
        assertNull(parts)
    }

    @Test
    fun with_no_figure_of_its_own_the_breakdown_says_how_full_it_is() {
        val (shown, parts) = contextFigures(null, snapshot)
        assertEquals(42.1, shown!!, 0.001)
        assertSame(snapshot, parts)
        assertEquals(null to null, contextFigures(Double.NaN, null))
    }
}
