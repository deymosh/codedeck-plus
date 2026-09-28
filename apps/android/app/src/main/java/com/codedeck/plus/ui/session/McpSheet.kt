package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.BusyToggle
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiSessionMcp
import uniffi.client_ffi.UniffiSessionMcpServer

/** A server's status as a colour: the same states the rest of the app
 *  colours (live, waiting on something, broken, off). */
internal fun mcpStatusColor(status: String): Color = when (status) {
    "connected" -> Tokens.Success
    "pending", "needs-auth" -> Tokens.Warn
    "failed" -> Tokens.Danger
    else -> Tokens.TextDim
}

/** The chip's dot: the worst state among the servers that are on. */
internal fun mcpOverallColor(mcp: UniffiSessionMcp): Color {
    val on = mcp.servers.map { it.status }.filter { it != "disabled" }
    return when {
        on.isEmpty() -> Tokens.TextDim
        "failed" in on -> Tokens.Danger
        on.any { it == "pending" || it == "needs-auth" } -> Tokens.Warn
        else -> Tokens.Success
    }
}

internal fun mcpStatusText(s: UniffiSessionMcpServer): String = when (s.status) {
    "connected" -> s.tools?.let { "Connected, $it tool${if (it == 1u) "" else "s"}" } ?: "Connected"
    "pending" -> "Connecting"
    "needs-auth" -> "Needs signing in on the machine"
    "failed" -> s.error?.let { "Failed: $it" } ?: "Failed"
    else -> "Off in this session"
}

/** The controls bar's MCP pill: how many servers are on, and a dot for how
 *  they are doing. Tapping opens [SessionMcpSheet]. */
@Composable
internal fun McpChip(mcp: UniffiSessionMcp, onTap: () -> Unit) {
    val on = mcp.servers.count { it.status != "disabled" }
    Row(
        Modifier
            .minimumInteractiveComponentSize()
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Dot(mcpOverallColor(mcp), size = 7.dp)
        Text("MCP $on", color = Tokens.Text, fontSize = Tokens.TextSm, fontWeight = FontWeight.Medium)
    }
}

/**
 * A running session's MCP servers: each one's state, and a switch to turn
 * it off or on for this session. Adding and removing servers is the
 * machine's settings' job, for every session.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionMcpSheet(mcp: UniffiSessionMcp, onToggle: (name: String, enabled: Boolean) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
    ) {
        SessionMcpList(mcp, onToggle)
    }
}

/** The sheet's content, apart so a snapshot can show it without a window. */
@Composable
internal fun SessionMcpList(mcp: UniffiSessionMcp, onToggle: (name: String, enabled: Boolean) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(bottom = Tokens.Space4),
    ) {
        Text(
            "MCP servers",
            color = Tokens.Text,
            fontSize = Tokens.TextXl,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = Tokens.Space5),
        )
        Text(
            if (mcp.projectWide) "A switch here applies to every session of this agent in the same project."
            else "A switch here applies to this session only. Add or remove servers in the machine's settings.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
            modifier = Modifier.padding(horizontal = Tokens.Space5).padding(top = 2.dp, bottom = Tokens.Space3),
        )
        mcp.error?.let {
            Text(it, color = Tokens.Danger, fontSize = Tokens.TextSm, modifier = Modifier.padding(horizontal = Tokens.Space5, vertical = Tokens.Space2))
        }
        if (mcp.servers.isEmpty() && mcp.error == null) {
            Text(
                "This session has no MCP servers. Add them in the machine's settings.",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextMd,
                modifier = Modifier.padding(horizontal = Tokens.Space5, vertical = Tokens.Space3),
            )
        }
        mcp.servers.forEachIndexed { i, s ->
            if (i > 0) HorizontalDivider(Modifier.padding(start = Tokens.Space5), thickness = 1.dp, color = Tokens.Border)
            ServerStatusRow(s, busy = s.name in mcp.busy, toggles = mcp.toggles, onToggle = onToggle)
        }
    }
}

@Composable
private fun ServerStatusRow(s: UniffiSessionMcpServer, busy: Boolean, toggles: Boolean, onToggle: (String, Boolean) -> Unit) {
    val on = s.status != "disabled"
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(start = Tokens.Space5, end = Tokens.Space4, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Dot(mcpStatusColor(s.status))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.name, color = if (on) Tokens.Text else Tokens.TextMuted, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                mcpStatusText(s),
                color = if (s.status == "failed") Tokens.Danger else Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        BusyToggle(on, busy, toggles) { onToggle(s.name, it) }
    }
}
