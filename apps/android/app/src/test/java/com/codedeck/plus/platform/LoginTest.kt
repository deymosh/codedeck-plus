package com.codedeck.plus.platform

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginTest {
    private val pubkey = "ab".repeat(32)

    @Test
    fun stored_logins_decode() {
        assertEquals(Login.OnDevice, decodeLogin("device", null, null))
        assertEquals(Login.SignerApp("com.example", pubkey), decodeLogin("signer", "com.example", pubkey))
    }

    @Test
    fun incomplete_or_unknown_logins_decode_to_none() {
        assertNull(decodeLogin(null, null, null))
        assertNull(decodeLogin("other", null, null))
        assertNull(decodeLogin("signer", null, pubkey))
        assertNull(decodeLogin("signer", "com.example", null))
        assertNull(decodeLogin("signer", "com.example", "npub1notahexkey"))
    }

    @Test
    fun the_signer_is_asked_for_every_kind_the_core_signs_and_nip44() {
        val asked = Json.parseToJsonElement(signerPermissionsJson()).jsonArray.map { it.jsonObject }
        fun type(o: kotlinx.serialization.json.JsonObject) = o.getValue("type").jsonPrimitive.content
        val kinds = asked.filter { type(it) == "sign_event" }.map { it.getValue("kind").jsonPrimitive.int }.toSet()
        // Commands (pair-request included), relay AUTH, Blossom upload auth.
        assertEquals(setOf(4515, 22242, 24242), kinds)
        val types = asked.map { type(it) }.toSet()
        assertTrue(types.containsAll(listOf("nip44_encrypt", "nip44_decrypt")))
    }
}
