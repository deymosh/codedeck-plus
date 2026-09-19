package com.codedeck.plus.ui.transcript

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes `crates/uniffi-bridge/fixtures/display_entries_corpus.json` — the
 * same fixture `display_entries_corpus.rs`'s `matches_the_committed_fixture`
 * test asserts the real Rust serializer still produces. A shape change on
 * either side that isn't mirrored on the other shows up here as a decode
 * failure, or there as a fixture diff — not a silent divergence.
 *
 * The fixture wraps both real FFI payloads (`displayEntriesJson`,
 * `pendingPermissionJson` — two SEPARATE strings crossing the boundary) in
 * one object purely for convenience of a single committed file; this test
 * splits them back apart before calling the real `parseDisplayEntries`/
 * `parsePendingPermission` entry points, so it exercises exactly what
 * `CoreBridge`'s `transcriptFlow` actually hands a screen.
 */
class DisplayEntriesFixtureTest {

    private fun loadFixture(): String =
        javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!
            .bufferedReader()
            .readText()

    @Test
    fun decodes_the_shared_corpus_fixture_into_every_display_kind() {
        val root = displayEntriesJson.parseToJsonElement(loadFixture()).jsonObject
        val entries = parseDisplayEntries(root.getValue("displayEntries").toString())
        val pending = parsePendingPermission(root.getValue("pendingPermission").toString())

        assertEquals(11, entries.size)
        assertTrue(entries[0] is DisplayEntry.UserMessage)
        assertTrue(entries[1] is DisplayEntry.AssistantMessage)

        val toolGroup = entries[2] as DisplayEntry.ToolGroup
        assertEquals(2, toolGroup.entries.size)
        assertEquals("2 actions", toolGroup.summary)

        val diff = entries[3] as DisplayEntry.Diff
        assertEquals("packages/core/src/nostr/pool.ts", diff.entry.diff?.path)
        assertEquals(3, diff.entry.diff?.lines?.size)
        assertEquals("del", diff.entry.diff?.lines?.get(1)?.type)

        assertTrue(entries[4] is DisplayEntry.Error)
        assertTrue(entries[5] is DisplayEntry.System)
        assertTrue(entries[6] is DisplayEntry.Lifecycle)

        val planApproval = entries[7] as DisplayEntry.PlanApproval
        assertEquals(true, planApproval.hasPlan)
        assertEquals("tu-plan", planApproval.toolUseId)

        val question = entries[8] as DisplayEntry.Question
        assertEquals(2, question.question.options?.size)
        assertEquals("Direction", question.question.header)

        val questionGroup = entries[9] as DisplayEntry.QuestionGroup
        assertEquals(2, questionGroup.questions.size)
        assertEquals("Scope", questionGroup.questions[0].header)
        assertEquals("Timeline", questionGroup.questions[1].header)

        val permission = entries[10] as DisplayEntry.PermissionRequest
        assertEquals("Read", permission.toolName)
        assertEquals("tu-permission", permission.requestId)

        assertEquals("tu-permission", pending.requestId)
        assertEquals("Read", pending.toolName)
        assertEquals(false, pending.isSubAgent)
    }

    @Test
    fun metadata_keys_stay_in_their_original_snake_case_wire_spelling() {
        val root = displayEntriesJson.parseToJsonElement(loadFixture()).jsonObject
        val entries = parseDisplayEntries(root.getValue("displayEntries").toString())
        val permission = entries[10] as DisplayEntry.PermissionRequest
        // Unlike every typed field around it, `metadata` is untyped bridge
        // passthrough — it must NOT be re-cased to camelCase the way
        // `toolName`/`requestId` etc. are.
        assertTrue(permission.entry.metadata?.containsKey("tool_use_id") == true)
        assertTrue(permission.entry.metadata?.containsKey("toolUseId") != true)
    }
}
