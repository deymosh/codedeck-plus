package com.codedeck.plus.ui.session

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.SessionKey
import com.codedeck.plus.ui.getOrderedSessionKeys
import com.codedeck.plus.ui.gsd.GsdStrip
import com.codedeck.plus.ui.sessionKeyOf
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.theme.stateColor
import com.codedeck.plus.ui.transcript.PendingPermissionSummary
import com.codedeck.plus.ui.transcript.TranscriptList
import com.codedeck.plus.ui.transcript.parseDisplayEntries
import com.codedeck.plus.ui.transcript.parsePendingPermission
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiTranscriptRowsView
import uniffi.uniffi_bridge.UniffiUsageData

/** The effort ladder the wire accepts (`SetEffort.level`'s own spellings). */
private val EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max", "auto")

/** Legacy mode cycle order + compact display labels (`core/modeCycle.ts`). */
private val MODE_CYCLE = listOf("plan", "default", "acceptEdits")
private val MODE_LABELS = mapOf("plan" to "PLAN", "default" to "YOLO", "acceptEdits" to "EDITS")
private const val MODE_TAP_COOLDOWN_MS = 600L
private const val MODE_CONFIRM_TIMEOUT_MS = 8_000L

/**
 * The session screen: session header rows (state/cwd/connection/model,
 * effort selector, mode-cycle button, send-failed badge, full title, usage
 * box, Stop while running, attention chevrons), the GSD strip, the
 * transcript, the always-visible pending-permission bar, the quick-prompt
 * bar, and the input bar. Port of `SessionScreen.tsx` — image attachment is
 * the remaining deliberate gap.
 *
 * The header's ‹/› chevrons mark sessions needing attention (blocked on the
 * user, or unread) left/right in the shared sidebar display order; tapping
 * one jumps there — the reference renders them as pointer-events:none hints
 * beside a swipe carousel, but this app's only equivalent affordance is the
 * tap itself.
 */
@Composable
fun SessionScreen(
    bridge: CoreBridge,
    machine: String,
    sessionId: String,
    onMenu: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val connection by bridge.connection.collectAsState()
    val machinesView by bridge.machines.collectAsState()
    val uiView by bridge.ui.collectAsState()
    val outboxView by bridge.outbox.collectAsState()
    val settings by bridge.settings.collectAsState()
    val quickPromptsView by bridge.quickPrompts.collectAsState()
    val scope = rememberCoroutineScope()

    val session = machinesView?.machines?.firstOrNull { it.pubkeyHex == machine }
        ?.sessions?.firstOrNull { it.id == sessionId }

    var transcriptView by remember(machine, sessionId) { mutableStateOf<UniffiTranscriptRowsView?>(null) }
    LaunchedEffect(machine, sessionId) {
        bridge.transcriptFlow(machine, sessionId).collect { transcriptView = it }
    }
    val displayEntries = remember(transcriptView) {
        transcriptView?.displayEntriesJson?.let(::parseDisplayEntries).orEmpty()
    }
    val pendingPermission: PendingPermissionSummary? = remember(transcriptView) {
        transcriptView?.pendingPermissionJson?.let(::parsePendingPermission)
    }

    val sessionKey = "$machine $sessionId"
    val respondedCards = uiView?.respondedCards?.get(sessionKey)?.toSet().orEmpty()
    val planChoices = uiView?.planApprovalChoices.orEmpty()

    var draft by remember(machine, sessionId) { mutableStateOf("") }
    val inputFocus = remember { FocusRequester() }

    // Mic/STT: hand the whole interaction to the ANDROID SYSTEM speech
    // recognizer — its activity holds RECORD_AUDIO itself, so this app
    // declares and requests no mic permission. Recognized text APPENDS to
    // the draft (same appendToDraft contract as quick prompts — never an
    // auto-send); cancel, a missing recognizer, or an empty result just
    // refocuses the input, never an error surface (the reference's
    // `recognizeSpeech()` null fallback).
    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val text = if (result.resultCode == Activity.RESULT_OK) {
            result.data
                ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                ?.firstOrNull()
                ?.trim()
                .orEmpty()
        } else {
            ""
        }
        if (text.isNotEmpty()) draft = appendToDraft(draft, text) else inputFocus.requestFocus()
    }
    fun dictate() {
        micLauncher.launch(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            },
        )
    }

    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        dispatch(
            UniffiIntent.SendInput(
                machine = machine,
                sessionId = sessionId,
                text = text,
                inputId = UUID.randomUUID().toString(),
            ),
        )
    }

    // --- Mode cycle (CDX-046): the confirmed mode comes from the machines
    // view; a tap shows the REQUESTED mode pulsing until either the
    // mode-confirmed lands (settling the request) or the revert window closes
    // (the request may have been lost — the button must not lie).
    val modeCycle = remember(machine, sessionId) { ModeCycleUi() }
    val confirmedMode = session?.permissionMode
    LaunchedEffect(confirmedMode) {
        val pending = modeCycle.pending
        if (pending != null && confirmedMode == pending) {
            modeCycle.revertJob?.cancel()
            modeCycle.pending = null
        }
    }
    fun tapMode() {
        val now = SystemClock.elapsedRealtime()
        if (now - modeCycle.lastTapAtMs < MODE_TAP_COOLDOWN_MS) return
        modeCycle.lastTapAtMs = now
        val displayed = modeCycle.pending ?: confirmedMode ?: "plan"
        val next = MODE_CYCLE[(MODE_CYCLE.indexOf(displayed) + 1).mod(MODE_CYCLE.size)]
        modeCycle.pending = next
        // Restart the revert window: only the LATEST request's confirmation
        // (or its absence) decides what the button ends up showing.
        modeCycle.revertJob?.cancel()
        modeCycle.revertJob = scope.launch {
            delay(MODE_CONFIRM_TIMEOUT_MS)
            modeCycle.pending = null
        }
        dispatch(UniffiIntent.SetMode(machine = machine, sessionId = sessionId, mode = next))
    }

    fun insertPrompt(text: String) {
        draft = appendToDraft(draft, text)
        inputFocus.requestFocus()
    }

    // Refresh the subscription-usage snapshot on open: the bridge only
    // publishes usage when asked; unsupported SDKs publish nothing and the
    // header just shows no usage badge.
    LaunchedEffect(machine, sessionId) {
        bridge.dispatch(UniffiIntent.RequestUsage(machine = machine, sessionId = sessionId))
    }

    // --- ‹/› attention chevrons: same ordered list as the sidebar/carousel,
    // same predicate as the sidebar's attention dot.
    val orderedKeys = remember(machinesView) { getOrderedSessionKeys(machinesView?.machines.orEmpty()) }
    val unreadSessions = uiView?.unreadSessions.orEmpty().toSet()
    val currentIndex = orderedKeys.indexOfFirst { it.machine == machine && it.sessionId == sessionId }
    fun needsAttention(key: SessionKey): Boolean {
        val state = machinesView?.machines
            ?.firstOrNull { it.pubkeyHex == key.machine }
            ?.sessions?.firstOrNull { it.id == key.sessionId }?.state
        return state == "waiting_permission" || state == "waiting_question" ||
            sessionKeyOf(key.machine, key.sessionId) in unreadSessions
    }
    val attentionLeft = currentIndex > 0 &&
        orderedKeys.subList(0, currentIndex).any { needsAttention(it) }
    val attentionRight = currentIndex >= 0 && currentIndex + 1 < orderedKeys.size &&
        orderedKeys.subList(currentIndex + 1, orderedKeys.size).any { needsAttention(it) }
    fun jumpAttention(direction: Int) {
        if (currentIndex < 0) return
        val targetIndex = if (direction < 0) {
            (currentIndex - 1 downTo 0).firstOrNull { needsAttention(orderedKeys[it]) }
        } else {
            ((currentIndex + 1) until orderedKeys.size).firstOrNull { needsAttention(orderedKeys[it]) }
        } ?: return
        val target = orderedKeys[targetIndex]
        dispatch(UniffiIntent.SelectSession(machine = target.machine, sessionId = target.sessionId))
    }

    // --- Outbox: the "send failed" badge counts this session's failed items;
    // Retry re-publishes the oldest one (the transcript's per-row Retry covers
    // the rest).
    val failedOutbox = outboxView?.items.orEmpty().filter {
        it.machine == machine && it.sessionId == sessionId && it.state == "failed"
    }
    fun retryOldestFailed() {
        failedOutbox.minByOrNull { it.createdAt }?.let { oldest ->
            dispatch(UniffiIntent.RetryOutboxItem(machine = machine, id = oldest.id))
        }
    }

    Column(modifier.fillMaxSize()) {
        SessionHeaderRow1(
            state = session?.state,
            cwd = session?.cwd,
            connectionStatus = connection?.status,
            model = session?.model,
            contextPercentage = session?.contextPercentage,
            showUsageBadge = settings?.showUsageBadge ?: false,
            usage = session?.usage,
            attentionLeft = attentionLeft,
            attentionRight = attentionRight,
            onJumpAttention = ::jumpAttention,
            onMenu = onMenu,
            running = session?.state == "running",
            onStop = { dispatch(UniffiIntent.Interrupt(machine = machine, sessionId = sessionId)) },
        )
        SessionHeaderRow2(
            effortLevel = session?.effortLevel,
            permissionMode = confirmedMode,
            modeLabel = MODE_LABELS[modeCycle.pending ?: confirmedMode] ?: "PLAN",
            modePending = modeCycle.pending != null,
            hasFailedOutbox = failedOutbox.isNotEmpty(),
            onEffortSelect = { level ->
                if (level != session?.effortLevel) {
                    dispatch(UniffiIntent.SetEffort(machine = machine, sessionId = sessionId, level = level))
                }
            },
            onModeTap = ::tapMode,
            onRetryOutbox = ::retryOldestFailed,
            title = session?.title,
        )

        GsdStrip(
            bridge = bridge,
            machine = machine,
            sessionId = sessionId,
            gsd = session?.gsd,
            sessionState = session?.state,
        )

        TranscriptList(
            displayEntries = displayEntries,
            outboxItems = outboxView?.items.orEmpty(),
            machine = machine,
            sessionId = sessionId,
            syncState = transcriptView?.syncState ?: "idle",
            contiguous = transcriptView?.contiguous ?: true,
            respondedCards = respondedCards,
            planApprovalChoices = planChoices,
            dispatch = ::dispatch,
            modifier = Modifier.weight(1f),
        )

        pendingPermission?.let { pending ->
            PendingPermissionBar(pending) { allow ->
                dispatch(
                    UniffiIntent.RespondPermission(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = pending.requestId,
                        allow = allow,
                        modifier = null,
                    ),
                )
            }
        }

        // Quick prompts: hidden entirely when the user has none defined; a tap
        // APPENDS the prompt into the draft — never an auto-send.
        val prompts = quickPromptsView?.prompts.orEmpty()
        if (prompts.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                prompts.forEach { prompt ->
                    Text(
                        prompt.label,
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextXs,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                            .background(Tokens.Text.copy(alpha = 0.03f))
                            .clickable { insertPrompt(prompt.text) }
                            .padding(horizontal = Tokens.Space2, vertical = 2.dp),
                    )
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(Tokens.Space2),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("Message the session…") },
                modifier = Modifier.weight(1f).focusRequester(inputFocus),
            )
            Icon(
                Icons.Outlined.Mic,
                contentDescription = "Dictate with voice",
                tint = Tokens.TextMuted,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .clickable(onClick = ::dictate)
                    .padding(Tokens.Space2)
                    .size(20.dp),
            )
            Button(onClick = ::send, enabled = draft.isNotBlank()) {
                Text("Send")
            }
        }
    }
}

/** Mode-cycle display state: what the button shows is the pending request
 *  while one is in flight, else the last confirmed mode. */
private class ModeCycleUi {
    var pending by mutableStateOf<String?>(null)
    var lastTapAtMs = Long.MIN_VALUE
    var revertJob: Job? = null
}

/** Tapping a quick prompt joins the fragment onto the draft: an empty or
 *  whitespace-only draft takes it verbatim, otherwise trailing whitespace is
 *  stripped and exactly one space joins the two. */
internal fun appendToDraft(draft: String, fragment: String): String =
    if (draft.isBlank()) fragment else "${draft.trimEnd()} $fragment"

@Composable
private fun SessionHeaderRow1(
    state: String?,
    cwd: String?,
    connectionStatus: String?,
    model: String?,
    contextPercentage: Double?,
    showUsageBadge: Boolean,
    usage: UniffiUsageData?,
    attentionLeft: Boolean,
    attentionRight: Boolean,
    onJumpAttention: (Int) -> Unit,
    onMenu: (() -> Unit)?,
    running: Boolean,
    onStop: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        if (attentionLeft) {
            NavChevron("‹") { onJumpAttention(-1) }
        }
        if (onMenu != null) {
            Icon(
                Icons.Outlined.Menu,
                contentDescription = "Open sessions",
                tint = Tokens.Text,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .clickable(onClick = onMenu)
                    .padding(Tokens.Space2)
                    .size(20.dp),
            )
        }
        if (state != null) {
            Text(
                state,
                color = Tokens.Bg,
                fontSize = Tokens.TextXs,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(stateColor(state))
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1 / 2),
            )
        }
        Text(
            cwd.orEmpty(),
            color = Tokens.TextMuted,
            fontSize = Tokens.TextXs,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(connectionStatus ?: "…", color = Tokens.TextDim, fontSize = Tokens.TextXs)
        if (model != null) {
            val ctx = contextPercentage?.let { " · ${it.toInt()}%" } ?: ""
            Text("$model$ctx", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        }
        val badges = usageBadges(usage, System.currentTimeMillis())
        if (showUsageBadge && badges.isNotEmpty()) {
            UsageBox(usage, badges)
        }
        if (running) {
            Text(
                "Stop",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.SurfaceHover)
                    .clickable(onClick = onStop)
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
            )
        }
        if (attentionRight) {
            NavChevron("›") { onJumpAttention(1) }
        }
    }
}

@Composable
private fun SessionHeaderRow2(
    effortLevel: String?,
    permissionMode: String?,
    modeLabel: String,
    modePending: Boolean,
    hasFailedOutbox: Boolean,
    onEffortSelect: (String) -> Unit,
    onModeTap: () -> Unit,
    onRetryOutbox: () -> Unit,
    title: String?,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        EffortSelector(effortLevel, onEffortSelect)
        if (permissionMode != null) {
            ModeButton(modeLabel, modePending, onModeTap)
        }
        if (hasFailedOutbox) {
            SendFailedBadge(onRetryOutbox)
        }
        // The FULL stored title (≤80 chars, `…` exactly at the 77+`...`
        // boundary) — wraps, never ellipsizes, so the stored ellipsis itself
        // stays readable; clamped to 3 lines like the reference.
        if (title != null) {
            Text(
                title,
                color = Tokens.TextMuted,
                fontSize = Tokens.TextXs,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/** ‹/› attention chevron — the reference renders these as non-interactive
 *  pulsing hints beside a swipe carousel; here the tap itself navigates. */
@Composable
private fun NavChevron(glyph: String, onClick: () -> Unit) {
    val alpha = pulsingAlpha(min = 0.4f, max = 1f, halfPeriodMs = 1_000)
    Text(
        glyph,
        color = Tokens.Text,
        fontSize = Tokens.TextXl,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .graphicsLayer { this.alpha = alpha }
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space1),
    )
}

/** Effort dropdown — the reference's `<select>`: shows the current level
 *  ("effort…" until the bridge reports one), opens the ladder on tap. */
@Composable
private fun EffortSelector(current: String?, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            current ?: "effort…",
            color = if (current != null) Tokens.Text else Tokens.TextMuted,
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceInput)
                .clickable { open = true }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            EFFORT_LEVELS.forEach { level ->
                DropdownMenuItem(
                    text = { Text(level, color = Tokens.Text, fontSize = Tokens.TextSm) },
                    onClick = {
                        open = false
                        onSelect(level)
                    },
                )
            }
        }
    }
}

/** The PLAN → YOLO → EDITS cycle button. While a request is in flight the
 *  label is the REQUESTED mode, pulsing like the legacy `setting-pending`. */
@Composable
private fun ModeButton(label: String, pending: Boolean, onTap: () -> Unit) {
    val alpha = if (pending) pulsingAlpha(min = 0.35f, max = 1f, halfPeriodMs = 500) else 1f
    Text(
        label,
        color = Tokens.Text,
        fontSize = Tokens.TextXs,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .graphicsLayer { this.alpha = alpha }
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.Text.copy(alpha = 0.03f))
            .clickable(onClick = onTap)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun SendFailedBadge(onRetry: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            "send failed",
            color = Tokens.Warn,
            fontSize = Tokens.TextXs,
            fontWeight = FontWeight.Bold,
            modifier = Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.Text.copy(alpha = 0.03f))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
        Text(
            "Retry",
            color = Tokens.Text,
            fontSize = Tokens.TextXs,
            fontWeight = FontWeight.Bold,
            modifier = Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceHover)
                .clickable(onClick = onRetry)
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/** The 5h/7d subscription-usage box: reported windows stacked as rows, the
 *  worst utilization coloring the whole rectangle (warn ≥75, critical ≥90,
 *  critical also straight off a badge's ≥90 flag). */
@Composable
private fun UsageBox(usage: UniffiUsageData?, badges: List<UsageBadgeData>) {
    val accent = when (usageSeverity(usage, badges)) {
        "critical" -> Tokens.Danger
        "warn" -> Tokens.Warn
        else -> Tokens.TextMuted
    }
    val fill = when (usageSeverity(usage, badges)) {
        "critical" -> Tokens.Danger.copy(alpha = 0.10f)
        "warn" -> Tokens.Warn.copy(alpha = 0.10f)
        else -> Tokens.Text.copy(alpha = 0.03f)
    }
    Column(
        Modifier
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .border(1.dp, accent, RoundedCornerShape(Tokens.RadiusSm))
            .background(fill)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        horizontalAlignment = Alignment.End,
    ) {
        badges.forEach { badge ->
            val description = badge.resetCountdown?.let { "${badge.text}, $it" } ?: badge.text
            Text(
                badge.text,
                color = accent,
                fontSize = Tokens.TextXs * 0.9f,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.semantics { contentDescription = description },
            )
        }
    }
}

@Composable
private fun pulsingAlpha(min: Float, max: Float, halfPeriodMs: Int): Float {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = min,
        targetValue = max,
        animationSpec = infiniteRepeatable(
            animation = tween(halfPeriodMs, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulseAlpha",
    )
    return alpha
}

@Composable
private fun PendingPermissionBar(pending: PendingPermissionSummary, onRespond: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Warn.copy(alpha = 0.12f))
            .padding(Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        val label = if (pending.isSubAgent) {
            "${pending.agentLabel ?: "Sub-agent"}: ${pending.toolName} needs permission"
        } else {
            "${pending.toolName} needs permission"
        }
        Text(label, color = Tokens.Text, fontSize = Tokens.TextSm, modifier = Modifier.weight(1f))
        Text(
            "Allow",
            color = Tokens.Success,
            fontSize = Tokens.TextSm,
            modifier = Modifier.clickable { onRespond(true) }.padding(Tokens.Space2),
        )
        Text(
            "Deny",
            color = Tokens.Danger,
            fontSize = Tokens.TextSm,
            modifier = Modifier.clickable { onRespond(false) }.padding(Tokens.Space2),
        )
    }
}

// --- Subscription-usage presentation helpers (port of `ui/usageFormat.ts`'s
// header subset).

private data class UsageBadgeData(val text: String, val resetCountdown: String?, val critical: Boolean)

private fun usageBadges(usage: UniffiUsageData?, nowMs: Long): List<UsageBadgeData> {
    if (usage?.available != true) return emptyList()
    val badges = mutableListOf<UsageBadgeData>()
    for ((label, window) in listOf("5h" to usage.fiveHour, "7d" to usage.sevenDay)) {
        val utilization = window?.utilization?.takeIf { it.isFinite() } ?: continue
        val pct = utilization.coerceIn(0.0, 100.0).roundToInt()
        badges.add(
            UsageBadgeData(
                text = "$label $pct%",
                resetCountdown = formatReset(window.resetsAt, nowMs),
                critical = pct >= 90,
            ),
        )
    }
    return badges
}

/** Severity for the usage BOX: the worst utilization across the reported
 *  windows colors the whole rectangle; ≥90 critical comes straight from the
 *  badges' own flag. */
private fun usageSeverity(usage: UniffiUsageData?, badges: List<UsageBadgeData>): String =
    when {
        badges.any { it.critical } -> "critical"
        listOfNotNull(
            usage?.fiveHour,
            usage?.sevenDay,
            usage?.sevenDayOpus,
            usage?.sevenDaySonnet,
        ).any { window -> (window.utilization?.takeIf { it.isFinite() } ?: 0.0) >= 75.0 } -> "warn"
        else -> "ok"
    }

/** Coarse reset countdown — carried in the badge row's accessibility
 *  description: the reference keeps it on each badge's tooltip, which has no
 *  touch-device surface, so visually the phone shows the percentage only,
 *  same as mobile on touch. */
private fun formatReset(resetsAt: String?, nowMs: Long): String? {
    val target = resetsAt?.let(::parseWireTimestamp) ?: return null
    val diffMs = target - nowMs
    if (diffMs <= 0) return "resetting…"
    val totalMin = diffMs / 60_000
    val days = totalMin / 1440
    val hours = (totalMin % 1440) / 60
    val mins = totalMin % 60
    return when {
        days > 0 -> "resets in ${days}d ${hours}h"
        hours > 0 -> "resets in ${hours}h ${mins}m"
        else -> "resets in ${mins}m"
    }
}

/** `Date.parse`'s ISO tolerance, tiered: `Z`-suffixed instants, then explicit
 *  offsets, then a bare local timestamp read as UTC. */
private fun parseWireTimestamp(value: String): Long? = try {
    Instant.parse(value).toEpochMilli()
} catch (_: DateTimeParseException) {
    try {
        OffsetDateTime.parse(value).toInstant().toEpochMilli()
    } catch (_: DateTimeParseException) {
        try {
            LocalDateTime.parse(value).toInstant(ZoneOffset.UTC).toEpochMilli()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}
