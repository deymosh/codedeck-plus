package com.codedeck.plus.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseIn
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/** Swipe-carousel tuning, ported from `apps/mobile/src/ui/useSwipeToNavigate.ts`. */
private val SWIPE_THRESHOLD = 60.dp
private const val SWIPE_DAMPEN = 0.4f
private const val SWIPE_DEBOUNCE_MS = 400
private const val SLIDE_DURATION_MS = 200

/**
 * The right pane of the shell — port of `apps/mobile/src/ui/MainPanel.tsx`'s
 * core switch, narrowed: no dm/marmot panel modes (F4). `sessionContent` is a
 * slot rather than a direct `SessionScreen` call so this file doesn't need
 * editing once F3.3.6 wires the real screen in — see that milestone's change
 * to `Shell.kt`, the only caller.
 *
 * The session surface is wrapped in a horizontal swipe carousel ([SwipeCarousel],
 * port of `useSwipeToNavigate` in session mode): swipe left shows the next
 * session, right the previous, over the sidebar's exact display order
 * ([orderedSessionKeys] — the same [getOrderedSessionKeys] list the sidebar
 * renders, so the two can never diverge), clamping at the edges. Navigation
 * dispatches the standard `SelectSession` path via [onSwipeNavigate].
 */
@Composable
fun MainPanel(
    selectedMachine: String?,
    selectedSession: String?,
    orderedSessionKeys: List<SessionKey>,
    isWide: Boolean,
    onOpenSidebar: () -> Unit,
    onSwipeNavigate: (machine: String, sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    sessionContent: @Composable (machine: String, sessionId: String) -> Unit,
) {
    Column(modifier.fillMaxSize().background(Tokens.Bg)) {
        if (!isWide) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space2),
                horizontalArrangement = Arrangement.Start,
            ) {
                Text(
                    "☰",
                    color = Tokens.Text,
                    fontSize = Tokens.TextLg,
                    modifier = Modifier.clickable(onClick = onOpenSidebar).padding(Tokens.Space2),
                )
            }
        }
        if (selectedMachine != null && selectedSession != null) {
            val currentIndex = orderedSessionKeys.indexOfFirst {
                it.machine == selectedMachine && it.sessionId == selectedSession
            }
            SwipeCarousel(
                currentIndex = currentIndex,
                itemCount = orderedSessionKeys.size,
                onNavigate = { index ->
                    orderedSessionKeys.getOrNull(index)?.let { target ->
                        onSwipeNavigate(target.machine, target.sessionId)
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                sessionContent(selectedMachine, selectedSession)
            }
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Select a session", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
                    if (!isWide) {
                        Button(
                            onClick = onOpenSidebar,
                            modifier = Modifier.padding(top = Tokens.Space3),
                        ) {
                            Text("☰ Sessions")
                        }
                    }
                }
            }
        }
    }
}

/**
 * Horizontal swipe carousel between the items of an ordered list — Compose
 * port of `apps/mobile/src/ui/useSwipeToNavigate.ts` in its session
 * configuration (clamp at the edges, wrap: false). A swipe left of
 * [SWIPE_THRESHOLD] navigates to `currentIndex + 1`, right to `currentIndex
 * - 1`; drags translate the content damped to [SWIPE_DAMPEN] and are
 * suppressed entirely at a clamped edge, like the reference.
 *
 * `detectHorizontalDragGestures` gives the vertical-dominant abort for free:
 * a child scrollable (the transcript) consumes vertical drags first, so a
 * vertical scroll never swipes — the direction lock the TS hook hand-rolls.
 * Rapid swipes are debounced ([SWIPE_DEBOUNCE_MS]); the commit animates the
 * current content out, fires [onNavigate] at the content switch, then slides
 * the new content in from the opposite side (the session selection itself is
 * asynchronous behind the FFI dispatch, so the new screen may land mid-slide —
 * the animation reads as the carousel settling either way).
 */
@Composable
private fun SwipeCarousel(
    currentIndex: Int,
    itemCount: Int,
    onNavigate: (index: Int) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val density = LocalDensity.current
    val thresholdPx = with(density) { SWIPE_THRESHOLD.toPx() }
    var panelWidthPx by remember { mutableIntStateOf(0) }
    val slide = remember { Animatable(0f) }
    var dragAccum by remember { mutableFloatStateOf(0f) }
    var lastSwipeAt by remember { mutableLongStateOf(0L) }
    var animating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // swipeTargetIndex(current, size, dir, wrap = false): null at the edges.
    val canSwipeLeft = currentIndex in 0 until itemCount - 1
    val canSwipeRight = currentIndex > 0

    fun snapBack() {
        scope.launch {
            slide.animateTo(0f, tween(SLIDE_DURATION_MS, easing = EaseOut))
        }
    }

    fun commitSwipe(totalDx: Float) {
        val dir = if (totalDx < 0) 1 else -1 // swipe left → next, right → prev
        val targetIndex = currentIndex + dir
        if (targetIndex < 0 || targetIndex >= itemCount) {
            snapBack()
            return
        }
        lastSwipeAt = System.currentTimeMillis()
        animating = true
        val width = panelWidthPx.coerceAtLeast(1).toFloat()
        val exit = if (totalDx < 0) -width else width
        val enter = -exit
        scope.launch {
            // Phase 1: slide the current content out (accelerate away).
            slide.animateTo(exit, tween(SLIDE_DURATION_MS, easing = EaseIn))
            // Phase 2: switch the item (async — the selection dispatches), and
            // position the incoming content at the enter side without easing.
            onNavigate(targetIndex)
            slide.snapTo(enter)
            // Phase 3: slide the new content in to center.
            slide.animateTo(0f, tween(SLIDE_DURATION_MS, easing = EaseOut))
            animating = false
        }
    }

    Box(
        modifier
            .onSizeChanged { panelWidthPx = it.width }
            .offset { IntOffset(slide.value.roundToInt(), 0) }
            .pointerInput(currentIndex, itemCount) {
                detectHorizontalDragGestures(
                    onDragStart = { offset ->
                        if (!animating) dragAccum = 0f
                    },
                    onDragEnd = {
                        if (animating) return@detectHorizontalDragGestures
                        val total = dragAccum
                        dragAccum = 0f
                        val now = System.currentTimeMillis()
                        when {
                            now - lastSwipeAt < SWIPE_DEBOUNCE_MS -> snapBack()
                            total < -thresholdPx && canSwipeLeft -> commitSwipe(total)
                            total > thresholdPx && canSwipeRight -> commitSwipe(total)
                            else -> snapBack()
                        }
                    },
                    onDragCancel = {
                        dragAccum = 0f
                        snapBack()
                    },
                ) { change, dragAmount ->
                    if (animating) return@detectHorizontalDragGestures
                    change.consume()
                    // detectHorizontalDragGestures already reduces the drag to
                    // its horizontal component — dragAmount IS the x delta.
                    val dx = dragAccum + dragAmount
                    dragAccum = dx
                    // Damped drag, suppressed at a clamped edge (the reference's
                    // "no drag visual past the edge" behavior).
                    val capped = when {
                        dx < 0 && !canSwipeLeft -> 0f
                        dx > 0 && !canSwipeRight -> 0f
                        else -> dx * SWIPE_DAMPEN
                    }
                    scope.launch { slide.snapTo(capped) }
                }
            },
    ) {
        content()
    }
}
