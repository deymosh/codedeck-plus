package com.codedeck.plus.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.actionFailedCopy
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PageLoading
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.modelPickerOptions
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiProviderProfileInfo
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId

/** Radio value for the free-text "new folder" branch — same sentinel `NewSessionModal.tsx` uses. */
private const val NEW_FOLDER = "__new__"

/** How long a create waits for the core to confirm before the UI gives up
 *  waiting and says so. The FFI dispatch is genuinely fire-and-forget (no
 *  awaited response exists to await, unlike mobile's `await core.api.create`),
 *  so this bounded wait over [CoreHost.events] is the confirmation. */
private const val CREATE_CONFIRM_TIMEOUT_MS = 10_000L

/** Last path segment of an absolute workspace root — port of
 *  `NewSessionModal.tsx`'s `rootLabel`. */
private fun rootLabel(root: String): String {
    val segments = root.split('\\', '/').filter { it.isNotEmpty() }
    return segments.lastOrNull() ?: root
}

/**
 * The new-session screen: which agent and, as far as that agent offers
 * them, provider, model, mode and effort, then the folder, with Start
 * pinned at the bottom. The choices start from the machine's own defaults
 * (see its settings page). Which agents, modes and efforts exist is the
 * bridge's agent catalog, never a list kept here.
 *
 * Models are asked for once per opening and once per agent change. Start
 * has no awaited reply over the FFI, so the in-flight state and the error
 * come from a bounded wait on [CoreHost.events] (see [NewSessionBody.create]).
 */
@Composable
fun NewSessionScreen(
    core: CoreHost,
    machinePubkey: String,
    onClose: () -> Unit,
    onCreated: (knownSessionIds: Set<String>) -> Unit,
) {
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }

    val machine = machineOrLeave(core, machinePubkey, onGone = onClose)
    if (machine == null) {
        PageLoading()
        return
    }

    NewSessionBody(
        machine = machine,
        events = core.events,
        dispatch = ::dispatch,
        onClose = onClose,
        onCreated = onCreated,
    )
}

@Composable
internal fun NewSessionBody(
    machine: UniffiMachineSummary,
    events: SharedFlow<CoreEvent>,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
    onCreated: (knownSessionIds: Set<String>) -> Unit,
) {
    // The agent the session runs on: the machine's chosen default while the
    // bridge still offers it, else its first agent, until the user picks
    // another. Re-keyed on the machine so another machine's screen starts
    // from its own defaults rather than a stale prior selection.
    val startAgent = machine.defaultAgent?.takeIf { id -> machine.agents.any { it.id == id } } ?: machine.agents.firstOrNull()?.id.orEmpty()
    var agentId by remember(machine.pubkeyHex) { mutableStateOf(startAgent) }
    val agent: UniffiAgent? = machine.agents.firstOrNull { it.id == agentId }

    // The machine's defaults for an agent pre-select its mode / effort /
    // model — but only ids the agent still offers; '' stays "the agent's
    // default", as everywhere here.
    fun defaultsOf(id: String?) = machine.agentDefaults.firstOrNull { it.agent == id }
    fun preferredMode(a: UniffiAgent?) = defaultsOf(a?.id)?.mode?.takeIf { pref -> a?.modes?.any { it.id == pref } == true }.orEmpty()
    fun preferredEffort(a: UniffiAgent?) = defaultsOf(a?.id)?.effort?.takeIf { pref -> a?.efforts?.any { it.id == pref } == true }.orEmpty()

    var folderChoice by remember(machine.pubkeyHex) { mutableStateOf("") }
    var newFolder by remember(machine.pubkeyHex) { mutableStateOf("") }
    var mode by remember(machine.pubkeyHex) { mutableStateOf(preferredMode(agent)) }
    var effort by remember(machine.pubkeyHex) { mutableStateOf(preferredEffort(agent)) }
    // The model the user picked here (a profile's default counts); null
    // until then, when the preferred default model applies instead.
    var modelPick by remember(machine.pubkeyHex) { mutableStateOf<String?>(null) }
    var providerId by remember(machine.pubkeyHex) { mutableStateOf("") }
    // Create-flow feedback — mobile's `creating`/`error` pair: the button
    // disables with a "Creating…" label, and failures surface as a banner
    // above the button row instead of closing the screen silently.
    var creating by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(machine.pubkeyHex, agentId) {
        if (agent?.supportsModels == true) dispatch(UniffiIntent.RequestModels(machine.pubkeyHex, agentId))
    }
    LaunchedEffect(machine.pubkeyHex) {
        if (machine.agents.any { it.supportsProviders }) {
            dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
        }
    }

    // The roots themselves, offered only when there is a choice to make — with
    // one root "Default (workspace root)" already IS that root, and a second
    // identical-looking row would be noise.
    val roots = if (machine.roots.size > 1) machine.roots else emptyList()
    val newFolderPath = newFolder.trim()
    val canCreate = agent != null && (folderChoice != NEW_FOLDER || newFolderPath.isNotEmpty())

    // The agent's own provider profiles, when a session can be bound to one
    // (an agent whose profiles add models offers them in the model list).
    val providerProfiles: List<UniffiProviderProfileInfo> =
        if (agent?.supportsProviders == true) machine.providerProfiles.filter { it.agent == agentId } else emptyList()
    val activeProfile = if (providerId != "") providerProfiles.find { it.id == providerId } else null
    // Each agent has its own model list — the Model picker never mixes them.
    val agentModels = machine.models.firstOrNull { it.agent == agentId }
    val modelsList: List<UniffiModelEntry> = agentModels?.models.orEmpty()
    val modelsErr = agentModels?.error
    val modelOptions: List<UniffiModelEntry> = activeProfile?.models ?: modelsList
    // The machine's default model for this agent pre-selects only while the
    // agent (or profile) offers it — never a model the bridge would refuse.
    val preferredModel = defaultsOf(agentId)?.model?.takeIf { pref -> pref.isNotEmpty() && modelOptions.any { it.id == pref } }.orEmpty()
    val model = modelPick ?: preferredModel

    fun changeProvider(id: String) {
        providerId = id
        val profile = if (id == "") null else providerProfiles.find { it.id == id }
        modelPick = profile?.defaultModel
    }

    fun changeAgent(id: String) {
        agentId = id
        val next = machine.agents.firstOrNull { it.id == id }
        providerId = ""
        mode = preferredMode(next)
        effort = preferredEffort(next)
        // Model ids are per agent — start from its default rather than carry
        // over one it may not know.
        modelPick = null
    }

    // What each "Default …" option resolves to on this agent, named in the
    // option itself: the bridge reports every default, so none is a guess.
    fun defaultLabel(kind: String, id: String?, choices: List<Pair<String, String>>): String {
        if (id.isNullOrEmpty()) return "Default $kind"
        val name = choices.firstOrNull { it.first == id }?.second ?: id
        return "Default $kind ($name)"
    }
    // The default names its provider too, as every entry in the list does.
    val defaultModelLabel = defaultLabel(
        "model",
        // A profile with no default of its own runs its first model.
        if (activeProfile != null) activeProfile.defaultModel ?: activeProfile.models.firstOrNull()?.id else agentModels?.defaultModel,
        modelOptions.map { m -> m.id to (m.label ?: m.id) + (m.provider?.let { " from $it" } ?: "") },
    )

    fun create() {
        if (creating || agent == null) return
        creating = true
        createError = null
        val cwd = if (folderChoice == NEW_FOLDER) newFolderPath else folderChoice
        // The machine's sessions before this create: whatever appears beyond
        // them afterwards is the session this create made.
        val knownSessionIds = machine.sessions.map { it.id }.toSet()
        scope.launch {
            // No explicit refresh is needed on success — CoreHost refreshes
            // its views from the very StateChanged events watched here.
            // `events` has no replay, so the wait subscribes BEFORE the
            // dispatch: UNDISPATCHED runs the async body up to its first
            // suspension (the subscription inside `first`) synchronously.
            val confirmation = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeoutOrNull(CREATE_CONFIRM_TIMEOUT_MS) {
                    events.first { event ->
                        when (event) {
                            is CoreEvent.StateChanged -> event.slice == SliceId.MACHINES
                            is CoreEvent.ActionFailed -> true
                            else -> false
                        }
                    }
                }
            }
            dispatch(
                UniffiIntent.CreateSession(
                    machine = machine.pubkeyHex,
                    agent = agent.id,
                    cwd = cwd.ifEmpty { null },
                    createCwd = if (folderChoice == NEW_FOLDER) true else null,
                    mode = mode.ifEmpty { null },
                    effort = effort.ifEmpty { null },
                    model = model.ifEmpty { null },
                    providerId = providerId.ifEmpty { null },
                ),
            )
            val settled = confirmation.await()
            creating = false
            when (settled) {
                is CoreEvent.StateChanged ->
                    // Accepted; the sessions list's pending card takes over
                    // until the session is live, and the shell then opens it.
                    onCreated(knownSessionIds)
                is CoreEvent.ActionFailed -> createError = actionFailedCopy(settled.kind)
                else -> createError = "The bridge did not confirm — check the session list."
            }
        }
    }

    // The pickers, in the order they appear at the top of the screen. Each
    // one shows only what the chosen agent offers.
    @Composable
    fun Options() {
        Group(title = "Agent", footer = modelsErr?.takeIf { activeProfile == null && modelsList.isEmpty() }) {
            // Rows so far, for the hairline between each and the one before.
            var shown = 0
            if (machine.agents.size > 1) {
                if (shown++ > 0) Divider()
                ValueRow("Agent") {
                    SelectField(
                        options = machine.agents.map { PickerOption(it.id, it.displayName) },
                        selected = agentId,
                        onSelect = ::changeAgent,
                    )
                }
            }

            if (providerProfiles.isNotEmpty()) {
                if (shown++ > 0) Divider()
                ValueRow("Provider") {
                    SelectField(
                        options = listOf(PickerOption("", "Default provider")) +
                            providerProfiles.map { PickerOption(it.id, it.label) },
                        selected = providerId,
                        onSelect = ::changeProvider,
                    )
                }
            }

            // --- Model ---
            run {
                if (shown++ > 0) Divider()
                ValueRow("Model") {
                    SelectField(
                        options = buildList {
                            add(PickerOption("", defaultModelLabel))
                            addAll(modelPickerOptions(modelOptions))
                            // A picked model the list does not (yet) carry stays
                            // visible instead of the picker silently showing
                            // nothing.
                            if (model != "" && modelOptions.none { it.id == model }) {
                                add(PickerOption(model, model))
                            }
                        },
                        selected = model,
                        onSelect = { modelPick = it },
                    )
                }
                // CDX-035: the bridge's own reason for an empty answer is
                // the group's footer, so an unavailable list is explained
                // instead of silently blank — only on the plain path, a
                // provider profile brings its own list.
            }

            // --- Mode ---
            val modes = agent?.modes.orEmpty()
            if (modes.isNotEmpty()) {
                if (shown++ > 0) Divider()
                ValueRow("Mode") {
                    SelectField(
                        options = listOf(PickerOption("", defaultLabel("mode", agent?.defaultMode, modes.map { it.id to it.label }))) +
                            modes.map { PickerOption(it.id, it.label) },
                        selected = mode,
                        onSelect = { mode = it },
                    )
                }
            }

            // --- Effort ---
            val efforts = agent?.efforts.orEmpty()
            if (efforts.isNotEmpty()) {
                if (shown++ > 0) Divider()
                ValueRow("Effort") {
                    SelectField(
                        options = listOf(PickerOption("", defaultLabel("effort", agent?.defaultEffort, efforts.map { it.id to it.label }))) +
                            efforts.map { PickerOption(it.id, it.label) },
                        selected = effort,
                        onSelect = { effort = it },
                    )
                }
            }
        }
    }

    // The folder list, one picked, plus the new-folder name field.
    @Composable
    fun GroupScope.FolderRows() {
        ChoiceRow("Workspace root", folderChoice == "", first = true) { folderChoice = "" }
        roots.forEach { root ->
            ChoiceRow(rootLabel(root), folderChoice == root, mono = true) { folderChoice = root }
        }
        machine.folders.forEach { folder ->
            ChoiceRow(folder, folderChoice == folder, mono = true) { folderChoice = folder }
        }
        ChoiceRow("New folder…", folderChoice == NEW_FOLDER) { folderChoice = NEW_FOLDER }
        if (folderChoice == NEW_FOLDER) {
            GroupBody {
                Field(value = newFolder, onValueChange = { newFolder = it }, placeholder = "my-new-project", mono = true)
            }
        }
    }

    Page(
        title = "New session",
        subtitle = "on ${machineLabel(machine.name)}",
        onBack = onClose,
        backLabel = "Cancel",
        bottomBar = {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                createError?.let { error ->
                    Text(error, color = Tokens.Danger, fontSize = Tokens.TextSm)
                }
                PrimaryButton(
                    if (creating) "Starting…" else "Start session",
                    onClick = ::create,
                    enabled = canCreate && !creating,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
    ) {
        Options()
        Group(title = "Folder", footer = "From the machine's workspace. A new folder is created there, as a git repository.") {
            FolderRows()
        }
    }
}

/** One choice in a list where exactly one is picked: a check marks it. */
@Composable
private fun GroupScope.ChoiceRow(label: String, selected: Boolean, mono: Boolean = false, first: Boolean = false, onClick: () -> Unit) {
    if (!first) Divider()
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Text(
            label,
            color = Tokens.Text,
            fontSize = if (mono) Tokens.TextMd else Tokens.TextLg,
            fontFamily = if (mono) Tokens.FontMono else Tokens.FontSans,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (selected) Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = Tokens.Text, modifier = Modifier.size(20.dp))
    }
}
