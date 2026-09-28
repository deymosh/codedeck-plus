package com.codedeck.plus.ui.session

import com.codedeck.plus.ui.screens.mcpFailureLine
import com.codedeck.plus.ui.theme.Tokens
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.client_ffi.UniffiMcpFailure
import uniffi.client_ffi.UniffiSessionMcp
import uniffi.client_ffi.UniffiSessionMcpServer

/** How MCP server states are worded and coloured. */
class McpSheetTest {
    private fun server(status: String, error: String? = null, tools: UInt? = null) = UniffiSessionMcpServer("s", status, error, tools)
    private fun mcp(vararg statuses: String) =
        UniffiSessionMcp(statuses.map { server(it) }, toggles = true, projectWide = false, error = null, busy = emptyList())

    @Test
    fun eachStateIsWordedForTheUser() {
        assertEquals("Connected, 1 tool", mcpStatusText(server("connected", tools = 1u)))
        assertEquals("Connected, 12 tools", mcpStatusText(server("connected", tools = 12u)))
        assertEquals("Failed: exit 1", mcpStatusText(server("failed", "exit 1")))
        assertEquals("Needs signing in on the machine", mcpStatusText(server("needs-auth")))
        assertEquals("Off in this session", mcpStatusText(server("disabled")))
    }

    @Test
    fun theChipShowsTheWorstStateOfTheServersThatAreOn() {
        assertEquals(Tokens.Success, mcpOverallColor(mcp("connected", "disabled")))
        assertEquals(Tokens.Warn, mcpOverallColor(mcp("connected", "needs-auth")))
        assertEquals(Tokens.Danger, mcpOverallColor(mcp("pending", "failed")))
        assertEquals(Tokens.TextDim, mcpOverallColor(mcp("disabled")))
    }

    @Test
    fun aFailedChangeNamesItsServers() {
        assertEquals("Could not turn off a, b: no", mcpFailureLine(UniffiMcpFailure("disable", listOf("a", "b"), "no")))
    }
}
