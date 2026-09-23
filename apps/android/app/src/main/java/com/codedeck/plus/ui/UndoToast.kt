package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent

/**
 * The bottom "Deleted X — Undo" toast after an optimistic session delete —
 * port of `apps/mobile/src/ui/UndoToast.tsx`. All state lives in the core's
 * ui view (`UniffiUiView.undoToast`, written by the runtime's delete
 * controller and cleared when the 4 s window commits or undo restores); this
 * composable only renders it and forwards the tap.
 *
 * Mounted once at the shell's root (`Shell.kt`) so it is visible regardless
 * of which screen is showing. When no toast is pending the composable emits
 * nothing — no empty overlay is laid out to intercept touches.
 */
@Composable
fun UndoToast(core: CoreHost, modifier: Modifier = Modifier) {
    val ui by core.ui.collectAsState()
    val toast = ui?.undoToast ?: return
    val scope = rememberCoroutineScope()

    Row(
        modifier
            .padding(bottom = Tokens.Space4)
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .border(1.dp, Tokens.Border, RoundedCornerShape(Tokens.RadiusMd))
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Text(
            "Deleted \"${toast.label}\"",
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Text(
            "Undo",
            color = Tokens.Accent,
            fontSize = Tokens.TextSm,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clickable {
                    scope.launch { core.dispatch(UniffiIntent.UndoDelete) }
                }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        )
    }
}
