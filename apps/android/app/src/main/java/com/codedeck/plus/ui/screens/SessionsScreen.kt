package com.codedeck.plus.ui.screens

import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxDefaults
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.AppLogo
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.DeckIcons
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.components.EmptyState
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.MachineLabelTracking
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.components.ThinkingGlyph
import com.codedeck.plus.ui.orderedMachines
import com.codedeck.plus.ui.orderedSessions
import com.codedeck.plus.ui.sessionKeyOf
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.theme.presenceColor
import com.codedeck.plus.ui.theme.stateColor
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiPendingSession
import uniffi.client_ffi.UniffiSessionSummary
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId

/** Port of `apps/mobile/src/core/sessionNeedsAttention.ts` — true when the
 *  session is blocked on the user (permission approval or an
 *  AskUserQuestion) OR has unread activity. The waiting branch is
 *  deliberately independent of `isUnread`: the unread mechanism skips the
 *  active session, but a session blocked on the user must light up even
 *  while it IS the active session. State strings are `SessionState`'s
 *  `snake_case` wire spelling. */
private fun sessionNeedsAttention(state: String?, isUnread: Boolean): Boolean =
    state == "waiting_permission" || state == "waiting_question" || isUnread

/** How often the machines' online/offline status is re-read from their last heartbeat. */
private const val PRESENCE_TICK_MS = 30_000L

/**
 * The home page: every paired machine with its sessions. Pull to refresh
 * asks each machine for its list again; a session swiped left is deleted
 * with a few seconds to undo (the shell's toast). The button at the lower
 * right pairs another machine; with none paired the page is an invitation
 * to pair the first.
 */
@Composable
fun SessionsScreen(
    core: CoreHost,
    machines: List<UniffiMachineSummary>,
    pendingSessions: List<UniffiPendingSession>,
    connectionStatus: String?,
    needsPairingCheck: Boolean,
    showCommitBadge: Boolean,
    unreadSessions: Set<String>,
    selectedMachine: String?,
    selectedSession: String?,
    onSelectSession: (machine: String, sessionId: String) -> Unit,
    onNewSession: (machine: String) -> Unit,
    onOpenMachine: (machine: String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(PRESENCE_TICK_MS)
            now = System.currentTimeMillis()
        }
    }
    // A fresh heartbeat moves the machine's status at once, not at the next tick.
    LaunchedEffect(machines) { now = System.currentTimeMillis() }

    SessionsContent(
        machines = machines,
        pendingSessions = pendingSessions,
        connectionStatus = connectionStatus,
        needsPairingCheck = needsPairingCheck,
        showCommitBadge = showCommitBadge,
        unreadSessions = unreadSessions,
        selectedMachine = selectedMachine,
        selectedSession = selectedSession,
        now = now,
        refreshing = refreshing,
        onRefresh = {
            if (!refreshing && machines.isNotEmpty()) {
                refreshing = true
                scope.launch {
                    // Subscribed before anything is dispatched: `events` has
                    // no replay, so a reply landing before a late
                    // subscription would be lost. The spinner stays up until
                    // the first answer, or 5 s on a dead network.
                    val landed = async(start = CoroutineStart.UNDISPATCHED) {
                        withTimeoutOrNull(5_000) {
                            core.events.first { it is CoreEvent.StateChanged && it.slice == SliceId.MACHINES }
                        }
                    }
                    machines.forEach { core.dispatch(UniffiIntent.RefreshSessions(it.pubkeyHex)) }
                    landed.await()
                    refreshing = false
                }
            }
        },
        onSelectSession = onSelectSession,
        onNewSession = onNewSession,
        onOpenMachine = onOpenMachine,
        onDeleteSession = { m, id, label -> scope.launch { core.dispatch(UniffiIntent.DeleteSession(m, id, label)) } },
        onDismissPending = { id -> scope.launch { core.dispatch(UniffiIntent.DismissPendingSession(id)) } },
        onOpenSettings = onOpenSettings,
        onOpenPairing = onOpenPairing,
        modifier = modifier,
    )
}

/** [SessionsScreen]'s page from plain data, so it renders the same in a snapshot. */
@Composable
fun SessionsContent(
    machines: List<UniffiMachineSummary>,
    pendingSessions: List<UniffiPendingSession>,
    connectionStatus: String?,
    needsPairingCheck: Boolean,
    showCommitBadge: Boolean,
    unreadSessions: Set<String>,
    selectedMachine: String?,
    selectedSession: String?,
    now: Long,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onSelectSession: (machine: String, sessionId: String) -> Unit,
    onNewSession: (machine: String) -> Unit,
    onOpenMachine: (machine: String) -> Unit,
    onDeleteSession: (machine: String, sessionId: String, label: String) -> Unit,
    onDismissPending: (pendingId: String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().background(Tokens.Bg)) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space2, top = Tokens.Space3, bottom = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                AppLogo(30.dp)
                Text(
                    "CodeDeck+",
                    color = Tokens.Text,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = (-0.3).sp,
                    modifier = Modifier.weight(1f),
                )
                IconAction(Icons.Outlined.Settings, "Settings", onOpenSettings)
            }

            if (machines.isNotEmpty()) {
                ConnectionNotice(connectionStatus, needsPairingCheck)
            }

            if (machines.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        icon = DeckIcons.PairMachine,
                        title = "Pair your first machine",
                        body = "Run codedeck-bridge on your laptop or server, then scan the code it shows. " +
                            "Its coding agents appear here, ready to drive.",
                        action = "Pair a machine",
                        onAction = onOpenPairing,
                        modifier = Modifier.padding(bottom = Tokens.Space7),
                    )
                }
            } else {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = onRefresh,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) {
                    SessionList(
                        machines = machines,
                        pendingSessions = pendingSessions,
                        showCommitBadge = showCommitBadge,
                        unreadSessions = unreadSessions,
                        selectedMachine = selectedMachine,
                        selectedSession = selectedSession,
                        now = now,
                        onSelectSession = onSelectSession,
                        onNewSession = onNewSession,
                        onOpenMachine = onOpenMachine,
                        onDeleteSession = onDeleteSession,
                        onDismissPending = onDismissPending,
                    )
                }
            }
        }
        if (machines.isNotEmpty()) {
            PairFab(onOpenPairing, Modifier.align(Alignment.BottomEnd).padding(Tokens.Space5))
        }
    }
}

/** The one filled, white button of the page: pair another machine. */
@Composable
private fun PairFab(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(60.dp)
            .shadow(12.dp, CircleShape, ambientColor = Color.White.copy(alpha = 0.25f), spotColor = Color.White.copy(alpha = 0.25f))
            .clip(CircleShape)
            .background(Tokens.Accent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(DeckIcons.PairMachine, contentDescription = "Pair a machine", tint = Tokens.AccentContrast, modifier = Modifier.size(28.dp))
    }
}

/** Says why sessions may be out of date: the relays are not reached, or messages fail to decrypt. */
@Composable
private fun ConnectionNotice(connectionStatus: String?, needsPairingCheck: Boolean) {
    val text = when {
        needsPairingCheck -> "Some messages could not be decrypted. Check this phone is still paired with its machines."
        connectionStatus == null || connectionStatus == "connected" -> return
        connectionStatus == "connecting" -> "Connecting…"
        connectionStatus == "offline" -> "Offline. Sessions update when the network is back."
        else -> "Reconnecting…"
    }
    val color = if (needsPairingCheck) Tokens.Warn else Tokens.TextMuted
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space1)
            .clip(RoundedCornerShape(Tokens.RadiusLg))
            .background(Tokens.SurfaceRaised)
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Dot(if (needsPairingCheck) Tokens.Warn else Tokens.PresenceStale)
        Text(text, color = color, fontSize = Tokens.TextSm)
    }
}

@Composable
private fun SessionList(
    machines: List<UniffiMachineSummary>,
    pendingSessions: List<UniffiPendingSession>,
    showCommitBadge: Boolean,
    unreadSessions: Set<String>,
    selectedMachine: String?,
    selectedSession: String?,
    now: Long,
    onSelectSession: (machine: String, sessionId: String) -> Unit,
    onNewSession: (machine: String) -> Unit,
    onOpenMachine: (machine: String) -> Unit,
    onDeleteSession: (machine: String, sessionId: String, label: String) -> Unit,
    onDismissPending: (pendingId: String) -> Unit,
) {
    // Worked out once per change of the lists, not on every recomposition
    // (the presence clock ticks the list every half minute).
    val orphanFailed = remember(pendingSessions) {
        pendingSessions.filter { it.machine.isBlank() && it.state == "failed" }.sortedBy { it.seenAt }
    }
    val groups = remember(machines, pendingSessions) {
        orderedMachines(machines).map { machine ->
            MachineGroup(
                machine = machine,
                pending = pendingSessions.filter { it.machine == machine.pubkeyHex }.sortedBy { it.seenAt },
                sessions = orderedSessions(machine.sessions),
            )
        }
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        // Room under the last card for the pairing button.
        contentPadding = PaddingValues(start = Tokens.Space4, end = Tokens.Space4, top = Tokens.Space2, bottom = 104.dp),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        // Failed creates that never reached a machine, once at the top.
        items(orphanFailed, key = { "orphan-${it.pendingId}" }, contentType = { "pending" }) { pending ->
            PendingSessionCard(pending, onDismissPending)
        }

        groups.forEachIndexed { index, (machine, machinePending, sessions) ->
            item(key = "${machine.pubkeyHex}-header", contentType = "header") {
                MachineHeader(
                    machine = machine,
                    now = now,
                    first = index == 0,
                    onOpen = { onOpenMachine(machine.pubkeyHex) },
                    onNewSession = { onNewSession(machine.pubkeyHex) },
                )
            }
            items(machinePending, key = { "pend-${it.pendingId}" }, contentType = { "pending" }) { pending ->
                PendingSessionCard(pending, onDismissPending)
            }
            if (sessions.isEmpty() && machinePending.isEmpty()) {
                item(key = "${machine.pubkeyHex}-empty", contentType = "empty") {
                    Text(
                        "No sessions yet.",
                        color = Tokens.TextDim,
                        fontSize = Tokens.TextSm,
                        modifier = Modifier.padding(horizontal = Tokens.Space2, vertical = Tokens.Space2),
                    )
                }
            }
            items(sessions, key = { "${machine.pubkeyHex}-${it.id}" }, contentType = { "session" }) { session ->
                SwipeToDeleteSessionCard(
                    machine = machine.pubkeyHex,
                    session = session,
                    agentName = machine.agents.takeIf { it.size > 1 }?.firstOrNull { it.id == session.agent }?.displayName,
                    isUnread = sessionKeyOf(machine.pubkeyHex, session.id) in unreadSessions,
                    isSelected = selectedMachine == machine.pubkeyHex && selectedSession == session.id,
                    showCommitBadge = showCommitBadge,
                    onClick = { onSelectSession(machine.pubkeyHex, session.id) },
                    onDelete = onDeleteSession,
                )
            }
        }
    }
}

/** One machine's part of the list, in the order it shows. */
private data class MachineGroup(
    val machine: UniffiMachineSummary,
    val pending: List<UniffiPendingSession>,
    val sessions: List<UniffiSessionSummary>,
)

/** A machine's name (opens its settings), whether it is up, and starting a session on it. */
@Composable
private fun MachineHeader(machine: UniffiMachineSummary, now: Long, first: Boolean, onOpen: () -> Unit, onNewSession: () -> Unit) {
    val presence = machinePresence(machine, now)
    Row(
        Modifier.fillMaxWidth().padding(top = if (first) Tokens.Space2 else Tokens.Space5, bottom = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Column(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(Tokens.RadiusMd))
                .clickable(onClick = onOpen)
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                machineLabel(machine.name),
                color = Tokens.Text,
                fontSize = Tokens.TextLg,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = MachineLabelTracking,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Dot(presence.color, size = 7.dp)
                val status = machineStatusText(machine, now) + if (machine.directUp != null) ", direct link" else ""
                Text(status, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
            }
        }
        NewSessionPill(enabled = machine.agents.isNotEmpty() || presence == MachinePresence.Online, onClick = onNewSession)
    }
}

@Composable
private fun NewSessionPill(enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceHover)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(start = Tokens.Space3, end = Tokens.Space4),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val color = if (enabled) Tokens.Text else Tokens.TextDim
        Icon(Icons.Outlined.Add, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Text("New session", color = color, fontSize = Tokens.TextSm, fontWeight = FontWeight.Medium)
    }
}

/**
 * Swipe-left-to-delete around [SessionCard]: past the threshold the
 * optimistic delete fires (undoable from the shell's toast), anything less
 * snaps back.
 */
@Composable
private fun SwipeToDeleteSessionCard(
    machine: String,
    session: UniffiSessionSummary,
    agentName: String?,
    isUnread: Boolean,
    isSelected: Boolean,
    showCommitBadge: Boolean,
    onClick: () -> Unit,
    onDelete: (machine: String, sessionId: String, label: String) -> Unit,
) {
    // The effect below captures these on first composition —
    // `rememberUpdatedState` keeps a swipe deleting THIS session.
    val currentOnDelete by rememberUpdatedState(onDelete)
    val currentSession by rememberUpdatedState(session)
    // Plain `remember`, NOT `rememberSwipeToDismissBoxState` (which is
    // `rememberSaveable`): the list keeps each item key's saveable state after
    // the item leaves, so a session brought back by Undo came back already
    // swiped away, and its settled value fired the delete again. A card that
    // (re)enters the list must always start settled.
    val positionalThreshold = SwipeToDismissBoxDefaults.positionalThreshold
    val dismissState = remember { SwipeToDismissBoxState(SwipeToDismissBoxValue.Settled, positionalThreshold) }

    // Delete fires once a left swipe settles at EndToStart; with
    // start-to-end disabled that and Settled are the only values.
    LaunchedEffect(dismissState) {
        snapshotFlow { dismissState.currentValue }.collect { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                val s = currentSession
                val label = s.title?.takeIf { it.isNotBlank() } ?: s.slug.takeIf { it.isNotBlank() } ?: "Session"
                currentOnDelete(machine, s.id, label)
            }
        }
    }
    SwipeToDismissBox(
        state = dismissState,
        modifier = Modifier.fillMaxWidth(),
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = {
            // Clipped to the card's own corners, so no red edge shows
            // around a card at rest.
            Row(
                Modifier.fillMaxSize().clip(RoundedCornerShape(Tokens.RadiusLg)).background(Tokens.Danger),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.End,
            ) {
                Text(
                    "Delete",
                    color = Color.White,
                    fontSize = Tokens.TextSm,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(end = Tokens.Space5),
                )
            }
        },
    ) {
        SessionCard(session, agentName, isUnread, isSelected, showCommitBadge, onClick)
    }
}

@Composable
private fun SessionCard(
    session: UniffiSessionSummary,
    agentName: String?,
    isUnread: Boolean,
    isSelected: Boolean,
    showCommitBadge: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(Tokens.RadiusLg)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (isSelected) Tokens.SurfaceHover else Tokens.SurfaceRaised)
            .border(1.dp, if (isSelected) Tokens.BorderStrong else Tokens.Border, shape)
            .clickable(onClick = onClick)
            .padding(start = Tokens.Space3, end = Tokens.Space4, top = Tokens.Space3, bottom = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        // The state rail: the session's state at the card's edge, bright
        // while it runs or waits, faint while idle.
        val idle = session.state == null || session.state == "idle"
        Box(
            Modifier
                .fillMaxHeight()
                .heightIn(min = 36.dp)
                .width(3.dp)
                .clip(RoundedCornerShape(Tokens.RadiusPill))
                .background(stateColor(session.state).copy(alpha = if (idle) 0.35f else 1f)),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                session.title ?: session.slug.ifBlank { session.id.take(8) },
                color = Tokens.Text,
                fontSize = Tokens.TextLg,
                fontWeight = if (isUnread) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                val where = session.project.ifBlank { session.cwd.substringAfterLast('/').substringAfterLast('\\') }
                Text(
                    listOfNotNull(where.ifBlank { null }, agentName).joinToString(" · "),
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (session.presence != "live") {
                    Chip(session.presence, color = Tokens.TextDim, border = Tokens.Border)
                }
                if (showCommitBadge && session.committed == true) {
                    Chip("committed", color = Tokens.Success, border = Tokens.Success.copy(alpha = 0.4f))
                }
            }
        }
        StatusMark(state = session.state, isUnread = isUnread, presence = session.presence)
    }
}

/**
 * The card's end mark: the loud attention dot when the session needs the
 * user, the thinking glyph while it runs, otherwise its presence.
 */
@Composable
private fun StatusMark(state: String?, isUnread: Boolean, presence: String) {
    // Blocked on the user outranks everything; a running turn outranks mere
    // unread output (a turn streaming in the background is always "unread").
    when {
        state == "waiting_permission" || state == "waiting_question" -> AttentionDot()
        state == "running" -> ThinkingGlyph()
        sessionNeedsAttention(state, isUnread) -> AttentionDot()
        else -> Dot(presenceColor(presence).copy(alpha = 0.6f))
    }
}

/** Solid, high-contrast, scale-only breathing dot: opacity stays at 1, since
 *  a fading pulse reads as no dot at all. */
@Composable
private fun AttentionDot() {
    val breathe = rememberInfiniteTransition(label = "attentionBreathe")
    val scale by breathe.animateFloat(
        initialValue = 1f,
        targetValue = 1.12f,
        animationSpec = infiniteRepeatable(animation = tween(durationMillis = 800, easing = EaseInOut), repeatMode = RepeatMode.Reverse),
        label = "attentionScale",
    )
    Box(
        Modifier
            .size(18.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .border(3.dp, Tokens.Text.copy(alpha = 0.18f), CircleShape)
            .padding(3.dp)
            .clip(CircleShape)
            .background(Tokens.Text),
    )
}

/**
 * A session being created ("Starting…") or whose create failed, with the
 * reason and a Dismiss — only a failed one can be dismissed, a pending one
 * may still become real.
 */
@Composable
private fun PendingSessionCard(pending: UniffiPendingSession, onDismiss: (pendingId: String) -> Unit) {
    val failed = pending.state == "failed"
    val shape = RoundedCornerShape(Tokens.RadiusLg)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Tokens.Surface)
            .border(1.dp, if (failed) Tokens.Danger.copy(alpha = 0.6f) else Tokens.Border, shape)
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        if (!failed) ThinkingGlyph()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                if (failed) "Session failed to start" else "Starting a session…",
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.Medium,
            )
            if (failed) {
                Text(pending.reason ?: "The bridge gave no reason.", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            }
        }
        if (failed) {
            Text(
                "Dismiss",
                color = Tokens.Text,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                    .background(Tokens.SurfaceHover)
                    .clickable { onDismiss(pending.pendingId) }
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
            )
        }
    }
}
