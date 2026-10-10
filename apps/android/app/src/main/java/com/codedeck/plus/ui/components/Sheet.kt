package com.codedeck.plus.ui.components

import androidx.compose.foundation.LocalOverscrollFactory
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.statusBars
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens

/** What a sheet leaves free above it, below the status bar: its drag
 *  handle's row, and a strip of the screen behind it. */
private val SHEET_TOP_ROOM = 72.dp

/**
 * A bottom sheet as every sheet in the app opens. Its content is never
 * taller than the screen below the status bar, so the sheet always stops
 * under it, and nothing in it stretches past an end: a drag beyond the top
 * does not pull the sheet up under the status bar. [skipPartiallyExpanded]
 * opens it whole at once, for a sheet the user came to act in; a long
 * read can start at half the screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeckSheet(
    onDismiss: () -> Unit,
    skipPartiallyExpanded: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = skipPartiallyExpanded),
        containerColor = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
    ) {
        val density = LocalDensity.current
        val window = LocalWindowInfo.current.containerSize.height
        val statusBar = WindowInsets.statusBars.getTop(density)
        val max = with(density) { (window - statusBar).toDp() } - SHEET_TOP_ROOM
        CompositionLocalProvider(LocalOverscrollFactory provides null) {
            Column(Modifier.heightIn(max = max.coerceAtLeast(0.dp)), content = content)
        }
    }
}
