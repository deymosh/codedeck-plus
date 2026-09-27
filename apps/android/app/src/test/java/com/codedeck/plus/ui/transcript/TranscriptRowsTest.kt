package com.codedeck.plus.ui.transcript

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class TranscriptRowsTest {
    private fun user(seq: Long, text: String) = """{"kind":"userMessage","seq":$seq,"text":"$text"}"""

    @Test
    fun deltas_build_on_each_other_and_decode_only_what_changed() {
        var decoded = 0
        val parse = { json: String -> decoded++; parseDisplayEntry(json) }

        val first = TranscriptRows.apply(
            TranscriptRows.EMPTY, full = true, order = listOf(1uL, 2uL),
            changed = listOf(1uL to user(1, "a"), 2uL to user(2, "b")), parse = parse,
        )
        assertEquals(listOf("a", "b"), first.entries.map { (it as DisplayEntry.UserMessage).text })

        // An earlier row changes and one is appended: only those two decode.
        decoded = 0
        val second = TranscriptRows.apply(
            first, full = false, order = listOf(1uL, 2uL, 3uL),
            changed = listOf(1uL to user(1, "a2"), 3uL to user(3, "c")), parse = parse,
        )
        assertEquals(2, decoded)
        assertEquals(listOf("a2", "b", "c"), second.entries.map { (it as DisplayEntry.UserMessage).text })

        // Nothing changed: the same list, nothing decoded.
        decoded = 0
        val third = TranscriptRows.apply(second, full = false, order = listOf(1uL, 2uL, 3uL), changed = emptyList(), parse = parse)
        assertSame(second, third)
        assertEquals(0, decoded)

        // A full delta replaces everything, a row that left is gone.
        val reset = TranscriptRows.apply(third, full = true, order = listOf(3uL), changed = listOf(3uL to user(3, "c")))
        assertEquals(listOf(3L), reset.entries.map { it.seq })
    }
}
