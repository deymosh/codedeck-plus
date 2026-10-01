package com.codedeck.plus.ui.transcript

/** Text up to this long is one block. */
internal const val BLOCK_TARGET = 4_000

/**
 * A message's markdown in blocks of about [target] characters, each a list
 * item of its own: the transcript then composes, parses and lays out only the
 * blocks on screen, and a streaming message re-parses only its last block.
 * One huge message as a single item is parsed and measured whole on the main
 * thread, which is how a long agent reply froze the app.
 *
 * Blocks end at a blank line outside a code fence, so each renders as it
 * would within the whole. Where markdown gives no such break before twice
 * [target], the block is cut at a line anyway: inside a code fence
 * the fence is closed and opened again in the next block, a table's header
 * is repeated, and a single line longer than the limit is cut at a space.
 * Short text is returned as is.
 */
fun markdownBlocks(text: String, target: Int = BLOCK_TARGET): List<String> {
    if (text.length <= target) return listOf(text)
    val hard = target * 2
    val blocks = mutableListOf<String>()
    val current = StringBuilder()
    // The open fence's marker (``` or ~~~, any length) and its opening line.
    var fence: String? = null
    var fenceLine = ""
    // A table's header and delimiter rows, while in a table.
    var tableHeader: String? = null
    var previous = ""

    fun flush() {
        if (current.isNotBlank()) blocks += current.toString().trimEnd('\n')
        current.clear()
    }
    fun append(line: String) {
        current.append(line).append('\n')
    }

    for (rawLine in text.split('\n')) {
        for (line in splitLongLine(rawLine, hard)) {
            val trimmed = line.trimStart()
            if (fence == null) {
                if (line.isBlank()) {
                    tableHeader = null
                    if (current.length >= target) {
                        flush()
                        previous = line
                        continue
                    }
                } else if (current.length >= hard) {
                    flush()
                    tableHeader?.let { append(it) }
                }
                val marker = fenceMarker(trimmed)
                if (marker != null) {
                    fence = marker
                    fenceLine = line
                } else if (isTableDelimiter(trimmed) && previous.trimStart().startsWith("|")) {
                    tableHeader = previous + "\n" + line
                }
                append(line)
            } else {
                val open = fence!!
                if (trimmed.startsWith(open) && trimmed.trimEnd().all { it == open[0] }) {
                    fence = null
                    append(line)
                } else {
                    if (current.length >= hard) {
                        append(open)
                        flush()
                        append(fenceLine)
                    }
                    append(line)
                }
            }
            previous = line
        }
    }
    flush()
    return blocks.ifEmpty { listOf(text) }
}

/** The fence a line opens (its run of ``` or ~~~), or null. */
private fun fenceMarker(trimmed: String): String? {
    val c = trimmed.firstOrNull() ?: return null
    if (c != '`' && c != '~') return null
    val run = trimmed.takeWhile { it == c }
    return run.takeIf { it.length >= 3 }
}

/** A table's delimiter row: `|---|:--:|`. */
private fun isTableDelimiter(trimmed: String): Boolean =
    trimmed.startsWith("|") && trimmed.length > 2 && trimmed.all { it == '|' || it == '-' || it == ':' || it == ' ' }

/** A line no longer than [limit], else its pieces, cut at the last space before the limit where there is one. */
private fun splitLongLine(line: String, limit: Int): List<String> {
    if (line.length <= limit) return listOf(line)
    val pieces = mutableListOf<String>()
    var rest = line
    while (rest.length > limit) {
        val space = rest.lastIndexOf(' ', limit)
        val cut = if (space > limit / 2) space else limit
        pieces += rest.substring(0, cut)
        rest = rest.substring(cut).trimStart(' ')
    }
    if (rest.isNotEmpty()) pieces += rest
    return pieces
}
