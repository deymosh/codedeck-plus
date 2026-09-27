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
import com.codedeck.plus.platform.Login
import com.codedeck.plus.ui.screens.LogsScreen
import com.codedeck.plus.ui.screens.PairingScreen
import com.codedeck.plus.ui.screens.SettingsScreen
import com.codedeck.plus.ui.session.SessionScreen
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.delay
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
    data object Logs : Screen
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
            Screen.Logs -> listOf("logs")
            Screen.Pairing -> listOf("pairing")
        }
    },
    restore = { saved ->
        when (saved.firstOrNull()) {
            "session" -> Screen.Session(saved[1], saved[2])
            "new-session" -> Screen.NewSession(saved[1])
            "settings" -> Screen.Settings
            "logs" -> Screen.Logs
            "pairing" -> Screen.Pairing
            else -> Screen.Sessions
        }
    },
)

/** A session the shell should open, from outside the composition (a
 *  notification tap or a `codedeck://session/…` link). */
data class OpenSessionRequest(val machine: String, val sessionId: String)

/** A just-created session to open once the bridge reports it: its id is not
 *  known when the create is sent, so the first session on [machine] that is
 *  not in [knownIds] is the new one. */
private data class AwaitedSession(val machine: String, val knownIds: Set<String>)

/** How long the shell keeps waiting for a created session to appear before
 *  it stops trying to open it; the list's pending card still tracks it. */
private const val AWAIT_CREATED_SESSION_MS = 120_000L

/**
 * App shell — one full-screen page at a time, driven by a single saved
 * [Screen]. The sessions list (`SessionsScreen`) is home; a session,
 * New Session, Settings and Pairing each replace it, and Back returns to it.
 *
 * Which session is open is this navigation state, not the core's selection:
 * opening a session also dispatches `SelectSession`, and leaving it clears
 * the selection (the core's unread and notification bookkeeping follow
 * both), but re-selecting the already-selected
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
    login: Login? = null,
    onLogOut: () -> Unit = {},
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
    var awaited by remember { mutableStateOf<AwaitedSession?>(null) }

    fun openSession(machine: String, sessionId: String) {
        awaited = null
        screen = Screen.Session(machine, sessionId)
        scope.launch { core.dispatch(UniffiIntent.SelectSession(machine, sessionId)) }
    }

    // The app always starts on the sessions list, paired or not: pairing
    // opens only when the user asks for it (the list's pair button, its empty
    // state) or a pairing link is in progress. Guessing "first run" from an
    // empty machine list misfired whenever the list read empty for a moment
    // at startup, dropping a paired phone onto the pairing screen.
    //
    // A deep link (`codedeck://pair…`) can stage or begin a pair from
    // anywhere in the app — surface it regardless of what's currently open.
    // Only a pair in progress counts: the core outlives this activity, so a
    // finished pair (`paired`, `failed`) is still its state when the app is
    // reopened, and must not pull the user back to pairing.
    LaunchedEffect(pairing?.phase, pairing?.staged) {
        val p = pairing
        if (p != null && (p.phase == "awaiting-ack" || p.staged != null)) screen = Screen.Pairing
    }

    LaunchedEffect(openRequest) {
        val request = openRequest ?: return@LaunchedEffect
        openSession(request.machine, request.sessionId)
        onOpenRequestHandled()
    }

    // Open a just-created session as soon as it shows up — unless the user
    // has already moved on from the list in the meantime.
    LaunchedEffect(awaited, machines) {
        val wait = awaited ?: return@LaunchedEffect
        val machine = machines.find { it.pubkeyHex == wait.machine } ?: return@LaunchedEffect
        val created = machine.sessions.firstOrNull { it.id !in wait.knownIds } ?: return@LaunchedEffect
        if (screen == Screen.Sessions) openSession(wait.machine, created.id) else awaited = null
    }
    LaunchedEffect(awaited) {
        if (awaited == null) return@LaunchedEffect
        delay(AWAIT_CREATED_SESSION_MS)
        awaited = null
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

    // The core's selection is what it treats as "the session on screen": that
    // session gets no notification and no unread dot. So leaving a session
    // page (Back to the list, Settings, …) deselects it, or the session just
    // left would keep going silent. Keyed on the selection too, so a select
    // that lands after the user already left is undone as well.
    LaunchedEffect(screen, selectedSession) {
        val machine = selectedMachine
        if (screen !is Screen.Session && selectedSession != null && machine != null) {
            core.dispatch(UniffiIntent.SelectSession(machine, null))
        }
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
            // The log is opened from Settings, so Back returns there.
            if (screen != Screen.Sessions) {
                BackHandler { screen = if (screen == Screen.Logs) Screen.Settings else Screen.Sessions }
            }
            when (val current = screen) {
                Screen.Settings -> SettingsScreen(
                    core,
                    login = login,
                    onLogOut = onLogOut,
                    onOpenLogs = { screen = Screen.Logs },
                    onClose = { screen = Screen.Sessions },
                )
                Screen.Logs -> LogsScreen(onBack = { screen = Screen.Settings })
                Screen.Pairing -> PairingScreen(core, onClose = { screen = Screen.Sessions })
                is Screen.NewSession -> NewSessionScreen(
                    core,
                    machinePubkey = current.machine,
                    onClose = { screen = Screen.Sessions },
                    onCreated = { knownIds ->
                        awaited = AwaitedSession(current.machine, knownIds)
                        screen = Screen.Sessions
                    },
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
