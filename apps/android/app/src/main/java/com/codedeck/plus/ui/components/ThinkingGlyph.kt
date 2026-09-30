package com.codedeck.plus.ui.components

import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.delay

/** Claude Code's spinner glyphs, cycled while a turn runs. */
private val THINKING_FRAMES = listOf("·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢")
private const val THINKING_FRAME_MS = 120L

/**
 * The "a turn is running" mark: Claude Code's cycling spinner glyph. One
 * component for every place a running session is shown (the session's own
 * thinking line, the sessions list), so they read as the same signal.
 * Fixed width, so the glyph changing shape never shifts what follows it.
 */
@Composable
fun ThinkingGlyph(
    modifier: Modifier = Modifier,
    color: Color = Tokens.Accent,
    fontSize: TextUnit = Tokens.TextMd,
) {
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(THINKING_FRAME_MS)
            frame = (frame + 1) % THINKING_FRAMES.size
        }
    }
    Text(
        THINKING_FRAMES[frame],
        color = color,
        fontSize = fontSize,
        fontFamily = Tokens.FontMono,
        textAlign = TextAlign.Center,
        modifier = modifier.width(18.dp),
    )
}

/** An alpha that breathes between [min] and [max], for a line that is
 *  alive (the running turn's activity, a request still in flight). */
@Composable
fun pulsingAlpha(min: Float, max: Float, halfPeriodMs: Int): Float {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = min,
        targetValue = max,
        animationSpec = infiniteRepeatable(
            animation = tween(halfPeriodMs, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulseAlpha",
    )
    return alpha
}
