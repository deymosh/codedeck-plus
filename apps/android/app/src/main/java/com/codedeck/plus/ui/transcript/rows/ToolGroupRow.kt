package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.SeqEntry
import com.codedeck.plus.ui.transcript.metaBool

private const val PREVIEW_LIMIT = 600

private fun preview(text: String): String =
    if (text.length > PREVIEW_LIMIT) text.take(PREVIEW_LIMIT) + "…" else text

/** A `redacted_thinking` block carries no readable text — without this it
 *  renders as a blank row inside the body. */
private fun isRedactedThinking(e: SeqEntry): Boolean =
    e.entry.entryType == "thinking" && e.entry.metadata.metaBool("redacted") == true

/**
 * Collapsed turn activity — "N actions" summary, expandable to the raw
 * `tool_use` commands, `tool_result` previews, the model's thinking, and any
 * collapsed assistant text. Port of `ToolGroupRow.tsx`; CDX-085: thinking
 * renders here (not a row of its own) in transcript order, so reasoning
 * appears where it actually happened.
 */
@Composable
fun ToolGroupRow(entries: List<SeqEntry>, summary: String, expanded: Boolean, onToggle: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(Tokens.Space3),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            Text(
                "▸",
                color = Tokens.TextMuted,
                modifier = Modifier.graphicsLayer { rotationZ = if (expanded) 90f else 0f },
            )
            Text(summary, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
        if (expanded) {
            Column(
                Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space3, bottom = Tokens.Space3),
            ) {
                entries.forEach { e ->
                    val prefix = if (e.entry.entryType == "tool_result") "↳ " else ""
                    Text(
                        prefix + if (isRedactedThinking(e)) "Thinking (redacted)" else preview(e.entry.content),
                        color = Tokens.TextDim,
                        fontFamily = Tokens.FontMono,
                        fontSize = Tokens.TextXs,
                        modifier = Modifier.padding(vertical = Tokens.Space1 / 2),
                    )
                }
            }
        }
    }
}
