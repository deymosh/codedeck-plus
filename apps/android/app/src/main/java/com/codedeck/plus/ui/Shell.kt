package com.codedeck.plus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.screens.NewSessionScreen
import com.codedeck.plus.ui.screens.PairingScreen
import com.codedeck.plus.ui.screens.SettingsScreen
import com.codedeck.plus.ui.session.SessionScreen
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent

/** Narrow ↔ wide breakpoint, matching `apps/mobile`'s `(min-width: 700px)`
 *  media query (`App.tsx`'s `isWide`) — same threshold, same meaning: wide
 *  shows the sessions list beside the session, narrow shows one at a time. */
private val WIDE_BREAKPOINT = 700.dp

/**
 * App shell (F3.3.3) — port of `apps/mobile/src/ui/App.tsx`'s core
 * composition: a machine-grouped sessions list (`Sidebar`) beside the
 * session (`MainPanel`) on wide screens; on phones the list is the home
 * screen and a session opens over it. Settings, Pairing, and
 * New Session are all full-screen replacements of this whole shell while
 * open (F4.1.5, F4.4), not overlays. The undo toast (`UndoToast.kt`) is
 * mounted here at the root so the post-delete undo window is reachable from
 * any screen; the keyboard-inset controller is still later work.
 */
@Composable
fun Shell(core: CoreHost) {
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
    // Values the sidebar needs from the ui/settings/pending-sessions slices
    // (unread dot, committed badge, pairing banner, placeholder cards).
    val unreadSessions = ui?.unreadSessions.orEmpty().toSet()
    val showCommitBadge = settings?.showCommitBadge ?: false
    val needsPairingCheck = connection?.needsPairingCheck ?: false
    val pending = pendingSessions?.pending.orEmpty()

    var newSessionFor by remember { mutableStateOf<String?>(null) }
    var settingsOpen by remember { mutableStateOf(false) }
    var pairingOpen by remember { mutableStateOf(false) }
    // First run (no machines paired) starts on pairing — same as
    // `apps/mobile`'s `App.tsx`. Waits for the first real `MachinesView`
    // fetch (`machinesView != null`) rather than deciding off the empty
    // pre-hydration list, so a phone that DOES have paired machines never
    // flashes the pairing screen while `CoreHost.start()`'s initial fetch
    // is still in flight.
    var pairingAutoOpenDecided by remember { mutableStateOf(false) }
    LaunchedEffect(machinesView) {
        if (!pairingAutoOpenDecided && machinesView != null) {
            pairingAutoOpenDecided = true
            if (machines.isEmpty()) pairingOpen = true
        }
    }
    // A deep link (`codedeck://pair…`, F4.2.3) can stage or begin a pair
    // from anywhere in the app — surface it the same way `App.tsx`'s own
    // effect does, regardless of what's currently open.
    LaunchedEffect(pairing?.phase, pairing?.staged) {
        val p = pairing
        if (p != null && (p.phase != "idle" || p.staged != null)) pairingOpen = true
    }

    fun selectSession(machine: String, sessionId: String) {
        scope.launch { core.dispatch(UniffiIntent.SelectSession(machine, sessionId)) }
    }

    // The failure banner floats over the top of the content, so its arrival
    // never shifts the screen under the user's finger; a tap dismisses it
    // early to uncover the header controls it sits on. The undo toast is
    // stacked below the content instead — overlaid, it covered the
    // composer's Send — and takes space only while it is showing.
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // System Back returns from a full-screen replacement to the shell,
            // like its own close button — without these it finished the activity.
            if (settingsOpen) {
                // Full-screen replacement, not an overlay: while Settings is open it
                // owns the window — the wide/narrow split simply isn't composed
                // underneath it, so returning shows the shell exactly as it was.
                BackHandler { settingsOpen = false }
                SettingsScreen(core, onClose = { settingsOpen = false })
            } else if (pairingOpen) {
                BackHandler { pairingOpen = false }
                PairingScreen(core, onClose = { pairingOpen = false })
            } else if (newSessionFor != null) {
                BackHandler { newSessionFor = null }
                NewSessionScreen(core, machinePubkey = newSessionFor!!, onClose = { newSessionFor = null })
            } else {
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val isWide = maxWidth >= WIDE_BREAKPOINT
    
                    val sessionContent: @Composable (String, String, (() -> Unit)?) -> Unit = { machine, sessionId, onBack ->
                        SessionScreen(core, machine, sessionId, onBack = onBack, modifier = Modifier.fillMaxSize())
                    }
    
                    if (isWide) {
                        Row(Modifier.fillMaxSize()) {
                            Sidebar(
                                core = core,
                                machines = machines,
                                pendingSessions = pending,
                                connectionStatus = connection?.status,
                                needsPairingCheck = needsPairingCheck,
                                showCommitBadge = showCommitBadge,
                                unreadSessions = unreadSessions,
                                selectedMachine = selectedMachine,
                                selectedSession = selectedSession,
                                onSelectSession = ::selectSession,
                                onNewSession = { newSessionFor = it },
                                onOpenSettings = { settingsOpen = true },
                                onOpenPairing = { pairingOpen = true },
                                modifier = Modifier.width(Tokens.SidebarWidth),
                            )
                            MainPanel(
                                selectedMachine = selectedMachine,
                                selectedSession = selectedSession,
                                isWide = true,
                                onOpenSidebar = {},
                                modifier = Modifier.weight(1f),
                                sessionContent = sessionContent,
                            )
                        }
                    } else {
                        // Phone: the Sessions list IS the home screen, full
                        // width, and a session opens over it; Back (or the
                        // session's back arrow) returns to the list, and Back on
                        // the list leaves the app. `showingSession` is separate
                        // from the core's selection so going back to the list
                        // keeps the selection intact. The app starts on the list.
                        var showingSession by rememberSaveable { mutableStateOf(false) }
                        // A selection that changes after this point (a tap in the
                        // list, a notification tap, a deep link) opens it.
                        var seenSelection by remember { mutableStateOf(selectedMachine to selectedSession) }
                        LaunchedEffect(selectedMachine, selectedSession) {
                            val current = selectedMachine to selectedSession
                            if (current != seenSelection) {
                                seenSelection = current
                                if (selectedSession != null) showingSession = true
                            }
                        }
                        if (showingSession && selectedSession != null) {
                            BackHandler { showingSession = false }
                            MainPanel(
                                selectedMachine = selectedMachine,
                                selectedSession = selectedSession,
                                isWide = false,
                                onOpenSidebar = { showingSession = false },
                                modifier = Modifier.fillMaxSize(),
                                sessionContent = sessionContent,
                            )
                        } else {
                            Sidebar(
                                core = core,
                                machines = machines,
                                pendingSessions = pending,
                                connectionStatus = connection?.status,
                                needsPairingCheck = needsPairingCheck,
                                showCommitBadge = showCommitBadge,
                                unreadSessions = unreadSessions,
                                selectedMachine = selectedMachine,
                                selectedSession = selectedSession,
                                onSelectSession = { machine, sessionId ->
                                    selectSession(machine, sessionId)
                                    // Re-opening the already-selected session
                                    // changes no selection, so open it here too.
                                    showingSession = true
                                },
                                onNewSession = { newSessionFor = it },
                                onOpenSettings = { settingsOpen = true },
                                onOpenPairing = { pairingOpen = true },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
            }
            ActionFailedBanner(core, Modifier.align(Alignment.TopCenter))
        }
        // Undo toast for an optimistic session delete — at the shell's root so it
        // is visible on whichever screen is showing. Emits nothing while no undo
        // window is open.
        UndoToast(core, Modifier.align(Alignment.CenterHorizontally))
    }
}
