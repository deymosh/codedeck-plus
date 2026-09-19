package com.codedeck.plus.ui.gsd

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import java.util.UUID
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiGsdAction
import uniffi.uniffi_bridge.UniffiGsdPhase
import uniffi.uniffi_bridge.UniffiGsdState
import uniffi.uniffi_bridge.UniffiIntent
import kotlin.math.roundToLong

/**
 * GsdStrip — the GSD stage strip under the session header, port of
 * `apps/mobile/src/ui/gsd/GsdStrip.tsx` + `gsdStages.ts`.
 *
 * GSD is command-driven — no hooks, no ambient UI — so the strip answers
 * "where am I" in one line and turns the next step into one tap. Visibility
 * has ONE gate: `gsd.available` (a real `.planning/`) — no state → no strip;
 * the [UniffiGsdState] itself only arrives in reply to a `RequestGsd` intent,
 * which this composable fires once on mount per session and again on every
 * expand (the bridge only publishes gsd-state in reply, so the phone must
 * always initiate).
 *
 * Commands go through the same path as typing (`SendInput`, which crosses
 * into the core's outbox) so a tap is never invisible: it renders in the
 * stream like any other input. While a turn is running or waiting on the
 * user, a sent command would be folded into that turn and silently lost —
 * chips are disabled at the source instead of letting a tap lie.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GsdStrip(
    bridge: CoreBridge,
    machine: String,
    sessionId: String,
    gsd: UniffiGsdState?,
    sessionState: String?,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
    }

    // One request on mount, per session — gating this on already-having state
    // meant neither side ever initiated and the strip could never render.
    // Also refreshes stored state from a prior run.
    LaunchedEffect(machine, sessionId) {
        bridge.dispatch(UniffiIntent.RequestGsd(machine = machine, sessionId = sessionId))
    }

    if (gsd == null || !gsd.available) return

    var open by remember(machine, sessionId) { mutableStateOf(false) }

    val waiting = sessionState == "waiting_question" || sessionState == "waiting_permission"
    val busy = sessionState == "running" || waiting

    fun run(command: String) {
        if (busy) return
        dispatch(
            UniffiIntent.SendInput(
                machine = machine,
                sessionId = sessionId,
                text = command,
                inputId = UUID.randomUUID().toString(),
            ),
        )
        open = false
    }

    val exec = executionLine(gsd)
    val chips = recoveryChips(gsd)
    val action = recommendedAction(gsd)
    // FFI carries f64 verbatim, so a NaN percent (mobile's JSON layer degrades
    // it to null → `?? 0`) would reach fillMaxWidth and poison layout.
    val pct = (gsd.percent.takeIf { it.isFinite() } ?: 0.0).coerceIn(0.0, 100.0)
    // Mid-execute or blocked, the recommended action is stale or double-fires.
    val actionReady = !busy && exec == null
    val summary = if (waiting) "Waiting on you" else (exec ?: stripSummary(gsd))
    val chevron = when {
        waiting -> "!"
        exec != null -> "⟳"
        open -> "▾"
        else -> "▸"
    }
    // Waiting (warn) / running (accent) left-edge stripe, like the reference's
    // inset box-shadow on `.barWaiting` / `.barRunning`.
    val stripe = when {
        waiting -> Tokens.Warn
        exec != null -> Tokens.Accent
        else -> null
    }

    Column(modifier.fillMaxWidth().background(Tokens.SurfaceRaised)) {
        FlowRow(
            Modifier
                .fillMaxWidth()
                .drawBehind {
                    stripe?.let { color ->
                        drawRect(color, size = Size(LeftStripeWidth.toPx(), size.height))
                    }
                }
                .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space1),
        ) {
            Row(
                Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .clickable {
                        val next = !open
                        open = next
                        // State only moves when commands finish — refresh on
                        // every expand.
                        if (next) {
                            dispatch(UniffiIntent.RequestGsd(machine = machine, sessionId = sessionId))
                        }
                    }
                    .padding(vertical = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Text(
                    chevron,
                    color = if (waiting) Tokens.Warn else Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    fontWeight = if (waiting) FontWeight.Bold else FontWeight.Normal,
                )
                Text(
                    summary,
                    color = if (waiting) Tokens.Text else Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (!waiting) {
                    Meter(pct)
                }
            }
            chips.forEach { chip ->
                GsdChip(
                    label = chip.label,
                    recovery = true,
                    enabled = !busy,
                    onClick = { run(chip.command) },
                )
            }
            if (actionReady && action != null) {
                GsdChip(
                    label = action.label,
                    recovery = false,
                    enabled = true,
                    onClick = { run(action.command) },
                )
            }
        }

        if (open) {
            PhaseList(gsd)
        }
    }
}

/** The 3 dp-wide bar accent the reference draws as an inset box-shadow. */
private val LeftStripeWidth = 3.dp

@Composable
private fun Meter(pct: Double) {
    Box(
        Modifier
            .size(width = 48.dp, height = 4.dp)
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.BorderStrong),
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth((pct / 100.0).toFloat())
                .clip(RoundedCornerShape(Tokens.RadiusPill))
                .background(Tokens.Accent),
        )
    }
}

/** Pill command chip; recovery chips speak in the warn color, like `.chipRecovery`. */
@Composable
private fun GsdChip(label: String, recovery: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val borderColor = when {
        !enabled -> Tokens.Border
        recovery -> Tokens.Warn
        else -> Tokens.BorderStrong
    }
    val textColor = if (enabled) (if (recovery) Tokens.Warn else Tokens.Text) else Tokens.TextDim
    Text(
        label,
        color = textColor,
        fontSize = Tokens.TextXs,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .border(1.dp, borderColor, RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.Surface)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1),
    )
}

@Composable
private fun PhaseList(gsd: UniffiGsdState) {
    Column(
        Modifier.padding(start = Tokens.Space3, end = Tokens.Space3, bottom = Tokens.Space2),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space1),
    ) {
        gsd.phases.forEach { phase ->
            val stages = phaseStages(phase)
            val current = gsd.currentPhase != null && phase.number == gsd.currentPhase
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(if (current) Tokens.SurfaceHover else Color.Transparent)
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Text(
                    stages.marks.joinToString(" "),
                    color = if (current) Tokens.Accent else Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    fontFamily = Tokens.FontMono,
                )
                Text(
                    "${phase.number}. ${phase.name}",
                    color = if (current) Tokens.Text else Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    stages.label,
                    color = if (current) Tokens.TextMuted else Tokens.TextDim,
                    fontSize = Tokens.TextXs,
                )
            }
        }
        if (gsd.phases.isEmpty()) {
            Text(
                "No phases yet",
                color = Tokens.TextDim,
                fontSize = Tokens.TextXs,
                modifier = Modifier.padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
            )
        }
    }
}

// --- gsdStages.ts port: presentation helpers over bridge-computed GSD state.
// The vocabulary is GSD's own; phone and desktop must describe a phase
// identically. The three marks read left→right as Discuss, Plan, Execute:
// ✓ done · ◆ in flight / needs you · ○ ready to start · · not reached yet.

/** The Discuss / Plan / Execute stage triple for one phase. */
internal data class PhaseStages(val marks: List<String>, val label: String)

internal data class RecoveryChip(val id: String, val label: String, val command: String)

private val STAGES = mapOf(
    "complete" to PhaseStages(listOf("✓", "✓", "✓"), "Complete"),
    "executed" to PhaseStages(listOf("✓", "✓", "◆"), "Verification required"),
    "partial" to PhaseStages(listOf("✓", "✓", "◆"), "Executing…"),
    "planned" to PhaseStages(listOf("✓", "✓", "○"), "Ready to execute"),
    "discussed" to PhaseStages(listOf("✓", "○", "·"), "Ready to plan"),
    "researched" to PhaseStages(listOf("✓", "○", "·"), "Ready to plan"),
    "empty" to PhaseStages(listOf("·", "·", "·"), "Up next"),
)

private val UNKNOWN = PhaseStages(listOf("·", "·", "·"), "Up next")

internal fun phaseStages(phase: UniffiGsdPhase): PhaseStages {
    val base = STAGES[phase.diskStatus] ?: UNKNOWN
    // A phase GSD has an action for is reachable now — say so, not "Up next".
    if (base == UNKNOWN && phase.action != null) {
        return PhaseStages(UNKNOWN.marks, "Ready to ${phase.action}")
    }
    return base
}

/** Human label for `UniffiGsdState.situation`, for the collapsed one-liner. */
internal fun situationLabel(situation: String): String = when (situation) {
    "no-project" -> "No project"
    "needs-first-phase" -> "Plan first phase"
    "planning" -> "Planning"
    "executing" -> "Executing"
    "verify-pending" -> "Verify"
    "verify-failed" -> "Verify failed"
    "paused" -> "Paused"
    "blocked" -> "Blocked"
    "idle-stranded" -> "Idle"
    "complete" -> "Complete"
    else -> "GSD"
}

/**
 * The one-line summary shown in the collapsed strip, e.g.
 * `v1.0 — MVP · Phase 2/3 · Executing · 50%`. Unresolved parts are dropped
 * rather than rendered as "null" or "0".
 */
internal fun stripSummary(gsd: UniffiGsdState): String {
    val parts = mutableListOf<String>()
    gsd.milestone?.let { parts.add(it) }

    val total = gsd.totalPhases ?: gsd.phases.size.takeIf { it > 0 }
    val current = gsd.currentPhase
    if (current != null && total != null) {
        parts.add("Phase $current/$total")
    } else if (current != null) {
        parts.add("Phase $current")
    } else if (total != null) {
        parts.add("$total phases")
    }

    parts.add(situationLabel(gsd.situation))
    parts.add("${percentText(gsd.percent)}%")
    return parts.joinToString(" · ")
}

/** Renders a whole-number percentage the way the TS template literal did
 *  (`50` for 50.0, `50.5` otherwise). */
private fun percentText(pct: Double): String {
    val rounded = pct.roundToLong()
    return if (pct == rounded.toDouble()) "$rounded" else pct.toString()
}

/** The action the strip offers as a tappable chip, or null. */
internal fun recommendedAction(gsd: UniffiGsdState): UniffiGsdAction? {
    if (gsd.actions.isEmpty()) return null
    return gsd.actions.firstOrNull { it.id == gsd.recommended }
        ?: gsd.actions.firstOrNull { it.recommended }
        ?: gsd.actions.first()
}

/**
 * The live line shown while a phase is executing, e.g.
 * `Phase 2 · plan 1/2 · task 2/3 · cover the build step`. Exists because the
 * ordinary readout is FROZEN during an execute (parallel-wave state writes
 * are batched after the merge). Null when there's nothing real to report.
 */
internal fun executionLine(gsd: UniffiGsdState): String? {
    val e = gsd.execution ?: return null

    val parts = mutableListOf("Phase ${e.phase}")
    if (e.plansTotal > 0uL) {
        parts.add("plan ${minOf(e.plansDone + 1uL, e.plansTotal)}/${e.plansTotal}")
    }
    if (e.tasksTotal != null && e.tasksTotal != 0L) {
        parts.add("task ${e.tasksDone}/${e.tasksTotal}")
    } else if (e.tasksDone > 0uL) {
        parts.add("task ${e.tasksDone}")
    }
    e.lastTask?.let { parts.add(it) }
    return parts.joinToString(" · ")
}

/** Recovery states are first-class in GSD; each gets a visible way out. */
internal fun recoveryChips(gsd: UniffiGsdState): List<RecoveryChip> {
    val chips = mutableListOf<RecoveryChip>()
    if (gsd.paused) chips.add(RecoveryChip("resume", "Resume", "/gsd-resume-work"))
    if (gsd.verifyFailed) {
        chips.add(RecoveryChip("reverify", "Re-verify", "/gsd-verify-work"))
    }
    if (gsd.blockers.isNotEmpty()) {
        chips.add(
            RecoveryChip(
                id = "debug",
                label = if (gsd.blockers.size > 1) "${gsd.blockers.size} blockers" else "Blocked",
                command = "/gsd-debug",
            ),
        )
    }
    return chips
}
