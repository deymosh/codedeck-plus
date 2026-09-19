package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.delay
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
    val events by bridge.events.collectAsState()
    // The event already sitting in the flow when this composable first
    // composed: a StateFlow replays its CURRENT value to a new collector, so
    // comparing by identity against this instance is what keeps a stale
    // failure from re-showing every time the shell re-attaches — the exact
    // idiom `NewSessionScreen.kt`'s create() uses around its own dispatch.
    val initial = remember { events }
    var lastSeen by remember { mutableStateOf(initial) }
    var shown by remember { mutableStateOf<CoreEvent.ActionFailed?>(null) }

    // Surface each NEW event of kind ActionFailed (identity-compared against
    // everything this composable has already seen).
    LaunchedEffect(events) {
        val current = events
        if (current !== lastSeen) {
            lastSeen = current
            if (current is CoreEvent.ActionFailed) shown = current
        }
    }
    // Auto-dismiss — re-keyed on `shown`, so a newer failure restarts it.
    LaunchedEffect(shown) {
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
