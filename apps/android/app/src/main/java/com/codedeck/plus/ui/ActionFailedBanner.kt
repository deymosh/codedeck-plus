package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filterIsInstance
import uniffi.client_runtime.ActionFailedKind
import uniffi.client_runtime.CoreEvent

/** How long the banner stays up before dismissing itself — the same window
 *  the core gives the undo toast (`UndoToast.kt`'s 4 s), so the app's two
 *  transient overlays keep one tempo. */
private const val BANNER_VISIBLE_MS = 4_000L

/** Human copy for a failed action — the UI writes the words, the event only
 *  carries the semantic kind. */
fun actionFailedCopy(kind: ActionFailedKind): String = when (kind) {
    ActionFailedKind.PUBLISH_UNREACHABLE -> "Could not reach a relay — check the connection and try again."
    ActionFailedKind.PUBLISH_REJECTED -> "The relay rejected the request — try again."
    ActionFailedKind.DECRYPT_FAILED -> "Could not decrypt the bridge's reply — try again."
    ActionFailedKind.DECODE_FAILED -> "Could not read the bridge's reply — try again."
}

/**
 * Global transient banner for a failed core action — the screen-level
 * counterpart of `CoreBridge.actionFailed` (whose callback itself stays
 * empty: client-runtime also emits the failure as a `CoreEvent.ActionFailed`
 * on the `events` flow, and that flow is what this banner watches).
 *
 * Mounted once at the shell's root (`Shell.kt`, `Alignment.TopCenter`) so it
 * is visible on whichever screen is showing — top, because the bottom edge is
 * `UndoToast`'s slot, so the two can never collide without any
 * mutual-exclusion state. Renders nothing while no failure is showing, and
 * auto-dismisses [BANNER_VISIBLE_MS] after the newest one arrived (a newer
 * failure replaces the visible copy and restarts the window).
 */
@Composable
fun ActionFailedBanner(bridge: CoreBridge, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf<CoreEvent.ActionFailed?>(null) }
    // Bumped on every failure. The dismiss timer keys on this rather than on
    // `shown`: two identical failures in a row are `equals` data-class
    // instances, and keying on the event itself would not restart the window
    // for the second one.
    var generation by remember { mutableIntStateOf(0) }

    // `events` has no replay, so only failures that happen while this
    // banner is mounted ever show — a stale one never re-appears when the
    // shell re-attaches.
    LaunchedEffect(bridge) {
        bridge.events.filterIsInstance<CoreEvent.ActionFailed>().collect { failed ->
            shown = failed
            generation++
        }
    }
    LaunchedEffect(generation) {
        if (shown != null) {
            delay(BANNER_VISIBLE_MS)
            shown = null
        }
    }

    shown?.let { failed ->
        // Same visual language as NewSessionScreen.kt's createError banner:
        // danger text on a translucent danger wash. Deliberately a plain
        // composable rather than a Material3 Snackbar/SnackbarHost — the
        // shell's root is a bare `Box` with no Scaffold to host a
        // SnackbarHostState, and the transient-overlay pattern `UndoToast.kt`
        // already established needs no new plumbing.
        Text(
            actionFailedCopy(failed.kind),
            color = Tokens.Danger,
            fontSize = Tokens.TextSm,
            modifier = modifier
                .padding(horizontal = Tokens.Space4, vertical = Tokens.Space3)
                .fillMaxWidth()
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.Danger.copy(alpha = 0.12f))
                .padding(Tokens.Space2),
        )
    }
}
