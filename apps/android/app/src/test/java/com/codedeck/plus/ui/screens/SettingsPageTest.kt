package com.codedeck.plus.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

/** Every Settings page survives being saved as a string and read back. */
class SettingsPageTest {
    @Test
    fun aPageReadsBackAsItself() {
        val pages = listOf(
            SettingsPage.Hub,
            SettingsPage.Machine("ab12"),
            SettingsPage.Plugins("ab12", "claude"),
            SettingsPage.Mcp("ab12", "opencode"),
            SettingsPage.Appearance,
            SettingsPage.Notifications,
            SettingsPage.Connection,
            SettingsPage.Messages,
            SettingsPage.Uploads,
            SettingsPage.Account,
        )
        pages.forEach { assertEquals(it, SettingsPage.restore(it.save())) }
    }

    @Test
    fun anAgentIdWithAColonKeepsItsWholeName() {
        assertEquals(SettingsPage.Mcp("ab12", "custom:agent"), SettingsPage.restore(SettingsPage.Mcp("ab12", "custom:agent").save()))
    }
}
