package com.codedeck.plus.ui.transcript

/**
 * A session's decoded transcript rows, kept by key (`DisplayEntry` seq) so a
 * delta from the core decodes only the rows it carries. The list stays the
 * same instance when a delta changes nothing, so the transcript does not
 * recompose for nothing.
 */
class TranscriptRows private constructor(
    private val byKey: Map<ULong, DisplayEntry>,
    val entries: List<DisplayEntry>,
) {
    companion object {
        val EMPTY = TranscriptRows(emptyMap(), emptyList())

        /**
         * Apply one delta (`UniffiTranscriptDelta`'s fields) to `previous`.
         * A `full` delta replaces it outright, in `changed`'s own order; any
         * other updates the changed rows and lays them all out by `order`.
         * `parse` decodes one row's JSON.
         */
        fun apply(
            previous: TranscriptRows,
            full: Boolean,
            order: List<ULong>,
            changed: List<Pair<ULong, String>>,
            parse: (String) -> DisplayEntry = ::parseDisplayEntry,
        ): TranscriptRows {
            if (full) {
                val entries = changed.map { parse(it.second) }
                return TranscriptRows(changed.map { it.first }.zip(entries).toMap(), entries)
            }
            if (changed.isEmpty() && order.size == previous.entries.size) return previous
            val byKey = previous.byKey.toMutableMap()
            changed.forEach { (key, json) -> byKey[key] = parse(json) }
            val keys = order.toSet()
            byKey.keys.retainAll(keys)
            return TranscriptRows(byKey, order.mapNotNull { byKey[it] })
        }
    }
}
