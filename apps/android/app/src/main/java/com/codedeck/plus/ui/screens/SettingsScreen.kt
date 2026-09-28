package com.codedeck.plus.ui.screens

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.SettingsEthernet
import androidx.compose.material.icons.outlined.TextFields
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.BuildConfig
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.platform.Login
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.ui.components.ActionRow
import com.codedeck.plus.ui.components.DeckIcons
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PageLoading
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.RowIcon
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SwitchRow
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiQuickPrompt
import uniffi.client_ffi.UniffiSettingsView
import java.util.UUID

/** UI-scale slider bounds and default — the core's `UI_SCALE_MIN` /
 *  `UI_SCALE_MAX` / `UI_SCALE_DEFAULT`. */
private const val UI_SCALE_MIN = 0.85f
private const val UI_SCALE_MAX = 1.4f
private const val UI_SCALE_DEFAULT = 1f

/** A page inside Settings. Saved as a string so the open page survives rotation. */
internal sealed interface SettingsPage {
    data object Hub : SettingsPage
    data class Machine(val pubkey: String) : SettingsPage
    /** One agent's plugins on a machine, opened from the machine's page. */
    data class Plugins(val pubkey: String, val agent: String) : SettingsPage
    /** One agent's MCP servers on a machine, opened from the machine's page. */
    data class Mcp(val pubkey: String, val agent: String) : SettingsPage
    data object Appearance : SettingsPage
    data object Notifications : SettingsPage
    data object Connection : SettingsPage
    data object Messages : SettingsPage
    data object Uploads : SettingsPage
    data object Account : SettingsPage

    fun save(): String = when (this) {
        Hub -> "hub"
        is Machine -> "machine:$pubkey"
        is Plugins -> "plugins:$pubkey:$agent"
        is Mcp -> "mcp:$pubkey:$agent"
        Appearance -> "appearance"
        Notifications -> "notifications"
        Connection -> "connection"
        Messages -> "messages"
        Uploads -> "uploads"
        Account -> "account"
    }

    companion object {
        fun restore(saved: String): SettingsPage = when {
            saved.startsWith("machine:") -> Machine(saved.removePrefix("machine:"))
            saved.startsWith("plugins:") -> saved.split(':').let { Plugins(it[1], it.drop(2).joinToString(":")) }
            saved.startsWith("mcp:") -> saved.split(':').let { Mcp(it[1], it.drop(2).joinToString(":")) }
            saved == "appearance" -> Appearance
            saved == "notifications" -> Notifications
            saved == "connection" -> Connection
            saved == "messages" -> Messages
            saved == "uploads" -> Uploads
            saved == "account" -> Account
            else -> Hub
        }
    }
}

/** The label of the app with `packageName`, or the package name itself. */
internal fun appLabel(context: Context, packageName: String): String = runCatching {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
}.getOrDefault(packageName)

/**
 * Settings: a hub of the paired machines and of this phone's own settings,
 * each opening a page of its own. Back on a page returns to the hub, and on
 * the hub closes Settings. Machines come first — most of what differs from
 * one setup to the next is per machine — then this phone, with Logs and
 * Account last.
 */
@Composable
fun SettingsScreen(
    core: CoreHost,
    login: Login? = null,
    onLogOut: () -> Unit = {},
    onOpenLogs: () -> Unit = {},
    onPairMachine: () -> Unit = {},
    onClose: () -> Unit,
) {
    val settings by core.settings.collectAsState()
    val quickPrompts by core.quickPrompts.collectAsState()
    val connection by core.connection.collectAsState()
    val machinesView by core.machines.collectAsState()
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var pageKey by rememberSaveable { mutableStateOf(SettingsPage.Hub.save()) }
    val page = SettingsPage.restore(pageKey)

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }
    fun open(next: SettingsPage) {
        pageKey = next.save()
    }
    val toHub = { open(SettingsPage.Hub) }
    // A plugins or MCP page goes back to its machine's page, every other to the hub.
    val back = when (page) {
        is SettingsPage.Plugins -> { { open(SettingsPage.Machine(page.pubkey)) } }
        is SettingsPage.Mcp -> { { open(SettingsPage.Machine(page.pubkey)) } }
        else -> toHub
    }
    if (page != SettingsPage.Hub) BackHandler(onBack = back)

    val view = settings
    if (view == null) {
        PageLoading()
        return
    }
    val machines = machinesView?.machines.orEmpty().sortedBy { it.name.lowercase() }
    val npub = remember { core.identityNpub() }
    val signerLabel = (login as? Login.SignerApp)?.let { remember(it.packageName) { appLabel(context, it.packageName) } }

    when (page) {
        SettingsPage.Hub -> SettingsHub(
            machines = machines,
            view = view,
            npub = npub,
            signerLabel = signerLabel,
            now = System.currentTimeMillis(),
            onOpen = ::open,
            onPairMachine = onPairMachine,
            onOpenLogs = onOpenLogs,
            onClose = onClose,
        )
        is SettingsPage.Machine -> {
            val machine = machines.find { it.pubkeyHex == page.pubkey }
            if (machine == null) {
                // Removed (here or elsewhere) while open.
                toHub()
            } else {
                MachineSettingsContent(
                    machine = machine,
                    connectedRelays = connection?.connectedRelays?.toSet().orEmpty(),
                    credentialsStatus = ui?.credentialsStatus?.get(machine.pubkeyHex),
                    providerProfileStatus = ui?.providerProfileStatus?.get(machine.pubkeyHex),
                    now = System.currentTimeMillis(),
                    dispatch = ::dispatch,
                    onBack = toHub,
                    onOpenPlugins = { agent -> open(SettingsPage.Plugins(machine.pubkeyHex, agent)) },
                    onOpenMcp = { agent -> open(SettingsPage.Mcp(machine.pubkeyHex, agent)) },
                )
            }
        }
        is SettingsPage.Plugins -> PluginsScreen(core, page.pubkey, page.agent, onBack = back)
        is SettingsPage.Mcp -> McpScreen(core, page.pubkey, page.agent, onBack = back)
        SettingsPage.Appearance -> AppearancePage(view, ::dispatch, toHub)
        SettingsPage.Notifications -> NotificationsPage(view, ::dispatch, toHub)
        SettingsPage.Connection -> {
            val serviceForeground by StayConnectedService.foreground.collectAsState()
            ConnectionPage(view, serviceForeground, ::dispatch, toHub)
        }
        SettingsPage.Messages -> MessagesPage(view, quickPrompts?.prompts.orEmpty(), ::dispatch, toHub)
        SettingsPage.Uploads -> UploadsPage(view, ::dispatch, toHub)
        SettingsPage.Account -> AccountPage(npub, signerLabel, onLogOut, toHub)
    }
}

/** The hub: the machines, then this phone's pages, Logs and Account last. */
@Composable
internal fun SettingsHub(
    machines: List<UniffiMachineSummary>,
    view: UniffiSettingsView,
    npub: String,
    signerLabel: String?,
    now: Long,
    onOpen: (SettingsPage) -> Unit,
    onPairMachine: () -> Unit,
    onOpenLogs: () -> Unit,
    onClose: () -> Unit,
    version: String = BuildConfig.VERSION_NAME,
) {
    Page(title = "Settings", onBack = onClose, backLabel = "Close settings") {
        Group(title = "Machines", footer = "Relays, agents and defaults are kept per machine.") {
            machines.forEach { machine ->
                key(machine.pubkeyHex) {
                    NavRow(
                        title = machineLabel(machine.name),
                        subtitle = machineStatusText(machine, now) + sessionCount(machine),
                        icon = { RowIcon(DeckIcons.Machine, tint = if (machinePresence(machine, now) == MachinePresence.Online) Tokens.PresenceLive else Tokens.TextMuted) },
                        onClick = { onOpen(SettingsPage.Machine(machine.pubkeyHex)) },
                    )
                    Divider(inset = 68.dp)
                }
            }
            ActionRow("Pair a machine", onClick = onPairMachine, icon = DeckIcons.PairMachine)
        }
        Group(title = "This phone") {
            NavRow(
                "Appearance",
                onClick = { onOpen(SettingsPage.Appearance) },
                icon = { RowIcon(Icons.Outlined.TextFields) },
                value = "${Math.round(view.uiScale * 100)}%",
            )
            Divider(inset = 68.dp)
            NavRow(
                "Notifications",
                onClick = { onOpen(SettingsPage.Notifications) },
                icon = { RowIcon(Icons.Outlined.NotificationsNone) },
                value = if (view.notificationsEnabled) "On" else "Off",
            )
            Divider(inset = 68.dp)
            NavRow(
                "Connection",
                onClick = { onOpen(SettingsPage.Connection) },
                icon = { RowIcon(Icons.Outlined.SettingsEthernet) },
                subtitle = listOf(
                    if (view.stayConnected) "Stays connected" else "Connects while open",
                    if (view.torProxyEnabled) "through Orbot" else null,
                ).filterNotNull().joinToString(", "),
            )
            Divider(inset = 68.dp)
            NavRow(
                "Messages",
                onClick = { onOpen(SettingsPage.Messages) },
                icon = { RowIcon(Icons.AutoMirrored.Outlined.Chat) },
                subtitle = "Quick prompts",
            )
            Divider(inset = 68.dp)
            NavRow(
                "Uploads",
                onClick = { onOpen(SettingsPage.Uploads) },
                icon = { RowIcon(Icons.Outlined.CloudUpload) },
                subtitle = if (view.blossomServer.isNotBlank()) "To ${blossomHost(view.blossomServer)}" else "Through the relays",
            )
        }
        Group {
            NavRow("Logs", onClick = onOpenLogs, icon = { RowIcon(Icons.AutoMirrored.Outlined.Article) })
            Divider(inset = 68.dp)
            NavRow(
                "Account",
                onClick = { onOpen(SettingsPage.Account) },
                icon = { RowIcon(Icons.Outlined.AccountCircle) },
                subtitle = (if (signerLabel != null) "In $signerLabel, " else "") + shortKey(npub),
            )
        }
        Text(
            "CodeDeck+ $version",
            color = Tokens.TextDim,
            fontSize = Tokens.TextXs,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Space2),
        )
    }
}

private fun sessionCount(machine: UniffiMachineSummary): String = when (val n = machine.sessions.size) {
    0 -> ""
    1 -> ", 1 session"
    else -> ", $n sessions"
}

@Composable
internal fun AppearancePage(view: UniffiSettingsView, dispatch: (UniffiIntent) -> Unit, onBack: () -> Unit) {
    Page(title = "Appearance", onBack = onBack) {
        Group(title = "Size", footer = "Scales the whole interface, text and spacing together, on top of the phone's own size.") {
            GroupBody {
                // Local position while dragging; re-keyed on the stored value
                // so a change made elsewhere snaps the thumb to it. The intent
                // fires on release.
                var position by remember(view.uiScale) { mutableStateOf(view.uiScale.toFloat()) }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Text("${Math.round(position * 100)}%", color = Tokens.Text, fontSize = Tokens.TextXl, modifier = Modifier.weight(1f))
                    QuietButton("Reset", enabled = position != UI_SCALE_DEFAULT, onClick = {
                        position = UI_SCALE_DEFAULT
                        dispatch(UniffiIntent.SetUiScale(UI_SCALE_DEFAULT.toDouble()))
                    })
                }
                Slider(
                    value = position,
                    // Snaps to 5% steps without drawing them.
                    onValueChange = { position = Math.round(it * 20) / 20f },
                    onValueChangeFinished = { dispatch(UniffiIntent.SetUiScale(position.toDouble())) },
                    valueRange = UI_SCALE_MIN..UI_SCALE_MAX,
                    colors = SliderDefaults.colors(
                        thumbColor = Tokens.Accent,
                        activeTrackColor = Tokens.Accent,
                        inactiveTrackColor = Tokens.SurfaceHover,
                        activeTickColor = Tokens.AccentContrast,
                        inactiveTickColor = Tokens.TextDim,
                    ),
                )
            }
        }
        Group(title = "Badges") {
            SwitchRow(
                "Usage limits",
                subtitle = "The 5-hour and 7-day limits in a session's header",
                checked = view.showUsageBadge,
                onChange = { dispatch(UniffiIntent.SetShowUsageBadge(it)) },
            )
            Divider()
            SwitchRow(
                "Committed",
                subtitle = "Marks sessions whose work is committed",
                checked = view.showCommitBadge,
                onChange = { dispatch(UniffiIntent.SetShowCommitBadge(it)) },
            )
        }
    }
}

@Composable
internal fun NotificationsPage(view: UniffiSettingsView, dispatch: (UniffiIntent) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    Page(title = "Notifications", onBack = onBack) {
        Group(footer = "When a session finishes, fails, or waits for you. The session on screen never notifies.") {
            SwitchRow(
                "Notifications",
                subtitle = "System notifications and the in-app chime",
                checked = view.notificationsEnabled,
                onChange = { dispatch(UniffiIntent.SetNotificationsEnabled(it)) },
            )
        }
        Group(footer = "Android keeps a channel per kind — action needed, session updates, messages — to silence or style separately.") {
            NavRow(
                "Sounds and channels",
                onClick = {
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
            )
        }
    }
}

@Composable
internal fun ConnectionPage(view: UniffiSettingsView, serviceForeground: Boolean?, dispatch: (UniffiIntent) -> Unit, onBack: () -> Unit) {
    Page(title = "Connection", onBack = onBack) {
        Group(
            footer = "Keeps the connection open in the background with a foreground service, checking it about every " +
                "minute and letting the phone sleep in between. Off, Android may pause the app in the background; " +
                "it catches up when you return.",
        ) {
            SwitchRow(
                "Stay connected",
                subtitle = when (serviceForeground) {
                    true -> "Running"
                    false -> "Not running"
                    null -> null
                },
                checked = view.stayConnected,
                onChange = { dispatch(UniffiIntent.SetStayConnected(it)) },
            )
        }
        Group(
            footer = "Sends relay and image-server traffic through Orbot (127.0.0.1:9050), which must be installed and " +
                "running. A machine's direct link skips it, except to .onion addresses. Changes apply immediately, " +
                "tearing down and re-dialing all relay connections.",
        ) {
            SwitchRow(
                "Route through Orbot",
                checked = view.torProxyEnabled,
                onChange = { dispatch(UniffiIntent.SetTorEnabled(it)) },
            )
        }
    }
}

@Composable
internal fun MessagesPage(
    view: UniffiSettingsView,
    quickPrompts: List<UniffiQuickPrompt>,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
) {
    Page(title = "Messages", onBack = onBack) {
        Group(
            title = "Quick prompts",
            footer = "Shortcuts above the message field; tapping one puts its text in the draft, it never sends by itself.",
        ) {
            quickPrompts.forEach { prompt ->
                key(prompt.id) {
                    QuickPromptRow(prompt, dispatch)
                    Divider()
                }
            }
            NewQuickPrompt(dispatch)
        }
    }
}

@Composable
private fun QuickPromptRow(prompt: UniffiQuickPrompt, dispatch: (UniffiIntent) -> Unit) {
    var editing by remember { mutableStateOf(false) }
    if (editing) {
        var label by remember { mutableStateOf(prompt.label) }
        var text by remember { mutableStateOf(prompt.text) }
        GroupBody {
            Field(value = label, onValueChange = { label = it }, label = "Label")
            Field(value = text, onValueChange = { text = it }, label = "Text", singleLine = false)
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                SecondaryButton("Save", onClick = {
                    dispatch(UniffiIntent.UpdateQuickPrompt(id = prompt.id, label = label, text = text))
                    editing = false
                }, enabled = label.isNotBlank() && text.isNotBlank())
                QuietButton("Delete", onClick = { dispatch(UniffiIntent.RemoveQuickPrompt(prompt.id)) }, danger = true)
                Box(Modifier.weight(1f))
                QuietButton("Cancel", onClick = { editing = false })
            }
        }
    } else {
        NavRow(title = prompt.label, subtitle = prompt.text, onClick = { editing = true })
    }
}

@Composable
private fun NewQuickPrompt(dispatch: (UniffiIntent) -> Unit) {
    var label by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    GroupBody {
        Field(value = label, onValueChange = { label = it }, placeholder = "Label, e.g. Continue")
        Field(value = text, onValueChange = { text = it }, placeholder = "The text it puts in the draft", singleLine = false)
        SecondaryButton("Add prompt", onClick = {
            dispatch(UniffiIntent.AddQuickPrompt(id = UUID.randomUUID().toString(), label = label, text = text))
            label = ""
            text = ""
        }, enabled = label.isNotBlank() && text.isNotBlank())
    }
}

/**
 * Who this phone is logged in as, and logging out. Logging out deletes
 * everything the phone keeps for the identity (paired machines, transcripts,
 * settings) — and, for a key kept on this phone, the key itself, which is
 * why the confirmation says so plainly.
 */
@Composable
internal fun AccountPage(npub: String, signerLabel: String?, onLogOut: () -> Unit, onBack: () -> Unit) {
    var confirming by remember { mutableStateOf(false) }
    Page(title = "Account", onBack = onBack) {
        Group(footer = "Machines and relays know this phone by this key.") {
            ValueRow(
                if (signerLabel != null) "Key held by $signerLabel" else "Key stored on this phone",
                subtitle = npub,
                mono = true,
            ) {}
        }
        Group {
            if (confirming) {
                GroupBody {
                    Text(
                        if (signerLabel != null) {
                            "Log out? Your key stays in $signerLabel. This phone forgets its paired machines, " +
                                "transcripts and settings; you can log back in and pair again."
                        } else {
                            "Log out? This deletes the secret key from this phone. Without a copy of it you " +
                                "cannot log in as this identity again. Paired machines, transcripts and " +
                                "settings are deleted too."
                        },
                        color = Tokens.Danger,
                        fontSize = Tokens.TextSm,
                        overflow = TextOverflow.Clip,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        SecondaryButton("Log out", onClick = onLogOut, danger = true)
                        QuietButton("Cancel", onClick = { confirming = false })
                    }
                }
            } else {
                ActionRow("Log out", onClick = { confirming = true }, danger = true)
            }
        }
    }
}
