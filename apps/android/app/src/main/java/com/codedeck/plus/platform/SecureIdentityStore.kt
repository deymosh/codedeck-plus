package com.codedeck.plus.platform

import android.content.Context
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom

/** The bare alias `withMasterKeyUri`'s `android-keystore://` URI names below
 *  — needed on its own to reach into the Android Keystore directly when the
 *  Tink wrapper's own key is unrecoverable (see [readOrCreateIdentitySecretHex]). */
private const val KEYSTORE_MASTER_KEY_ALIAS = "codedeck_identity_master_key"

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
 * plain JVM, where no Android Keystore exists. If the Keystore-backed
 * keyset itself is unusable (a stale/invalidated master key — see
 * `buildIdentityKeysetHandle`'s call site below), that is treated the same
 * as a corrupted `identity.bin`: wiped and rebuilt from scratch rather than
 * left to crash the caller.
 */
fun readOrCreateIdentitySecretHex(context: Context): String {
    AeadConfig.register()
    val identityFile = File(context.filesDir, "identity.bin")
    val keysetHandle = runCatching { buildIdentityKeysetHandle(context) }.getOrElse {
        // The Keystore-backed master key this keyset references can go stale
        // independently of anything this app does — an emulator that has been
        // through enough install/uninstall churn, or the OS invalidating a
        // real device's key out from under it — and `AndroidKeysetManager`
        // does NOT self-heal from that: `.build()` throws instead. Uncaught,
        // that took down `StayConnectedService.onCreate()` in a crash loop
        // the OS just kept restarting (device-observed 2026-09-19).
        //
        // Clearing the app's OWN storage is not enough to recover from this —
        // verified live on the crashing emulator: `pm clear` (which wipes
        // `identity.bin` and the keyset `SharedPreferences` blob same as
        // below) still hit the identical `InvalidKeyException` on the very
        // next launch. The broken entry lives in the Keystore daemon itself,
        // keyed by alias, independent of this app's own files — so recovery
        // needs deleting THAT entry too, not just what Tink wrapped around
        // it. Both the alias and the app-side blobs are exactly as
        // recoverable as "no identity yet" per this function's own
        // philosophy above: wipe all three and mint a fresh keyset the same
        // way a genuine first run would.
        runCatching {
            val keyStore = KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)
            if (keyStore.containsAlias(KEYSTORE_MASTER_KEY_ALIAS)) {
                keyStore.deleteEntry(KEYSTORE_MASTER_KEY_ALIAS)
            }
        }
        context.getSharedPreferences("codedeck_identity_keyset_prefs", Context.MODE_PRIVATE)
            .edit().clear().apply()
        identityFile.delete()
        buildIdentityKeysetHandle(context)
    }
    val aead = keysetHandle.getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    return readOrCreateIdentitySecretHex(aead, identityFile)
}

private fun buildIdentityKeysetHandle(context: Context) =
    AndroidKeysetManager.Builder()
        .withSharedPref(context, "codedeck_identity_keyset", "codedeck_identity_keyset_prefs")
        .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
        .withMasterKeyUri("android-keystore://$KEYSTORE_MASTER_KEY_ALIAS")
        .build()
        .keysetHandle
