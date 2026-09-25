package com.codedeck.plus.platform

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The kind strings are `NotifyEvent::kind_str` in crates/client-core — these
 * assertions fail on both sides if the vocabulary and the channel routing
 * drift apart.
 */
class NotificationChannelRoutingTest {

    @Test
    fun attention_kinds_land_on_the_action_channel() {
        for (kind in listOf("permission-request", "question", "plan-approval")) {
            assertEquals("codedeck_action_needed", channelFor(kind).id)
        }
    }

    @Test
    fun lifecycle_kinds_land_on_the_updates_channel() {
        for (kind in listOf("session-finished", "session-failed")) {
            assertEquals("codedeck_session_updates", channelFor(kind).id)
        }
    }

    @Test
    fun dms_and_unknown_kinds_fall_back_to_messages() {
        assertEquals("codedeck_messages", channelFor("dm-received").id)
        assertEquals("codedeck_messages", channelFor("something-new").id)
    }
}
