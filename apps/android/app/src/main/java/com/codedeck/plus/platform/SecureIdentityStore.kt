package com.codedeck.plus.platform

import android.content.Context
import androidx.core.content.edit
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
 *  Tink wrapper's own key is unrecoverable (see [KeyVault]). */
private const val KEYSTORE_MASTER_KEY_ALIAS = "codedeck_identity_master_key"

/** Associated data binding each file's ciphertext to what it holds, so one
 *  secret's blob can never be read back as another. */
private const val IDENTITY_LABEL = "identity_secret_hex"
private const val SESSION_KEYS_LABEL = "session_keys"

private val HEX64 = Regex("^[0-9a-f]{64}$")

/** A fresh 32-byte secret, lowercase hex. */
fun freshSecretHex(): String =
    ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

/** The `aead`-encrypted secret in `file`, or `null` when there is none or it
 *  does not decrypt to a 64-char lowercase hex string. */
fun readSecretHex(aead: Aead, file: File, label: String): String? {
    val secret = runCatching { String(aead.decrypt(file.readBytes(), label.toByteArray())) }.getOrNull()
    return secret?.takeIf { it.matches(HEX64) }
}

/** Encrypt `secretHex` with `aead` into `file`. */
fun writeSecretHex(aead: Aead, file: File, label: String, secretHex: String) {
    require(secretHex.matches(HEX64)) { "not a 64-char hex secret" }
    file.parentFile?.mkdirs()
    file.writeBytes(aead.encrypt(secretHex.toByteArray(), label.toByteArray()))
}

/**
 * Reads the persisted, `aead`-encrypted secret from `file`, or generates a
 * fresh one, writes it, and returns it — idempotent: a second call with the
 * same `aead` and `file` returns the SAME secret. Any read/decrypt failure
 * (missing file, corrupted ciphertext, wrong key), or a value that is not a
 * 64-char lowercase hex string, counts as "none yet": losing a persisted key
 * is recoverable (re-pair); silently crashing on launch is not.
 */
fun readOrCreateSecretHex(aead: Aead, file: File, label: String): String =
    readSecretHex(aead, file, label) ?: freshSecretHex().also { writeSecretHex(aead, file, label, it) }

/** [readOrCreateSecretHex] for the identity file. */
fun readOrCreateIdentitySecretHex(aead: Aead, file: File): String =
    readOrCreateSecretHex(aead, file, IDENTITY_LABEL)

/**
 * The phone's session keys (the core's opaque ring, which holds their
 * secrets), encrypted with `aead` in `file` — never in the database. An
 * unreadable file loads as nothing: the core then makes fresh keys and
 * grants them to every bridge again.
 */
class KeystoreSessionKeyStore(private val aead: Aead, private val file: File) : UniffiSessionKeyStore {
    private val associatedData = SESSION_KEYS_LABEL.toByteArray()

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
 * The app's secrets, each encrypted with a Tink AES-256-GCM keyset whose
 * master key never leaves the Android Keystore (`AndroidKeysetManager`
 * stores the keyset as a `SharedPreferences` blob wrapped by that key). No
 * secret is ever written anywhere in plaintext, the core's database
 * included:
 * - `identity.bin`: the identity key, for a login that keeps it on this
 *   device (created here, or imported). A NIP-55 signer login has none.
 * - `session_keys.bin`: the session keys (see `docs/CLIENT.md`, "Keys").
 *
 * If the Keystore-backed keyset itself is unusable (a stale or invalidated
 * master key), every secret is as lost as a corrupted file: all of it is
 * wiped and rebuilt from scratch rather than left to crash the caller.
 */
class KeyVault(context: Context) {
    private val app = context.applicationContext
    private val identityFile = File(app.filesDir, "identity.bin")
    private val sessionKeysFile = File(app.filesDir, "session_keys.bin")
    private val aead: Aead by lazy { buildAead() }

    /** The on-device identity's secret, or `null` when there is none. */
    fun identitySecretHex(): String? = readSecretHex(aead, identityFile, IDENTITY_LABEL)

    /** Replace the on-device identity with `secretHex` (created or imported). */
    fun setIdentity(secretHex: String) = writeSecretHex(aead, identityFile, IDENTITY_LABEL, secretHex)

    /** Forget the on-device identity (a signer app holds it instead). */
    fun clearIdentity() {
        identityFile.delete()
    }

    /** Where the core keeps the session keys. */
    fun sessionKeyStore(): UniffiSessionKeyStore = KeystoreSessionKeyStore(aead, sessionKeysFile)

    /** Start over with fresh session keys (a new identity gets new ones):
     *  the core makes them on its next start. */
    fun resetSession() {
        sessionKeysFile.delete()
    }

    private fun buildAead(): Aead {
        AeadConfig.register()
        val keysetHandle = runCatching { buildKeysetHandle() }.getOrElse {
            // The Keystore-backed master key this keyset references can go
            // stale independently of anything this app does — an emulator
            // after enough install/uninstall churn, or the OS invalidating a
            // real device's key — and `AndroidKeysetManager` does NOT
            // self-heal: `.build()` throws. Uncaught, that took down
            // `StayConnectedService.onCreate()` in a crash loop
            // (device-observed 2026-09-19). Clearing the app's own storage
            // is not enough either: the broken entry lives in the Keystore
            // daemon, keyed by alias. So delete that entry too, drop the
            // app-side blobs, and mint a fresh keyset as a first run would.
            runCatching {
                val keyStore = KeyStore.getInstance("AndroidKeyStore")
                keyStore.load(null)
                if (keyStore.containsAlias(KEYSTORE_MASTER_KEY_ALIAS)) {
                    keyStore.deleteEntry(KEYSTORE_MASTER_KEY_ALIAS)
                }
            }
            app.getSharedPreferences("codedeck_identity_keyset_prefs", Context.MODE_PRIVATE)
                .edit { clear() }
            identityFile.delete()
            sessionKeysFile.delete()
            buildKeysetHandle()
        }
        return keysetHandle.getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    private fun buildKeysetHandle() =
        AndroidKeysetManager.Builder()
            .withSharedPref(app, "codedeck_identity_keyset", "codedeck_identity_keyset_prefs")
            .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
            .withMasterKeyUri("android-keystore://$KEYSTORE_MASTER_KEY_ALIAS")
            .build()
            .keysetHandle
}
