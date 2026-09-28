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
import com.codedeck.plus.ui.screens.AppearancePage
import com.codedeck.plus.ui.screens.SessionsContent
import com.codedeck.plus.ui.screens.ConnectionPage
import com.codedeck.plus.ui.screens.LogsContent
import com.codedeck.plus.ui.screens.MachineSettingsContent
import com.codedeck.plus.ui.screens.MessagesPage
import com.codedeck.plus.ui.screens.NewSessionBody
import com.codedeck.plus.ui.screens.NotificationsPage
import com.codedeck.plus.ui.screens.PairingBody
import com.codedeck.plus.ui.screens.PluginsContent
import com.codedeck.plus.ui.screens.UploadsPage
import com.codedeck.plus.ui.screens.SettingsHub
import com.codedeck.plus.ui.session.Composer
import com.codedeck.plus.ui.session.QuickPromptStrip
import com.codedeck.plus.ui.session.SessionControlsBar
import com.codedeck.plus.ui.session.SessionTopBar
import com.codedeck.plus.ui.session.SlashCommandMenu
import com.codedeck.plus.ui.session.ThinkingIndicator
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
            SessionTopBar(title = "Fix the flaky reconnect test", workspace = "/home/me/code/codedeck-plus", sessionState = "running", onBack = {})
            TranscriptList(
                displayEntries = DesignFixtures.transcript(), outboxItems = emptyList(), machine = workstation.pubkeyHex, sessionId = "s1",
                syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(), dispatch = {},
                modifier = Modifier.weight(1f),
            )
            ThinkingIndicator(onStop = {})
            QuickPromptStrip(quickPrompts) {}
            SessionControlsBar(
                effort = "high", efforts = claude.efforts, modeLabel = "Accept edits", modePending = false, model = "claude-opus-5-5",
                contextPercentage = 42.0, contextWindow = 200_000, onEffortSelect = {}, onModeTap = {}, showUsageBadge = true, usage = null,
            )
            Composer(
                draft = "", onDraftChange = {}, placeholder = "Message…", canAttach = true, uploading = false,
                canSend = false, onAttachPhoto = {}, onAttachFile = {}, onDictate = {}, onSend = {}, onSlash = {},
            )
        }
    },
    "session_commands" to {
        Column(Modifier.background(Tokens.Bg)) {
            SessionTopBar(title = "Fix the flaky reconnect test", workspace = "/home/me/code/codedeck-plus", sessionState = "idle", onBack = {})
            TranscriptList(
                displayEntries = DesignFixtures.transcript(), outboxItems = emptyList(), machine = workstation.pubkeyHex, sessionId = "s1",
                syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(), dispatch = {},
                modifier = Modifier.weight(1f),
            )
            SlashCommandMenu(DesignFixtures.commands, "co") {}
            SessionControlsBar(
                effort = "high", efforts = claude.efforts, modeLabel = "Accept edits", modePending = false, model = "claude-opus-5-5",
                contextPercentage = 42.0, contextWindow = 200_000, onEffortSelect = {}, onModeTap = {}, showUsageBadge = true, usage = null,
            )
            Composer(
                draft = "/co", onDraftChange = {}, placeholder = "Message the session…", canAttach = true, uploading = false,
                canSend = true, onAttachPhoto = {}, onAttachFile = {}, onDictate = {}, onSend = {}, onSlash = {},
            )
        }
    },
    "transcript" to {
        // The first entries of the corpus, which the pinned-to-bottom session page scrolls past.
        TranscriptList(
            displayEntries = DesignFixtures.transcript().take(7), outboxItems = emptyList(), machine = workstation.pubkeyHex,
            sessionId = "s1", syncState = "idle", contiguous = true, respondedCards = emptySet(), planApprovalChoices = emptyMap(),
            dispatch = {}, modifier = Modifier.background(Tokens.Bg),
        )
    },
    "new_session" to {
        NewSessionBody(machine = workstation, events = MutableSharedFlow<CoreEvent>(), dispatch = {}, onClose = {}, onCreated = {})
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
            providerProfileStatus = null, now = NOW, dispatch = {}, onBack = {}, onOpenPlugins = {},
        )
    },
    "plugins" to { PluginsContent(workstation, "claude-code", dispatch = {}, onBack = {}) },
    "plugins_browse" to { PluginsContent(workstation, "claude-code", dispatch = {}, onBack = {}, startOnBrowse = true) },
    "plugins_opencode" to { PluginsContent(workstation, "opencode", dispatch = {}, onBack = {}) },
    "settings_appearance" to { AppearancePage(settings, {}, {}) },
    "settings_notifications" to { NotificationsPage(settings, {}, {}) },
    "settings_connection" to { ConnectionPage(settings, serviceForeground = true, dispatch = {}, onBack = {}) },
    "settings_messages" to { MessagesPage(settings, quickPrompts, {}, {}) },
    "settings_uploads" to { UploadsPage(settings, {}, {}) },
    "settings_uploads_blossom" to {
        UploadsPage(settings.copy(blossomServer = "https://blossom.example.com", maxUploadBytes = 26_214_400uL), {}, {})
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
    @Test fun session_commands() = paparazzi.page("session_commands")
    @Test fun transcript() = paparazzi.page("transcript")
    @Test fun new_session() = paparazzi.page("new_session")
    @Test fun pairing() = paparazzi.page("pairing")
    @Test fun settings() = paparazzi.page("settings")
    @Test fun plugins() = paparazzi.page("plugins")
    @Test fun plugins_browse() = paparazzi.page("plugins_browse")
    @Test fun plugins_opencode() = paparazzi.page("plugins_opencode")
    @Test fun settings_appearance() = paparazzi.page("settings_appearance")
    @Test fun settings_notifications() = paparazzi.page("settings_notifications")
    @Test fun settings_connection() = paparazzi.page("settings_connection")
    @Test fun settings_uploads() = paparazzi.page("settings_uploads")
    @Test fun settings_uploads_blossom() = paparazzi.page("settings_uploads_blossom")
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
