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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiQuickPrompt
import uniffi.uniffi_bridge.UniffiSettingsView
import java.util.UUID

/** The complete default-mode set — `PermissionMode`'s own wire spellings. */
private val MODE_OPTIONS = listOf("default", "acceptEdits", "plan")

/**
 * F4.1.5 — the settings screen, rendered as a full-screen replacement the
 * shell swaps in (not an overlay): port of `apps/mobile/src/ui/screens/
 * SettingsScreen.tsx`'s global-preference surface — UI scale, defaults for
 * new sessions, notifications/badges, stay-connected, Orbot routing, the
 * blossom server, the quick-prompt editor, and relay management with
 * per-relay connection dots. Deliberately absent: mesh (deferred to F6,
 * off by default upstream) and the per-machine credentials/providers blocks
 * (F4.3) — no placeholder UI for either; they appear when those milestones
 * do.
 */
@Composable
fun SettingsScreen(bridge: CoreBridge, onClose: () -> Unit) {
    val settings by bridge.settings.collectAsState()
    val quickPrompts by bridge.quickPrompts.collectAsState()
    val connection by bridge.connection.collectAsState()
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
                Text(
                    "×",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXl,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .clickable(onClick = onClose)
                        .padding(Tokens.Space2),
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
                    OutlinedTextField(
                        value = view.defaultEffort,
                        onValueChange = { dispatch(UniffiIntent.SetDefaultEffort(it)) },
                        label = { Text("Default effort") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = view.defaultModel,
                        onValueChange = { dispatch(UniffiIntent.SetDefaultModel(it)) },
                        label = { Text("Default model") },
                        modifier = Modifier.fillMaxWidth(),
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
                    // Stores the preference only. Starting/stopping the actual
                    // StayConnectedService foreground service from this toggle
                    // is separate follow-up wiring — today the service runs
                    // whenever the app does (see MainActivity), regardless of
                    // this switch.
                    SwitchRow(
                        label = "Keep the connection alive in the background",
                        checked = view.stayConnected,
                        onChange = { dispatch(UniffiIntent.SetStayConnected(it)) },
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
            }
        }
    }
}

@Composable
private fun SectionHeading(title: String) {
    Text(title, color = Tokens.TextMuted, fontSize = Tokens.TextMd)
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
