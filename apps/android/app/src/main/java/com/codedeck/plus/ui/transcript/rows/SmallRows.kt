package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.TranscriptMarkdown

/** A message the user sent; a long press selects its text. */
@Composable
fun UserMessageRow(text: String, segment: Segment = Segment.Only) {
    // Your turns sit on the right, set off from the agent's full-width text.
    Row(Modifier.fillMaxWidth().padding(start = Tokens.Space7), horizontalArrangement = Arrangement.End) {
        val bubble = if (segment == Segment.Only) {
            Modifier
                .clip(RoundedCornerShape(topStart = Tokens.RadiusXl, topEnd = Tokens.RadiusXl, bottomStart = Tokens.RadiusXl, bottomEnd = Tokens.RadiusSm))
                .background(Tokens.SurfaceHover)
        } else {
            // A long message's blocks fill the full width, so they line up as one bubble.
            Modifier.fillMaxWidth().segmentFrame(segment, Tokens.RadiusXl, fill = Tokens.SurfaceHover)
        }
        Column(bubble.padding(segmentInsets(segment, Tokens.Space4, Tokens.Space3))) {
            TranscriptMarkdown(text)
        }
    }
}

/**
 * Where a block of a long message sits among its blocks (see
 * `markdownBlocks`): each is a list item of its own, and a framed message (a
 * plan, the user's bubble) draws its part of one frame.
 */
enum class Segment { Only, First, Middle, Last }

/** The gap the transcript list leaves between items, which a segment's frame bridges. */
private val ItemGap = Tokens.Space2

/**
 * A segment's part of a frame round a message cut into list items: the top
 * corners on the first, the bottom ones on the last, the sides on every one,
 * running through the gap to the next so the frame shows no break.
 */
private fun Modifier.segmentFrame(segment: Segment, radius: Dp, fill: Color? = null, stroke: Color? = null): Modifier = drawBehind {
    val r = radius.toPx()
    val gap = ItemGap.toPx()
    val hasTop = segment == Segment.Only || segment == Segment.First
    val hasBottom = segment == Segment.Only || segment == Segment.Last
    // A round rect running past the edges this segment does not close, cut
    // back to the segment plus the gap below it.
    val top = if (hasTop) 0f else -(r + 1f)
    val bottom = if (hasBottom) size.height else size.height + gap + r + 1f
    val clipBottom = if (hasBottom) size.height else size.height + gap
    clipRect(top = 0f, bottom = clipBottom) {
        val corner = CornerRadius(r, r)
        val at = Offset(0f, top)
        val area = Size(size.width, bottom - top)
        fill?.let { drawRoundRect(it, at, area, corner) }
        stroke?.let {
            val w = 1.dp.toPx()
            drawRoundRect(it, at + Offset(w / 2, w / 2), Size(area.width - w, area.height - w), corner, style = Stroke(w))
        }
    }
}

/** A framed segment's insets: none at the edges of a cut, where the list's gap stands in for a paragraph break. */
private fun segmentInsets(segment: Segment, horizontal: Dp, vertical: Dp): PaddingValues = PaddingValues(
    start = horizontal,
    end = horizontal,
    top = if (segment == Segment.Only || segment == Segment.First) vertical else 0.dp,
    bottom = if (segment == Segment.Only || segment == Segment.Last) vertical else 0.dp,
)

/** Agent text (markdown). `isPlan` frames it as a plan document, which stays
 *  readable after the plan is approved: outlined in the accent rather than
 *  filled, so it reads as a document and not as one more card. A long
 *  press selects its text. */
@Composable
fun AgentTextRow(text: String, isPlan: Boolean = false, segment: Segment = Segment.Only) {
    val planShape = RoundedCornerShape(Tokens.RadiusLg)
    val planFrame = Tokens.Accent.copy(alpha = 0.55f)
    Column(
        Modifier
            .fillMaxWidth()
            .let {
                when {
                    !isPlan -> it
                    segment == Segment.Only -> it.border(1.dp, planFrame, planShape)
                    else -> it.segmentFrame(segment, Tokens.RadiusLg, stroke = planFrame)
                }
            }
            .padding(segmentInsets(segment, if (isPlan) Tokens.Space4 else Tokens.Space1, if (isPlan) Tokens.Space4 else Tokens.Space1)),
    ) {
        if (isPlan && (segment == Segment.Only || segment == Segment.First)) {
            Text(
                "Plan",
                color = Tokens.Text,
                fontSize = Tokens.TextSm,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(bottom = Tokens.Space2),
            )
        }
        TranscriptMarkdown(text)
    }
}

/** A one-line status message from the bridge or agent. */
@Composable
fun StatusRow(text: String) {
    if (text.isBlank()) return
    Text(
        text,
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Space1),
    )
}

/** An agent or bridge error. */
@Composable
fun ErrorRow(text: String, label: String? = null) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Danger.copy(alpha = 0.12f), RoundedCornerShape(Tokens.RadiusLg))
            .padding(Tokens.Space2),
    ) {
        if (label != null) {
            Text(label, color = Tokens.Danger, fontSize = Tokens.TextXs)
        }
        Text(text, color = Tokens.Danger, fontSize = Tokens.TextSm)
    }
}

/**
 * A lifecycle notice. A session that died, failed or hit an auth error is
 * shown as a labelled error, so it is unmistakable; a restart (or any other
 * notice) is a centered divider line.
 */
@Composable
fun NoticeRow(notice: String, text: String) {
    val errorLabel = when (notice) {
        "session_died" -> "Session died"
        "session_failed" -> "Session failed"
        "auth_error" -> "Authentication error"
        else -> null
    }
    if (errorLabel != null) {
        ErrorRow(text, errorLabel)
        return
    }
    Text(
        text,
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Space2),
    )
}

/** Visible "fetching missed output…" while a sync cycle fills a range the
 *  phone knows it's missing. Port of `SyncGapRow.tsx`. */
@Composable
fun SyncGapRow(failed: Boolean) {
    Text(
        if (failed) "Some output could not be fetched yet — retrying…" else "Fetching missed output…",
        color = Tokens.TextMuted,
        fontSize = Tokens.TextXs,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(Tokens.Space2),
    )
}

/** A user send the transcript does not yet CONTAIN (CDX-063) — its outbox
 *  lifecycle state, Retry on failure. Port of `OutboxRow.tsx`. */
@Composable
fun OutboxRow(item: uniffi.client_ffi.UniffiOutboxItem, onRetry: (String) -> Unit) {
    val failed = item.state == "failed"
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (failed) Tokens.Danger.copy(alpha = 0.1f) else Tokens.SurfaceRaised,
                RoundedCornerShape(Tokens.RadiusLg),
            )
            .padding(Tokens.Space2),
    ) {
        Text(item.text, color = Tokens.Text, fontSize = Tokens.TextMd)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Text(
                when (item.state) {
                    "pending" -> "sending…"
                    "published" -> "sent — waiting for bridge"
                    "confirmed" -> "delivered"
                    "failed" -> "failed: ${item.error ?: "unknown"}"
                    else -> item.state
                },
                color = if (failed) Tokens.Danger else Tokens.TextMuted,
                fontSize = Tokens.TextXs,
            )
            if (failed) {
                Text(
                    "Retry",
                    color = Tokens.Text,
                    fontSize = Tokens.TextXs,
                    modifier = Modifier
                        .minimumInteractiveComponentSize()
                        .clip(RoundedCornerShape(Tokens.RadiusMd + 4.dp))
                        .background(Tokens.SurfaceHover)
                        .clickable { onRetry(item.id) }
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                )
            }
        }
    }
}
