package com.codedeck.plus.ui.session

import com.codedeck.plus.ui.screens.blossomHost
import com.codedeck.plus.ui.screens.isBlossomUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Sizes, the upload limit, file names and server addresses as the attach flow sees them. */
class AttachmentTest {
    @Test
    fun sizesReadInKilobytesThenMegabytes() {
        assertEquals("1 KB", formatSize(12))
        assertEquals("801 KB", formatSize(820_000))
        assertEquals("5.0 MB", formatSize(5_250_000))
        assertEquals("25.0 MB", formatSize(26_214_400))
    }

    @Test
    fun aFileOverTheLimitSaysSoAndHowToSendMore() {
        assertNull(tooLargeReason("a.pdf", 1_000, 5_250_000, blossom = false))
        val relays = tooLargeReason("scan.pdf", 8_000_000, 5_250_000, blossom = false)!!
        assertTrue(relays, relays.startsWith("scan.pdf is 7.6 MB; attachments can be up to 5.0 MB.") && relays.contains("Blossom"))
        val blossom = tooLargeReason("scan.pdf", 30_000_000, 26_214_400, blossom = true)!!
        assertFalse(blossom, blossom.contains("Blossom"))
    }

    @Test
    fun aFileNameKeepsOnlySafeCharactersAndItsExtension() {
        assertEquals("my_report__v2_.pdf", safeFilename("my report (v2).pdf"))
    }

    @Test
    fun aServerAddressIsHttpsWithAHostOrHttpToAnOnion() {
        assertTrue(isBlossomUrl(" https://blossom.example.com/ "))
        assertTrue(isBlossomUrl("http://abcdef.onion:3000"))
        assertFalse(isBlossomUrl("http://blossom.example.com"))
        assertFalse(isBlossomUrl("http://evil.onion.example.com"))
        assertFalse(isBlossomUrl("http://.onion"))
        assertFalse(isBlossomUrl("blossom.example.com"))
        assertFalse(isBlossomUrl("https://"))
        assertFalse(isBlossomUrl("https:///x"))
        assertEquals("blossom.example.com", blossomHost("https://blossom.example.com/upload"))
        assertEquals("abcdef.onion:3000", blossomHost("http://abcdef.onion:3000/"))
    }
}
