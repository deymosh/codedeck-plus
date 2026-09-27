package com.codedeck.plus.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The app's own icons, drawn for what this app is about — a machine the
 * phone drives — where the stock set only has generic shapes. Outlined, on
 * the 24-unit grid with a 1.8 stroke, so they sit with the Material outlined
 * icons used elsewhere. Single colour: `Icon` tints them.
 */
object DeckIcons {
    /** A machine: a monitor on its stand. */
    val Machine: ImageVector by lazy {
        icon("Machine") {
            // Screen.
            moveTo(4.5f, 4f)
            horizontalLineTo(19.5f)
            arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, 1.5f)
            verticalLineTo(14f)
            arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, 1.5f)
            horizontalLineTo(4.5f)
            arcToRelative(1.5f, 1.5f, 0f, false, true, -1.5f, -1.5f)
            verticalLineTo(5.5f)
            arcToRelative(1.5f, 1.5f, 0f, false, true, 1.5f, -1.5f)
            close()
            // Stand and base.
            moveTo(12f, 15.5f)
            verticalLineTo(19.5f)
            moveTo(8f, 19.5f)
            horizontalLineTo(16f)
        }
    }

    /**
     * Pair a machine: the monitor with a plus at its lower right corner —
     * the screen's corner is left open around the plus so the two read as
     * one mark at small sizes.
     */
    val PairMachine: ImageVector by lazy {
        icon("PairMachine") {
            // Screen, open at the lower right corner.
            moveTo(19f, 10f)
            verticalLineTo(5.5f)
            arcToRelative(1.5f, 1.5f, 0f, false, false, -1.5f, -1.5f)
            horizontalLineTo(4.5f)
            arcToRelative(1.5f, 1.5f, 0f, false, false, -1.5f, 1.5f)
            verticalLineTo(14f)
            arcToRelative(1.5f, 1.5f, 0f, false, false, 1.5f, 1.5f)
            horizontalLineTo(13f)
            // Stand and base.
            moveTo(8f, 15.5f)
            verticalLineTo(19.5f)
            moveTo(5f, 19.5f)
            horizontalLineTo(11f)
            // The plus.
            moveTo(18.5f, 12.5f)
            verticalLineTo(20.5f)
            moveTo(14.5f, 16.5f)
            horizontalLineTo(22.5f)
        }
    }

    private fun icon(name: String, pathData: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).path(
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            pathBuilder = pathData,
        ).build()
}
