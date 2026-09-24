package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DiffLine

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
 * Diff card (CDX-050) — file path header + monospace colored lines. Long
 * diffs collapse beyond [DIFF_COLLAPSE_AT] lines behind an "N more lines"
 * expander.
 */
@Composable
fun DiffRow(path: String, lines: List<DiffLine>, truncated: Boolean, expanded: Boolean, onToggle: () -> Unit) {
    val overflow = lines.size - DIFF_COLLAPSE_AT
    val visible = if (expanded || overflow <= 0) lines else lines.take(DIFF_COLLAPSE_AT)

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceInput)
            .padding(Tokens.Space2),
    ) {
        if (path.isNotEmpty()) {
            // The whole path, wrapped onto as many lines as it needs: which
            // file changed is the card's headline, and an ellipsis cut the
            // one part that tells files apart. The truncation note flows
            // right after it in the same text.
            Text(
                buildAnnotatedString {
                    append(path)
                    if (truncated) {
                        withStyle(SpanStyle(color = Tokens.TextDim)) { append(" (truncated)") }
                    }
                },
                color = Tokens.TextMuted,
                fontFamily = Tokens.FontMono,
                fontSize = Tokens.TextXs,
            )
            HorizontalDivider(Modifier.padding(vertical = Tokens.Space1), color = Tokens.Border)
        }
        // Lines never wrap — a wrapped code line breaks the +/- column and the
        // indentation — so the block scrolls sideways instead, as one unit.
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            visible.forEach { line: DiffLine ->
                Text(
                    linePrefix(line.type) + line.text,
                    color = lineColor(line.type),
                    fontFamily = Tokens.FontMono,
                    fontSize = Tokens.TextXs,
                    softWrap = false,
                )
            }
        }
        if (overflow > 0) {
            HorizontalDivider(Modifier.padding(top = Tokens.Space1), color = Tokens.Border)
            // The whole full-width strip is the tap target, label centered.
            Text(
                if (expanded) "Show less" else "$overflow more line${if (overflow != 1) "s" else ""}",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextXs,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggle)
                    .minimumInteractiveComponentSize()
                    .wrapContentHeight(Alignment.CenterVertically),
            )
        }
    }
}
