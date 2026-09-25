package com.codedeck.plus.platform

import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.aead.PredefinedAeadParameters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Exercises the pure half of SecureIdentityStore.kt — generate once,
 * persist, re-read, regenerate on corruption — with a real in-process Tink
 * `Aead`: `KeysetHandle.generateNew` works fine on a plain JVM, and only
 * `AndroidKeysetManager`'s Keystore master key would need a device, so the
 * `Context` overload stays out of this suite (a Robolectric keystore
 * shadow would test the shadow, not the logic).
 */
class SecureIdentityStoreTest {

    companion object {
        init {
            AeadConfig.register()
        }
    }

    @get:Rule
    val tempFolder: TemporaryFolder = TemporaryFolder()

    private val hex64 = Regex("^[0-9a-f]{64}$")

    private fun newAead(): Aead =
        KeysetHandle.generateNew(PredefinedAeadParameters.AES256_GCM)
            .getPrimitive(RegistryConfiguration.get(), Aead::class.java)

    private fun newFile(): File = File(tempFolder.newFolder(), "identity.bin")

    // --- create + idempotent re-read --------------------------------------

    @Test
    fun first_call_with_no_file_creates_it_and_returns_a_64_char_hex_secret() {
        val aead = newAead()
        val file = newFile()
        val secret = readOrCreateIdentitySecretHex(aead, file)
        assertTrue(secret.matches(hex64))
        assertTrue(file.isFile)
        // The blob on disk is the AEAD ciphertext (IV + ciphertext + tag),
        // never the raw secret itself.
        assertFalse(file.readBytes().contentEquals(secret.toByteArray()))
    }

    @Test
    fun second_call_with_the_same_aead_and_file_returns_the_same_secret() {
        val aead = newAead()
        val file = newFile()
        val first = readOrCreateIdentitySecretHex(aead, file)
        val second = readOrCreateIdentitySecretHex(aead, file)
        assertEquals(first, second)
    }

    // --- corruption / key-loss recovery ------------------------------------

    @Test
    fun corrupted_ciphertext_falls_back_to_a_fresh_secret_and_persists_it() {
        val aead = newAead()
        val file = newFile()
        file.writeBytes(ByteArray(37) { (it * 7).toByte() }) // garbage, fails the GCM tag

        val recovered = readOrCreateIdentitySecretHex(aead, file)
        assertTrue(recovered.matches(hex64))

        // The recovered identity itself must now persist correctly.
        assertEquals(recovered, readOrCreateIdentitySecretHex(aead, file))
    }

    @Test
    fun a_wrong_key_cannot_read_a_file_and_falls_back_to_a_fresh_secret() {
        val originalKey = newAead()
        val file = newFile()
        val first = readOrCreateIdentitySecretHex(originalKey, file)

        val otherKey = newAead()
        val rePaired = readOrCreateIdentitySecretHex(otherKey, file)
        assertNotEquals(first, rePaired)
        assertTrue(rePaired.matches(hex64))

        // And the re-paired identity persists under the new key.
        assertEquals(rePaired, readOrCreateIdentitySecretHex(otherKey, file))
    }

    @Test
    fun a_ciphertext_that_decrypts_to_a_non_hex_payload_is_treated_as_corrupt() {
        val aead = newAead()
        val file = newFile()
        // Valid encryption with the right key and associated data — but not
        // a 64-hex-char secret; only the store's shape check rejects it.
        val blob = aead.encrypt(
            "definitely-not-a-secret".toByteArray(),
            "identity_secret_hex".toByteArray(),
        )
        file.writeBytes(blob)

        val fresh = readOrCreateIdentitySecretHex(aead, file)
        assertNotEquals("definitely-not-a-secret", fresh)
        assertTrue(fresh.matches(hex64))
        assertEquals(fresh, readOrCreateIdentitySecretHex(aead, file))
    }
}
