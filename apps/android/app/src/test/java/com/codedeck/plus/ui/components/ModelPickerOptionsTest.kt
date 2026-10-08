package com.codedeck.plus.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.client_ffi.UniffiModelEntry

class ModelPickerOptionsTest {
    @Test
    fun `models are grouped by provider, in the order providers first appear`() {
        val options = modelPickerOptions(
            listOf(
                UniffiModelEntry("OpenCode Go/glm-5.3-flash", "glm-5.3-flash", "OpenCode Go", null, emptyList()),
                UniffiModelEntry("Z.ai/glm-5.3-flash", "glm-5.3-flash", "Z.ai", null, emptyList()),
                UniffiModelEntry("OpenCode Go/minimax-m3", null, "OpenCode Go", null, emptyList()),
            ),
        )
        assertEquals(
            listOf(
                PickerOption("OpenCode Go/glm-5.3-flash", "glm-5.3-flash", "OpenCode Go"),
                PickerOption("OpenCode Go/minimax-m3", "OpenCode Go/minimax-m3", "OpenCode Go"),
                PickerOption("Z.ai/glm-5.3-flash", "glm-5.3-flash", "Z.ai"),
            ),
            options,
        )
    }
}
