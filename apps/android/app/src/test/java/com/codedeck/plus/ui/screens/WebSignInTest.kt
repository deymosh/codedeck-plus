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
}
