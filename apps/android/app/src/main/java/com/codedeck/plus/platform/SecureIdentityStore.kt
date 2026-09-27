package com.codedeck.plus.platform

import android.content.Context
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import uniffi.client_ffi.UniffiSessionKeyStore
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom

/** The bare alias `withMasterKeyUri`'s `android-keystore://` URI names below
 *  — needed on its own to reach into the Android Keystore directly when the
 *  Tink wrapper's own key is unrecoverable (see [keystoreAead]). */
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

/** Where the identity secret is kept, encrypted with [keystoreAead]. */
fun identityFile(context: Context): File = File(context.filesDir, "identity.bin")

/** Where the session keys are kept, encrypted with [keystoreAead]. */
fun sessionKeysFile(context: Context): File = File(context.filesDir, "session_keys.bin")

/**
 * The phone's session keys (the core's opaque ring, which holds their
 * secrets), encrypted with `aead` in `file` — never in the database. An
 * unreadable file loads as nothing: the core then makes fresh keys and
 * grants them to every bridge again.
 */
class KeystoreSessionKeyStore(private val aead: Aead, private val file: File) : UniffiSessionKeyStore {
    private val associatedData = "session_keys".toByteArray()

    override fun load(): String? = runCatching {
        String(aead.decrypt(file.readBytes(), associatedData))
    }.getOrNull()

    override fun save(ring: String) {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.path + ".tmp")
            tmp.writeBytes(aead.encrypt(ring.toByteArray(), associatedData))
            if (!tmp.renameTo(file)) {
                file.delete()
                tmp.renameTo(file)
            }
        }
    }
}

/**
 * The real Keystore-backed `Aead` the identity and session-key files are
 * encrypted with — `AndroidKeysetManager` stores the keyset as a
 * `SharedPreferences` blob, itself encrypted by a master key that never
 * leaves the Android Keystore. Kept apart from the file logic above so it
 * stays unit-testable on a plain JVM, where no Android Keystore exists. If
 * the Keystore-backed keyset itself is unusable (a stale/invalidated master
 * key — see `buildIdentityKeysetHandle`'s call site below), that is treated
 * the same as a corrupted `identity.bin`: everything it encrypted is wiped
 * and it is rebuilt from scratch rather than left to crash the caller.
 */
fun keystoreAead(context: Context): Aead {
    AeadConfig.register()
    val identityFile = identityFile(context)
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
        sessionKeysFile(context).delete()
        buildIdentityKeysetHandle(context)
    }
    return keysetHandle.getPrimitive(RegistryConfiguration.get(), Aead::class.java)
}

private fun buildIdentityKeysetHandle(context: Context) =
    AndroidKeysetManager.Builder()
        .withSharedPref(context, "codedeck_identity_keyset", "codedeck_identity_keyset_prefs")
        .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
        .withMasterKeyUri("android-keystore://$KEYSTORE_MASTER_KEY_ALIAS")
        .build()
        .keysetHandle
