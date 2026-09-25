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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiProviderProfileAck
import uniffi.client_ffi.UniffiQuickPrompt
import uniffi.client_ffi.UniffiSettingsView
import uniffi.client_ffi.UniffiUiView
import java.util.UUID

/** UI-scale slider bounds and default — `core/stores/settings.ts`'s
 *  UI_SCALE_MIN / UI_SCALE_MAX / UI_SCALE_DEFAULT. */
private const val UI_SCALE_MIN = 0.85f
private const val UI_SCALE_MAX = 1.4f
private const val UI_SCALE_DEFAULT = 1f

/** A default-for-new-sessions picker over every paired agent's choices (by
 *  id, first label wins), plus "agent default" and — so a stored preference
 *  no current agent offers stays visible and clearable — that stored value. */
private fun preferenceOptions(choices: List<UniffiOptionChoice>, stored: String): List<PickerOption> = buildList {
    add(PickerOption("", "Agent default"))
    choices.distinctBy { it.id }.forEach { add(PickerOption(it.id, it.label)) }
    if (stored != "" && choices.none { it.id == stored }) add(PickerOption(stored, stored))
}

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
fun SettingsScreen(core: CoreHost, onClose: () -> Unit) {
    val settings by core.settings.collectAsState()
    val quickPrompts by core.quickPrompts.collectAsState()
    val connection by core.connection.collectAsState()
    val machinesView by core.machines.collectAsState()
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }

    val view = settings
    if (view == null) {
        // Pre-hydration — same shape `MainActivity` shows while its own
        // core reference is still null. Nothing to render until the
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
                            valueRange = UI_SCALE_MIN..UI_SCALE_MAX,
                            // Ten steps between the bounds = twelve stops, exactly
                            // the TSX slider's 0.05 increments.
                            steps = 10,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "${Math.round(sliderPosition * 100)}%",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                        )
                        val atDefault = sliderPosition == UI_SCALE_DEFAULT
                        Text(
                            "Reset",
                            color = if (atDefault) Tokens.TextDim else Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                            modifier =
                                (if (atDefault) {
                                    Modifier
                                } else {
                                    Modifier.clickable {
                                        sliderPosition = UI_SCALE_DEFAULT
                                        dispatch(UniffiIntent.SetUiScale(1.0))
                                    }
                                }).padding(Tokens.Space2),
                        )
                    }
                    Text(
                        "The whole interface previews live. Base size adapts to the " +
                            "screen automatically; this multiplies it.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // --- Preferences (defaults for new sessions) ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Preferences")
                    // The TSX's `.prefRow` — the label takes the free width and
                    // the control sits at the row's right edge, never stacked.
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        Text(
                            "Default mode",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.weight(1f),
                        )
                        SelectField(
                            options = preferenceOptions(machines.flatMap { m -> m.agents.flatMap { it.modes } }, view.defaultMode),
                            selected = view.defaultMode,
                            onSelect = { dispatch(UniffiIntent.SetDefaultMode(it)) },
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        Text(
                            "Default effort",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.weight(1f),
                        )
                        SelectField(
                            options = preferenceOptions(machines.flatMap { m -> m.agents.flatMap { it.efforts } }, view.defaultEffort),
                            selected = view.defaultEffort,
                            onSelect = { dispatch(UniffiIntent.SetDefaultEffort(it)) },
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        Text(
                            "Default model",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.weight(1f),
                        )
                        val modelUnion = machines.flatMap { m -> m.models.flatMap { it.models } }.distinctBy { it.id }
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
                    }
                    // The TSX's muted paragraph under the three pickers.
                    Text(
                        "Pre-filled on the new-session screen whenever the chosen agent " +
                            "offers them. Choices come from every paired machine's agents.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // --- Notifications & badges ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Notifications & badges")
                    SwitchRow(
                        label = "Notifications (system notifications and the attention chime)",
                        checked = view.notificationsEnabled,
                        onChange = { dispatch(UniffiIntent.SetNotificationsEnabled(it)) },
                    )
                    SwitchRow(
                        label = "Show usage badge (5h/7d limits in the session header)",
                        checked = view.showUsageBadge,
                        onChange = { dispatch(UniffiIntent.SetShowUsageBadge(it)) },
                    )
                    SwitchRow(
                        label = "Show commit badge on session cards",
                        checked = view.showCommitBadge,
                        onChange = { dispatch(UniffiIntent.SetShowCommitBadge(it)) },
                    )
                }

                // --- Stay connected ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Stay connected")
                    // The switch only stores the preference. StayConnectedService
                    // (which hosts the CoreHost, so it can never be
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
                    Text(
                        "Android only: a foreground service holds the process and radio " +
                            "awake (persistent notification shows the live connection state). " +
                            "It asks for notification permission on first start. Off = the OS " +
                            "may pause CodeDeck in the background; it resyncs when you return.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // --- Route through Orbot ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Route through Orbot")
                    SwitchRow(
                        label = "Route relay traffic through Orbot (SOCKS5)",
                        checked = view.torProxyEnabled,
                        onChange = { dispatch(UniffiIntent.SetTorEnabled(it)) },
                    )
                    Text(
                        "Android only. Requires Orbot installed and running with its SOCKS " +
                            "proxy enabled (127.0.0.1:9050 by default) — this does not launch " +
                            "or manage Orbot itself. Fully applied on the next app restart; " +
                            "toggling while running only affects NEW connections, not ones " +
                            "already open.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
                }

                // --- Messages ---
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SectionHeading("Messages")
                    // Local draft persisted on blur only — the same shape as the
                    // TSX's `onBlur` (re-keyed on the stored value so an echo or
                    // an external change snaps the draft back to the truth).
                    var blossomDraft by remember(view.blossomServer) { mutableStateOf(view.blossomServer) }
                    var blossomHadFocus by remember { mutableStateOf(false) }
                    Box(Modifier.fillMaxWidth()) {
                        OutlinedTextField(
                            value = blossomDraft,
                            onValueChange = { blossomDraft = it },
                            placeholder = { Text("https://blossom.descendant.io (image upload server)") },
                            modifier = Modifier
                                .fillMaxWidth()
                                .onFocusChanged { focus ->
                                    if (focus.isFocused) {
                                        blossomHadFocus = true
                                    } else if (blossomHadFocus) {
                                        // onFocusChanged also reports the initial attach
                                        // as unfocused — only a field that held focus writes.
                                        blossomHadFocus = false
                                        dispatch(UniffiIntent.SetBlossomServer(blossomDraft.trim()))
                                    }
                                },
                        )
                    }
                    Text(
                        "Blossom server for image attachments in DMs and session messages " +
                            "(images are encrypted before upload; the key travels only inside " +
                            "the encrypted message). Empty = the built-in default.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
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
                    Text(
                        "Shortcuts shown above the session input; tapping one inserts its " +
                            "text into the draft (it never sends by itself).",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
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
                    var relayError by remember { mutableStateOf<String?>(null) }
                    relayError?.let { error ->
                        Text(error, color = Tokens.Danger, fontSize = Tokens.TextSm)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        OutlinedTextField(
                            value = addRelayDraft,
                            onValueChange = {
                                addRelayDraft = it
                                relayError = null
                            },
                            placeholder = { Text("wss://relay.example.com") },
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            onClick = {
                                val url = addRelayDraft.trim()
                                // The TSX's `^wss?://.+` gate on the trimmed input —
                                // same error copy, and no add when it fails.
                                if (!Regex("^wss?://.+").matches(url)) {
                                    relayError = "relay URLs start with wss:// (or ws:// for local dev)"
                                } else {
                                    relayError = null
                                    dispatch(UniffiIntent.AddRelay(url))
                                    addRelayDraft = ""
                                }
                            },
                            enabled = addRelayDraft.isNotBlank(),
                        ) {
                            Text("Add")
                        }
                    }
                    Text(
                        "Removing the last relay is blocked — the phone needs at least one.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                    )
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

        MachineCredentials(machine, credentialsStatus, dispatch)

        if (machine.agents.any { it.supportsProviders }) {
            MachineProviders(machine, providerProfileStatus, dispatch)
        }

        if (confirmRemove) {
            Text(
                "Remove ${machine.name} from this phone? Its sessions keep running on " +
                    "the machine; this forgets the pairing and the local transcripts.",
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

/**
 * Section label — the reference (`SettingsScreen.tsx`'s section titles) is
 * uppercase, semibold, letter-spaced, muted text: a label, not body text.
 * Same treatment `SessionsScreen.kt`'s MachineHeader gives machine names and
 * `NewSessionScreen.kt`'s SectionHeading gives its pickers —
 * `String.uppercase()`, `FontWeight.Bold`, 0.05 em tracking on the muted
 * color.
 */
@Composable
private fun SectionHeading(title: String) {
    Text(
        title.uppercase(),
        color = Tokens.TextMuted,
        fontSize = Tokens.TextMd,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.05.em,
    )
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
        // Same shape as `SessionsScreen`'s private PresenceDot (its own copy —
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
