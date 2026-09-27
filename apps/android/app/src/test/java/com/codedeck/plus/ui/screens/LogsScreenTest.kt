package com.codedeck.plus.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class LogsScreenTest {
    @Test
    fun a_line_is_coloured_by_its_logcat_level() {
        assertEquals('W', logLineLevel("09-27 16:43:03.737 W/codedeck(29969): client_ffi::observer: action_failed"))
        assertEquals('E', logLineLevel("09-27 15:59:39.717 E/AndroidRuntime(25191): FATAL EXCEPTION: main"))
        assertEquals('I', logLineLevel("09-27 15:50:32.004 I/CodeDeckSigner(22395): NIP44_ENCRYPT : asking"))
        assertEquals(null, logLineLevel("\tat com.sun.jna.Native.load(Native.java:695)"))
    }
}
