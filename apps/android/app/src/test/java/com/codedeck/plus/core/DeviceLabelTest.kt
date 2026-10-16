package com.codedeck.plus.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The device name the phone sends with every session-key grant — what the
 * bridge shows in its terminal allowlist and in a refusal to open a terminal.
 */
class DeviceLabelTest {
    @Test
    fun prefixesTheManufacturerOnlyWhenTheModelDoesNotNameIt() {
        // "Pixel 8a" already names its make, so a make adds nothing.
        assertEquals("Pixel 8a", deviceLabel("Google", "Pixel 8a"))
        // A bare model code names no make on its own.
        assertEquals("Samsung SM-S918B", deviceLabel("samsung", "SM-S918B"))
        // Already prefixed: never doubled.
        assertEquals("Samsung Galaxy S23", deviceLabel("Samsung", "Samsung Galaxy S23"))
    }

    @Test
    fun fallsBackWhenOneHalfIsMissing() {
        assertEquals("Google", deviceLabel("Google", ""))
        assertEquals("Pixel 8a", deviceLabel("", "Pixel 8a"))
        assertEquals("Android device", deviceLabel("", ""))
    }

    @Test
    fun capitalizesALowercaseManufacturer() {
        // Build.MANUFACTURER is often lowercase ("samsung").
        assertEquals("Samsung SM-S918B", deviceLabel("samsung", "SM-S918B"))
    }
}
