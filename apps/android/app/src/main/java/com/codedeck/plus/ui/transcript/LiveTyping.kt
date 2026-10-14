package com.codedeck.plus.ui.transcript

import android.animation.ValueAnimator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import com.codedeck.plus.core.LiveReply
import kotlin.math.ceil

/** How long typing takes to catch up with the text that has arrived: about
 *  the gap between two updates from the bridge, so a steady stream reads as
 *  continuous typing instead of a jump every quarter second. */
private const val CATCH_UP_MS = 250f

/** How often the shown text moves on: smooth to the eye, and half the
 *  markdown re-parses of updating every frame. */
private const val STEP_MS = 33L

/** The longest frame gap counted, so a stall (the app paused) does not dump
 *  the whole backlog in one step. */
private const val MAX_FRAME_MS = 100L

/**
 * The replies the agent is still writing, typed out: each one shows a prefix
 * of the text that has arrived, moving on every [STEP_MS] at the pace that
 * empties what is left in about [CATCH_UP_MS]. The frames run only while some
 * reply has text left to show, and with animations off in the system settings
 * the text shows as it comes. A reply with nothing shown yet is no row at all.
 */
@Composable
fun rememberTypedReplies(replies: List<LiveReply>): List<DisplayEntry.AgentMessage> {
    // Characters shown, by reply id.
    val shown = remember { mutableStateMapOf<Long, Int>() }
    LaunchedEffect(replies) {
        val ids = replies.mapTo(HashSet()) { it.id }
        shown.keys.retainAll(ids)
        if (!ValueAnimator.areAnimatorsEnabled()) {
            replies.forEach { shown[it.id] = it.text.length }
            return@LaunchedEffect
        }
        var last = 0L
        while (replies.any { (shown[it.id] ?: 0) < it.text.length }) {
            withFrameMillis { now ->
                if (last != 0L && now - last < STEP_MS) return@withFrameMillis
                val elapsed = if (last == 0L) STEP_MS else (now - last).coerceAtMost(MAX_FRAME_MS)
                last = now
                for (reply in replies) {
                    val at = shown[reply.id] ?: 0
                    val backlog = reply.text.length - at
                    if (backlog <= 0) continue
                    var next = at + maxOf(1, ceil(backlog * elapsed / CATCH_UP_MS).toInt())
                    // Never between the two halves of a surrogate pair.
                    if (next < reply.text.length && reply.text[next - 1].isHighSurrogate()) next++
                    shown[reply.id] = minOf(next, reply.text.length)
                }
            }
        }
    }
    return replies.mapNotNull { reply ->
        val count = shown[reply.id] ?: 0
        if (count == 0) {
            null
        } else {
            DisplayEntry.AgentMessage(seq = -reply.id, text = reply.text.substring(0, count), part = reply.key)
        }
    }
}
