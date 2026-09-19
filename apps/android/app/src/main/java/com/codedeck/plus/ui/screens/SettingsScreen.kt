package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiCredentialsAck
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiMachineSummary
import uniffi.uniffi_bridge.UniffiProviderProfileAck
import uniffi.uniffi_bridge.UniffiQuickPrompt
import uniffi.uniffi_bridge.UniffiSettingsView
import uniffi.uniffi_bridge.UniffiUiView
import java.util.UUID

/** The complete default-mode set — `PermissionMode`'s own wire spellings. */
private val MODE_OPTIONS = listOf("default", "acceptEdits", "plan")

/** The effort ladder's wire spellings — `protocolConstants.ts`'s
 *  `EFFORT_LEVELS`, duplicated per-file for the same reason `MODE_OPTIONS`
 *  above is (no UniFFI export for protocol defaults on this FFI surface). */
private val EFFORT_OPTIONS = listOf("low", "medium", "high", "xhigh", "max", "auto")

/** One choice in a [SelectField] dropdown — value is what gets dispatched,
 *  label is what the user reads (they differ for the model union, where the
 *  label is the entry's human name and the value its wire id). */
private data class PickerOption(val value: String, val label: String)

/** Same capability string `NewSessionScreen.kt` gates its own provider picker
 *  on — duplicated per-file rather than shared, matching that file's own
 *  precedent (this codebase has no shared capability-constants file yet). */
private const val CAP_CUSTOM_PROVIDERS = "custom-providers"

/**
 * F4.1.5 — the settings screen, rendered as a full-screen replacement the
 * shell swaps in (not an overlay): port of `apps/mobile/src/ui/screens/
 * SettingsScreen.tsx`'s global-preference surface — UI scale, defaults for
 * new sessions, notifications/badges, stay-connected, Orbot routing, the
 * blossom server, the quick-prompt editor, relay management with per-relay
 * connection dots, and (F4.3) per-machine credentials/AI-provider blocks.
 * Deliberately absent: mesh (deferred to F6, off by default upstream).
 */
@Composable
fun SettingsScreen(bridge: CoreBridge, onClose: () -> Unit) {
    val settings by bridge.settings.collectAsState()
    val quickPrompts by bridge.quickPrompts.collectAsState()
    val connection by bridge.connection.collectAsState()
    val machinesView by bridge.machines.collectAsState()
    val ui by bridge.ui.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
    }

    val view = settings
    if (view == null) {
        // Pre-hydration — same shape `MainActivity` shows while its own
        // bridge reference is still null. Nothing to render until the
        // SETTINGS slice's first fetch lands.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
    } else {
        SettingsBody(
            view = view,
            quickPrompts = quickPrompts?.prompts.orEmpty(),
            connectedRelays = connection?.connectedRelays?.toSet().orEmpty(),
            machines = machinesView?.machines.orEmpty(),
            ui = ui,
            dispatch = ::dispatch,
            onClose = onClose,
        )
    }
}

@Composable
private fun SettingsBody(
    view: UniffiSettingsView,
    quickPrompts: List<UniffiQuickPrompt>,
    connectedRelays: Set<String>,
    machines: List<UniffiMachineSummary>,
    ui: UniffiUiView?,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
) {
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Settings", color = Tokens.Text, fontSize = Tokens.TextLg, modifier = Modifier.weight(1f))
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
                // --- UI scale ---
                Column {
                    SectionHeading("UI scale")
                    // Live local position for drag feedback; re-keyed on the
                    // persisted value so an echo of our own dispatch (or a
                    // change made anywhere else) snaps the thumb back to
                    // the truth. The intent only fires on release.
                    var sliderPosition by remember(view.uiScale) { mutableStateOf(view.uiScale.toFloat()) }
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        Slider(
                            value = sliderPosition,
                            onValueChange = { sliderPosition = it },
                            onValueChangeFinished = {
                                dispatch(UniffiIntent.SetUiScale(sliderPosition.toDouble()))
                            },
                            valueRange = 0.5f..2f,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "${(sliderPosition * 100).toInt()}%",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                        )
                    }
                }

                // --- Preferences (defaults for new sessions) ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Preferences")
                    Text("Default mode", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        MODE_OPTIONS.forEach { mode ->
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                                    .background(
                                        if (mode == view.defaultMode) Tokens.SurfaceHover else Tokens.SurfaceRaised,
                                    )
                                    .clickable { dispatch(UniffiIntent.SetDefaultMode(mode)) }
                                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                            ) {
                                Text(
                                    mode,
                                    color = if (mode == view.defaultMode) Tokens.Text else Tokens.TextMuted,
                                    fontSize = Tokens.TextSm,
                                )
                            }
                        }
                    }
                    Text("Default effort", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    SelectField(
                        options =
                            listOf(PickerOption("", "Default (auto)")) +
                                EFFORT_OPTIONS.map { PickerOption(it, it) },
                        selected = view.defaultEffort,
                        onSelect = { dispatch(UniffiIntent.SetDefaultEffort(it)) },
                    )

                    Text("Default model", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    val modelUnion = machines.flatMap { it.models }.distinctBy { it.id }
                    val storedModel = view.defaultModel
                    SelectField(
                        options = buildList {
                            add(PickerOption("", "Bridge default"))
                            modelUnion.forEach { entry ->
                                add(PickerOption(entry.id, entry.label ?: entry.id))
                            }
                            // The stored default may name a machine that has
                            // since unpaired — keep it visible and selectable
                            // so the user can see, keep, or clear it (the TSX's
                            // trailing stale-model `<option>`).
                            if (storedModel != "" && modelUnion.none { it.id == storedModel }) {
                                add(PickerOption(storedModel, storedModel))
                            }
                        },
                        selected = storedModel,
                        onSelect = { dispatch(UniffiIntent.SetDefaultModel(it)) },
                    )
                    // The TSX's muted paragraph under the three pickers.
                    Text(
                        "Applied to new sessions: the mode is switched right after the " +
                            "session starts; effort and model pre-fill the new-session " +
                            "sheet. Models come from every paired machine's reported list.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // --- Notifications & badges ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Notifications & badges")
                    SwitchRow(
                        label = "Notifications",
                        checked = view.notificationsEnabled,
                        onChange = { dispatch(UniffiIntent.SetNotificationsEnabled(it)) },
                    )
                    SwitchRow(
                        label = "Show usage badge",
                        checked = view.showUsageBadge,
                        onChange = { dispatch(UniffiIntent.SetShowUsageBadge(it)) },
                    )
                    SwitchRow(
                        label = "Show commit badge",
                        checked = view.showCommitBadge,
                        onChange = { dispatch(UniffiIntent.SetShowCommitBadge(it)) },
                    )
                }

                // --- Stay connected ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Stay connected")
                    // The switch only stores the preference. StayConnectedService
                    // (which hosts the CoreBridge, so it can never be
                    // started/stopped from here the way mobile's controller
                    // starts/stops its plugin service) collects the setting and
                    // promotes/demotes its own foreground state — the badge
                    // below is the service's live answer, mobile's
                    // `service running` / `service off` pair.
                    val serviceForeground by StayConnectedService.foreground.collectAsState()
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        Text(
                            "Keep the connection alive in the background",
                            color = Tokens.Text,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.weight(1f),
                        )
                        if (serviceForeground != null) {
                            // Same pill/border treatment as the TSX's
                            // `badgeLive`/`badgeOffline`: green text and border
                            // while running, dim text on the plain border off.
                            val live = serviceForeground == true
                            Text(
                                if (live) "service running" else "service off",
                                color = if (live) Tokens.Success else Tokens.TextDim,
                                fontSize = Tokens.TextXs,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                                    .border(
                                        1.dp,
                                        if (live) Tokens.Success else Tokens.BorderStrong,
                                        RoundedCornerShape(Tokens.RadiusPill),
                                    )
                                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                            )
                        }
                        Switch(
                            checked = view.stayConnected,
                            onCheckedChange = { dispatch(UniffiIntent.SetStayConnected(it)) },
                        )
                    }
                }

                // --- Route through Orbot ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Route through Orbot")
                    SwitchRow(
                        label = "Route relay traffic through Orbot (SOCKS5)",
                        checked = view.torProxyEnabled,
                        onChange = { dispatch(UniffiIntent.SetTorEnabled(it)) },
                    )
                }

                // --- Messages ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Messages")
                    OutlinedTextField(
                        value = view.blossomServer,
                        onValueChange = { dispatch(UniffiIntent.SetBlossomServer(it)) },
                        label = { Text("Blossom server") },
                        placeholder = { Text("Default") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                // --- Quick prompts ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Quick prompts")
                    quickPrompts.forEach { prompt ->
                        key(prompt.id) {
                            QuickPromptRow(prompt, dispatch)
                        }
                    }
                    var addLabel by remember { mutableStateOf("") }
                    var addText by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = addLabel,
                        onValueChange = { addLabel = it },
                        label = { Text("Label") },
                        placeholder = { Text("Label (e.g. Continue)") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        OutlinedTextField(
                            value = addText,
                            onValueChange = { addText = it },
                            label = { Text("Text") },
                            placeholder = { Text("Prompt text inserted into the draft") },
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = {
                                dispatch(
                                    UniffiIntent.AddQuickPrompt(
                                        id = UUID.randomUUID().toString(),
                                        label = addLabel,
                                        text = addText,
                                    ),
                                )
                                // Optimistic clear — don't wait for the
                                // QUICK_PROMPTS slice round-trip.
                                addLabel = ""
                                addText = ""
                            },
                            enabled = addLabel.isNotBlank() && addText.isNotBlank(),
                        ) {
                            Text("Add")
                        }
                    }
                }

                // --- Relays ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Relays")
                    // Min-1 guard, mirroring the TSX: the phone needs at
                    // least one relay, so the UI never offers to remove it.
                    val canRemove = view.relays.size > 1
                    view.relays.forEach { url ->
                        key(url) {
                            RelayRow(
                                url = url,
                                connected = url in connectedRelays,
                                canRemove = canRemove,
                                onRemove = { dispatch(UniffiIntent.RemoveRelay(url)) },
                            )
                        }
                    }
                    var addRelayDraft by remember { mutableStateOf("") }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        OutlinedTextField(
                            value = addRelayDraft,
                            onValueChange = { addRelayDraft = it },
                            placeholder = { Text("wss://…") },
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = {
                                dispatch(UniffiIntent.AddRelay(addRelayDraft.trim()))
                                addRelayDraft = ""
                            },
                            enabled = addRelayDraft.isNotBlank(),
                        ) {
                            Text("Add")
                        }
                    }
                }

                // --- Machines (F4.3) ---
                if (machines.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
                        SectionHeading("Machines")
                        machines.sortedBy { it.name }.forEach { machine ->
                            key(machine.pubkeyHex) {
                                MachineSection(
                                    machine = machine,
                                    credentialsStatus = ui?.credentialsStatus?.get(machine.pubkeyHex),
                                    providerProfileStatus = ui?.providerProfileStatus?.get(machine.pubkeyHex),
                                    dispatch = dispatch,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MachineSection(
    machine: UniffiMachineSummary,
    credentialsStatus: UniffiCredentialsAck?,
    providerProfileStatus: UniffiProviderProfileAck?,
    dispatch: (UniffiIntent) -> Unit,
) {
    var confirmRemove by remember(machine.pubkeyHex) { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.Surface)
            .padding(Tokens.Space3),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Text(machine.name, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
            val host = machine.host
            if (host != null) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceRaised)
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                ) {
                    Text(host, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
                }
            }
        }
        Text(
            "${machine.pubkeyHex.take(16)}…${machine.pubkeyHex.takeLast(8)}",
            color = Tokens.TextDim,
            fontSize = Tokens.TextXs,
            fontFamily = Tokens.FontMono,
        )

        MachineCredentials(machine.pubkeyHex, credentialsStatus, dispatch)

        if (machine.capabilities.contains(CAP_CUSTOM_PROVIDERS)) {
            MachineProviders(machine, providerProfileStatus, dispatch)
        }

        if (confirmRemove) {
            Text(
                "Remove ${machine.name}? You'll need to pair with it again to reconnect.",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text(
                    "Remove machine",
                    color = Tokens.Danger,
                    fontSize = Tokens.TextSm,
                    modifier = Modifier
                        .clickable { dispatch(UniffiIntent.RemoveMachine(machine.pubkeyHex)) }
                        .padding(Tokens.Space2),
                )
                Text(
                    "Cancel",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    modifier = Modifier.clickable { confirmRemove = false }.padding(Tokens.Space2),
                )
            }
        } else {
            Text(
                "Remove machine…",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier.clickable { confirmRemove = true }.padding(Tokens.Space2),
            )
        }
    }
}

@Composable
private fun SectionHeading(title: String) {
    Text(title, color = Tokens.TextMuted, fontSize = Tokens.TextMd)
}

/** A `<select>`-style dropdown — the same trigger-plus-[DropdownMenu] idiom
 *  `SessionScreen.kt`'s `EffortSelector` established (bordered trigger text
 *  that opens the option list on tap). `selected` not matching any option
 *  (a stored value from before a ladder/union changed) falls back to showing
 *  the raw value in the trigger rather than silently showing nothing. */
@Composable
private fun SelectField(
    options: List<PickerOption>,
    selected: String,
    enabled: Boolean = true,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val currentLabel = options.firstOrNull { it.value == selected }?.label ?: selected
    Box {
        Text(
            currentLabel,
            color = when {
                !enabled -> Tokens.TextDim
                selected == "" -> Tokens.TextMuted
                else -> Tokens.Text
            },
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceInput)
                .clickable(enabled = enabled) { open = true }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label, color = Tokens.Text, fontSize = Tokens.TextSm) },
                    onClick = {
                        open = false
                        onSelect(option.value)
                    },
                )
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Text(label, color = Tokens.Text, fontSize = Tokens.TextSm, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun QuickPromptRow(prompt: UniffiQuickPrompt, dispatch: (UniffiIntent) -> Unit) {
    // Inline per-row edit state — no dialog; leaving and re-entering edit
    // re-prefills from the prompt's current values.
    var editing by remember { mutableStateOf(false) }
    if (editing) {
        var editLabel by remember { mutableStateOf(prompt.label) }
        var editText by remember { mutableStateOf(prompt.text) }
        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            OutlinedTextField(
                value = editLabel,
                onValueChange = { editLabel = it },
                label = { Text("Label") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = editText,
                onValueChange = { editText = it },
                label = { Text("Text") },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Button(
                    onClick = {
                        dispatch(
                            UniffiIntent.UpdateQuickPrompt(
                                id = prompt.id,
                                label = editLabel,
                                text = editText,
                            ),
                        )
                        editing = false
                    },
                    enabled = editLabel.isNotBlank() && editText.isNotBlank(),
                ) {
                    Text("Save")
                }
                Text(
                    "Cancel",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    modifier = Modifier.clickable { editing = false }.padding(Tokens.Space2),
                )
            }
        }
    } else {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            Column(Modifier.weight(1f)) {
                Text(prompt.label, color = Tokens.Text, fontSize = Tokens.TextSm)
                Text(
                    prompt.text,
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                "Edit",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                modifier = Modifier.clickable { editing = true }.padding(Tokens.Space2),
            )
            Text(
                "Delete",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .clickable { dispatch(UniffiIntent.RemoveQuickPrompt(prompt.id)) }
                    .padding(Tokens.Space2),
            )
        }
    }
}

@Composable
private fun RelayRow(url: String, connected: Boolean, canRemove: Boolean, onRemove: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        // Same shape as `Sidebar`'s private PresenceDot (its own copy —
        // that helper is file-private to the ui package). Absent from
        // `ConnectionView.connectedRelays` doesn't mean unreachable, just
        // not currently subscribed.
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(if (connected) Tokens.Success else Tokens.TextDim),
        )
        Text(
            url,
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
            fontFamily = Tokens.FontMono,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            "Remove",
            color = if (canRemove) Tokens.Danger else Tokens.TextDim,
            fontSize = Tokens.TextSm,
            modifier = (if (canRemove) Modifier.clickable(onClick = onRemove) else Modifier)
                .padding(Tokens.Space2),
        )
    }
}
