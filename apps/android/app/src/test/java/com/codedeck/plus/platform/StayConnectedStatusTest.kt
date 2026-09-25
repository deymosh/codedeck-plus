package com.codedeck.plus.platform

import org.junit.Assert.assertEquals
import org.junit.Test

class StayConnectedStatusTest {

    @Test
    fun title_counts_paired_machines() {
        assertEquals("No machines paired", stayConnectedStatus(0, emptyList(), "connected", 1, 1).title)
        assertEquals("Paired with 1 machine", stayConnectedStatus(1, emptyList(), "connected", 1, 1).title)
        assertEquals("Paired with 3 machines", stayConnectedStatus(3, emptyList(), "connected", 1, 1).title)
    }

    @Test
    fun waiting_sessions_lead_then_running_then_relays() {
        val status = stayConnectedStatus(
            machineCount = 2,
            sessionStates = listOf("running", "waiting_permission", "idle", "running", "waiting_question", null),
            connectionStatus = "connected",
            connectedRelays = 2,
            configuredRelays = 3,
        )
        assertEquals("2 sessions waiting for you · 2 running · 2/3 relays", status.text)
    }

    @Test
    fun idle_machines_say_nothing_is_running() {
        val status = stayConnectedStatus(1, listOf("idle", null), "connected", 1, 1)
        assertEquals("No sessions running · 1/1 relay", status.text)
    }

    @Test
    fun without_machines_only_the_connection_shows() {
        assertEquals("1/2 relays", stayConnectedStatus(0, emptyList(), "connected", 1, 2).text)
    }

    @Test
    fun a_connection_that_is_not_up_replaces_the_relay_count() {
        assertEquals("1 running · Connecting…", stayConnectedStatus(1, listOf("running"), "connecting", 0, 2).text)
        assertEquals("1 running · Connecting…", stayConnectedStatus(1, listOf("running"), null, 0, 2).text)
        assertEquals("1 running · Reconnecting…", stayConnectedStatus(1, listOf("running"), "waiting-retry", 0, 2).text)
        assertEquals("1 running · Offline", stayConnectedStatus(1, listOf("running"), "offline", 0, 2).text)
        assertEquals("1 running · Disconnected", stayConnectedStatus(1, listOf("running"), "stopped", 0, 2).text)
    }
}
