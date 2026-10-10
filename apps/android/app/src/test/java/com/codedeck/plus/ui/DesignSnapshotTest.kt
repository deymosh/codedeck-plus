package com.codedeck.plus.ui

import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.codedeck.plus.ui.DesignFixtures.NOW
import com.codedeck.plus.ui.DesignFixtures.buildBox
import com.codedeck.plus.ui.DesignFixtures.claude
import com.codedeck.plus.ui.DesignFixtures.quickPrompts
import com.codedeck.plus.ui.DesignFixtures.settings
import com.codedeck.plus.ui.DesignFixtures.workstation
import com.codedeck.plus.ui.screens.AddView
import com.codedeck.plus.ui.screens.AppearancePage
import com.codedeck.plus.ui.screens.SessionsContent
import com.codedeck.plus.ui.screens.McpContent
import com.codedeck.plus.ui.screens.ConnectionPage
import com.codedeck.plus.ui.screens.LogsContent
import com.codedeck.plus.ui.screens.MachineSettingsContent
import com.codedeck.plus.ui.screens.MessagesPage
import com.codedeck.plus.ui.screens.NewSessionBody
import com.codedeck.plus.ui.screens.NotificationsPage
import com.codedeck.plus.ui.screens.PairingBody
import com.codedeck.plus.ui.screens.PluginsContent
import com.codedeck.plus.ui.screens.ProviderEditor
import com.codedeck.plus.ui.screens.ProvidersContent
import com.codedeck.plus.ui.screens.UploadsPage
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.screens.AccountPage
import com.codedeck.plus.ui.screens.BackupPage
import com.codedeck.plus.ui.screens.RestoreContent
import uniffi.client_ffi.UniffiUsageData
import uniffi.client_ffi.UniffiBackupStatus
import uniffi.client_ffi.UniffiBackupView
import com.codedeck.plus.ui.screens.SettingsHub
import com.codedeck.plus.ui.session.Composer
import com.codedeck.plus.ui.session.QuickPromptStrip
import com.codedeck.plus.ui.session.ContextDetails
import com.codedeck.plus.ui.session.ContextRing
import com.codedeck.plus.ui.session.OptionsPage
import com.codedeck.plus.ui.session.SessionOptionsChip
import com.codedeck.plus.ui.session.SessionOptionsList
import androidx.compose.foundation.layout.Box
import uniffi.client_ffi.UniffiUsageWindow
import com.codedeck.plus.ui.session.SessionTopBar
import com.codedeck.plus.ui.session.SlashCommandMenu
import com.codedeck.plus.ui.theme.CodeDeckTheme
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.TranscriptList
import kotlinx.coroutines.flow.MutableSharedFlow
import org.junit.Rule
import org.junit.Test
import uniffi.client_ffi.UniffiPairingView
import uniffi.client_ffi.UniffiPendingSession
import uniffi.client_runtime.CoreEvent

/** Every page as the user sees it, from fixed data (see [DesignFixtures]). */
private val pages: Map<String, @Composable () -> Unit> = linkedMapOf(
    "home" to {
        SessionsContent(
            machines = listOf(workstation, buildBox),
            pendingSessions = listOf(UniffiPendingSession("p1", buildBox.pubkeyHex, buildBox.name, "t", "pending", null, 1uL)),
            connectionStatus = "connected", needsPairingCheck = false, showCommitBadge = true,
            unreadSessions = setOf(sessionKeyOf(workstation.pubkeyHex, "s3")),
            selectedMachine = workstation.pubkeyHex, selectedSession = "s1", now = NOW, refreshing = false,
            onRefresh = {}, onSelectSession = { _, _ -> }, onNewSession = {}, onOpenMachine = {},
            onDeleteSession = { _, _, _ -> }, onDismissPending = {}, onOpenSettings = {}, onOpenPairing = {},
        )
    },
    "home_nothing_paired" to {
        SessionsContent(
            machines = emptyList(), pendingSessions = emptyList(), connectionStatus = "connecting", needsPairingCheck = false,
            showCommitBadge = true, unreadSessions = emptySet(), selectedMachine = null, selectedSession = null, now = NOW,
            refreshing = false, onRefresh = {}, onSelectSession = { _, _ -> }, onNewSession = {}, onOpenMachine = {},
            onDeleteSession = { _, _, _ -> }, onDismissPending = {}, onOpenSettings = {}, onOpenPairing = {},
        )
    },
    "session" to {
        Column(Modifier.background(Tokens.Bg)) {
            SessionTopBar(
                title = "Fix the flaky reconnect test", workspace = "/home/me/code/codedeck-plus", sessionState = "running", onBack = {},
                trailing = { ContextRing(42.0, alert = Tokens.Danger) {} },
            )
            TranscriptList(
                displayEntries = DesignFixtures.transcript(), outboxItems = emptyList(), machine = workstation.pubkeyHex, sessionId = "s1",
                syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(), running = true,
                activity = DesignFixtures.activity(), canStopTasks = true, dispatch = {}, modifier = Modifier.weight(1f),
            )
            QuickPromptStrip(quickPrompts) {}
            Composer(
                draft = "", onDraftChange = {}, placeholder = "Message…", canAttach = true, uploading = false,
                canSend = false, onStop = {}, onAttachPhoto = {}, onAttachFile = {}, onDictate = {}, onSend = {},
                options = { SessionOptionsChip(DesignFixtures.claudeOptions) {} },
            )
        }
    },
    "session_composer_opencode" to {
        Column(Modifier.background(Tokens.Bg)) {
            Composer(
                draft = "Run the migration again and tell me what changed in the schema", onDraftChange = {}, placeholder = "Message…",
                canAttach = false, uploading = false, canSend = true, onStop = null, onAttachPhoto = {}, onAttachFile = {}, onDictate = {}, onSend = {},
                options = { SessionOptionsChip(DesignFixtures.opencodeOptions) {} },
            )
        }
    },
    "session_options" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            SessionOptionsList(DesignFixtures.claudeOptions, OptionsPage.Main, {}, {}, {}, {}, { _, _ -> }, {})
        }
    },
    "session_options_more" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            SessionOptionsList(DesignFixtures.opencodeOptions, OptionsPage.Main, {}, {}, {}, {}, { _, _ -> }, {})
        }
    },
    "session_options_models" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            SessionOptionsList(DesignFixtures.opencodeOptions, OptionsPage.Models, {}, {}, {}, {}, { _, _ -> }, {})
        }
    },
    "session_options_mcp" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            SessionOptionsList(DesignFixtures.claudeOptions, OptionsPage.Mcp, {}, {}, {}, {}, { _, _ -> }, {})
        }
    },
    "session_options_effort" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            SessionOptionsList(DesignFixtures.claudeOptions, OptionsPage.Effort, {}, {}, {}, {}, { _, _ -> }, {})
        }
    },
    "session_context" to {
        Box(Modifier.background(Tokens.SurfaceRaised)) {
            ContextDetails(
                percentage = 42.0, window = 200_000,
                usage = UniffiUsageData(
                    available = true, plan = "max",
                    windows = listOf(
                        UniffiUsageWindow("5h", 61.0, java.time.Instant.ofEpochMilli(NOW + 134 * 60_000).toString()),
                        UniffiUsageWindow("7d", 92.0, java.time.Instant.ofEpochMilli(NOW + 2 * 86_400_000 + 5 * 3_600_000).toString()),
                    ),
                    sessionCostUsd = 0.0371, context = DesignFixtures.contextBreakdown, fetchedAt = "2026-10-08T10:00:00Z",
                ),
                nowMs = NOW,
                onClose = {},
            )
        }
    },
    "session_commands" to {
        Column(Modifier.background(Tokens.Bg)) {
            SessionTopBar(
                title = "Fix the flaky reconnect test", workspace = "/home/me/code/codedeck-plus", sessionState = "idle", onBack = {},
                trailing = { ContextRing(42.0) {} },
            )
            TranscriptList(
                displayEntries = DesignFixtures.transcript(), outboxItems = emptyList(), machine = workstation.pubkeyHex, sessionId = "s1",
                syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(), running = false,
                activity = null, canStopTasks = false, dispatch = {}, modifier = Modifier.weight(1f),
            )
            SlashCommandMenu(DesignFixtures.commands, "co") {}
            Composer(
                draft = "/co", onDraftChange = {}, placeholder = "Message…", canAttach = true, uploading = false,
                canSend = true, onStop = null, onAttachPhoto = {}, onAttachFile = {}, onDictate = {}, onSend = {},
                options = { SessionOptionsChip(DesignFixtures.claudeOptions) {} },
            )
        }
    },
    "transcript" to {
        // The first entries of the corpus, which the pinned-to-bottom session page scrolls past.
        TranscriptList(
            displayEntries = DesignFixtures.transcript().take(7), outboxItems = emptyList(), machine = workstation.pubkeyHex,
            sessionId = "s1", syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(),
            running = false, activity = null, canStopTasks = false, dispatch = {}, modifier = Modifier.background(Tokens.Bg),
        )
    },
    "transcript_plan" to {
        TranscriptList(
            displayEntries = DesignFixtures.waitingCards.take(2), outboxItems = emptyList(), machine = workstation.pubkeyHex,
            sessionId = "s1", syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(),
            running = false, activity = null, canStopTasks = false, dispatch = {}, modifier = Modifier.background(Tokens.Bg),
        )
    },
    "transcript_long" to {
        // Long enough to be cut into blocks: the plan's frame and the user's
        // bubble must still read as one each.
        val steps = (1..30).joinToString("\n\n") { i ->
            "### Step $i\n\nMove the reconnect logic behind the transport port, keep the backoff state in the core, " +
                "and cover the new path with a deterministic test that drives the clock by hand.\n\n" +
                "- Touches `crates/client-runtime/src/transport.rs`\n- Keeps the public surface unchanged"
        }
        val paste = (1..50).joinToString("\n\n") { "Log line $it: relay wss://relay.example.org dropped the socket after 75 s of silence." }
        TranscriptList(
            displayEntries = listOf(
                DisplayEntry.AgentMessage(1, "# Plan: a quieter reconnect\n\n$steps", isPlan = true),
                DisplayEntry.UserMessage(2, paste),
            ),
            outboxItems = emptyList(), machine = workstation.pubkeyHex,
            sessionId = "s1", syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(),
            running = false, activity = null, canStopTasks = false, dispatch = {}, modifier = Modifier.background(Tokens.Bg),
        )
    },
    "transcript_cards" to {
        TranscriptList(
            displayEntries = DesignFixtures.waitingCards.drop(2), outboxItems = emptyList(), machine = workstation.pubkeyHex,
            sessionId = "s1", syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(),
            running = false, activity = null, canStopTasks = false, dispatch = {}, modifier = Modifier.background(Tokens.Bg),
        )
    },
    "new_session" to {
        NewSessionBody(machine = workstation, events = MutableSharedFlow<CoreEvent>(), dispatch = {}, onClose = {}, onCreated = {})
    },
    "new_session_opencode" to {
        NewSessionBody(machine = workstation.copy(defaultAgent = "opencode"), events = MutableSharedFlow<CoreEvent>(), dispatch = {}, onClose = {}, onCreated = {})
    },
    "new_session_install" to {
        // The only agent failed to install: retrying comes before any option.
        val failed = DesignFixtures.deepseek.copy(installState = "failed", installError = "the download did not match the pinned checksum")
        NewSessionBody(machine = workstation.copy(agents = listOf(failed), defaultAgent = null), events = MutableSharedFlow<CoreEvent>(), dispatch = {}, onClose = {}, onCreated = {})
    },
    "pairing" to {
        CompositionLocalProvider(LocalActivityResultRegistryOwner provides DesignFixtures.noResults) {
            PairingBody(
                view = UniffiPairingView(phase = "idle", error = null, timedOut = false, staged = null, candidate = null),
                selfNpub = "npub1phonephonephonephonephonephonephonephonephonephonephon",
                dispatch = {},
                onClose = {},
            )
        }
    },
    "settings" to {
        SettingsHub(
            machines = listOf(buildBox, workstation), view = settings, npub = workstation.npub, signerLabel = "Amber", now = NOW,
            onOpen = {}, onPairMachine = {}, onOpenLogs = {}, onClose = {},
            // Fixed: the real one comes from the build and differs per machine.
            version = "1.0.0",
        )
    },
    "settings_machine" to {
        MachineSettingsContent(
            machine = workstation, connectedRelays = setOf("wss://relay.example.org"), credentialsStatus = null,
            providerProfileStatus = null, now = NOW, dispatch = {}, onBack = {}, onOpenProviders = {}, onOpenPlugins = {}, onOpenMcp = {},
        )
    },
    "settings_machine_update_needed" to {
        MachineSettingsContent(
            machine = workstation.copy(updateNeeded = "bridge"), connectedRelays = setOf("wss://relay.example.org"),
            credentialsStatus = null, providerProfileStatus = null, now = NOW, dispatch = {}, onBack = {},
            onOpenProviders = {}, onOpenPlugins = {}, onOpenMcp = {},
        )
    },
    "plugins" to { PluginsContent(workstation, "claude-code", dispatch = {}, onBack = {}) },
    "plugins_browse" to { PluginsContent(workstation, "claude-code", dispatch = {}, onBack = {}, startOnBrowse = true) },
    "mcp" to { McpContent(workstation, "claude-code", dispatch = {}, onBack = {}) },
    "mcp_add" to { McpContent(workstation, "claude-code", dispatch = {}, onBack = {}, startAdding = AddView.Form) },
    "mcp_import" to {
        McpContent(
            workstation, "claude-code", dispatch = {}, onBack = {}, startAdding = AddView.Json,
            pasted = """{"mcpServers": {
  "sentry": {"type": "http", "url": "https://mcp.sentry.dev/mcp", "headers": {"Authorization": "Bearer sntrys_x"}},
  "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"]},
  "old-ws": {"type": "websocket", "url": "wss://x.example"}
}}""",
            parse = { DesignFixtures.mcpImport },
        )
    },
    "plugins_opencode" to { PluginsContent(workstation, "opencode", dispatch = {}, onBack = {}) },
    "providers_opencode" to { ProvidersContent(workstation, "opencode", status = null, dispatch = {}, onBack = {}) },
    "providers_opencode_open" to { ProvidersContent(workstation, "opencode", status = null, dispatch = {}, onBack = {}, openProfile = "home-gateway") },
    "providers_claude_empty" to { ProvidersContent(workstation, "claude-code", status = null, dispatch = {}, onBack = {}) },
    "providers_edit" to {
        ProvidersContent(workstation, "opencode", status = null, dispatch = {}, onBack = {}, startEditing = ProviderEditor.Existing("home-gateway"), validBaseUrl = { true })
    },
    "providers_add" to { ProvidersContent(workstation, "claude-code", status = null, dispatch = {}, onBack = {}, startEditing = ProviderEditor.New, validBaseUrl = { true }) },
    "settings_appearance" to { AppearancePage(settings, {}, {}) },
    "settings_notifications" to { NotificationsPage(settings, {}, {}) },
    "settings_connection" to { ConnectionPage(settings, serviceForeground = true, dispatch = {}, onBack = {}) },
    "settings_messages" to { MessagesPage(settings, quickPrompts, {}, {}) },
    "settings_uploads" to { UploadsPage(settings, {}, {}) },
    "settings_uploads_blossom" to {
        UploadsPage(settings.copy(blossomServer = "https://blossom.example.com", maxUploadBytes = 26_214_400uL), {}, {})
    },
    "settings_backup_off" to { BackupPage(settings.backup, torOn = true, now = NOW, dispatch = {}, onBack = {}) },
    "settings_backup_on" to {
        BackupPage(
            UniffiBackupView(relay = "wss://relay.example.org", savedAt = (NOW - 3 * 60_000).toULong(), status = UniffiBackupStatus.Idle),
            torOn = false, now = NOW, dispatch = {}, onBack = {},
        )
    },
    "settings_backup_found" to {
        BackupPage(
            UniffiBackupView(relay = "wss://relay.example.org", savedAt = null, status = FOUND),
            torOn = false, now = NOW, dispatch = {}, onBack = {},
        )
    },
    "settings_backup_failed" to {
        BackupPage(
            UniffiBackupView(
                relay = "wss://relay.example.org",
                savedAt = (NOW - 26 * 3_600_000).toULong(),
                status = UniffiBackupStatus.Failed("The relay did not take the backup: blocked: auth required"),
            ),
            torOn = false, now = NOW, dispatch = {}, onBack = {},
        )
    },
    "settings_account_key" to { AccountPage(workstation.npub, signerLabel = null, onLogOut = {}, onBack = {}, revealKey = { null }) },
    "restore" to { RestoreContent(settings.backup, torOn = false, dispatch = {}, onDone = {}, now = NOW) },
    "restore_found" to {
        RestoreContent(UniffiBackupView(relay = "wss://relay.example.org", savedAt = null, status = FOUND), torOn = false, dispatch = {}, onDone = {}, now = NOW)
    },
    "logs" to {
        LogsContent(
            lines = listOf(
                "09-27 18:02:11.201 I/codedeck(4312): Core::new: tor=false proxy=Some(\"127.0.0.1:9050\")",
                "09-27 18:02:11.480 I/codedeck(4312): relays: [\"wss://relay.example.org\"]",
                "09-27 18:02:12.004 D/codedeck(4312): connection_changed: status=Connected",
                "09-27 18:02:40.771 W/codedeck(4312): relay wss://nostr.home.lan:4869 silent for 75 s, dropping it",
                "09-27 18:03:02.118 E/codedeck(4312): publish rejected: blocked: not allowed",
            ),
            onRefresh = {},
            onCopy = {},
            onBack = {},
        )
    },
)

/** A backup another phone saved two hours before the fixtures' clock. */
private val FOUND = UniffiBackupStatus.Found(savedAt = (NOW - 2 * 3_600_000).toULong(), machines = 2u)

private fun Paparazzi.page(name: String) = snapshot { CodeDeckTheme { pages.getValue(name)() } }

/** The pages on a phone: what fits on one screen. */
class DesignSnapshotTest {
    @get:Rule
    val paparazzi = Paparazzi(
        // What a 360x740 dp phone leaves between its status and navigation
        // bars (the app pads for both): 360x680 dp.
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false, screenWidth = 1080, screenHeight = 2040, density = Density.XXHIGH),
        showSystemUi = false,
    )

    @Test fun home() = paparazzi.page("home")
    @Test fun home_nothing_paired() = paparazzi.page("home_nothing_paired")
    @Test fun session() = paparazzi.page("session")
    @Test fun session_composer_opencode() = paparazzi.page("session_composer_opencode")
    @Test fun session_options() = paparazzi.page("session_options")
    @Test fun session_options_more() = paparazzi.page("session_options_more")
    @Test fun session_options_effort() = paparazzi.page("session_options_effort")
    @Test fun session_context() = paparazzi.page("session_context")
    @Test fun session_commands() = paparazzi.page("session_commands")
    @Test fun transcript() = paparazzi.page("transcript")
    @Test fun transcript_plan() = paparazzi.page("transcript_plan")
    @Test fun transcript_cards() = paparazzi.page("transcript_cards")
    @Test fun transcript_long() = paparazzi.page("transcript_long")
    @Test fun new_session() = paparazzi.page("new_session")
    @Test fun new_session_opencode() = paparazzi.page("new_session_opencode")
    @Test fun new_session_install() = paparazzi.page("new_session_install")
    @Test fun pairing() = paparazzi.page("pairing")
    @Test fun settings() = paparazzi.page("settings")
    @Test fun settings_machine_update_needed() = paparazzi.page("settings_machine_update_needed")
    @Test fun plugins() = paparazzi.page("plugins")
    @Test fun plugins_browse() = paparazzi.page("plugins_browse")
    @Test fun plugins_opencode() = paparazzi.page("plugins_opencode")
    @Test fun mcp() = paparazzi.page("mcp")
    @Test fun mcp_add() = paparazzi.page("mcp_add")
    @Test fun mcp_import() = paparazzi.page("mcp_import")
    @Test fun providers_opencode() = paparazzi.page("providers_opencode")
    @Test fun providers_opencode_open() = paparazzi.page("providers_opencode_open")
    @Test fun providers_claude_empty() = paparazzi.page("providers_claude_empty")
    @Test fun providers_edit() = paparazzi.page("providers_edit")
    @Test fun providers_add() = paparazzi.page("providers_add")
    @Test fun session_options_models() = paparazzi.page("session_options_models")
    @Test fun session_options_mcp() = paparazzi.page("session_options_mcp")
    @Test fun settings_appearance() = paparazzi.page("settings_appearance")
    @Test fun settings_notifications() = paparazzi.page("settings_notifications")
    @Test fun settings_connection() = paparazzi.page("settings_connection")
    @Test fun settings_uploads() = paparazzi.page("settings_uploads")
    @Test fun settings_uploads_blossom() = paparazzi.page("settings_uploads_blossom")
    @Test fun settings_backup_off() = paparazzi.page("settings_backup_off")
    @Test fun settings_backup_on() = paparazzi.page("settings_backup_on")
    @Test fun settings_backup_found() = paparazzi.page("settings_backup_found")
    @Test fun settings_backup_failed() = paparazzi.page("settings_backup_failed")
    @Test fun settings_account_key() = paparazzi.page("settings_account_key")
    @Test fun restore() = paparazzi.page("restore")
    @Test fun restore_found() = paparazzi.page("restore_found")
    @Test fun logs() = paparazzi.page("logs")
}

/** The long pages whole, on a very tall screen, to see everything below the fold. */
class DesignFullPageSnapshotTest {
    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false, screenWidth = 1080, screenHeight = 4200, density = Density.XXHIGH),
        showSystemUi = false,
    )

    @Test fun new_session() = paparazzi.page("new_session")
    @Test fun pairing() = paparazzi.page("pairing")
    @Test fun settings() = paparazzi.page("settings")
    @Test fun settings_machine() = paparazzi.page("settings_machine")
    @Test fun plugins() = paparazzi.page("plugins")
    @Test fun settings_messages() = paparazzi.page("settings_messages")
}
