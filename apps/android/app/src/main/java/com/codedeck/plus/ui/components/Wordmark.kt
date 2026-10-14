package com.codedeck.plus.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.codedeck.plus.ui.theme.Tokens

/**
 * Which quarters of a terminal cell each block element fills, as top-left,
 * top-right, bottom-left, bottom-right. A wordmark is drawn from these rather
 * than set as text: a phone's fonts draw block elements at widths of their
 * own, which pulls a logo's columns apart.
 */
private val QUADRANTS: Map<Char, Int> = mapOf(
    '█' to 0b1111, '▀' to 0b1100, '▄' to 0b0011, '▌' to 0b1010, '▐' to 0b0101,
    '▛' to 0b1110, '▜' to 0b1101, '▙' to 0b1011, '▟' to 0b0111,
    '▘' to 0b1000, '▝' to 0b0100, '▖' to 0b0010, '▗' to 0b0001,
)

/** Widest a wordmark cell gets, however much room there is. */
private val MaxCell = 10.dp

/**
 * An agent's block-art wordmark ([AgentLook.wordmark]): each character one
 * cell twice as tall as it is wide, the first [split] cells of every line in
 * the muted text colour and the rest in [color]. It scales down to fit the
 * width it is given. Characters that are not block elements are left blank.
 */
@Composable
fun Wordmark(lines: List<String>, split: Int, color: Color, label: String, modifier: Modifier = Modifier) {
    val columns = lines.maxOfOrNull { it.length } ?: return
    if (columns == 0) return
    BoxWithConstraints(modifier) {
        val cell: Dp = min(MaxCell, maxWidth / columns)
        Canvas(
            Modifier
                .size(cell * columns, cell * 2 * lines.size)
                .semantics { contentDescription = label },
        ) {
            val w = size.width / columns
            val h = size.height / lines.size
            val quarter = Size(w / 2, h / 2)
            lines.forEachIndexed { row, line ->
                line.forEachIndexed { col, ch ->
                    val bits = QUADRANTS[ch] ?: return@forEachIndexed
                    val fill = if (col < split) Tokens.TextMuted else color
                    for (q in 0 until 4) {
                        if (bits and (0b1000 shr q) == 0) continue
                        val x = col * w + (q % 2) * quarter.width
                        val y = row * h + (q / 2) * quarter.height
                        // A hair wider and taller, so neighbouring quarters meet without a seam.
                        drawRect(fill, Offset(x, y), Size(quarter.width + 0.5f, quarter.height + 0.5f))
                    }
                }
            }
        }
    }
}
