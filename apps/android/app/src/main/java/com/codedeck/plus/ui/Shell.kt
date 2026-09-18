package com.codedeck.plus.ui

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.screens.NewSessionScreen
import com.codedeck.plus.ui.screens.PairingScreen
import com.codedeck.plus.ui.screens.SettingsScreen
import com.codedeck.plus.ui.session.SessionScreen
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiIntent

/** Narrow ↔ wide breakpoint, matching `apps/mobile`'s `(min-width: 700px)`
 *  media query (`App.tsx`'s `isWide`) — same threshold, same meaning: wide
 *  shows the sidebar beside the panel, narrow puts it in a drawer. */
private val WIDE_BREAKPOINT = 700.dp

/**
 * App shell (F3.3.3) — port of `apps/mobile/src/ui/App.tsx`'s core
 * composition: a machine-grouped `Sidebar` beside (wide) or over (narrow:
 * `ModalNavigationDrawer`, Compose's own native drawer gestures replacing
 * the hand-rolled scrim+drawer div) `MainPanel`. Settings, Pairing, and
 * New Session are all full-screen replacements of this whole shell while
 * open (F4.1.5, F4.4), not overlays; the undo toast and the keyboard-inset
 * controllers are still later F4 work.
 */
@Composable
fun Shell(bridge: CoreBridge) {
    val machinesView by bridge.machines.collectAsState()
    val connection by bridge.connection.collectAsState()
    val ui by bridge.ui.collectAsState()
    val pairing by bridge.pairing.collectAsState()
    val scope = rememberCoroutineScope()

    val machines = machinesView?.machines ?: emptyList()
    val selectedMachine = ui?.selectedMachine
    val selectedSession = ui?.selectedSession

    var newSessionFor by remember { mutableStateOf<String?>(null) }
    var settingsOpen by remember { mutableStateOf(false) }
    var pairingOpen by remember { mutableStateOf(false) }
    // First run (no machines paired) starts on pairing — same as
    // `apps/mobile`'s `App.tsx`. Waits for the first real `MachinesView`
    // fetch (`machinesView != null`) rather than deciding off the empty
    // pre-hydration list, so a phone that DOES have paired machines never
    // flashes the pairing screen while `CoreBridge.start()`'s initial fetch
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
        scope.launch { bridge.dispatch(UniffiIntent.SelectSession(machine, sessionId)) }
    }

    if (settingsOpen) {
        // Full-screen replacement, not an overlay: while Settings is open it
        // owns the window — the wide/narrow split (and the narrow branch's
        // drawer state) simply isn't composed underneath it, so returning
        // re-derives the drawer from the current selection as usual.
        SettingsScreen(bridge, onClose = { settingsOpen = false })
    } else if (pairingOpen) {
        PairingScreen(bridge, onClose = { pairingOpen = false })
    } else if (newSessionFor != null) {
        NewSessionScreen(bridge, machinePubkey = newSessionFor!!, onClose = { newSessionFor = null })
    } else {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val isWide = maxWidth >= WIDE_BREAKPOINT

            val sessionContent: @Composable (String, String) -> Unit = { machine, sessionId ->
                SessionScreen(bridge, machine, sessionId, modifier = Modifier.fillMaxSize())
            }

            if (isWide) {
                Row(Modifier.fillMaxSize()) {
                    Sidebar(
                        machines = machines,
                        connectionStatus = connection?.status,
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
                // Narrow: open by default while nothing is selected — the
                // sidebar IS the home surface (old-app behaviour, App.tsx's own
                // `sidebarOpen` default) — and a session tap closes it.
                val drawerState = rememberDrawerState(
                    initialValue = if (selectedSession == null) DrawerValue.Open else DrawerValue.Closed,
                )
                // A deep-link-driven or bottom-sheet selection can land while the
                // drawer is already closed; nothing here forces it shut again —
                // only an explicit tap (below) does, matching the wide pane's
                // own "selection doesn't change layout" behavior.
                LaunchedEffect(selectedSession) {
                    if (selectedSession == null) drawerState.open()
                }
                ModalNavigationDrawer(
                    drawerState = drawerState,
                    drawerContent = {
                        ModalDrawerSheet {
                            Sidebar(
                                machines = machines,
                                connectionStatus = connection?.status,
                                selectedMachine = selectedMachine,
                                selectedSession = selectedSession,
                                onSelectSession = { machine, sessionId ->
                                    selectSession(machine, sessionId)
                                    scope.launch { drawerState.close() }
                                },
                                onNewSession = { newSessionFor = it },
                                onOpenSettings = { settingsOpen = true },
                                onOpenPairing = { pairingOpen = true },
                            )
                        }
                    },
                ) {
                    MainPanel(
                        selectedMachine = selectedMachine,
                        selectedSession = selectedSession,
                        isWide = false,
                        onOpenSidebar = { scope.launch { drawerState.open() } },
                        modifier = Modifier.fillMaxSize(),
                        sessionContent = sessionContent,
                    )
                }
            }
        }
    }
}
