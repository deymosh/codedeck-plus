package com.codedeck.plus.ui.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionCostTest {
    @Test
    fun a_cost_reads_in_dollars_and_a_free_session_shows_none() {
        assertEquals("$0.42", sessionCost(0.4213))
        assertEquals("<$0.01", sessionCost(0.004))
        assertEquals("$12.30", sessionCost(12.3))
        assertEquals("$140", sessionCost(139.6))
        assertNull(sessionCost(0.0))
        assertNull(sessionCost(Double.NaN))
    }
}
