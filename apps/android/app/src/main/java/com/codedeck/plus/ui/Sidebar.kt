package com.codedeck.plus.ui

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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.theme.connectionColor
import com.codedeck.plus.ui.theme.presenceColor
import com.codedeck.plus.ui.theme.stateColor
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiMachineSummary
import uniffi.uniffi_bridge.UniffiPendingSession
import uniffi.uniffi_bridge.UniffiSessionSummary

/** Port of `apps/mobile/src/core/sessionNeedsAttention.ts` — true when the
 *  session is blocked on the user (permission approval or an
 *  AskUserQuestion) OR has unread activity. The waiting branch is
 *  deliberately independent of `isUnread`: the unread mechanism skips the
 *  active session, but a session blocked on the user must light up even
 *  while it IS the active session. State strings are `SessionState`'s
 *  `snake_case` wire spelling. */
private fun sessionNeedsAttention(state: String?, isUnread: Boolean): Boolean =
    state == "waiting_permission" || state == "waiting_question" || isUnread

/**
 * The session sidebar — machine-grouped session list with a per-machine "+"
 * for a new session. Port of `apps/mobile/src/ui/Sidebar.tsx`: pending/
 * failed session placeholder cards, pull-to-refresh, swipe-left-to-delete
 * with the shell's undo toast, the attention/unread dot, the committed
 * badge, and the decrypt-failure pairing banner. Machine group order and
 * per-group session order come from the shared [orderedMachines]/
 * [orderedSessions] helpers so the swipe carousel's navigation order can
 * never diverge from this display order.
 */
@Composable
fun Sidebar(
    bridge: CoreBridge,
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
    onOpenSettings: () -> Unit,
    onOpenPairing: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxHeight()
            .background(Tokens.Surface)
            .padding(Tokens.Space3),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Sessions", color = Tokens.Text, fontSize = Tokens.TextLg)
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceRaised)
                        .clickable(onClick = onOpenPairing)
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                ) {
                    Text("Pair", color = Tokens.Text, fontSize = Tokens.TextSm)
                }
                Box(
                    Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceRaised)
                        .clickable(onClick = onOpenSettings)
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                ) {
                    Text("Settings", color = Tokens.Text, fontSize = Tokens.TextSm)
                }
            }
        }

        // Banners, matching `Sidebar.tsx`'s order: the decrypt-failure /
        // re-pair warning first, then the plain connection-status banner.
        if (needsPairingCheck) {
            Text(
                "Some messages could not be decrypted — check that this phone is still paired with its bridges.",
                color = Tokens.Warn,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Tokens.Space2)
                    .clip(RoundedCornerShape(Tokens.RadiusMd))
                    .border(1.dp, Tokens.Warn, RoundedCornerShape(Tokens.RadiusMd))
                    .padding(Tokens.Space3),
            )
        }
        if (connectionStatus != null && connectionStatus != "connected") {
            Row(
                Modifier.fillMaxWidth().padding(top = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
            ) {
                PresenceDot(connectionColor(connectionStatus))
                Text("connection: $connectionStatus", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            }
        }

        // Pull-to-refresh: re-request the session list from every paired
        // machine (the same "refresh each machine" fan-out `Sidebar.tsx`'s
        // refreshAll does). Dispatch is fire-and-forget, so the spinner stays
        // up until the first MACHINES slice-changed lands (bounded by a
        // timeout so a dead network can never pin it).
        var refreshing by remember { mutableStateOf(false) }
        val pullScope = rememberCoroutineScope()

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                if (refreshing || machines.isEmpty()) return@PullToRefreshBox
                refreshing = true
                pullScope.launch {
                    val before = bridge.events.value
                    machines.forEach { machine ->
                        bridge.dispatch(UniffiIntent.RefreshSessions(machine.pubkeyHex))
                    }
                    withTimeoutOrNull(5_000) {
                        bridge.events.first { event ->
                            event !== before &&
                                event is CoreEvent.StateChanged &&
                                event.slice == SliceId.MACHINES
                        }
                    }
                    refreshing = false
                }
            },
            modifier = Modifier.weight(1f).padding(top = Tokens.Space2),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (machines.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            "No machines paired yet.",
                            color = Tokens.TextMuted,
                            fontSize = Tokens.TextSm,
                            modifier = Modifier.padding(vertical = Tokens.Space4),
                        )
                    }
                }

                // Failed pendings that never resolved to a machine
                // (machine === "") — shown once at the top, not under every
                // group (`Sidebar.tsx`'s orphanFailed).
                val orphanFailed = pendingSessions
                    .filter { it.machine.isBlank() && it.state == "failed" }
                    .sortedBy { it.seenAt }
                items(orphanFailed, key = { "orphan-${it.pendingId}" }) { pending ->
                    PendingSessionCard(
                        pending = pending,
                        onDismiss = { dismissId ->
                            pullScope.launch {
                                bridge.dispatch(UniffiIntent.DismissPendingSession(dismissId))
                            }
                        },
                        modifier = Modifier.padding(vertical = Tokens.Space1),
                    )
                }

                orderedMachines(machines).forEach { machine ->
                    item(key = "${machine.pubkeyHex}-header", contentType = "header") {
                        MachineHeader(machine, onNewSession = { onNewSession(machine.pubkeyHex) })
                    }
                    val machinePending = pendingSessions
                        .filter { it.machine == machine.pubkeyHex }
                        .sortedBy { it.seenAt }
                    items(machinePending, key = { "pend-${it.pendingId}" }) { pending ->
                        PendingSessionCard(
                            pending = pending,
                            onDismiss = { dismissId ->
                                pullScope.launch {
                                    bridge.dispatch(UniffiIntent.DismissPendingSession(dismissId))
                                }
                            },
                            modifier = Modifier.padding(vertical = Tokens.Space1),
                        )
                    }
                    val sessions = orderedSessions(machine.sessions)
                    if (sessions.isEmpty()) {
                        if (machinePending.isEmpty()) {
                            item(key = "${machine.pubkeyHex}-empty") {
                                Text(
                                    "No sessions — tap + to start one.",
                                    color = Tokens.TextDim,
                                    fontSize = Tokens.TextSm,
                                    modifier = Modifier.padding(vertical = Tokens.Space2),
                                )
                            }
                        }
                    } else {
                        items(sessions, key = { "${machine.pubkeyHex}-${it.id}" }) { session ->
                            val key = sessionKeyOf(machine.pubkeyHex, session.id)
                            SwipeToDeleteSessionCard(
                                machine = machine.pubkeyHex,
                                session = session,
                                isUnread = key in unreadSessions,
                                isSelected =
                                selectedMachine == machine.pubkeyHex && selectedSession == session.id,
                                showCommitBadge = showCommitBadge,
                                onClick = { onSelectSession(machine.pubkeyHex, session.id) },
                                onDelete = { m, id, label ->
                                    pullScope.launch {
                                        bridge.dispatch(UniffiIntent.DeleteSession(m, id, label))
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MachineHeader(machine: UniffiMachineSummary, onNewSession: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        // Machine-level presence isn't part of `UniffiMachinesView` yet (it
        // lives on `ConnectionView` per-machine, not surfaced to Android
        // until a screen needs it) — the sidebar's own state-colored session
        // rows carry the signal that actually matters for this slice.
        Text(machine.name, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
        Box(
            Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceRaised)
                .clickable(onClick = onNewSession)
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        ) {
            Text("+", color = Tokens.Text, fontSize = Tokens.TextMd)
        }
    }
}

/**
 * Swipe-left-to-delete wrapper around [SessionCard] — the Compose idiomatic
 * equivalent of `apps/mobile/src/ui/useSwipeToDelete.ts` (left-only translate,
 * ≥threshold commits the optimistic delete, anything less snaps back; mobile
 * animates the card off-screen for 0.2 s before firing the callback, this
 * box's dismiss anchor does the same job). Mobile's 80 CSS px threshold maps
 * to the material positional threshold here.
 */
@Composable
private fun SwipeToDeleteSessionCard(
    machine: String,
    session: UniffiSessionSummary,
    isUnread: Boolean,
    isSelected: Boolean,
    showCommitBadge: Boolean,
    onClick: () -> Unit,
    onDelete: (machine: String, sessionId: String, label: String) -> Unit,
) {
    // The dismiss state's confirm lambda is captured on first composition —
    // re-read the callback through `rememberUpdatedState` so a swipe always
    // deletes THIS composition's session, never a stale one.
    val currentOnDelete by rememberUpdatedState(onDelete)
    val currentSession by rememberUpdatedState(session)
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.EndToStart -> {
                    val s = currentSession
                    val label = s.title?.takeIf { it.isNotBlank() }
                        ?: s.slug.takeIf { it.isNotBlank() }
                        ?: "Session"
                    currentOnDelete(machine, s.id, label)
                    true
                }
                else -> false
            }
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        modifier = Modifier.fillMaxWidth(),
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = {
            // Full-width danger panel behind the card; "Delete" hugs the
            // right edge and is revealed as the opaque card slides left.
            Row(
                Modifier
                    .fillMaxSize()
                    .background(Tokens.Danger),
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
        SessionCard(
            session = session,
            isUnread = isUnread,
            isSelected = isSelected,
            showCommitBadge = showCommitBadge,
            onClick = onClick,
        )
    }
}

@Composable
private fun SessionCard(
    session: UniffiSessionSummary,
    isUnread: Boolean,
    isSelected: Boolean,
    showCommitBadge: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(if (isSelected) Tokens.SurfaceHover else Tokens.SurfaceRaised)
            .clickable(onClick = onClick)
            .padding(Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Box(
            Modifier
                .size(3.dp)
                .fillMaxHeight()
                .background(stateColor(session.state)),
        )
        Column(Modifier.weight(1f)) {
            Text(
                session.title ?: session.slug.ifBlank { session.id.take(8) },
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                Text(session.project.ifBlank { session.cwd }, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
                if (session.presence != "live") {
                    Text("· ${session.presence}", color = Tokens.TextDim, fontSize = Tokens.TextXs)
                }
                if (showCommitBadge && session.committed == true) {
                    Text(
                        "committed",
                        color = Tokens.Success,
                        fontSize = Tokens.TextXs,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .background(Tokens.Success.copy(alpha = 0.12f))
                            .padding(horizontal = Tokens.Space1),
                    )
                }
            }
        }
        StatusDot(state = session.state, isUnread = isUnread, presence = session.presence)
    }
}

/**
 * The card's right-edge dot, mirroring `Sidebar.tsx`'s `StatusDot` priority:
 * the loud attention dot when the session needs the user, the subtle muted
 * dot while it runs, otherwise the card falls back to this app's presence
 * dot (mobile carries presence as a text badge instead — the Android card
 * already had the dot, and it is kept as the idle-state filler).
 */
@Composable
private fun StatusDot(state: String?, isUnread: Boolean, presence: String) {
    when {
        sessionNeedsAttention(state, isUnread) -> AttentionDot()
        state == "running" -> PresenceDot(Tokens.TextMuted)
        else -> PresenceDot(presenceColor(presence))
    }
}

/** Solid, high-contrast, scale-only breathing dot (mobile's `.attentionDot`:
 *  opacity stays locked at 1 — a fading pulse reads as "no dot"). The 12 dp
 *  white dot sits inside a 3 dp translucent ring (mobile's box-shadow), and
 *  the whole element breathes on a 1.6 s scale cycle. */
@Composable
private fun AttentionDot() {
    val breathe = rememberInfiniteTransition(label = "attentionBreathe")
    val scale by breathe.animateFloat(
        initialValue = 1f,
        targetValue = 1.12f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 800, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
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

@Composable
private fun PresenceDot(color: androidx.compose.ui.graphics.Color) {
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/**
 * A pending-session placeholder card — "Starting session…" while the bridge
 * is creating the session, an error card with the failure reason once it has
 * failed (mobile's `Sidebar.tsx` per-machine block + orphan-failed variant;
 * only the failed card carries a Dismiss action, since a still-pending one
 * may still become real).
 */
@Composable
private fun PendingSessionCard(
    pending: UniffiPendingSession,
    onDismiss: (pendingId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val borderColor = if (pending.state == "failed") Tokens.Danger else Tokens.Border
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.Surface)
            .border(1.dp, borderColor, RoundedCornerShape(Tokens.RadiusMd))
            .padding(Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Column(Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Text(
                    if (pending.state == "pending") "Starting session…" else "Session failed",
                    color = Tokens.Text,
                    fontSize = Tokens.TextMd,
                    fontWeight = FontWeight.SemiBold,
                )
                if (pending.state == "pending") {
                    PillBadge("pending", Tokens.Accent)
                } else {
                    PillBadge("failed", Tokens.Warn)
                }
            }
            if (pending.state == "failed") {
                Text(
                    pending.reason ?: "unknown reason",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                )
            }
        }
        if (pending.state == "failed") {
            Text(
                "Dismiss",
                color = Tokens.Text,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.SurfaceRaised)
                    .clickable { onDismiss(pending.pendingId) }
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
            )
        }
    }
}

/** Rounded outline badge, mirroring `shared.module.css`'s `.badge` family. */
@Composable
private fun PillBadge(text: String, color: Color) {
    Text(
        text,
        color = color,
        fontSize = Tokens.TextXs,
        modifier = Modifier
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .border(1.dp, color, RoundedCornerShape(Tokens.RadiusPill))
            .padding(horizontal = Tokens.Space2, vertical = 2.dp),
    )
}
