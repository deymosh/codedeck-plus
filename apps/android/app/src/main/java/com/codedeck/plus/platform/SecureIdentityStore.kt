package com.codedeck.plus.platform

import android.content.Context
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import java.io.File
import java.security.SecureRandom

/**
 * Reads the persisted, `aead`-encrypted identity secret from `file`, or
 * generates a fresh 32-byte hex secret, encrypts it, writes it to `file`,
 * and returns it — idempotent: a second call with the same `aead` and
 * `file` returns the SAME secret. Any read/decrypt failure (missing file,
 * corrupted ciphertext, wrong key), or a value that decrypts but is not a
 * 64-char lowercase hex string, is treated the same as "no identity yet"
 * and a fresh one is generated and written: losing a persisted identity is
 * recoverable (re-pair); silently crashing on first launch is not.
 */
fun readOrCreateIdentitySecretHex(aead: Aead, file: File): String {
    val associatedData = "identity_secret_hex".toByteArray()
    val existing = runCatching {
        val ciphertext = file.readBytes()
        String(aead.decrypt(ciphertext, associatedData))
    }.getOrNull()
    if (existing != null && existing.matches(Regex("^[0-9a-f]{64}$"))) return existing
    val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }
    val ciphertext = aead.encrypt(fresh.toByteArray(), associatedData)
    file.parentFile?.mkdirs()
    file.writeBytes(ciphertext)
    return fresh
}

/**
 * The production entry point for [readOrCreateIdentitySecretHex]: builds
 * the real Keystore-backed `Aead` — `AndroidKeysetManager` stores the
 * keyset as a `SharedPreferences` blob, itself encrypted by a master key
 * that never leaves the Android Keystore — and points it at
 * `filesDir/identity.bin`. Kept as a separate overload so the pure
 * generate-once / persist / re-read logic above stays unit-testable on a
 * plain JVM, where no Android Keystore exists.
 */
fun readOrCreateIdentitySecretHex(context: Context): String {
    AeadConfig.register()
    val keysetHandle = AndroidKeysetManager.Builder()
        .withSharedPref(context, "codedeck_identity_keyset", "codedeck_identity_keyset_prefs")
        .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
        .withMasterKeyUri("android-keystore://codedeck_identity_master_key")
        .build()
        .keysetHandle
    val aead = keysetHandle.getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    return readOrCreateIdentitySecretHex(aead, File(context.filesDir, "identity.bin"))
}
