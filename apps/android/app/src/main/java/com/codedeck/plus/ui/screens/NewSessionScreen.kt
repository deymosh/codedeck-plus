package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.actionFailedCopy
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiProviderProfileInfo

/** Radio value for the free-text "new folder" branch — same sentinel `NewSessionModal.tsx` uses. */
private const val NEW_FOLDER = "__new__"

/** How long a create waits for the core to confirm before the UI gives up
 *  waiting and says so. The FFI dispatch is genuinely fire-and-forget (no
 *  awaited response exists to await, unlike mobile's `await core.api.create`),
 *  so this bounded wait over [CoreHost.events] is the confirmation. */
private const val CREATE_CONFIRM_TIMEOUT_MS = 10_000L

/** Below this body height the pickers + folder list scroll as one column
 *  instead of the folder list scrolling on its own between them and the
 *  pinned buttons — a phone in landscape would otherwise leave the folder
 *  list no room at all. */
private val COMPACT_BODY_HEIGHT = 360.dp

/** Last path segment of an absolute workspace root — port of
 *  `NewSessionModal.tsx`'s `rootLabel`. */
private fun rootLabel(root: String): String {
    val segments = root.split('\\', '/').filter { it.isNotEmpty() }
    return segments.lastOrNull() ?: root
}

/**
 * F4.1 — the new-session screen, rendered as a full-screen replacement the
 * shell swaps in (same pattern `SettingsScreen.kt`/`PairingScreen.kt`
 * established), replacing `NewSessionSheet.kt`'s single-button placeholder:
 * port of `apps/mobile/src/ui/NewSessionModal.tsx`'s folder/agent/provider/
 * model/mode/effort picker. Which agents, modes and effort levels exist is the
 * bridge's agent catalog, not a list hardcoded here.
 *
 * Agent, provider, model, mode and effort render as the shared `SelectField`
 * dropdown (`ui/components/SelectField.kt`), the native app's equivalent of
 * the TSX reference's `<select>` elements; only Folder is a radio-row list
 * ([SelectableRow]) — the one section the reference also renders as a list.
 * Each dropdown section is ONE row ([SelectRow]): the section label on the
 * start edge, the dropdown at the end (`SettingsScreen.kt`'s prefRow
 * idiom), not a stacked heading-above-control pair.
 *
 * One deliberate narrowing from the TSX reference: that screen retries its
 * `modelsRequest` on every heartbeat while no list has landed yet
 * (`freshAskedFor` in its own doc comment). `UniffiMachineSummary` carries no
 * heartbeat timestamp to key that retry loop off of, so this screen instead
 * asks once per screen-open and once per agent change — covering the
 * common case (the picker asks, the bridge answers) without inventing a
 * timer this FFI surface doesn't need for anything else.
 *
 * Create differs from the TSX's `await core.api.createSession` the same way:
 * the FFI dispatch has no awaited reply, so the in-flight button state and
 * the error banner come from a bounded wait on [CoreHost.events] instead
 * (see [NewSessionBody.create]).
 */
@Composable
fun NewSessionScreen(
    core: CoreHost,
    machinePubkey: String,
    onClose: () -> Unit,
    onCreated: (knownSessionIds: Set<String>) -> Unit,
) {
    val machinesView by core.machines.collectAsState()
    val settings by core.settings.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }

    val machine = machinesView?.machines?.find { it.pubkeyHex == machinePubkey }
    if (machinesView != null && machine == null) {
        // The machine vanished (e.g. removed on another device) while this
        // screen was open — nothing sane to create against, so back out.
        LaunchedEffect(Unit) { onClose() }
        return
    }
    if (machine == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    NewSessionBody(
        machine = machine,
        defaultMode = settings?.defaultMode.orEmpty(),
        defaultModel = settings?.defaultModel.orEmpty(),
        defaultEffort = settings?.defaultEffort.orEmpty(),
        events = core.events,
        dispatch = ::dispatch,
        onClose = onClose,
        onCreated = onCreated,
    )
}

@Composable
private fun NewSessionBody(
    machine: UniffiMachineSummary,
    defaultMode: String,
    defaultModel: String,
    defaultEffort: String,
    events: SharedFlow<CoreEvent>,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
    onCreated: (knownSessionIds: Set<String>) -> Unit,
) {
    // The agent the session runs on — the bridge's first advertised agent
    // until the user picks another. Re-keyed on the machine so switching which
    // machine's "+" opened this screen starts from a clean slate rather than a
    // stale prior selection.
    var agentId by remember(machine.pubkeyHex) { mutableStateOf(machine.agents.firstOrNull()?.id.orEmpty()) }
    val agent: UniffiAgent? = machine.agents.firstOrNull { it.id == agentId }

    // Preferences (CDX-047 parity) pre-select mode/effort/model — but only
    // ids this agent actually offers; '' stays "the agent's default", the
    // same way every other field here uses '' for that.
    fun preferredMode(a: UniffiAgent?) = defaultMode.takeIf { pref -> a?.modes?.any { it.id == pref } == true }.orEmpty()
    fun preferredEffort(a: UniffiAgent?) = defaultEffort.takeIf { pref -> a?.efforts?.any { it.id == pref } == true }.orEmpty()

    var folderChoice by remember(machine.pubkeyHex) { mutableStateOf("") }
    var newFolder by remember(machine.pubkeyHex) { mutableStateOf("") }
    var mode by remember(machine.pubkeyHex) { mutableStateOf(preferredMode(agent)) }
    var effort by remember(machine.pubkeyHex) { mutableStateOf(preferredEffort(agent)) }
    var model by remember(machine.pubkeyHex) { mutableStateOf(defaultModel) }
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

    // Custom provider profiles only for an agent that can use them.
    val providerProfiles: List<UniffiProviderProfileInfo> =
        if (agent?.supportsProviders == true) machine.providerProfiles else emptyList()
    val activeProfile = if (providerId != "") providerProfiles.find { it.id == providerId } else null
    // Each agent has its own model list — the Model picker never mixes them.
    val agentModels = machine.models.firstOrNull { it.agent == agentId }
    val modelsList: List<UniffiModelEntry> = agentModels?.models.orEmpty()
    val modelsErr = agentModels?.error

    fun changeProvider(id: String) {
        providerId = id
        val profile = if (id == "") null else providerProfiles.find { it.id == id }
        model = profile?.defaultModel ?: defaultModel
    }

    fun changeAgent(id: String) {
        agentId = id
        val next = machine.agents.firstOrNull { it.id == id }
        providerId = ""
        mode = preferredMode(next)
        effort = preferredEffort(next)
        // Model ids are per agent — start from its default rather than carry
        // over one it may not know.
        model = ""
    }

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
        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            if (machine.agents.size > 1) {
                SelectRow("Agent") {
                    SelectField(
                        options = machine.agents.map { PickerOption(it.id, it.displayName) },
                        selected = agentId,
                        onSelect = ::changeAgent,
                    )
                }
            }

            if (providerProfiles.isNotEmpty()) {
                SelectRow("Provider") {
                    SelectField(
                        options = listOf(PickerOption("", "Default provider")) +
                            providerProfiles.map { PickerOption(it.id, it.label) },
                        selected = providerId,
                        onSelect = ::changeProvider,
                    )
                }
            }

            // --- Model ---
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                SelectRow("Model") {
                    val modelOptions = activeProfile?.models ?: modelsList
                    SelectField(
                        options = buildList {
                            add(PickerOption("", "Default model"))
                            modelOptions.forEach { m ->
                                add(PickerOption(m.id, m.label ?: m.id))
                            }
                            // The preferred default model (CDX-047) may not be in
                            // THIS machine's list — keep the pre-selection honest
                            // instead of a controlled picker silently showing
                            // nothing (the same trailing synthetic option
                            // `SettingsScreen.kt`'s model picker appends for a
                            // stale stored value).
                            if (model != "" && modelOptions.none { it.id == model }) {
                                add(PickerOption(model, model))
                            }
                        },
                        selected = model,
                        onSelect = { model = it },
                    )
                }
                // CDX-035: the bridge's own reason for an empty answer, so
                // an unavailable list is explained instead of silently
                // blank — only on the plain (non-profile) path, a
                // provider profile brings its own list.
                if (activeProfile == null && modelsList.isEmpty() && modelsErr != null) {
                    Text(modelsErr, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                }
            }

            // --- Mode ---
            val modes = agent?.modes.orEmpty()
            if (modes.isNotEmpty()) {
                SelectRow("Mode") {
                    SelectField(
                        options = listOf(PickerOption("", "Default mode")) + modes.map { PickerOption(it.id, it.label) },
                        selected = mode,
                        onSelect = { mode = it },
                    )
                }
            }

            // --- Effort ---
            val efforts = agent?.efforts.orEmpty()
            if (efforts.isNotEmpty()) {
                SelectRow("Effort") {
                    SelectField(
                        options = listOf(PickerOption("", "Default effort")) + efforts.map { PickerOption(it.id, it.label) },
                        selected = effort,
                        onSelect = { effort = it },
                    )
                }
            }
        }
    }

    // The radio rows of the folder list, plus the new-folder name field.
    @Composable
    fun FolderRows() {
        SelectableRow("Default (workspace root)", folderChoice == "") { folderChoice = "" }
        roots.forEach { root ->
            SelectableRow(rootLabel(root), folderChoice == root, mono = true) { folderChoice = root }
        }
        machine.folders.forEach { folder ->
            SelectableRow(folder, folderChoice == folder, mono = true) { folderChoice = folder }
        }
        SelectableRow("New folder…", folderChoice == NEW_FOLDER) { folderChoice = NEW_FOLDER }
        if (folderChoice == NEW_FOLDER) {
            OutlinedTextField(
                value = newFolder,
                onValueChange = { newFolder = it },
                placeholder = { Text("my-new-project") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }

    // Three bands that never scroll together: the pickers on top, the folder
    // list filling the middle (the only part that scrolls, however many
    // folders the machine has), and Create/Cancel pinned to the bottom.
    // A window too short for that split (a phone in landscape) scrolls the
    // pickers and folders as one column instead, so the folder list never
    // collapses to nothing; the buttons stay pinned either way.
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "New session on ${machine.name}",
                    color = Tokens.Text,
                    fontSize = Tokens.TextLg,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = "Close",
                    tint = Tokens.TextMuted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .clickable(onClick = onClose)
                        .padding(Tokens.Space2)
                        .size(20.dp),
                )
            }

            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val compact = maxHeight < COMPACT_BODY_HEIGHT
                Column(
                    Modifier
                        .fillMaxSize()
                        .then(if (compact) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                        .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                    verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
                ) {
                    Options()
                    SectionHeading("Folder", Modifier.padding(top = Tokens.Space2))
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .then(
                                if (compact) {
                                    Modifier
                                } else {
                                    Modifier.weight(1f).verticalScroll(rememberScrollState())
                                },
                            ),
                        verticalArrangement = Arrangement.spacedBy(Tokens.Space1),
                    ) {
                        FolderRows()
                    }
                    Text(
                        "Folders come from the machine's workspace; a new folder is created " +
                            "(and git-initialized) on the machine.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextXs,
                    )
                }
            }

            HorizontalDivider(color = Tokens.Border)
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(Tokens.Space3),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                // Same banner placement (and tone) as the TSX's
                // `{error && <div className={s.bannerError}>{error}</div>}`
                // sitting right above the button row.
                createError?.let { error ->
                    Text(
                        error,
                        color = Tokens.Danger,
                        fontSize = Tokens.TextSm,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .background(Tokens.Danger.copy(alpha = 0.12f))
                            .padding(Tokens.Space2),
                    )
                }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Button(
                        onClick = ::create,
                        enabled = canCreate && !creating,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(if (creating) "Creating…" else "Create")
                    }
                    Text(
                        "Cancel",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextMd,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .clickable(onClick = onClose)
                            .padding(Tokens.Space3),
                    )
                }
            }
        }
    }
}

/**
 * Section label — the reference renders these (`NewSessionModal.module.css`'s
 * `.sectionTitle`, and the settings screen's own equivalent) as uppercase,
 * semibold, letter-spaced, muted text: a label, not body text. Same treatment
 * `SessionsScreen.kt`'s MachineHeader gives machine names — `String.uppercase()`,
 * `FontWeight.Bold`, 0.05 em tracking on the muted color.
 */
@Composable
private fun SectionHeading(title: String, modifier: Modifier = Modifier) {
    Text(
        title.uppercase(),
        color = Tokens.TextMuted,
        fontSize = Tokens.TextMd,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.05.em,
        modifier = modifier,
    )
}

/**
 * One picker as a single settings row: the section label on the start edge
 * taking the free width, the `SelectField` hugging the row's end — the same
 * label-left-control-right idiom `SettingsScreen.kt`'s preference rows use
 * (weight(1f) on the label right-aligns the control), replacing the stacked
 * heading-above-control layout. The label goes through [SectionHeading]
 * rather than a bare `Text` because in the TSX reference Backend/Provider/
 * Model/Effort ARE `.sectionTitle` divs — the same uppercase treatment the
 * Folder heading gets.
 */
@Composable
private fun SelectRow(label: String, content: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        SectionHeading(label, Modifier.weight(1f))
        content()
    }
}

@Composable
private fun SelectableRow(label: String, selected: Boolean, mono: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(if (selected) Tokens.SurfaceHover else Tokens.SurfaceRaised)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(
            label,
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
            fontFamily = if (mono) Tokens.FontMono else Tokens.FontSans,
        )
    }
}
