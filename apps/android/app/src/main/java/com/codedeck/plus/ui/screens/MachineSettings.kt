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
import androidx.compose.ui.text.font.FontWeight
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
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.modelPickerOptions
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiProviderProfileAck
import uniffi.client_ffi.isRelayUrl

/** Whether the machine is heard from, as a word and its colour. */
internal enum class MachinePresence(val label: String, val color: Color) {
    Online("Online", Tokens.PresenceLive),
    Offline("Offline", Tokens.PresenceOffline),
}

/** A heartbeat older than this means the bridge is not running (it beats every 30 s). */
private const val HEARTBEAT_FRESH_MS = 90_000L

internal fun machinePresence(machine: UniffiMachineSummary, now: Long): MachinePresence {
    val at = machine.lastHeartbeatAt?.toLong()
    return if (!machine.machineOffline && at != null && now - at < HEARTBEAT_FRESH_MS) MachinePresence.Online else MachinePresence.Offline
}

/** "Online", or when it was last heard from. */
internal fun machineStatusText(machine: UniffiMachineSummary, now: Long): String {
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
 * One machine's page: who it is and whether it is up, what its new sessions
 * start with, the relays it is reached over, its direct link, the
 * credentials kept on it, its agents' AI providers, plugins and MCP
 * servers (each agent's on a page of its own, opened through
 * [onOpenProviders], [onOpenPlugins] and [onOpenMcp]), and forgetting it. Pure — the
 * caller supplies the machine and a dispatcher — so it renders the same in
 * a snapshot.
 */
@Composable
fun MachineSettingsContent(
    machine: UniffiMachineSummary,
    connectedRelays: Set<String>,
    credentialsStatus: UniffiCredentialsAck?,
    providerProfileStatus: UniffiProviderProfileAck?,
    now: Long,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    onOpenProviders: (agent: String) -> Unit,
    onOpenPlugins: (agent: String) -> Unit,
    onOpenMcp: (agent: String) -> Unit,
) {
    // The model pickers need each agent's list, and the provider and plugin
    // rows their counts: ask for them on opening.
    LaunchedEffect(machine.pubkeyHex) {
        machine.agents.filter { it.supportsModels }.forEach { dispatch(UniffiIntent.RequestModels(machine.pubkeyHex, it.id)) }
        if (providerAgents(machine).isNotEmpty()) dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
        machine.agents.filter { it.supportsPlugins }.forEach {
            dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, it.id, available = false))
        }
        machine.agents.filter { it.supportsMcp }.forEach { dispatch(UniffiIntent.RequestMcp(machine.pubkeyHex, it.id)) }
    }
    var confirmRemove by remember(machine.pubkeyHex) { mutableStateOf(false) }

    Page(title = machineLabel(machine.name), onBack = onBack) {
        MachineHeader(machine, now)
        NewSessionDefaults(machine, dispatch)
        MachineRelays(machine, connectedRelays, dispatch)
        Group(
            title = "Direct link",
            footer = "A path to the bridge that skips the relays — your LAN, a VPN or an onion service. " +
                "The relays remain the fallback.",
        ) {
            GroupBody { MachineDirectLink(machine, dispatch) }
        }
        val hasCredentials = machine.credentials.isNotEmpty() || machine.agents.any { it.credentials.isNotEmpty() }
        if (hasCredentials) {
            Group(title = "Credentials") {
                GroupBody { MachineCredentials(machine, credentialsStatus, dispatch) }
            }
        }
        val providerAgents = providerAgents(machine)
        if (providerAgents.isNotEmpty()) {
            Group(title = "AI providers", footer = "API endpoints an agent can use: a service, or a gateway of your own. Each is kept for one agent.") {
                providerAgents.forEachIndexed { i, agent ->
                    if (i > 0) Divider()
                    val count = machine.providerProfiles.count { it.agent == agent.id }
                    NavRow(agent.displayName, onClick = { onOpenProviders(agent.id) }, value = if (count == 1) "1 provider" else "$count providers")
                }
            }
        }
        val pluginAgents = machine.agents.filter { it.supportsPlugins }
        if (pluginAgents.isNotEmpty()) {
            Group(title = "Plugins", footer = "Installed on the machine, for every session of that agent.") {
                pluginAgents.forEachIndexed { i, agent ->
                    if (i > 0) Divider()
                    val count = machine.plugins.firstOrNull { it.agent == agent.id }?.installed?.size
                    NavRow(agent.displayName, onClick = { onOpenPlugins(agent.id) }, value = count?.let { "$it installed" })
                }
            }
        }
        val mcpAgents = machine.agents.filter { it.supportsMcp }
        if (mcpAgents.isNotEmpty()) {
            Group(title = "MCP servers", footer = "Tools every session of that agent can use, set up on the machine.") {
                mcpAgents.forEachIndexed { i, agent ->
                    if (i > 0) Divider()
                    val count = machine.mcp.firstOrNull { it.agent == agent.id }?.servers?.size
                    NavRow(agent.displayName, onClick = { onOpenMcp(agent.id) }, value = count?.let { if (it == 1) "1 server" else "$it servers" })
                }
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
 * What a new session on this machine starts with: the agent, and for each
 * agent the mode, effort and model — each agent has its own, so they are
 * kept per agent.
 */
@Composable
private fun NewSessionDefaults(machine: UniffiMachineSummary, dispatch: (UniffiIntent) -> Unit) {
    if (machine.agents.isEmpty()) {
        Group(title = "New sessions", footer = "The agents appear once the bridge has been heard from.") {
            ValueRow("Agent", subtitle = "Waiting for the bridge") {}
        }
        return
    }
    val firstAgent = machine.agents.first()
    Group(title = "New sessions", footer = "What a session started here begins with. You can still change any of it when you start one.") {
        if (machine.agents.size > 1) {
            ValueRow("Agent") {
                SelectField(
                    options = listOf(PickerOption("", "First available (${firstAgent.displayName})")) +
                        machine.agents.map { PickerOption(it.id, it.displayName) },
                    selected = machine.defaultAgent.orEmpty(),
                    onSelect = { dispatch(UniffiIntent.SetDefaultAgent(machine.pubkeyHex, it.ifEmpty { null })) },
                )
            }
            Divider()
        }
        machine.agents.forEachIndexed { index, agent ->
            if (index > 0) Divider()
            AgentDefaultsRows(machine, agent, showName = machine.agents.size > 1, dispatch)
        }
    }
}

@Composable
private fun GroupScope.AgentDefaultsRows(
    machine: UniffiMachineSummary,
    agent: UniffiAgent,
    showName: Boolean,
    dispatch: (UniffiIntent) -> Unit,
) {
    val current = machine.agentDefaults.firstOrNull { it.agent == agent.id }
    val mode = current?.mode.orEmpty()
    val effort = current?.effort.orEmpty()
    val model = current?.model.orEmpty()
    fun set(mode: String = current?.mode.orEmpty(), effort: String = current?.effort.orEmpty(), model: String = current?.model.orEmpty()) {
        dispatch(UniffiIntent.SetAgentDefaults(machine.pubkeyHex, agent.id, mode, effort, model))
    }
    if (showName) {
        Text(
            agent.displayName,
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = Tokens.Space4, end = Tokens.Space4, top = Tokens.Space3),
        )
    }
    val models = machine.models.firstOrNull { it.agent == agent.id }
    val modelList = models?.models.orEmpty()
    if (agent.supportsModels) {
        ValueRow("Model", subtitle = models?.error?.takeIf { modelList.isEmpty() }) {
            SelectField(
                options = buildList {
                    add(PickerOption("", models?.defaultModel?.let { d -> "Default (${modelList.firstOrNull { it.id == d }?.label ?: d})" } ?: "Default"))
                    addAll(modelPickerOptions(modelList))
                    // A kept choice the bridge no longer lists stays visible, to see or clear.
                    if (model.isNotEmpty() && modelList.none { it.id == model }) add(PickerOption(model, model))
                },
                selected = model,
                onSelect = { set(model = it) },
            )
        }
    }
    if (agent.modes.isNotEmpty()) {
        ValueRow("Mode") {
            SelectField(
                options = listOf(PickerOption("", defaultOptionLabel(agent.defaultMode, agent.modes.map { it.id to it.label }))) +
                    agent.modes.map { PickerOption(it.id, it.label) },
                selected = mode,
                onSelect = { set(mode = it) },
            )
        }
    }
    if (agent.efforts.isNotEmpty()) {
        ValueRow("Effort") {
            SelectField(
                options = listOf(PickerOption("", defaultOptionLabel(agent.defaultEffort, agent.efforts.map { it.id to it.label }))) +
                    agent.efforts.map { PickerOption(it.id, it.label) },
                selected = effort,
                onSelect = { set(effort = it) },
            )
        }
    }
}

/** "Default (Plan)": the agent's own default, named. */
private fun defaultOptionLabel(id: String?, choices: List<Pair<String, String>>): String {
    if (id.isNullOrEmpty()) return "Default"
    return "Default (${choices.firstOrNull { it.first == id }?.second ?: id})"
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
    onOpenProviders: (agent: String) -> Unit,
    onOpenPlugins: (agent: String) -> Unit,
    onOpenMcp: (agent: String) -> Unit,
) {
    val connection by core.connection.collectAsState()
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    MachineSettingsContent(
        machine = machine,
        connectedRelays = connection?.connectedRelays?.toSet().orEmpty(),
        credentialsStatus = ui?.credentialsStatus?.get(pubkey),
        providerProfileStatus = ui?.providerProfileStatus?.get(pubkey),
        now = System.currentTimeMillis(),
        dispatch = { intent -> scope.launch { core.dispatch(intent) } },
        onBack = onBack,
        onOpenProviders = onOpenProviders,
        onOpenPlugins = onOpenPlugins,
        onOpenMcp = onOpenMcp,
    )
}
