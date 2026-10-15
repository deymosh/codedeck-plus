package com.codedeck.plus.ui.screens

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.ActionRow
import com.codedeck.plus.ui.components.ConfirmDialog
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.components.modelPickerOptions
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary

/**
 * One agent on one machine, everything about it in one place: where it
 * stands (installed, installing, failed), what its new sessions start with,
 * its keys, its AI providers, plugins, MCP servers and saved permissions —
 * each of those a page of its own, opened through the `onOpen…` callbacks —
 * and removing
 * what CodeDeck installed of it. Opened from the machine's page. Pure: the
 * caller supplies the machine and a dispatcher, so it renders the same in a
 * snapshot.
 */
@Composable
fun AgentSettingsContent(
    machine: UniffiMachineSummary,
    agentId: String,
    credentialsStatus: UniffiCredentialsAck?,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    onOpenProviders: () -> Unit,
    onOpenPlugins: () -> Unit,
    onOpenMcp: () -> Unit,
    onOpenPermissionRules: () -> Unit,
) {
    val agent = machine.agents.firstOrNull { it.id == agentId }
    // Only this agent's lists, and only once it can answer: the counts below
    // and the model picker need them. The saved permissions are read on
    // their own page alone.
    val ready = agent?.ready == true
    LaunchedEffect(machine.pubkeyHex, agentId, ready) {
        if (agent == null || !ready) return@LaunchedEffect
        if (agent.supportsModels) dispatch(UniffiIntent.RequestModels(machine.pubkeyHex, agentId))
        if (agent.supportsProviders || agent.supportsProviderModels) dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
        if (agent.supportsAccounts) dispatch(UniffiIntent.RequestAccounts(machine.pubkeyHex, agentId, all = false))
        if (agent.supportsPlugins) dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, agentId, available = false))
        if (agent.supportsMcp) dispatch(UniffiIntent.RequestMcp(machine.pubkeyHex, agentId))
    }
    var confirmRemove by remember(machine.pubkeyHex, agentId) { mutableStateOf(false) }

    Page(title = agent?.displayName ?: agentId, subtitle = machineLabel(machine.name), onBack = onBack) {
        if (agent == null) {
            // The bridge stopped reporting it (a newer or older bridge).
            Group { ValueRow("Not on this machine", subtitle = "The bridge no longer reports this agent.") {} }
            return@Page
        }
        // Where it stands, when there is something to do or to wait for: an
        // installed agent at rest is the page itself.
        if (!ready || agent.actionBusy != null || agent.actionFailure != null) {
            Group {
                AgentInstallRow(
                    agent,
                    onInstall = { dispatch(UniffiIntent.AgentAction(machine.pubkeyHex, agent.id, "install")) },
                    onRemove = null,
                )
            }
        }
        if (!ready) return@Page

        if (agent.supportsModels || agent.modes.isNotEmpty() || agent.efforts.isNotEmpty()) {
            Group(title = "New sessions", footer = "What a new session starts with. You can still change it when you start one.") {
                AgentDefaultsRows(machine, agent, dispatch)
            }
        }
        if (agent.credentials.isNotEmpty()) {
            Group(title = "Keys") {
                GroupBody { MachineCredentials(machine, credentialsStatus, dispatch, scope = CredentialScope.Agent(agent.id)) }
            }
        }
        AgentPagesGroup(machine, agent, onOpenProviders, onOpenPlugins, onOpenMcp, onOpenPermissionRules)
        if (agent.removable) {
            Group {
                ActionRow("Remove ${agent.displayName}", onClick = { confirmRemove = true }, danger = true, icon = Icons.Outlined.DeleteOutline)
            }
        }
    }

    if (confirmRemove && agent != null) {
        ConfirmDialog(
            title = "Remove ${agent.displayName}?",
            body = "Its sessions on ${machineLabel(machine.name)} end, and what CodeDeck installed of it is deleted. " +
                "Its settings and conversations stay; install it again here at any time.",
            confirm = "Remove",
            onConfirm = {
                dispatch(UniffiIntent.AgentAction(machine.pubkeyHex, agent.id, "remove"))
                confirmRemove = false
            },
            onDismiss = { confirmRemove = false },
        )
    }
}

/** The agent's settings that are pages of their own, each with how many it has once known. */
@Composable
private fun AgentPagesGroup(
    machine: UniffiMachineSummary,
    agent: UniffiAgent,
    onOpenProviders: () -> Unit,
    onOpenPlugins: () -> Unit,
    onOpenMcp: () -> Unit,
    onOpenPermissionRules: () -> Unit,
) {
    // Accounts are connected on the providers page too: an agent with only
    // those (OpenCode on a server it does not start) still needs the row.
    val providers = agent.supportsProviders || agent.supportsProviderModels || agent.supportsAccounts
    if (!providers && !agent.supportsPlugins && !agent.supportsMcp && !agent.supportsPermissionRules) return
    Group {
        var first = true
        fun divide(): Boolean = (!first).also { first = false }
        if (providers) {
            if (divide()) Divider()
            val profiles = machine.providerProfiles.count { it.agent == agent.id }
            val accounts = machine.accounts.firstOrNull { it.agent == agent.id }?.connected?.size ?: 0
            NavRow("AI providers", onClick = onOpenProviders, value = "${profiles + accounts} connected")
        }
        if (agent.supportsPlugins) {
            if (divide()) Divider()
            val count = machine.plugins.firstOrNull { it.agent == agent.id }?.installed?.size
            NavRow("Plugins", onClick = onOpenPlugins, value = count?.let { "$it installed" })
        }
        if (agent.supportsMcp) {
            if (divide()) Divider()
            val count = machine.mcp.firstOrNull { it.agent == agent.id }?.servers?.size
            NavRow("MCP servers", onClick = onOpenMcp, value = count?.let { countOf(it, "server", "servers") })
        }
        if (agent.supportsPermissionRules) {
            if (divide()) Divider()
            // Read on their page only: the count shows once they have been.
            val count = machine.permissionRules.firstOrNull { it.agent == agent.id }?.rules?.size
            NavRow("Saved permissions", onClick = onOpenPermissionRules, value = count?.let { countOf(it, "rule", "rules") })
        }
    }
}

private fun countOf(n: Int, one: String, many: String): String = "$n ${if (n == 1) one else many}"

/** The model, mode and effort a new session of [agent] starts with — each agent has its own. */
@Composable
private fun GroupScope.AgentDefaultsRows(machine: UniffiMachineSummary, agent: UniffiAgent, dispatch: (UniffiIntent) -> Unit) {
    val current = machine.agentDefaults.firstOrNull { it.agent == agent.id }
    val mode = current?.mode.orEmpty()
    val effort = current?.effort.orEmpty()
    val model = current?.model.orEmpty()
    fun set(mode: String = current?.mode.orEmpty(), effort: String = current?.effort.orEmpty(), model: String = current?.model.orEmpty()) {
        dispatch(UniffiIntent.SetAgentDefaults(machine.pubkeyHex, agent.id, mode, effort, model))
    }
    val models = machine.models.firstOrNull { it.agent == agent.id }
    val modelList = models?.models.orEmpty()
    var first = true
    fun divide(): Boolean = (!first).also { first = false }
    if (agent.supportsModels) {
        if (divide()) Divider()
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
        if (divide()) Divider()
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
        if (divide()) Divider()
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

/** [AgentSettingsContent] for one agent of the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun AgentSettingsScreen(
    core: CoreHost,
    pubkey: String,
    agentId: String,
    onBack: () -> Unit,
    onOpenProviders: () -> Unit,
    onOpenPlugins: () -> Unit,
    onOpenMcp: () -> Unit,
    onOpenPermissionRules: () -> Unit,
) {
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    AgentSettingsContent(
        machine = machine,
        agentId = agentId,
        credentialsStatus = ui?.credentialsStatus?.get(pubkey),
        dispatch = { intent -> scope.launch { core.dispatch(intent) } },
        onBack = onBack,
        onOpenProviders = onOpenProviders,
        onOpenPlugins = onOpenPlugins,
        onOpenMcp = onOpenMcp,
        onOpenPermissionRules = onOpenPermissionRules,
    )
}
