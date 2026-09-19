package com.codedeck.plus.ui.transcript

import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.launch

/**
 * `PinState`/`PinEvent`/`pinReducer` — direct port of
 * `apps/mobile/src/ui/transcript/pinReducer.ts`, the ONE pure state machine
 * behind transcript auto-scroll (bug C's cure: the old app had four
 * competing auto-scroll drivers, only some of which checked a
 * "user is interacting" guard). Scrolling is owned by exactly one effect
 * (`rememberTranscriptPin` below) gated on `pinned`, computed here from an
 * explicit event vocabulary — identical to the TS reducer, including its
 * five tested invariants:
 *
 * 1. Any unflagged scroll that ends away from the bottom → unpinned.
 * 2. Reaching the bottom (however) → pinned, missed count cleared.
 * 3. A session switch resets pinned but NOT at-bottom, so the owner effect's
 *    initial scroll actually fires (CDX-024).
 * 4. `new-entries` never changes `pinned` and never scrolls while unpinned —
 *    only the missed-entries badge moves.
 * 5. Flagged (programmatic) scrolls never unpin.
 */
data class PinState(
    /** The single gate: the owner effect scrolls to bottom iff this is true. */
    val pinned: Boolean,
    /** Geometry: is the viewport currently at the bottom. */
    val atBottom: Boolean,
    /** Nesting depth of flagged programmatic scrolls currently in flight. */
    val programmaticDepth: Int,
    /** Entries that arrived while unpinned — the jump-to-bottom pill badge. */
    val missedEntries: Int,
)

sealed class PinEvent {
    data class UserScroll(val atBottom: Boolean) : PinEvent()
    data object ProgrammaticScrollStart : PinEvent()
    data object ProgrammaticScrollEnd : PinEvent()
    data object ReachedBottom : PinEvent()
    data object LeftBottom : PinEvent()
    data class NewEntries(val count: Int) : PinEvent()
    data object SessionSwitch : PinEvent()
}

val initialPinState = PinState(pinned = true, atBottom = true, programmaticDepth = 0, missedEntries = 0)

fun pinReducer(state: PinState, event: PinEvent): PinState = when (event) {
    is PinEvent.UserScroll -> {
        if (state.programmaticDepth > 0) {
            // Flagged window: this scroll is the pin owner's own
            // scrollToBottom (or its momentum) — must never unpin. Geometry
            // only.
            if (event.atBottom) {
                state.copy(atBottom = true, missedEntries = if (state.pinned) 0 else state.missedEntries)
            } else {
                state.copy(atBottom = false)
            }
        } else if (event.atBottom) {
            // The user landed on the bottom — re-pin (invariant 2).
            state.copy(atBottom = true, pinned = true, missedEntries = 0)
        } else {
            // Unflagged scroll away from the bottom — unpin (invariant 1).
            state.copy(atBottom = false, pinned = false)
        }
    }

    PinEvent.ProgrammaticScrollStart -> state.copy(programmaticDepth = state.programmaticDepth + 1)

    PinEvent.ProgrammaticScrollEnd -> state.copy(programmaticDepth = maxOf(0, state.programmaticDepth - 1))

    PinEvent.ReachedBottom ->
        // However the viewport got here — at the bottom means pinned.
        state.copy(atBottom = true, pinned = true, missedEntries = 0)

    PinEvent.LeftBottom ->
        // Geometry only: content growth pushed the viewport off the bottom
        // with no user intent. Never unpins by itself (invariant 1 vs 5).
        state.copy(atBottom = false)

    is PinEvent.NewEntries ->
        if (state.pinned) state else state.copy(missedEntries = state.missedEntries + maxOf(0, event.count))

    PinEvent.SessionSwitch ->
        // Pinned but NOT atBottom: the owner effect scrolls iff
        // `pinned && !atBottom` — asserting atBottom here would leave a
        // long session mid-history with no jump pill (CDX-024).
        initialPinState.copy(atBottom = false)
}

data class TranscriptPin(
    val pinned: Boolean,
    val missedEntries: Int,
    val jumpToBottom: () -> Unit,
)

/**
 * The ONE owner of transcript auto-scroll — Compose adaptation of
 * `useTranscriptPin.ts`. `LazyListState` replaces `VListHandle`:
 * `canScrollForward` (`false` at the true end) stands in for virtua's
 * `BOTTOM_THRESHOLD_PX` distance math, `interactionSource` gives an
 * unambiguous user-drag signal `onScroll`'s heuristic had to approximate,
 * and `animateScrollToItem` being a `suspend fun` that returns exactly when
 * the scroll finishes replaces the TS hook's `onScrollEnd`-or-timeout
 * fallback (Compose's own API shape removes that race outright).
 *
 * Callers key their composable on the session (`key(sessionKey) { … }`,
 * `apps/mobile`'s own CDX-086 fix — a switch is a remount, not a prop
 * change) so this hook's `remember` blocks reset fresh per session; the
 * ported `SessionSwitch` event exists in the reducer for fidelity but this
 * hook relies on the remount, same as the TS hook now does.
 */
@Composable
fun rememberTranscriptPin(listState: LazyListState, itemCount: Int): TranscriptPin {
    var state by remember { mutableStateOf(initialPinState.copy(atBottom = false)) }
    var prevCount by remember { mutableIntStateOf(itemCount) }
    val scope = rememberCoroutineScope()

    fun dispatch(event: PinEvent) {
        state = pinReducer(state, event)
    }

    suspend fun scrollToBottom() {
        if (itemCount == 0) return
        dispatch(PinEvent.ProgrammaticScrollStart)
        try {
            listState.animateScrollToItem(itemCount - 1)
        } finally {
            dispatch(PinEvent.ProgrammaticScrollEnd)
        }
    }

    // New entries: geometry may have left the bottom; tell the reducer. An
    // EVENT, not a scroll — the owner effect below decides whether to move.
    LaunchedEffect(itemCount) {
        val delta = itemCount - prevCount
        prevCount = itemCount
        if (delta > 0) {
            if (listState.canScrollForward) dispatch(PinEvent.LeftBottom)
            dispatch(PinEvent.NewEntries(delta))
        }
    }

    // A user drag starting while unflagged is what unpins (invariants 1/5).
    // This hook never has more than one programmatic scroll in flight (the
    // owner effect below is the only caller), so `programmaticDepth == 0` at
    // drag-start is a sufficient guard — no nested-window bookkeeping needed
    // the way the TS hook's own flag-timeout fallback did.
    val isDragged by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(isDragged) {
        if (isDragged && state.programmaticDepth == 0) {
            dispatch(PinEvent.UserScroll(atBottom = false))
        }
    }

    // Once any scroll (drag fling or programmatic) settles, reconcile
    // geometry — reaching the bottom re-pins regardless of how it got there
    // (invariant 2).
    LaunchedEffect(Unit) {
        snapshotFlow { listState.isScrollInProgress }.collect { inProgress ->
            if (!inProgress && !listState.canScrollForward) dispatch(PinEvent.ReachedBottom)
        }
    }

    // ★ THE single pin-owner effect — the only scroll driver. ★
    LaunchedEffect(state.pinned, state.atBottom, itemCount) {
        if (state.pinned && itemCount > 0 && !state.atBottom) scrollToBottom()
    }

    return TranscriptPin(
        pinned = state.pinned,
        missedEntries = state.missedEntries,
        jumpToBottom = {
            scope.launch {
                dispatch(PinEvent.ReachedBottom) // explicit intent: pin now
                scrollToBottom()
            }
        },
    )
}
