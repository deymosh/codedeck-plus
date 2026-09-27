package com.codedeck.plus.platform

import android.database.MatrixCursor
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class Nip55SignerTest {
    @Test
    fun a_signature_row_is_an_answer() {
        val cursor = MatrixCursor(arrayOf("signature", "event", "result")).apply { addRow(arrayOf("sig", "{}", "sig")) }
        assertEquals(ProviderAnswer.Answered("sig", "{}"), providerAnswerOf(cursor))
    }

    @Test
    fun a_result_without_an_event_is_an_answer() {
        val cursor = MatrixCursor(arrayOf("result")).apply { addRow(arrayOf("ciphertext")) }
        assertEquals(ProviderAnswer.Answered("ciphertext", null), providerAnswerOf(cursor))
    }

    @Test
    fun a_rejected_column_is_an_always_reject() {
        val cursor = MatrixCursor(arrayOf("rejected")).apply { addRow(arrayOf("true")) }
        assertEquals(ProviderAnswer.Rejected, providerAnswerOf(cursor))
    }

    @Test
    fun json_plaintext_reaches_the_signer_as_text() {
        assertEquals(" {\"type\":\"pair-request\"}", signerPlaintext("{\"type\":\"pair-request\"}"))
        assertEquals("hello", signerPlaintext("hello"))
    }

    @Test
    fun an_empty_cursor_needs_the_user() {
        assertEquals(ProviderAnswer.NeedsApproval, providerAnswerOf(MatrixCursor(arrayOf("result"))))
    }
}
