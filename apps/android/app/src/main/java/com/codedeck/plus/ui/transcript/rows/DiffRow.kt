package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DiffLine
import com.codedeck.plus.ui.transcript.OutputEntry

const val DIFF_COLLAPSE_AT = 40

private fun lineColor(type: String): Color = when (type) {
    "add" -> Tokens.Success
    "del" -> Tokens.Danger
    else -> Tokens.TextMuted
}

private fun linePrefix(type: String): String = when (type) {
    "add" -> "+"
    "del" -> "-"
    else -> " "
}

/**
 * Diff card (CDX-050) — filename header + monospace colored lines. Port of
 * `DiffRow.tsx`. Long diffs collapse beyond [DIFF_COLLAPSE_AT] lines behind
 * an "N more lines" expander. Unlike the TS original, there's no
 * reconstruct-from-`+`/`-`-prefixed-`content` fallback for a missing
 * structured payload — `entry.diff` is expected to always be present for a
 * `diff`-kind entry (the bridge always sends it structured); an absent one
 * here just shows the raw content, a disclosed simplification.
 */
@Composable
fun DiffRow(entry: OutputEntry, expanded: Boolean, onToggle: () -> Unit) {
    val diff = entry.diff
    if (diff == null) {
        Text(entry.content, color = Tokens.TextMuted, fontFamily = Tokens.FontMono, fontSize = Tokens.TextSm)
        return
    }
    val overflow = diff.lines.size - DIFF_COLLAPSE_AT
    val visible = if (expanded || overflow <= 0) diff.lines else diff.lines.take(DIFF_COLLAPSE_AT)

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceInput)
            .padding(Tokens.Space2),
    ) {
        if (diff.path.isNotEmpty()) {
            Row {
                Text(diff.path, color = Tokens.TextMuted, fontFamily = Tokens.FontMono, fontSize = Tokens.TextXs)
                if (diff.truncated == true) {
                    Text(" (truncated)", color = Tokens.TextDim, fontFamily = Tokens.FontMono, fontSize = Tokens.TextXs)
                }
            }
        }
        visible.forEach { line: DiffLine ->
            Text(
                linePrefix(line.type) + line.text,
                color = lineColor(line.type),
                fontFamily = Tokens.FontMono,
                fontSize = Tokens.TextXs,
            )
        }
        if (overflow > 0) {
            Text(
                if (expanded) "Show less" else "$overflow more line${if (overflow != 1) "s" else ""}",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextXs,
                modifier = Modifier.clickable(onClick = onToggle).padding(top = Tokens.Space1),
            )
        }
    }
}
