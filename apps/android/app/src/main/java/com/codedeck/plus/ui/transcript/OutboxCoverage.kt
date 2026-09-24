package com.codedeck.plus.ui.transcript

import uniffi.client_ffi.UniffiOutboxItem

/**
 * Port of `apps/mobile/src/ui/transcript/outboxCoverage.ts` (CDX-063): an
 * outbox row stays visible until the transcript actually CONTAINS a
 * covering user entry for it — the bridge acks an input the moment it's
 * accepted, before any transcript entry exists; the user's row is only
 * authored when the SDK echoes it back on a droppable ephemeral kind, so
 * hiding the row on the ack alone can make a sent message vanish.
 *
 * Simplified from the TS original: no `OUTBOX_ECHO_GRACE_MS` aging sweep for
 * a long-uncovered `confirmed` item (that needs `confirmedAt`, which
 * `UniffiOutboxItem` doesn't cross yet — a disclosed narrowing, not an
 * oversight; add the field the day a screen needs the aging behavior). Every
 * uncovered item stays visible regardless of age, same as the TS function's
 * own no-`opts` contract.
 *
 * The covering source is `DisplayEntry.UserMessage` rows, not a separate
 * flat entry list — every `text`/`role=user` entry becomes exactly one
 * `UserMessage` display row (`buildDisplayEntries` never absorbs a
 * user-role entry into a tool group), so the grouped list already carries
 * everything `userEntriesOf` would have found in the raw transcript.
 */

private fun normalize(text: String): String = text.replace("\r\n", "\n").trim()

private fun coversNormalized(entry: String, item: String): Boolean {
    if (item.isEmpty()) return false
    if (entry == item) return true
    if (!entry.startsWith(item)) return false
    return entry.substring(item.length).trimStart().startsWith("<!--")
}

/** Does this transcript user entry cover this outbox item's text? Exact
 *  match after normalization, or the item text followed by a
 *  bridge-appended HTML comment — never a bare prefix. */
fun entryCovers(entryContent: String, itemText: String): Boolean =
    coversNormalized(normalize(entryContent), normalize(itemText))

private data class SeqText(val seq: Long, val content: String)

private fun userEntriesOf(displayEntries: List<DisplayEntry>): List<SeqText> =
    displayEntries.filterIsInstance<DisplayEntry.UserMessage>().map { SeqText(it.seq, it.text) }

/** Pairs outbox items (createdAt order) against user entries (seq order);
 *  each entry consumes at most one item. A covering entry is proof of
 *  delivery even for an item the sweep marked failed. */
private fun coveredOutboxIds(items: List<UniffiOutboxItem>, userEntries: List<SeqText>): Set<String> {
    val orderedItems = items.sortedBy { it.createdAt }.map { it.id to normalize(it.text) }
    val orderedEntries = userEntries.sortedBy { it.seq }.map { normalize(it.content) }
    val used = BooleanArray(orderedEntries.size)
    val covered = mutableSetOf<String>()
    for ((id, text) in orderedItems) {
        for (i in orderedEntries.indices) {
            if (used[i]) continue
            if (coversNormalized(orderedEntries[i], text)) {
                used[i] = true
                covered.add(id)
                break
            }
        }
    }
    return covered
}

/** The outbox rows a session's transcript renders after its display
 *  entries: every item — whatever its ack state — that no user entry covers
 *  yet, oldest first. */
fun visibleOutboxItems(
    items: List<UniffiOutboxItem>,
    machine: String,
    sessionId: String,
    displayEntries: List<DisplayEntry>,
): List<UniffiOutboxItem> {
    val sessionItems = items.filter { it.machine == machine && it.sessionId == sessionId }.sortedBy { it.createdAt }
    if (sessionItems.isEmpty()) return emptyList()
    val covered = coveredOutboxIds(sessionItems, userEntriesOf(displayEntries))
    return sessionItems.filterNot { covered.contains(it.id) }
}
