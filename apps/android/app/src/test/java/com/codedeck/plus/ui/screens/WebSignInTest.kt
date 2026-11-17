package com.codedeck.plus.ui.screens

import com.codedeck.plus.ui.DesignFixtures
import org.junit.Assert.assertEquals
import org.junit.Test

class WebSignInTest {
    private val machine = DesignFixtures.workstation

    @Test
    fun the_page_is_served_at_the_root_of_each_wss_endpoint() {
        assertEquals(listOf("https://192.168.1.20:7447/", "https://workstation.tail1234.ts.net:7447/"), webPageUrls(machine))
        val more = machine.copy(
            directAdvertised = listOf("wss://192.168.1.20:7447/", "ws://abcdef.onion:7447", "wss://abcdef.onion:7447"),
            directEndpoints = listOf("wss://192.168.1.20:7447"),
        )
        assertEquals(listOf("https://192.168.1.20:7447/"), webPageUrls(more))
    }

    @Test
    fun a_scanned_code_is_sent_only_to_the_machine_its_qr_names() {
        val npub = machine.npub
        assertEquals(ScannedSignIn.Code("K7QM-4XTR"), readSignInQr(" codedeck://web-sign-in?machine=$npub&code=K7QM-4XTR\n", npub))
        assertEquals(ScannedSignIn.OtherMachine, readSignInQr("codedeck://web-sign-in?machine=npub1other&code=K7QM-4XTR", npub))
        assertEquals(ScannedSignIn.OtherMachine, readSignInQr("codedeck://web-sign-in?code=K7QM-4XTR", npub))
        assertEquals(ScannedSignIn.NotSignIn, readSignInQr("codedeck://pair?npub=$npub&token=x", npub))
        assertEquals(ScannedSignIn.NotSignIn, readSignInQr("codedeck://web-sign-in?machine=$npub&code=", npub))
    }

    @Test
    fun the_fingerprint_reads_as_a_browsers_certificate_viewer_writes_it() {
        val pin = "3f9a1c0e7b2d4a58c6e1f0b9d8a7c6e5f4d3c2b1a09f8e7d6c5b4a3928170615"
        assertEquals(
            "3F:9A:1C:0E:7B:2D:4A:58\nC6:E1:F0:B9:D8:A7:C6:E5\nF4:D3:C2:B1:A0:9F:8E:7D\n6C:5B:4A:39:28:17:06:15",
            fingerprintLines(pin),
        )
    }
}
