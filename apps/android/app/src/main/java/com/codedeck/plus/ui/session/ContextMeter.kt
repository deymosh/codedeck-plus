package com.codedeck.plus.ui.session

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.DeckSheet
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.SheetHeader
import uniffi.client_ffi.UniffiContextBreakdown
import uniffi.client_ffi.UniffiContextGroup
import uniffi.client_ffi.UniffiUsageData
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/** How full the context is, as a colour: the text colour until 75 %, then
 *  warn, then danger from 90 % — the thresholds the usage limits use. */
internal fun contextColor(percentage: Double?): Color = when {
    (percentage ?: 0.0) >= 90.0 -> Tokens.Danger
    (percentage ?: 0.0) >= 75.0 -> Tokens.Warn
    else -> Tokens.Text
}

/**
 * The session's context meter, in the top bar's corner: a ring that fills
 * as the session's context does. Tapping it shows [ContextDetails]. An
 * empty ring when the agent has not said how full it is yet. [alert] puts a
 * dot of that colour on it — a usage limit running out — which the details
 * then explain.
 */
@Composable
internal fun ContextRing(percentage: Double?, alert: Color? = null, onClick: () -> Unit) {
    val fraction = (percentage?.takeIf { it.isFinite() } ?: 0.0).coerceIn(0.0, 100.0) / 100.0
    val color = contextColor(percentage)
    Box(
        Modifier
            .size(Tokens.TapMin)
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
                // Ringed in the top bar's colour, so it reads apart from the arc.
                val r = 3.5.dp.toPx()
                val at = Offset(size.width - r / 2, r / 2)
                drawCircle(Tokens.Surface, radius = r + 1.5.dp.toPx(), center = at)
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
@Composable
internal fun ContextSheet(
    percentage: Double?,
    window: Long?,
    usage: UniffiUsageData?,
    nowMs: Long,
    onDismiss: () -> Unit,
) {
    DeckSheet(onDismiss) {
        ContextDetails(percentage, window, usage, nowMs, onClose = onDismiss)
    }
}

/**
 * How full the session's context is (and in tokens, when the window is
 * known) — part by part when the agent says what fills it, with the lists
 * behind some parts — then what the session has cost, and the agent's
 * usage limits with when each resets. Apart from the sheet so a snapshot
 * can show it.
 */
@Composable
internal fun ContextDetails(percentage: Double?, window: Long?, usage: UniffiUsageData?, nowMs: Long, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding()) {
        SheetHeader("Context", null, Icons.Outlined.Close to onClose)
        ContextFigures(percentage, window, usage, nowMs)
    }
}

/** The shades of the context's parts, in order: white the only accent,
 *  colour kept for state. */
private val PART_SHADES = listOf(1f, 0.72f, 0.52f, 0.38f, 0.28f, 0.2f)

private fun partShade(index: Int): Color = Tokens.Text.copy(alpha = PART_SHADES[index.coerceAtMost(PART_SHADES.lastIndex)])

/** How many items a list shows before "Show more". */
private const val SHORT_ITEM_LIST = 12

/**
 * How full the context is (0–100, or null when unknown), and the breakdown
 * to show with it. The session's own [percentage] moves with every step of
 * a turn and leads; the [snapshot] of what fills the context is asked for
 * again each time it moves, so until the new one comes the old one is left
 * out rather than shown disagreeing with the figure above it.
 *
 * A context at or past its window is the one case where the two may differ
 * without the snapshot being stale: the figure stops at 100 %, and the parts
 * are what say how far past it the context went. Leaving them out there
 * would hide the parts exactly when they are worth reading and leave the
 * tokens below them to be worked out from the capped figure instead.
 */
internal fun contextFigures(percentage: Double?, snapshot: UniffiContextBreakdown?): Pair<Double?, UniffiContextBreakdown?> {
    val parts = snapshot?.takeIf { it.windowTokens > 0u }
    val partsPct = parts?.let { it.usedTokens.toDouble() / it.windowTokens.toDouble() * 100.0 }
    val live = percentage?.takeIf { it.isFinite() }
    val agrees = live == null ||
        (partsPct != null && (abs(partsPct - live) < 1.0 || (live >= 100.0 && partsPct >= 100.0)))
    return (live ?: partsPct)?.coerceIn(0.0, 100.0) to parts?.takeIf { agrees }
}

@Composable
private fun ContextFigures(percentage: Double?, window: Long?, usage: UniffiUsageData?, nowMs: Long) {
    val (shown, breakdown) = contextFigures(percentage, usage?.context)
    Column(
        Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space5, bottom = Tokens.Space5),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        if (shown == null) {
            Text("The agent has not said how full the context is yet.", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
        } else {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text("${shown.roundToInt()}%", color = contextColor(shown), fontSize = Tokens.TextTitle, fontWeight = FontWeight.SemiBold)
                Text("used", color = Tokens.TextMuted, fontSize = Tokens.TextMd, modifier = Modifier.padding(bottom = 4.dp))
            }
            if (breakdown != null) PartsMeter(breakdown) else Meter(shown, contextColor(shown))
            val used = breakdown?.usedTokens?.toLong() ?: window?.takeIf { it > 0 }?.let { (shown / 100.0 * it).roundToInt().toLong() }
            val of = breakdown?.windowTokens?.toLong() ?: window?.takeIf { it > 0 }
            if (used != null && of != null) {
                Text("${formatTokens(used)} of ${formatTokens(of)} tokens", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
            }
        }
        breakdown?.let { Parts(it) }
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

/** The window as one bar, each part in the window a segment of its own shade. */
@Composable
private fun PartsMeter(breakdown: UniffiContextBreakdown) {
    val window = breakdown.windowTokens.toFloat()
    Row(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceHover),
    ) {
        breakdown.categories.filter { it.kind == "used" }.forEachIndexed { i, part ->
            val share = part.tokens.toFloat() / window
            if (share > 0f) Box(Modifier.weight(share.coerceAtMost(1f)).height(6.dp).background(partShade(i)))
        }
        val rest = 1f - breakdown.categories.filter { it.kind == "used" }.sumOf { it.tokens.toLong() }.toFloat() / window
        if (rest > 0f) Box(Modifier.weight(rest))
    }
}

/** Each part: its shade, name, tokens and share of the window; then the
 *  lists behind some parts, each opening to its items. */
@Composable
private fun Parts(breakdown: UniffiContextBreakdown) {
    val window = breakdown.windowTokens.toDouble()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = Tokens.Space2)
            .clip(RoundedCornerShape(Tokens.RadiusLg))
            .background(Tokens.SurfaceHover)
            .padding(vertical = Tokens.Space2),
    ) {
        var usedIndex = 0
        breakdown.categories.forEach { part ->
            val shade = when (part.kind) {
                "used" -> partShade(usedIndex++)
                "free" -> Tokens.BorderStrong
                else -> Tokens.TextDim
            }
            val share = if (part.kind == "deferred") "—" else percentText(part.tokens.toDouble() / window * 100.0)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(PART_ROW_PADDING),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                Dot(shade)
                Text(part.name, color = Tokens.Text, fontSize = Tokens.TextMd, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                PartFigures(formatTokens(part.tokens.toLong()), share)
            }
        }
        breakdown.groups.forEach { group ->
            HorizontalDivider(Modifier.padding(vertical = Tokens.Space1), thickness = 1.dp, color = Tokens.Border)
            PartList(group, window)
        }
    }
}

/** How wide a part's share of the window is set, so the shares line up. */
private val SHARE_WIDTH = 48.dp

/** How wide the list chevron's column is; a part without a list keeps it
 *  empty, so every row's figures line up. */
private val CHEVRON_WIDTH = 16.dp

/** A row's figures at its end, in the columns every row of the parts
 *  shares: tokens, the share of the window, and the list chevron when the
 *  row opens to one ([open] says whether it is open). */
@Composable
private fun PartFigures(tokens: String, share: String?, open: Boolean? = null, fontSize: TextUnit = Tokens.TextMd) {
    Text(tokens, color = Tokens.TextMuted, fontSize = fontSize, textAlign = TextAlign.End)
    // The chevron close to the share, in the room the rows' smaller end
    // padding leaves, so the names keep theirs.
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(share.orEmpty(), color = Tokens.TextMuted, fontSize = fontSize, textAlign = TextAlign.End, modifier = Modifier.width(SHARE_WIDTH))
        Box(Modifier.width(CHEVRON_WIDTH), contentAlignment = Alignment.Center) {
            if (open != null) {
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = if (open) "Hide" else "Show",
                    tint = Tokens.TextMuted,
                    modifier = Modifier.size(CHEVRON_WIDTH).rotate(if (open) 90f else 0f),
                )
            }
        }
    }
}

/** The parts' rows' padding: a smaller end, where the chevron's column sits. */
private val PART_ROW_PADDING = PaddingValues(start = Tokens.Space4, end = Tokens.Space2)

/** A list behind a part — "MCP tools", 88 of them — with its tokens and
 *  share of the [window] in the parts' columns, opening to its items: the
 *  first few at once and the rest on "Show more". */
@Composable
private fun PartList(group: UniffiContextGroup, window: Double) {
    var open by rememberSaveable(group.name) { mutableStateOf(false) }
    var all by rememberSaveable(group.name) { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Tokens.TapMin)
            .clickable { open = !open }
            .padding(PART_ROW_PADDING),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Text(group.name, color = Tokens.Text, fontSize = Tokens.TextMd, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text(
                group.items.size.toString(),
                color = Tokens.TextMuted,
                fontSize = Tokens.TextXs,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                    .background(Tokens.BorderStrong)
                    .padding(horizontal = 7.dp, vertical = 1.dp),
            )
        }
        PartFigures(formatTokens(group.tokens.toLong()), percentText(group.tokens.toDouble() / window * 100.0), open = open)
    }
    if (!open) return
    val shown = if (all) group.items else group.items.take(SHORT_ITEM_LIST)
    shown.forEach { item ->
        Row(
            Modifier.fillMaxWidth().padding(PART_ROW_PADDING).padding(vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
        ) {
            Text(item.name, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
            PartFigures(formatTokens(item.tokens.toLong()), share = null, fontSize = Tokens.TextSm)
        }
    }
    val more = group.items.size - shown.size
    if (more > 0) {
        Text(
            "Show $more more",
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
            fontWeight = FontWeight.Medium,
            modifier = Modifier
                .padding(horizontal = Tokens.Space2)
                .clip(RoundedCornerShape(Tokens.RadiusMd))
                .clickable { all = true }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space2),
        )
    }
}

/** A share of the window: one decimal under 10 %, whole above. */
private fun percentText(pct: Double): String = when {
    !pct.isFinite() -> "—"
    pct < 10.0 -> String.format(Locale.ROOT, "%.1f%%", pct)
    else -> "${pct.roundToInt()}%"
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
