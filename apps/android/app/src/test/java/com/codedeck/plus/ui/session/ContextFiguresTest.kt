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

    @Test
    fun a_context_past_its_window_keeps_its_breakdown_under_the_capped_figure() {
        // 240 000 of 200 000: the figure stops at 100 %, the parts are what
        // say by how much — dropping them here would leave the tokens line
        // reading "200k of 200k" for a context holding 240k.
        val over = DesignFixtures.contextBreakdown.copy(usedTokens = 240_000u)
        val (shown, parts) = contextFigures(100.0, over)
        assertEquals(100.0, shown!!, 0.0)
        assertSame(over, parts)
    }

    @Test
    fun a_snapshot_from_before_the_turn_is_still_left_out_past_the_top() {
        // The parts say the context is over its window while the session's own
        // figure says 60 %: that snapshot is from an earlier turn, not an
        // over-full context.
        val over = DesignFixtures.contextBreakdown.copy(usedTokens = 240_000u)
        val (shown, parts) = contextFigures(60.0, over)
        assertEquals(60.0, shown!!, 0.0)
        assertNull(parts)
    }
}
