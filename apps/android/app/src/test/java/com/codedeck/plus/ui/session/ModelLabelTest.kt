package com.codedeck.plus.ui.session

import org.junit.Assert.assertEquals
import org.junit.Test

/** Port of `apps/mobile/src/ui/__tests__/modelLabel.test.ts` — the same
 *  cases, asserting the Kotlin port of `modelLabel` (SessionScreen.kt) keeps
 *  the reference's exact display convention for the header's model tag. */
class ModelLabelTest {
    @Test
    fun tagsTheKnownModelsLikeTheReference() {
        assertEquals("O5", modelLabel("claude-opus-5"))
        assertEquals("O4.8", modelLabel("claude-opus-4-8"))
        assertEquals("S4.6", modelLabel("claude-sonnet-4-6"))
        assertEquals("H4.5", modelLabel("claude-haiku-4-5-20251001"))
        assertEquals("F5", modelLabel("claude-fable-5"))
    }

    @Test
    fun stripsTheOneMContextMarkerBeforeLookup() {
        // These fall through the tag table without the strip and would read
        // `opus-5[1m]` in a badge with room for a handful of characters; the
        // 1M window is already visible in the context figure beside the tag.
        assertEquals("O5", modelLabel("claude-opus-5[1m]"))
        assertEquals("O4.8", modelLabel("claude-opus-4-8[1m]"))
        assertEquals("O5", modelLabel("claude-opus-5-1m"))
    }

    @Test
    fun derivesSomethingUsableForAnUnknownModel() {
        // A new release, or a custom provider profile's id.
        assertEquals("opus-9", modelLabel("claude-opus-9"))
        assertEquals("sonnet-7", modelLabel("claude-sonnet-7-20270101"))
        // Non-claude ids pass through unchanged (the header's marquee, not
        // this function, is what keeps a long one legible).
        assertEquals("kimi-k3-turbo", modelLabel("kimi-k3-turbo"))
        assertEquals(
            "Z.ai (Global) - Coding Plan/glm-5.3-flash",
            modelLabel("Z.ai (Global) - Coding Plan/glm-5.3-flash"),
        )
    }

    @Test
    fun reportsQuestionMarkRatherThanGuessingWhenNoModelIsRecorded() {
        assertEquals("?", modelLabel(null))
        assertEquals("?", modelLabel(""))
    }
}
