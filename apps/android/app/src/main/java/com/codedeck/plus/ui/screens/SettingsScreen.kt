package com.codedeck.plus.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
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
import androidx.compose.material.icons.outlined.CloudSync
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.BuildConfig
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.platform.KeyVault
import com.codedeck.plus.platform.Login
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.ui.components.ActionRow
import com.codedeck.plus.ui.components.ConfirmDialog
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.client_ffi.UniffiBackupStatus
import uniffi.client_ffi.UniffiBackupView
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.nsecOf
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
    /** One agent's AI providers on a machine, opened from the machine's page. */
    data class Providers(val pubkey: String, val agent: String) : SettingsPage
    data object Appearance : SettingsPage
    data object Notifications : SettingsPage
    data object Connection : SettingsPage
    data object Messages : SettingsPage
    data object Uploads : SettingsPage
    data object Backup : SettingsPage
    data object Account : SettingsPage

    fun save(): String = when (this) {
        Hub -> "hub"
        is Machine -> "machine:$pubkey"
        is Plugins -> "plugins:$pubkey:$agent"
        is Mcp -> "mcp:$pubkey:$agent"
        is Providers -> "providers:$pubkey:$agent"
        Appearance -> "appearance"
        Notifications -> "notifications"
        Connection -> "connection"
        Messages -> "messages"
        Uploads -> "uploads"
        Backup -> "backup"
        Account -> "account"
    }

    /** How far below the hub the page sits: Back goes to a shallower page. */
    val depth: Int
        get() = when (this) {
            Hub -> 0
            is Plugins, is Mcp, is Providers -> 2
            else -> 1
        }

    companion object {
        fun restore(saved: String): SettingsPage = when {
            saved.startsWith("machine:") -> Machine(saved.removePrefix("machine:"))
            saved.startsWith("plugins:") -> saved.split(':').let { Plugins(it[1], it.drop(2).joinToString(":")) }
            saved.startsWith("mcp:") -> saved.split(':').let { Mcp(it[1], it.drop(2).joinToString(":")) }
            saved.startsWith("providers:") -> saved.split(':').let { Providers(it[1], it.drop(2).joinToString(":")) }
            saved == "appearance" -> Appearance
            saved == "notifications" -> Notifications
            saved == "connection" -> Connection
            saved == "messages" -> Messages
            saved == "uploads" -> Uploads
            saved == "backup" -> Backup
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
    // As in the shell: a page keeps its saved UI state (scroll position,
    // expanded rows) while a deeper page is open over it, and forgets it once
    // left for a page no deeper than itself.
    val pages = rememberSaveableStateHolder()
    fun open(next: SettingsPage) {
        val left = pageKey
        if (left != next.save() && next.depth <= SettingsPage.restore(left).depth) pages.removeState(left)
        pageKey = next.save()
    }
    val toHub = { open(SettingsPage.Hub) }
    // A page of a machine's (its providers, plugins or MCP servers) goes back
    // to the machine's page, where it was left; every other to the hub.
    val machineOf = when (page) {
        is SettingsPage.Plugins -> page.pubkey
        is SettingsPage.Mcp -> page.pubkey
        is SettingsPage.Providers -> page.pubkey
        else -> null
    }
    val back = machineOf?.let { pubkey -> { open(SettingsPage.Machine(pubkey)) } } ?: toHub
    if (page != SettingsPage.Hub) BackHandler(onBack = back)

    val view = settings
    if (view == null) {
        PageLoading()
        return
    }
    val machines = machinesView?.machines.orEmpty().sortedBy { it.name.lowercase() }
    // An npub that fails to derive shows as absent rather than crashing
    // the whole settings hub.
    val npub = remember { runCatching { core.identityNpub() }.getOrDefault("") }
    val signerLabel = (login as? Login.SignerApp)?.let { remember(it.packageName) { appLabel(context, it.packageName) } }

    pages.SaveableStateProvider(pageKey) {
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
                        onOpenProviders = { agent -> open(SettingsPage.Providers(machine.pubkeyHex, agent)) },
                        onOpenPlugins = { agent -> open(SettingsPage.Plugins(machine.pubkeyHex, agent)) },
                        onOpenMcp = { agent -> open(SettingsPage.Mcp(machine.pubkeyHex, agent)) },
                    )
                }
            }
            is SettingsPage.Plugins -> PluginsScreen(core, page.pubkey, page.agent, onBack = back)
            is SettingsPage.Mcp -> McpScreen(core, page.pubkey, page.agent, onBack = back)
            is SettingsPage.Providers -> ProvidersScreen(core, page.pubkey, page.agent, onBack = back)
            SettingsPage.Appearance -> AppearancePage(view, ::dispatch, toHub)
            SettingsPage.Notifications -> NotificationsPage(view, ::dispatch, toHub)
            SettingsPage.Connection -> {
                val serviceForeground by StayConnectedService.foreground.collectAsState()
                ConnectionPage(view, serviceForeground, ::dispatch, toHub)
            }
            SettingsPage.Messages -> MessagesPage(view, quickPrompts?.prompts.orEmpty(), ::dispatch, toHub)
            SettingsPage.Uploads -> UploadsPage(view, ::dispatch, toHub)
            SettingsPage.Backup -> BackupPage(view.backup, view.torProxyEnabled, System.currentTimeMillis(), ::dispatch, toHub)
            SettingsPage.Account -> AccountPage(
                npub,
                signerLabel,
                onLogOut,
                toHub,
                // Only a key kept on this phone can be shown; reading it
                // touches the Keystore and a file, so not on the main thread.
                revealKey = if (login is Login.OnDevice) {
                    { withContext(Dispatchers.IO) { KeyVault(context).identitySecretHex()?.let { nsecOf(it) } } }
                } else {
                    null
                },
            )
        }
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
                    val tint = when (machinePresence(machine, now)) {
                        MachinePresence.Online -> Tokens.PresenceLive
                        MachinePresence.Mismatched -> Tokens.Warn
                        MachinePresence.Offline -> Tokens.TextMuted
                    }
                    NavRow(
                        title = machineLabel(machine.name),
                        subtitle = machineStatusText(machine, now) + sessionCount(machine),
                        icon = { RowIcon(DeckIcons.Machine, tint = tint) },
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
            Divider(inset = 68.dp)
            NavRow(
                "Backup",
                onClick = { onOpen(SettingsPage.Backup) },
                icon = { RowIcon(Icons.Outlined.CloudSync) },
                subtitle = backupSummary(view.backup, now),
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

/** The hub's line for the backup: off, waiting on a choice, failing, or when it last saved. */
private fun backupSummary(backup: UniffiBackupView, now: Long): String {
    val relay = backup.relay ?: return "Off"
    return when (val status = backup.status) {
        is UniffiBackupStatus.Found -> "A backup on ${relayHost(relay)} waits for you"
        is UniffiBackupStatus.Failed -> "Not backed up"
        else -> backup.savedAt?.let { "Backed up ${whenSaved(it.toLong(), now)}" } ?: "On, to ${relayHost(relay)}"
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
                var position by remember(view.uiScale) { mutableFloatStateOf(view.uiScale.toFloat()) }
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
                subtitle = "Mark a session's context ring when a 5-hour or 7-day limit passes 75%",
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
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete “${prompt.label}”?",
            body = "It no longer appears above the message field.",
            confirm = "Delete",
            onConfirm = { dispatch(UniffiIntent.RemoveQuickPrompt(prompt.id)) },
            onDismiss = { confirmDelete = false },
        )
    }
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
                QuietButton("Delete", onClick = { confirmDelete = true }, danger = true)
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
 * The secret key of a login kept on this phone, hidden until asked for:
 * it is the only way back into the identity on another phone or after
 * logging out. Copied as sensitive, so the keyboard's clipboard preview
 * does not show it.
 */
@Composable
private fun SecretKeyGroup(revealKey: suspend () -> String?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var nsec by remember { mutableStateOf<String?>(null) }
    var copied by remember { mutableStateOf(false) }
    Group(footer = "Anyone with your secret key is you. Keep a copy somewhere safe and never share it.") {
        val shown = nsec
        if (shown == null) {
            ValueRow("Secret key", subtitle = "Hidden") {
                QuietButton("Show", onClick = { scope.launch { nsec = revealKey() } })
            }
        } else {
            GroupBody {
                Text(shown, color = Tokens.Text, fontSize = Tokens.TextSm, fontFamily = Tokens.FontMono)
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                    SecondaryButton(if (copied) "Copied" else "Copy", onClick = {
                        copySensitive(context, shown)
                        copied = true
                    })
                    QuietButton("Hide", onClick = {
                        nsec = null
                        copied = false
                    })
                }
            }
        }
    }
}

/** Put a secret on the clipboard, flagged so Android does not preview it. */
private fun copySensitive(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText("Secret key", text)
    // API 33 only: before that there is no clipboard preview to hide the
    // secret from.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
}

/**
 * Who this phone is logged in as, and logging out. Logging out deletes
 * everything the phone keeps for the identity (paired machines, transcripts,
 * settings) — and, for a key kept on this phone, the key itself, which is
 * why the confirmation says so plainly.
 */
@Composable
internal fun AccountPage(
    npub: String,
    signerLabel: String?,
    onLogOut: () -> Unit,
    onBack: () -> Unit,
    revealKey: (suspend () -> String?)? = null,
) {
    var confirming by remember { mutableStateOf(false) }
    Page(title = "Account", onBack = onBack) {
        Group(footer = "Machines and relays know this phone by this key.") {
            ValueRow(
                if (signerLabel != null) "Key held by $signerLabel" else "Key stored on this phone",
                subtitle = npub,
                mono = true,
            ) {}
        }
        if (revealKey != null) SecretKeyGroup(revealKey)
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
