package com.codedeck.plus.ui.session

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.SheetHeader
import uniffi.client_ffi.UniffiUsageData
import kotlin.math.roundToInt

/** How full the context is, as a colour: the text colour until 75 %, then
 *  warn, then danger from 90 % — the thresholds the usage limits use. */
internal fun contextColor(percentage: Double?): Color = when {
    (percentage ?: 0.0) >= 90.0 -> Tokens.Danger
    (percentage ?: 0.0) >= 75.0 -> Tokens.Warn
    else -> Tokens.Text
}

/**
 * The composer's context meter: a ring that fills as the session's context
 * does. Tapping it shows [ContextDetails]. An empty ring when the agent has
 * not said how full it is yet. [alert] puts a dot of that colour on it — a
 * usage limit running out — which the details then explain.
 */
@Composable
internal fun ContextRing(percentage: Double?, alert: Color? = null, onClick: () -> Unit) {
    val fraction = (percentage?.takeIf { it.isFinite() } ?: 0.0).coerceIn(0.0, 100.0) / 100.0
    val color = contextColor(percentage)
    Box(
        Modifier
            .size(40.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = (percentage?.let { "Context ${it.roundToInt()}% used" } ?: "Context") +
                    (if (alert != null) ", a usage limit is nearly reached" else "")
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(20.dp)) {
            val stroke = 2.5.dp.toPx()
            drawCircle(Tokens.BorderStrong, style = Stroke(stroke))
            if (fraction > 0) {
                drawArc(
                    color,
                    startAngle = -90f,
                    sweepAngle = (360 * fraction).toFloat(),
                    useCenter = false,
                    style = Stroke(stroke, cap = StrokeCap.Round),
                )
            }
            if (alert != null) {
                // Ringed in the composer's colour, so it reads apart from the arc.
                val r = 3.5.dp.toPx()
                val at = androidx.compose.ui.geometry.Offset(size.width - r / 2, r / 2)
                drawCircle(Tokens.SurfaceRaised, radius = r + 1.5.dp.toPx(), center = at)
                drawCircle(alert, radius = r, center = at)
            }
        }
    }
}

/** The ring's alert for the agent's usage limits: danger once one passes
 *  90 %, warn once one passes 75 %, else none. */
internal fun usageAlert(limits: List<UsageWindowData>): Color? {
    val worst = limits.maxOfOrNull { it.percent } ?: return null
    return when {
        worst >= 90 -> Tokens.Danger
        worst >= 75 -> Tokens.Warn
        else -> null
    }
}

/** [ContextDetails] in a bottom sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ContextSheet(
    percentage: Double?,
    window: Long?,
    usage: UniffiUsageData?,
    nowMs: Long,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
    ) {
        ContextDetails(percentage, window, usage, nowMs, onClose = onDismiss)
    }
}

/**
 * How full the session's context is (and in tokens, when the window is
 * known), what the session has cost, and the agent's usage limits with
 * when each resets. Apart from the sheet so a snapshot can show it.
 */
@Composable
internal fun ContextDetails(percentage: Double?, window: Long?, usage: UniffiUsageData?, nowMs: Long, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
        SheetHeader("Context", null, Icons.Outlined.Close to onClose)
        ContextFigures(percentage, window, usage, nowMs)
    }
}

@Composable
private fun ContextFigures(percentage: Double?, window: Long?, usage: UniffiUsageData?, nowMs: Long) {
    Column(
        Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space5, bottom = Tokens.Space5),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        val pct = percentage?.takeIf { it.isFinite() }?.coerceIn(0.0, 100.0)
        if (pct == null) {
            Text("The agent has not said how full the context is yet.", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
        } else {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text("${pct.roundToInt()}%", color = contextColor(pct), fontSize = Tokens.TextTitle, fontWeight = FontWeight.SemiBold)
                Text("used", color = Tokens.TextMuted, fontSize = Tokens.TextMd, modifier = Modifier.padding(bottom = 4.dp))
            }
            Meter(pct, contextColor(pct))
            if (window != null && window > 0) {
                val used = (pct / 100.0 * window).roundToInt().toLong()
                Text("${formatTokens(used)} of ${formatTokens(window)} tokens", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
            }
        }
        usage?.sessionCostUsd?.let(::sessionCost)?.let { cost ->
            DetailRow("This session", cost)
        }
        usageWindows(usage, nowMs).forEach { w ->
            DetailRow(
                "${w.label} limit",
                "${w.percent}%" + (w.resetCountdown?.let { " · $it" } ?: ""),
                color = when {
                    w.percent >= 90 -> Tokens.Danger
                    w.percent >= 75 -> Tokens.Warn
                    else -> Tokens.Text
                },
            )
        }
    }
}

@Composable
private fun Meter(percentage: Double, color: Color) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceHover),
    ) {
        Box(
            Modifier
                .fillMaxWidth((percentage / 100.0).toFloat())
                .height(6.dp)
                .clip(RoundedCornerShape(Tokens.RadiusPill))
                .background(color),
        )
    }
}

@Composable
private fun DetailRow(label: String, value: String, color: Color = Tokens.Text) {
    Row(Modifier.fillMaxWidth().padding(top = Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Tokens.TextMuted, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
        Text(value, color = color, fontSize = Tokens.TextMd, fontWeight = FontWeight.Medium)
    }
}
