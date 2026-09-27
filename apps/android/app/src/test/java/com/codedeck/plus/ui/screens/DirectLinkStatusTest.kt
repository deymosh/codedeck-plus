package com.codedeck.plus.ui.screens

import com.codedeck.plus.ui.DesignFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectLinkStatusTest {
    private val machine = DesignFixtures.workstation

    @Test
    fun a_bridge_that_listens_but_names_no_address_asks_for_one() {
        val listening = machine.copy(directAdvertised = emptyList(), directEndpoints = emptyList(), directUp = null, directPinned = true)
        assertTrue(directLinkStatusText(listening).contains("add the address"))
        val off = listening.copy(directPinned = false)
        assertEquals("Through the relays", directLinkStatusText(off))
        assertTrue(directLinkStatusText(machine).startsWith("Connected directly"))
    }
}
