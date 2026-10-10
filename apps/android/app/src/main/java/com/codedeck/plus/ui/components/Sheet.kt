package com.codedeck.plus.ui.components

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.LocalOverscrollFactory
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.AnchoredDraggableState
import androidx.compose.foundation.gestures.DraggableAnchors
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import com.codedeck.plus.ui.theme.Tokens
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** As wide as a sheet grows, on a tablet or in landscape. */
private val SHEET_MAX_WIDTH = 640.dp

/** A drag released slowly moves the sheet to the next stop once it went
 *  this far; a shorter one springs back. */
private val SHEET_POSITIONAL_THRESHOLD = 56.dp

/** A release at least this fast moves the sheet to the next stop in its
 *  direction, however far it went. */
private val SHEET_VELOCITY_THRESHOLD = 125.dp

/** Critically damped, so the sheet comes to rest at a stop without passing it. */
private val SHEET_MOTION = spring<Float>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)

/** How much a back gesture narrows and shortens the sheet at its end. */
private val BACK_SHRINK_X = 48.dp
private val BACK_SHRINK_Y = 24.dp

/** Where a sheet rests: off the screen, at half of it, or whole. */
private enum class SheetStop { Hidden, Half, Full }

/**
 * A bottom sheet as every sheet in the app opens. Built on the foundation
 * gestures rather than Material's sheet, whose settle spring passes its
 * stops and whose surface follows the status bar's inset as it rises:
 *
 * - it lives in the screen below the status bar (and above the keyboard),
 *   so a tall sheet stops right under the status bar and its
 *   content scrolls inside it;
 * - it comes to rest at a stop without passing it, and a drag past the top
 *   does not move it at all;
 * - a drag on its content scrolls the content first and moves the sheet
 *   only once the content is at its top; a fling that only scrolled the
 *   content never closes the sheet;
 * - its height changing while a finger holds it (live content) moves it
 *   only once the finger lets go.
 *
 * [skipPartiallyExpanded] opens it whole at once, for a sheet the user came
 * to act in; a long read can start at half the screen. The content handles
 * its own bottom inset (`navigationBarsPadding`) so it scrolls behind the
 * navigation bar. System Back, which the sheet follows as a predictive
 * gesture, takes a whole sheet with a half stop to it and otherwise closes
 * the sheet, unless the content's own `BackHandler` takes it first.
 */
@Composable
fun DeckSheet(
    onDismiss: () -> Unit,
    skipPartiallyExpanded: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val dismiss by rememberUpdatedState(onDismiss)
    val sheet = remember { SheetMotion(density, scope) { dismiss() } }
    LaunchedEffect(sheet) { sheet.open() }

    Dialog(
        onDismissRequest = sheet::close,
        // Back is the predictive handler's below, so the sheet follows the gesture.
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false, dismissOnBackPress = false),
    ) {
        // The scrim below is the sheet's own; the platform dim and the
        // window's own enter animation would double it.
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            window?.setWindowAnimations(0)
        }
        // A back gesture shrinks the sheet as it goes; let go, it steps
        // back (a whole sheet that also has a half stop goes to it) or
        // closes. A page's own BackHandler in the content comes first.
        val back = remember { Animatable(0f) }
        PredictiveBackHandler { events ->
            try {
                events.collect { back.snapTo(it.progress) }
                if (sheet.back()) back.animateTo(0f)
            } catch (cancelled: CancellationException) {
                scope.launch { back.animateTo(0f) }
                throw cancelled
            }
        }
        Box(Modifier.fillMaxSize()) {
            val scrim by animateFloatAsState(
                if (sheet.stop == SheetStop.Hidden) 0f else 1f,
                animationSpec = tween(Tokens.TransitionMs),
                label = "scrim",
            )
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(sheet) { detectTapGestures { sheet.close() } }
                    .semantics {
                        contentDescription = "Close sheet"
                        onClick { sheet.close(); true }
                    },
            ) { drawRect(Tokens.Scrim, alpha = scrim) }
            Box(
                Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))
                    .imePadding(),
            ) {
                Column(
                    Modifier
                        .align(Alignment.TopCenter)
                        .widthIn(max = SHEET_MAX_WIDTH)
                        .fillMaxWidth()
                        .layout { measurable, constraints ->
                            val placeable = measurable.measure(constraints.copy(minHeight = 0))
                            sheet.measured(constraints.maxHeight.toFloat(), placeable.height, half = !skipPartiallyExpanded)
                            layout(placeable.width, placeable.height) {
                                val offset = sheet.state.offset
                                placeable.place(0, (if (offset.isNaN()) constraints.maxHeight.toFloat() else offset).roundToInt())
                            }
                        }
                        .nestedScroll(sheet.nestedScroll)
                        .draggable(
                            rememberDraggableState(sheet::drag),
                            Orientation.Vertical,
                            startDragImmediately = sheet.state.isAnimationRunning,
                            onDragStopped = { sheet.settle(it) },
                        )
                        .semantics {
                            paneTitle = "Sheet"
                            dismiss { sheet.close(); true }
                            when (sheet.stop) {
                                SheetStop.Half -> expand { sheet.expand(); true }
                                SheetStop.Full -> if (sheet.hasHalf) collapse { sheet.back(); true }
                                SheetStop.Hidden -> Unit
                            }
                        }
                        .graphicsLayer {
                            val p = back.value
                            if (p > 0f && size.width > 0f && size.height > 0f) {
                                scaleX = 1f - min(BACK_SHRINK_X.toPx(), size.width) * p / size.width
                                scaleY = 1f - min(BACK_SHRINK_Y.toPx(), size.height) * p / size.height
                                // Shrinks towards the bottom of the screen, where the sheet stands.
                                val visible = sheet.region - sheet.state.offset
                                transformOrigin = TransformOrigin(0.5f, if (visible.isNaN()) 1f else visible / size.height)
                            }
                        }
                        .clip(RoundedCornerShape(topStart = Tokens.RadiusXl, topEnd = Tokens.RadiusXl))
                        .background(Tokens.SurfaceRaised),
                ) {
                    // The content keeps its proportions while the sheet shrinks.
                    Column(
                        Modifier.graphicsLayer {
                            val p = back.value
                            if (p > 0f && size.width > 0f && size.height > 0f) {
                                val sx = 1f - min(BACK_SHRINK_X.toPx(), size.width) * p / size.width
                                val sy = 1f - min(BACK_SHRINK_Y.toPx(), size.height) * p / size.height
                                scaleY = sx / sy
                                transformOrigin = TransformOrigin(0.5f, 0f)
                            }
                        },
                    ) {
                        // A tap on the handle opens a half sheet whole, and closes a whole one.
                        Box(
                            Modifier
                                .align(Alignment.CenterHorizontally)
                                .clip(RoundedCornerShape(Tokens.RadiusPill))
                                .clickable(onClickLabel = if (sheet.stop == SheetStop.Half) "Expand" else "Close") {
                                    if (sheet.stop == SheetStop.Half) sheet.expand() else sheet.close()
                                }
                                .semantics { contentDescription = "Drag handle" }
                                .padding(horizontal = Tokens.Space2, vertical = 22.dp),
                        ) {
                            Box(
                                Modifier
                                    .size(width = 32.dp, height = 4.dp)
                                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                                    .background(Tokens.TextDim),
                            )
                        }
                        // Nothing in a sheet stretches past an end: the sheet is
                        // what moves there.
                        CompositionLocalProvider(LocalOverscrollFactory provides null, LocalContentColor provides Tokens.Text) {
                            content()
                        }
                    }
                }
            }
        }
    }
}

/**
 * A sheet's position and how it moves between its stops: its drag, its
 * hand-off with the content's scrolling, and settling at a stop.
 */
private class SheetMotion(density: Density, private val scope: CoroutineScope, private val onClosed: () -> Unit) {
    val state = AnchoredDraggableState(SheetStop.Hidden)

    /** The stop the sheet rests at or is on its way to. */
    var stop by mutableStateOf(SheetStop.Hidden)
        private set

    private val positionalThreshold = with(density) { SHEET_POSITIONAL_THRESHOLD.toPx() }
    private val velocityThreshold = with(density) { SHEET_VELOCITY_THRESHOLD.toPx() }

    /** A finger is moving the sheet: new stops wait in [pending] until it lets go. */
    private var dragging = false
    private var pending: DraggableAnchors<SheetStop>? = null
    private var closing = false

    /** How tall the screen the sheet lives in is, as last measured. */
    var region = Float.NaN
        private set

    val hasHalf: Boolean get() = state.anchors.hasPositionFor(SheetStop.Half)

    /** The sheet was measured: [region] tall to live in, [height] tall itself. */
    fun measured(region: Float, height: Int, half: Boolean) {
        this.region = region
        val anchors = DraggableAnchors {
            SheetStop.Hidden at region
            if (half && height > region / 2) SheetStop.Half at region / 2
            if (height > 0) SheetStop.Full at max(0f, region - height)
        }
        if (anchors == state.anchors) return
        if (dragging) pending = anchors else state.updateAnchors(anchors, fit(stop, anchors))
    }

    suspend fun open() {
        snapshotFlow { state.anchors.size }.first { it > 1 }
        moveTo(if (state.anchors.hasPositionFor(SheetStop.Half)) SheetStop.Half else SheetStop.Full)
    }

    /** Slides the sheet away, then says it closed. */
    fun close() {
        if (closing) return
        closing = true
        scope.launch {
            moveTo(SheetStop.Hidden)
            onClosed()
        }
    }

    /** Back: a whole sheet with a half stop goes to it, else the sheet
     *  closes. Whether it stayed open. */
    fun back(): Boolean {
        if (stop == SheetStop.Full && hasHalf) {
            scope.launch { moveTo(SheetStop.Half) }
            return true
        }
        close()
        return false
    }

    fun expand() {
        if (!closing) scope.launch { moveTo(SheetStop.Full) }
    }

    fun drag(delta: Float) {
        if (closing) return
        grab()
        dragging = true
        state.dispatchRawDelta(delta)
    }

    /** A finger took the sheet: a move under way (opening, settling) stops
     *  so it does not pull against the finger. */
    private fun grab() {
        if (state.isAnimationRunning) scope.launch { state.anchoredDrag(MutatePriority.UserInput) {} }
    }

    /** The finger let go at [velocity]: rest at the stop it points to. */
    suspend fun settle(velocity: Float) {
        if (closing) return
        val anchors = release()
        val target = target(anchors, velocity)
        moveTo(target, velocity)
        if (target == SheetStop.Hidden && !closing) {
            closing = true
            onClosed()
        }
    }

    /** Ends a drag, taking the stops that changed under it. */
    private fun release(): DraggableAnchors<SheetStop> {
        dragging = false
        val anchors = pending ?: return state.anchors
        pending = null
        return anchors.also { state.updateAnchors(it, fit(stop, it)) }
    }

    private fun target(anchors: DraggableAnchors<SheetStop>, velocity: Float): SheetStop {
        val offset = state.offset.takeUnless { it.isNaN() } ?: return stop
        if (abs(velocity) >= velocityThreshold) return anchors.closestAnchor(offset, searchUpwards = velocity > 0) ?: stop
        val closest = anchors.closestAnchor(offset) ?: return stop
        if (closest != stop) return closest
        val moved = offset - anchors.positionOf(stop)
        if (abs(moved) < positionalThreshold) return stop
        return anchors.closestAnchor(offset, searchUpwards = moved > 0) ?: stop
    }

    private suspend fun moveTo(target: SheetStop, velocity: Float = 0f) {
        stop = target
        state.anchoredDrag(target) { anchors, latest ->
            val to = anchors.positionOf(latest)
            val from = state.offset
            if (to.isNaN() || from.isNaN() || from == to) return@anchoredDrag
            val top = anchors.minPosition()
            val bottom = anchors.maxPosition()
            // Held within the stops: a fling's speed never carries it past one.
            animate(from, to, velocity, SHEET_MOTION) { value, speed -> dragTo(value.coerceIn(top, bottom), speed) }
        }
    }

    /** Whether the sheet is away from its stop, mid-drag. */
    private fun displaced(): Boolean {
        val at = state.anchors.positionOf(stop)
        return !at.isNaN() && !state.offset.isNaN() && abs(state.offset - at) > 0.5f
    }

    /**
     * The hand-off with the content's scrolling. An upward drag raises the
     * sheet before the content scrolls; a drag the content cannot use (down
     * at its top) moves the sheet. A fling ending a drag that moved the
     * sheet settles the sheet and is not passed to the content; one that
     * only scrolled the content leaves the sheet where it is.
     */
    val nestedScroll = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset =
            if (available.y < 0 && source == NestedScrollSource.UserInput) Offset(0f, consume(available.y)) else Offset.Zero

        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
            if (source == NestedScrollSource.UserInput) Offset(0f, consume(available.y)) else Offset.Zero

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (!displaced()) {
                release()
                return Velocity.Zero
            }
            settle(available.y)
            return available
        }

        override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
            if (!displaced()) return Velocity.Zero
            settle(available.y)
            return available
        }

        private fun consume(delta: Float): Float {
            if (delta == 0f || closing || state.offset.isNaN()) return 0f
            val used = state.dispatchRawDelta(delta)
            if (used != 0f) {
                grab()
                dragging = true
            }
            return used
        }
    }

    private companion object {
        /** [want] if [anchors] has it; else the nearest stop that is there. */
        fun fit(want: SheetStop, anchors: DraggableAnchors<SheetStop>): SheetStop = when {
            anchors.hasPositionFor(want) -> want
            want == SheetStop.Half && anchors.hasPositionFor(SheetStop.Full) -> SheetStop.Full
            else -> SheetStop.Hidden
        }
    }
}
