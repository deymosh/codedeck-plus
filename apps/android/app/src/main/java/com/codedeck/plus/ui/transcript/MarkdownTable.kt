package com.codedeck.plus.ui.transcript

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.mikepenz.markdown.compose.elements.MarkdownTableBasicText
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes.HEADER
import org.intellij.markdown.flavours.gfm.GFMElementTypes.ROW
import org.intellij.markdown.flavours.gfm.GFMTokenTypes.CELL

/** A column never grows past this: a longer cell wraps onto more lines
 *  rather than pushing its neighbours off screen. */
private val MAX_COLUMN_WIDTH = 280.dp
private val CELL_PADDING_H = 8.dp
private val CELL_PADDING_V = 6.dp

/**
 * A GFM table whose columns are sized by their content, for agent output where
 * no cell may be cut off. Replaces the renderer's default `MarkdownTable`,
 * which gives every column the same nominal width and renders each cell on
 * one ellipsized line.
 *
 * Each column is as wide as its widest cell (up to [MAX_COLUMN_WIDTH], past
 * which the cell wraps); every cell shows its full text. A table narrower
 * than the transcript row is stretched to fill it, spreading the spare room
 * across the columns in proportion to their width; a wider one scrolls
 * horizontally. Row heights follow their tallest cell. Cell text goes
 * through the renderer's own `MarkdownTableBasicText`, so inline markdown in
 * a cell (code, emphasis, links) renders exactly as elsewhere.
 */
@Composable
fun TranscriptMarkdownTable(content: String, node: ASTNode, style: TextStyle) {
    val rows = remember(node) {
        node.children
            .filter { it.type == HEADER || it.type == ROW }
            .map { row -> row.children.filter { it.type == CELL } }
    }
    val columns = rows.firstOrNull()?.size ?: 0
    if (columns == 0) return

    BoxWithConstraints(
        Modifier
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.Surface),
    ) {
        val minTableWidth = if (constraints.hasBoundedWidth) maxWidth else 0.dp
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            TableGrid(rows, columns, minTableWidth) { rowIndex, cell ->
                val header = rowIndex == 0
                val last = rowIndex == rows.lastIndex
                Box(
                    Modifier
                        .drawBehind {
                            if (!last) {
                                val y = size.height - 0.5.dp.toPx()
                                drawLine(
                                    color = if (header) Tokens.BorderStrong else Tokens.Border,
                                    start = Offset(0f, y),
                                    end = Offset(size.width, y),
                                    strokeWidth = 1.dp.toPx(),
                                )
                            }
                        }
                        .padding(horizontal = CELL_PADDING_H, vertical = CELL_PADDING_V),
                ) {
                    if (cell != null) {
                        MarkdownTableBasicText(
                            content = content,
                            cell = cell,
                            style = if (header) style.copy(fontWeight = FontWeight.Bold) else style,
                            maxLines = Int.MAX_VALUE,
                            overflow = TextOverflow.Clip,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Lays [rows] × [columns] cells out as a grid: column width from the cells'
 * max intrinsic width (capped), row height from the tallest cell measured at
 * that width. A row shorter than the header gets empty cells (GFM allows it)
 * so every row still draws its full-width divider; extra cells are dropped,
 * as GFM does.
 */
@Composable
private fun TableGrid(
    rows: List<List<ASTNode>>,
    columns: Int,
    minTableWidth: Dp,
    cell: @Composable (rowIndex: Int, cell: ASTNode?) -> Unit,
) {
    Layout(
        content = {
            rows.forEachIndexed { r, cells ->
                for (c in 0 until columns) cell(r, cells.getOrNull(c))
            }
        },
    ) { measurables, _ ->
        val cap = MAX_COLUMN_WIDTH.roundToPx()
        val at = { r: Int, c: Int -> measurables[r * columns + c] }

        val widths = IntArray(columns) { c ->
            rows.indices.maxOf { r -> at(r, c).maxIntrinsicWidth(Constraints.Infinity) }.coerceAtMost(cap)
        }
        val natural = widths.sum()
        val target = minTableWidth.roundToPx()
        if (natural in 1 until target) {
            val extra = target - natural
            var spare = extra
            for (c in 0 until columns) {
                // The last column takes the rounding remainder.
                val share = if (c == columns - 1) spare else extra * widths[c] / natural
                widths[c] += share
                spare -= share
            }
        }

        val heights = IntArray(rows.size) { r ->
            (0 until columns).maxOf { c -> at(r, c).minIntrinsicHeight(widths[c]) }
        }
        val placeables = rows.indices.map { r ->
            (0 until columns).map { c -> at(r, c).measure(Constraints.fixed(widths[c], heights[r])) }
        }

        layout(widths.sum(), heights.sum()) {
            var y = 0
            placeables.forEachIndexed { r, row ->
                var x = 0
                row.forEachIndexed { c, placeable ->
                    placeable.place(x, y)
                    x += widths[c]
                }
                y += heights[r]
            }
        }
    }
}
