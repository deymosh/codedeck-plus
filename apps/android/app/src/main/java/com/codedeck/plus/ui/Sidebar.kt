package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.theme.connectionColor
import com.codedeck.plus.ui.theme.presenceColor
import com.codedeck.plus.ui.theme.stateColor
import uniffi.uniffi_bridge.UniffiMachineSummary
import uniffi.uniffi_bridge.UniffiSessionSummary

/**
 * The session sidebar — machine-grouped session list with a per-machine "+"
 * for a new session. Port of `apps/mobile/src/ui/Sidebar.tsx`'s core
 * structure, narrowed for this first vertical slice per the F3.3 execution
 * plan: no pull-to-refresh, swipe-to-delete, pending-session cards, or the
 * bottom-pinned DM section — those are F4. Presence dots, state-colored left
 * accents, and the connection banner ARE in scope; they're what makes the
 * list actually legible against a real bridge.
 */
@Composable
fun Sidebar(
    machines: List<UniffiMachineSummary>,
    connectionStatus: String?,
    selectedMachine: String?,
    selectedSession: String?,
    onSelectSession: (machine: String, sessionId: String) -> Unit,
    onNewSession: (machine: String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxHeight()
            .background(Tokens.Surface)
            .padding(Tokens.Space3),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Sessions", color = Tokens.Text, fontSize = Tokens.TextLg)
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                Box(
                    Modifier
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceRaised)
                        .clickable(onClick = onOpenPairing)
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                ) {
                    Text("Pair", color = Tokens.Text, fontSize = Tokens.TextSm)
                }
                Box(
                    Modifier
                        .clip(androidx.compose.foundation.shape.RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceRaised)
                        .clickable(onClick = onOpenSettings)
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                ) {
                    Text("Settings", color = Tokens.Text, fontSize = Tokens.TextSm)
                }
            }
        }

        if (connectionStatus != null && connectionStatus != "connected") {
            Row(
                Modifier.fillMaxWidth().padding(top = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
            ) {
                PresenceDot(connectionColor(connectionStatus))
                Text("connection: $connectionStatus", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            }
        }

        LazyColumn(Modifier.weight(1f).padding(top = Tokens.Space2)) {
            if (machines.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "No machines paired yet.",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                        modifier = Modifier.padding(vertical = Tokens.Space4),
                    )
                }
            }
            machines.forEach { machine ->
                item(key = "${machine.pubkeyHex}-header") {
                    MachineHeader(machine, onNewSession = { onNewSession(machine.pubkeyHex) })
                }
                if (machine.sessions.isEmpty()) {
                    item(key = "${machine.pubkeyHex}-empty") {
                        Text(
                            "No sessions — tap + to start one.",
                            color = Tokens.TextDim,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.padding(vertical = Tokens.Space2),
                        )
                    }
                } else {
                    items(machine.sessions, key = { "${machine.pubkeyHex}-${it.id}" }) { session ->
                        SessionCard(
                            session = session,
                            isSelected = selectedMachine == machine.pubkeyHex && selectedSession == session.id,
                            onClick = { onSelectSession(machine.pubkeyHex, session.id) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MachineHeader(machine: UniffiMachineSummary, onNewSession: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        // Machine-level presence isn't part of `UniffiMachinesView` yet (it
        // lives on `ConnectionView` per-machine, not surfaced to Android
        // until a screen needs it) — the sidebar's own state-colored session
        // rows carry the signal that actually matters for this slice.
        Text(machine.name, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
        Box(
            Modifier
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceRaised)
                .clickable(onClick = onNewSession)
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        ) {
            Text("+", color = Tokens.Text, fontSize = Tokens.TextMd)
        }
    }
}

@Composable
private fun SessionCard(
    session: UniffiSessionSummary,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(Tokens.RadiusMd))
            .background(if (isSelected) Tokens.SurfaceHover else Tokens.SurfaceRaised)
            .clickable(onClick = onClick)
            .padding(Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Box(
            Modifier
                .size(3.dp)
                .fillMaxHeight()
                .background(stateColor(session.state)),
        )
        Column(Modifier.weight(1f)) {
            Text(
                session.title ?: session.slug.ifBlank { session.id.take(8) },
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                Text(session.project.ifBlank { session.cwd }, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
                if (session.presence != "live") {
                    Text("· ${session.presence}", color = Tokens.TextDim, fontSize = Tokens.TextXs)
                }
            }
        }
        PresenceDot(presenceColor(session.presence))
    }
}

@Composable
private fun PresenceDot(color: androidx.compose.ui.graphics.Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}
