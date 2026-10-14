package com.codedeck.plus.ui.transcript

import java.time.Instant
import java.util.Locale

/**
 * The working line's counter, as Claude Code's spinner writes it:
 * `(12s · ↓ 1.2k tokens)`. Like the CLI it waits until the turn has run
 * more than five seconds and some reply has arrived, so a quick turn shows
 * none; null until then.
 */
internal fun workingCounterText(elapsedSeconds: Long, tokens: Long): String? {
    if (elapsedSeconds <= 5 || tokens <= 0) return null
    return "(${elapsedSeconds}s · ↓ ${compactCount(tokens)} tokens)"
}

/** A count the way the CLI shows one: `950`, `1.2k`, `12.3k`, `1.5m`. */
internal fun compactCount(n: Long): String {
    if (n < 1_000) return n.toString()
    val (value, unit) = if (n < 1_000_000) n / 1_000.0 to "k" else n / 1_000_000.0 to "m"
    val rounded = String.format(Locale.ROOT, "%.1f", value).removeSuffix(".0")
    return rounded + unit
}

/**
 * The reply's tokens so far in the turn that started with [entries]' last
 * message from the user, estimated the way Claude Code's spinner does it:
 * the characters the agent wrote (its text, its thinking, the arguments of
 * its calls, and what is still being typed out in [live]) over four.
 */
internal fun turnTokens(entries: List<DisplayEntry>, live: List<DisplayEntry.AgentMessage>): Long {
    val turn = entries.subList(entries.indexOfLast { it is DisplayEntry.UserMessage } + 1, entries.size)
    var chars = live.sumOf { it.text.length.toLong() }
    for (entry in turn) {
        chars += when (entry) {
            is DisplayEntry.AgentMessage -> entry.text.length.toLong()
            is DisplayEntry.ToolGroup -> entry.steps.sumOf { step ->
                when (step) {
                    is ToolStep.Call -> (step.input?.length ?: step.title.length).toLong()
                    is ToolStep.Thinking -> step.text.length.toLong()
                    is ToolStep.Text -> step.text.length.toLong()
                    is ToolStep.Result -> 0L
                }
            }
            else -> 0L
        }
    }
    return chars / 4
}

/** [iso] (an ISO 8601 instant) in epoch milliseconds; null when it is not one. */
internal fun epochMillisOf(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

/**
 * One line saying what a finished call came to, for the line under a lone
 * call (after the agent's result mark): what a terminal UI writes there —
 * the lines a read returned, how many results a search found, what an edit
 * changed, otherwise the first line the result says. Null while the call
 * runs, and for a sub-agent (its row says what it is doing).
 */
internal fun resultSummary(call: ToolStep.Call): String? {
    val result = call.result ?: return null
    val text = result.text.trimEnd()
    val lines = if (text.isBlank()) emptyList() else text.lines()
    val first = lines.firstOrNull { it.isNotBlank() }?.trim()
    if (result.isError) return first ?: "Failed"
    return when (call.toolKind) {
        "agent" -> null
        "read" -> "Read ${lines.size} ${plural(lines.size, "line")}"
        "search" -> if (lines.isEmpty()) "Nothing found" else "Found ${lines.size} ${plural(lines.size, "result")}"
        "edit", "delete", "move" ->
            if (call.added + call.removed > 0) {
                "Added ${call.added} ${plural(call.added, "line")}, removed ${call.removed} ${plural(call.removed, "line")}"
            } else {
                first ?: "Done"
            }
        "execute" -> when {
            first == null -> "No output"
            lines.size > 1 -> "$first … +${lines.size - 1} ${plural(lines.size - 1, "line")}"
            else -> first
        }
        else -> first
    }
}

private fun plural(n: Int, word: String): String = if (n == 1) word else "${word}s"
