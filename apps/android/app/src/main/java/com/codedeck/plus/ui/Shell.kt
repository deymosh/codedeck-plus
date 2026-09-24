package com.codedeck.plus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.screens.NewSessionScreen
import com.codedeck.plus.ui.screens.PairingScreen
import com.codedeck.plus.ui.screens.SettingsScreen
import com.codedeck.plus.ui.session.SessionScreen
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent

/** Which full-screen page the shell shows. Exactly one at a time, whatever
 *  the orientation or window width: the sessions list is the home page and
 *  every other page replaces it until Back returns there. */
private sealed interface Screen {
    data object Sessions : Screen
    data class Session(val machine: String, val sessionId: String) : Screen
    data class NewSession(val machine: String) : Screen
    data object Settings : Screen
    data object Pairing : Screen
}

/** Saves [Screen] as a flat string list, so the open page survives rotation
 *  and process recreation. */
private val ScreenSaver = listSaver<Screen, String>(
    save = { screen ->
        when (screen) {
            Screen.Sessions -> listOf("sessions")
            is Screen.Session -> listOf("session", screen.machine, screen.sessionId)
            is Screen.NewSession -> listOf("new-session", screen.machine)
            Screen.Settings -> listOf("settings")
            Screen.Pairing -> listOf("pairing")
        }
    },
    restore = { saved ->
        when (saved.firstOrNull()) {
            "session" -> Screen.Session(saved[1], saved[2])
            "new-session" -> Screen.NewSession(saved[1])
            "settings" -> Screen.Settings
            "pairing" -> Screen.Pairing
            else -> Screen.Sessions
        }
    },
)

/** A session the shell should open, from outside the composition (a
 *  notification tap or a `codedeck://session/…` link). */
data class OpenSessionRequest(val machine: String, val sessionId: String)

/**
 * App shell — one full-screen page at a time, driven by a single saved
 * [Screen]. The sessions list (`SessionsScreen`) is home; a session,
 * New Session, Settings and Pairing each replace it, and Back returns to it.
 *
 * Which session is open is this navigation state, not the core's selection:
 * opening a session also dispatches `SelectSession` (the core's unread and
 * notification bookkeeping follow it), but re-selecting the already-selected
 * session changes nothing in the core, so navigation cannot be derived from
 * selection changes. [openRequest] is the explicit channel for opens that
 * start outside the composition; the shell consumes it through
 * [onOpenRequestHandled].
 *
 * The undo toast (`UndoToast.kt`) and the action-failed banner are mounted
 * here at the root so they are reachable from any page.
 */
@Composable
fun Shell(
    core: CoreHost,
    openRequest: OpenSessionRequest? = null,
    onOpenRequestHandled: () -> Unit = {},
) {
    val machinesView by core.machines.collectAsState()
    val connection by core.connection.collectAsState()
    val ui by core.ui.collectAsState()
    val pairing by core.pairing.collectAsState()
    val settings by core.settings.collectAsState()
    val pendingSessions by core.pendingSessions.collectAsState()
    val scope = rememberCoroutineScope()

    val machines = machinesView?.machines ?: emptyList()
    val selectedMachine = ui?.selectedMachine
    val selectedSession = ui?.selectedSession

    var screen by rememberSaveable(stateSaver = ScreenSaver) { mutableStateOf<Screen>(Screen.Sessions) }

    fun openSession(machine: String, sessionId: String) {
        screen = Screen.Session(machine, sessionId)
        scope.launch { core.dispatch(UniffiIntent.SelectSession(machine, sessionId)) }
    }

    // First run (no machines paired) starts on pairing. Waits for the first
    // real `MachinesView` fetch (`machinesView != null`) rather than deciding
    // off the empty pre-hydration list, so a phone that DOES have paired
    // machines never flashes the pairing screen while `CoreHost.start()`'s
    // initial fetch is still in flight.
    var pairingAutoOpenDecided by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(machinesView) {
        if (!pairingAutoOpenDecided && machinesView != null) {
            pairingAutoOpenDecided = true
            if (machines.isEmpty()) screen = Screen.Pairing
        }
    }
    // A deep link (`codedeck://pair…`) can stage or begin a pair from
    // anywhere in the app — surface it regardless of what's currently open.
    LaunchedEffect(pairing?.phase, pairing?.staged) {
        val p = pairing
        if (p != null && (p.phase != "idle" || p.staged != null)) screen = Screen.Pairing
    }

    LaunchedEffect(openRequest) {
        val request = openRequest ?: return@LaunchedEffect
        openSession(request.machine, request.sessionId)
        onOpenRequestHandled()
    }

    // A session deleted while open (another device, the bridge) clears the
    // core's selection; fall back to the list instead of an empty page. Only
    // a non-null → null change counts: a freshly opened session may not be
    // selected in the core yet.
    var previousSelection by remember { mutableStateOf(selectedSession) }
    LaunchedEffect(selectedSession) {
        if (previousSelection != null && selectedSession == null && screen is Screen.Session) {
            screen = Screen.Sessions
        }
        previousSelection = selectedSession
    }

    // The failure banner floats over the top of the content, so its arrival
    // never shifts the screen under the user's finger; a tap dismisses it
    // early to uncover the header controls it sits on. The undo toast is
    // stacked below the content instead — overlaid, it covered the
    // composer's Send — and takes space only while it is showing.
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // System Back on any page returns to the sessions list, like each
            // page's own close/back control; Back on the list leaves the app.
            if (screen != Screen.Sessions) BackHandler { screen = Screen.Sessions }
            when (val current = screen) {
                Screen.Settings -> SettingsScreen(core, onClose = { screen = Screen.Sessions })
                Screen.Pairing -> PairingScreen(core, onClose = { screen = Screen.Sessions })
                is Screen.NewSession -> NewSessionScreen(
                    core,
                    machinePubkey = current.machine,
                    onClose = { screen = Screen.Sessions },
                )
                is Screen.Session -> SessionScreen(
                    core,
                    current.machine,
                    current.sessionId,
                    onBack = { screen = Screen.Sessions },
                    modifier = Modifier.fillMaxSize().background(Tokens.Bg),
                )
                Screen.Sessions -> SessionsScreen(
                    core = core,
                    machines = machines,
                    pendingSessions = pendingSessions?.pending.orEmpty(),
                    connectionStatus = connection?.status,
                    needsPairingCheck = connection?.needsPairingCheck ?: false,
                    showCommitBadge = settings?.showCommitBadge ?: false,
                    unreadSessions = ui?.unreadSessions.orEmpty().toSet(),
                    selectedMachine = selectedMachine,
                    selectedSession = selectedSession,
                    onSelectSession = ::openSession,
                    onNewSession = { screen = Screen.NewSession(it) },
                    onOpenSettings = { screen = Screen.Settings },
                    onOpenPairing = { screen = Screen.Pairing },
                    modifier = Modifier.fillMaxSize(),
                )
            }
            ActionFailedBanner(core, Modifier.align(Alignment.TopCenter))
        }
        // Undo toast for an optimistic session delete — at the shell's root so it
        // is visible on whichever screen is showing. Emits nothing while no undo
        // window is open.
        UndoToast(core, Modifier.align(Alignment.CenterHorizontally))
    }
}
