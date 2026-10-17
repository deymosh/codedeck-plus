package com.codedeck.plus.ui.screens

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.ActionRow
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.ConfirmDialog
import com.codedeck.plus.ui.components.DeckIcons
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiTerminalInfo
import uniffi.client_ffi.isRelayUrl

/** Whether the machine is heard from, as a word and its colour. */
internal enum class MachinePresence(val label: String, val color: Color) {
    Online("Online", Tokens.PresenceLive),
    Offline("Offline", Tokens.PresenceOffline),

    /** Heard from, but in another protocol version: nothing it says can be read. */
    Mismatched("Update needed", Tokens.Warn),
}

/** A heartbeat older than this means the bridge is not running (it beats every 30 s). */
private const val HEARTBEAT_FRESH_MS = 90_000L

internal fun machinePresence(machine: UniffiMachineSummary, now: Long): MachinePresence {
    if (machine.updateNeeded != null) return MachinePresence.Mismatched
    val at = machine.lastHeartbeatAt?.toLong()
    return if (!machine.machineOffline && at != null && now - at < HEARTBEAT_FRESH_MS) MachinePresence.Online else MachinePresence.Offline
}

/** "Online", which side to update, or when it was last heard from. */
internal fun machineStatusText(machine: UniffiMachineSummary, now: Long): String {
    when (machine.updateNeeded) {
        "app" -> return "Update the app"
        "bridge" -> return "Update the bridge"
    }
    if (machinePresence(machine, now) == MachinePresence.Online) return "Online"
    val at = machine.lastHeartbeatAt?.toLong() ?: return "Offline"
    val minutes = (now - at) / 60_000
    return when {
        minutes < 1 -> "Offline, seen just now"
        minutes < 60 -> "Offline, seen $minutes min ago"
        minutes < 48 * 60 -> "Offline, seen ${minutes / 60} h ago"
        else -> "Offline, seen ${minutes / (24 * 60)} days ago"
    }
}

/**
 * The machine [pubkey] as the core knows it, for a page about that machine.
 * Null until the machines arrive, and once they have when it is not among
 * them (removed, perhaps from another device); then [onGone] runs once, to
 * close the page.
 */
@Composable
internal fun machineOrLeave(core: CoreHost, pubkey: String, onGone: () -> Unit): UniffiMachineSummary? {
    val machinesView by core.machines.collectAsState()
    val machine = machinesView?.machines?.find { it.pubkeyHex == pubkey }
    if (machine == null && machinesView != null) LaunchedEffect(Unit) { onGone() }
    return machine
}

/** `npub1abcdef…uvwxyz`: enough of both ends to tell two keys apart. */
internal fun shortKey(key: String): String = if (key.length <= 20) key else "${key.take(12)}…${key.takeLast(6)}"

/**
 * One machine's page: who it is and whether it is up, its agents — the one
 * new sessions start on, and a row each that opens everything about that
 * agent ([onOpenAgent]: its new-session defaults, keys, AI providers,
 * plugins, MCP servers, saved permissions) or installs one it lacks — its
 * terminals ([onOpenTerminal]: a new one, or one of [terminals]), then
 * what is the machine's own: the relays it is reached over, its direct link,
 * the bridge's credentials, and forgetting it. Pure — the caller supplies
 * the machine and a dispatcher — so it renders the same in a snapshot.
 */
@Composable
fun MachineSettingsContent(
    machine: UniffiMachineSummary,
    connectedRelays: Set<String>,
    credentialsStatus: UniffiCredentialsAck?,
    now: Long,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    onOpenAgent: (agent: String) -> Unit,
    terminals: List<UniffiTerminalInfo>,
    onOpenTerminal: (term: String?) -> Unit,
) {
    var confirmRemove by remember(machine.pubkeyHex) { mutableStateOf(false) }

    Page(title = machineLabel(machine.name), onBack = onBack) {
        MachineHeader(machine, now)
        MachineAgents(machine, dispatch, onOpenAgent)
        MachineTerminalsGroup(machine, terminals, now, onOpen = { onOpenTerminal(null) }, onAttach = onOpenTerminal)
        MachineRelays(machine, connectedRelays, dispatch)
        Group(
            title = "Direct link",
            footer = "A path to the bridge that skips the relays — your LAN, a VPN or an onion service. " +
                "The relays remain the fallback.",
        ) {
            GroupBody { MachineDirectLink(machine, dispatch) }
        }
        if (machine.credentials.isNotEmpty()) {
            Group(title = "Credentials") {
                GroupBody { MachineCredentials(machine, credentialsStatus, dispatch, scope = CredentialScope.Bridge) }
            }
        }
        Group(footer = "Its sessions keep running on the machine; this phone forgets the pairing and its transcripts.") {
            ActionRow("Remove machine", onClick = { confirmRemove = true }, danger = true, icon = Icons.Outlined.DeleteOutline)
        }
    }

    if (confirmRemove) {
        ConfirmDialog(
            title = "Remove ${machineLabel(machine.name)}?",
            body = "Its sessions keep running on the machine. This phone forgets the pairing and the " +
                "transcripts it kept; pair again to come back.",
            confirm = "Remove",
            onConfirm = {
                dispatch(UniffiIntent.RemoveMachine(machine.pubkeyHex))
                onBack()
            },
            onDismiss = { confirmRemove = false },
        )
    }
}

@Composable
private fun MachineHeader(machine: UniffiMachineSummary, now: Long) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val presence = machinePresence(machine, now)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space4),
    ) {
        Box(
            Modifier
                .size(64.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(Tokens.SurfaceRaised)
                .border(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.35f), Tokens.Border)), RoundedCornerShape(20.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(DeckIcons.Machine, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(30.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Dot(presence.color)
                Text(machineStatusText(machine, now), color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                machine.host?.let { Chip(it) }
            }
            Row(
                Modifier.clip(RoundedCornerShape(Tokens.RadiusSm)).clickable { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("npub", machine.npub))) } },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(shortKey(machine.npub), color = Tokens.TextDim, fontSize = Tokens.TextXs, fontFamily = Tokens.FontMono)
                Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy the machine's key", tint = Tokens.TextDim, modifier = Modifier.size(14.dp))
            }
        }
    }
}

/**
 * The machine's agents: which one a new session starts on (when more than
 * one can run), then a row each — an installed one opens its page, one that
 * is missing or failed offers its install right here.
 */
@Composable
private fun MachineAgents(machine: UniffiMachineSummary, dispatch: (UniffiIntent) -> Unit, onOpenAgent: (agent: String) -> Unit) {
    if (machine.agents.isEmpty()) {
        Group(title = "Agents", footer = "The agents appear once the bridge has been heard from.") {
            ValueRow("Agents", subtitle = "Waiting for the bridge") {}
        }
        return
    }
    val ready = machine.agents.filter { it.ready }
    Group(
        title = "Agents",
        footer = if (ready.isEmpty()) "Install an agent to start sessions on this machine." else "Installed at the version the bridge pins.",
    ) {
        if (ready.size > 1) {
            val first = ready.first()
            ValueRow("New sessions") {
                SelectField(
                    options = listOf(PickerOption("", "First available (${first.displayName})")) +
                        ready.map { PickerOption(it.id, it.displayName) },
                    // A chosen agent since removed reads as the first available, as it acts.
                    selected = machine.defaultAgent?.takeIf { id -> ready.any { it.id == id } }.orEmpty(),
                    onSelect = { dispatch(UniffiIntent.SetDefaultAgent(machine.pubkeyHex, it.ifEmpty { null })) },
                )
            }
            Divider()
        }
        machine.agents.forEachIndexed { i, agent ->
            if (i > 0) Divider()
            if (agent.ready && agent.actionBusy == null) {
                NavRow(agent.displayName, onClick = { onOpenAgent(agent.id) }, subtitle = installLine(agent).first)
            } else {
                AgentInstallRow(
                    agent,
                    onInstall = { dispatch(UniffiIntent.AgentAction(machine.pubkeyHex, agent.id, "install")) },
                    onRemove = null,
                )
            }
        }
    }
}

/** The relays the machine is reached over: each with whether it is up, removable while another remains, and an add field. */
@Composable
private fun MachineRelays(machine: UniffiMachineSummary, connectedRelays: Set<String>, dispatch: (UniffiIntent) -> Unit) {
    var draft by remember(machine.pubkeyHex) { mutableStateOf("") }
    val candidate = draft.trim()
    val invalid = candidate.isNotEmpty() && !isRelayUrl(candidate)
    Group(
        title = "Relays",
        footer = "Where this phone and the bridge meet. Learned when you paired; the bridge must be on at least one of them.",
    ) {
        machine.relays.forEachIndexed { index, url ->
            if (index > 0) Divider()
            Row(
                Modifier.fillMaxWidth().padding(start = Tokens.Space4, end = Tokens.Space1, top = Tokens.Space1, bottom = Tokens.Space1),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                Dot(if (url in connectedRelays) Tokens.PresenceLive else Tokens.PresenceOffline)
                Text(
                    url.removePrefix("wss://"),
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                    fontFamily = Tokens.FontMono,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                // The last relay cannot go: its button keeps its place, hidden and inert.
                val canRemove = machine.relays.size > 1
                IconAction(
                    Icons.Outlined.Close,
                    "Remove $url",
                    onClick = { dispatch(UniffiIntent.SetMachineRelays(machine.pubkeyHex, machine.relays - url)) },
                    tint = if (canRemove) Tokens.TextMuted else Color.Transparent,
                    enabled = canRemove,
                )
            }
        }
        if (machine.relays.isNotEmpty()) Divider()
        GroupBody {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Field(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = "wss://relay.example.com",
                    mono = true,
                    isError = invalid,
                    supporting = if (invalid) "Use wss://, or ws:// only to an .onion address." else null,
                    modifier = Modifier.weight(1f),
                )
                SecondaryButton(
                    "Add",
                    onClick = {
                        dispatch(UniffiIntent.SetMachineRelays(machine.pubkeyHex, machine.relays + candidate))
                        draft = ""
                    },
                    enabled = candidate.isNotEmpty() && !invalid && candidate !in machine.relays,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

/** [MachineSettingsContent] for the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun MachineSettingsScreen(
    core: CoreHost,
    pubkey: String,
    onBack: () -> Unit,
    onOpenAgent: (agent: String) -> Unit,
    onOpenTerminal: (term: String?) -> Unit,
) {
    val connection by core.connection.collectAsState()
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    MachineSettingsContent(
        machine = machine,
        connectedRelays = connection?.connectedRelays?.toSet().orEmpty(),
        credentialsStatus = ui?.credentialsStatus?.get(pubkey),
        now = System.currentTimeMillis(),
        dispatch = { intent -> scope.launch { core.dispatch(intent) } },
        onBack = onBack,
        onOpenAgent = onOpenAgent,
        terminals = ui?.terminals?.byMachine?.get(pubkey).orEmpty(),
        onOpenTerminal = onOpenTerminal,
    )
}
