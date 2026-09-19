package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.actionFailedCopy
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiMachineSummary
import uniffi.uniffi_bridge.UniffiModelEntry
import uniffi.uniffi_bridge.UniffiProviderProfileInfo

/** Radio value for the free-text "new folder" branch — same sentinel `NewSessionModal.tsx` uses. */
private const val NEW_FOLDER = "__new__"

/** `protocolConstants.ts`'s own `EFFORT_LEVELS` fallback list, hardcoded here
 *  for the same reason `SettingsScreen.kt`'s `MODE_OPTIONS` is: no UniFFI
 *  export for protocol defaults exists on this FFI surface yet. */
private val EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max", "auto")

private const val CAP_OPENCODE = "opencode"
private const val CAP_CUSTOM_PROVIDERS = "custom-providers"
private const val BACKEND_OPENCODE = "opencode"

/** How long a create waits for the core to confirm before the UI gives up
 *  waiting and says so. The FFI dispatch is genuinely fire-and-forget (no
 *  awaited response exists to await, unlike mobile's `await core.api.create`),
 *  so this bounded wait over [CoreBridge.events] is the confirmation. */
private const val CREATE_CONFIRM_TIMEOUT_MS = 10_000L

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
 * port of `apps/mobile/src/ui/NewSessionModal.tsx`'s folder/backend/provider/
 * model/effort picker.
 *
 * Backend, provider, model, and effort render as the shared `SelectField`
 * dropdown (`ui/components/SelectField.kt`), the native app's equivalent of
 * the TSX reference's `<select>` elements; only Folder is a radio-row list
 * ([SelectableRow]) — the one section the reference also renders as a list.
 *
 * One deliberate narrowing from the TSX reference: that screen retries its
 * `modelsRequest` on every heartbeat while no list has landed yet
 * (`freshAskedFor` in its own doc comment). `UniffiMachineSummary` carries no
 * heartbeat timestamp to key that retry loop off of, so this screen instead
 * asks once per screen-open and once per backend change — covering the
 * common case (the picker asks, the bridge answers) without inventing a
 * timer this FFI surface doesn't need for anything else.
 *
 * Create differs from the TSX's `await core.api.createSession` the same way:
 * the FFI dispatch has no awaited reply, so the in-flight button state and
 * the error banner come from a bounded wait on [CoreBridge.events] instead
 * (see [NewSessionBody.create]).
 */
@Composable
fun NewSessionScreen(bridge: CoreBridge, machinePubkey: String, onClose: () -> Unit) {
    val machinesView by bridge.machines.collectAsState()
    val settings by bridge.settings.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
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
        defaultModel = settings?.defaultModel.orEmpty(),
        defaultEffort = settings?.defaultEffort.orEmpty(),
        events = bridge.events,
        dispatch = ::dispatch,
        onClose = onClose,
    )
}

@Composable
private fun NewSessionBody(
    machine: UniffiMachineSummary,
    defaultModel: String,
    defaultEffort: String,
    events: StateFlow<CoreEvent?>,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
) {
    // Preferences (CDX-047 parity) pre-select model/effort; '' stays "bridge
    // default" the same way every other field here uses '' for that. Re-keyed
    // on the machine so switching which machine's "+" opened this screen
    // (unlikely — the shell always dismisses first — but cheap to be honest
    // about) starts from a clean slate rather than a stale prior selection.
    var folderChoice by remember(machine.pubkeyHex) { mutableStateOf("") }
    var newFolder by remember(machine.pubkeyHex) { mutableStateOf("") }
    var model by remember(machine.pubkeyHex) { mutableStateOf(defaultModel) }
    var effort by remember(machine.pubkeyHex) { mutableStateOf(defaultEffort) }
    // "" = Claude Code (the only backend before OpenCode existed), matching
    // the ''-means-default convention every other field here already uses.
    var backend by remember(machine.pubkeyHex) { mutableStateOf("") }
    var providerId by remember(machine.pubkeyHex) { mutableStateOf("") }
    // Create-flow feedback — mobile's `creating`/`error` pair: the button
    // disables with a "Creating…" label, and failures surface as a banner
    // above the button row instead of closing the screen silently.
    var creating by remember { mutableStateOf(false) }
    var createError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(machine.pubkeyHex, backend) {
        dispatch(UniffiIntent.RequestModels(machine.pubkeyHex, backend.ifEmpty { null }))
    }
    LaunchedEffect(machine.pubkeyHex) {
        if (machine.capabilities.contains(CAP_CUSTOM_PROVIDERS)) {
            dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
        }
    }

    // The roots themselves, offered only when there is a choice to make — with
    // one root "Default (workspace root)" already IS that root, and a second
    // identical-looking row would be noise.
    val roots = if (machine.roots.size > 1) machine.roots else emptyList()
    val newFolderPath = newFolder.trim()
    val canCreate = folderChoice != NEW_FOLDER || newFolderPath.isNotEmpty()

    // The Provider select exists only when the bridge can honor it — cap
    // advertised AND OpenCode isn't the active backend (custom provider
    // profiles are an Anthropic-compatible-credential concept OpenCode never
    // reads).
    val providerProfiles: List<UniffiProviderProfileInfo> =
        if (backend != BACKEND_OPENCODE && machine.capabilities.contains(CAP_CUSTOM_PROVIDERS)) {
            machine.providerProfiles
        } else {
            emptyList()
        }
    val activeProfile = if (providerId != "") providerProfiles.find { it.id == providerId } else null
    // OpenCode has its own model list, unrelated to Claude Code's — the Model
    // picker must never mix the two.
    val modelsList: List<UniffiModelEntry> = if (backend == BACKEND_OPENCODE) machine.openCodeModels else machine.models
    val modelsErr = if (backend == BACKEND_OPENCODE) machine.openCodeModelsError else machine.modelsError

    fun changeProvider(id: String) {
        providerId = id
        val profile = if (id == "") null else providerProfiles.find { it.id == id }
        model = profile?.defaultModel ?: defaultModel
    }

    fun changeBackend(value: String) {
        backend = value
        providerId = ""
        // OpenCode model ids don't share Claude Code's shape — reset to the
        // bridge/OpenCode default instead of carrying over a stale preference.
        model = if (value == BACKEND_OPENCODE) "" else defaultModel
    }

    fun create() {
        if (creating) return
        creating = true
        createError = null
        // Identity of the pre-dispatch event: a StateFlow replays its CURRENT
        // value to a new collector, so the wait below must compare against
        // this exact instance or it would instantly match the stale event
        // that was already sitting in the flow before we dispatched.
        val before = events.value
        val cwd = if (folderChoice == NEW_FOLDER) newFolderPath else folderChoice
        dispatch(
            UniffiIntent.CreateSession(
                machine = machine.pubkeyHex,
                cwd = cwd.ifEmpty { null },
                createCwd = if (folderChoice == NEW_FOLDER) true else null,
                model = model.ifEmpty { null },
                defaultEffort = effort.ifEmpty { null },
                providerId = providerId.ifEmpty { null },
                backend = if (backend == BACKEND_OPENCODE) BACKEND_OPENCODE else null,
            ),
        )
        scope.launch {
            // No explicit refresh is needed on success — CoreBridge refreshes
            // its views from the very StateChanged events watched here.
            val settled = withTimeoutOrNull(CREATE_CONFIRM_TIMEOUT_MS) {
                events.first { event ->
                    event !== before && when (event) {
                        is CoreEvent.StateChanged -> event.slice == SliceId.MACHINES
                        is CoreEvent.ActionFailed -> true
                        else -> false
                    }
                }
            }
            creating = false
            when (settled) {
                is CoreEvent.StateChanged ->
                    // Accepted; the sidebar's pending-session card takes over
                    // from here (mobile's optimistic flow).
                    onClose()
                is CoreEvent.ActionFailed -> createError = actionFailedCopy(settled.kind)
                else -> createError = "The bridge did not confirm — check the session list."
            }
        }
    }

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

            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space4),
            ) {
                // --- Folder ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                    SectionHeading("Folder")
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
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Text(
                        "Folders come from the machine's workspace; a new folder is created " +
                            "(and git-initialized) on the machine.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // Rendered only when the bridge advertises the 'opencode'
                // capability — an old bridge's zod would reject the field
                // anyway, so hiding the picker keeps this screen honest about
                // what this bridge can do.
                if (machine.capabilities.contains(CAP_OPENCODE)) {
                    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        SectionHeading("Backend")
                        SelectField(
                            options = listOf(
                                PickerOption("", "Claude Code"),
                                PickerOption(BACKEND_OPENCODE, "OpenCode"),
                            ),
                            selected = backend,
                            onSelect = ::changeBackend,
                        )
                    }
                }

                // Rendered only when the bridge advertises 'custom-providers'
                // AND stores at least one profile — an OpenCode session never
                // sees this (providerProfiles is forced empty above).
                if (providerProfiles.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        SectionHeading("Provider")
                        SelectField(
                            options = listOf(PickerOption("", "Anthropic")) +
                                providerProfiles.map { PickerOption(it.id, it.label) },
                            selected = providerId,
                            onSelect = ::changeProvider,
                        )
                    }
                }

                // --- Model ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                    SectionHeading("Model")
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
                    // CDX-035: the bridge's own reason for an empty answer, so
                    // an unavailable list is explained instead of silently
                    // blank — only on the plain (non-profile) path, a
                    // provider profile brings its own list.
                    if (activeProfile == null && modelsList.isEmpty() && modelsErr != null) {
                        Text(modelsErr, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    }
                }

                // --- Effort ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                    SectionHeading("Effort")
                    SelectField(
                        options = listOf(PickerOption("", "Default effort")) +
                            EFFORT_LEVELS.map { PickerOption(it, it) },
                        selected = effort,
                        onSelect = { effort = it },
                    )
                }

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

@Composable
private fun SectionHeading(title: String) {
    Text(title, color = Tokens.TextMuted, fontSize = Tokens.TextMd)
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
