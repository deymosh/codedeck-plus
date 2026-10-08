package com.codedeck.plus.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class ProvidersTest {
    @Test
    fun a_context_window_reads_as_people_write_it() {
        assertEquals("1M", contextSize(1_000_000u))
        assertEquals("1M", contextSize(1_048_576u))
        assertEquals("200K", contextSize(200_000u))
        assertEquals("128K", contextSize(131_072u))
        assertEquals("33K", contextSize(32_768u + 1u))
        assertEquals("512", contextSize(512u))
    }
}
