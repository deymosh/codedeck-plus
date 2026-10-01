package com.codedeck.plus.platform

import android.content.Context
import androidx.core.content.edit
import uniffi.client_ffi.UniffiIdentitySigner
import uniffi.client_ffi.localIdentitySigner

/**
 * How this install holds its Nostr identity. Chosen once on the welcome
 * screen; the core does not start before there is one.
 */
sealed interface Login {
    /** The identity key lives on this device, in the [KeyVault]. */
    data object OnDevice : Login

    /** A NIP-55 signer app holds the identity. */
    data class SignerApp(val packageName: String, val pubkeyHex: String) : Login
}

private const val PREFS = "codedeck_login"
private const val KIND = "kind"
private const val PACKAGE = "package"
private const val PUBKEY = "pubkey"

/** Where the [Login] choice is kept. Nothing secret: a package name and a
 *  public key at most. */
class LoginStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(): Login? = decodeLogin(prefs.getString(KIND, null), prefs.getString(PACKAGE, null), prefs.getString(PUBKEY, null))

    fun save(login: Login) {
        // Committed synchronously: the login must be on disk before the core
        // starts, and the service reads it right after.
        prefs.edit(commit = true) {
            clear()
            when (login) {
                Login.OnDevice -> putString(KIND, "device")
                is Login.SignerApp -> putString(KIND, "signer")
                    .putString(PACKAGE, login.packageName)
                    .putString(PUBKEY, login.pubkeyHex)
            }
        }
    }

    fun clear() {
        prefs.edit(commit = true) { clear() }
    }
}

/** The core's database file (in the app's database directory). */
const val CORE_DATABASE = "codedeck.db"

/** Forget the login and everything kept for it: the stored choice, the
 *  on-device key, the session keys, and the core's database (paired
 *  machines, transcripts and settings all belong to that identity). The
 *  core must already be shut down. */
fun forgetLogin(context: Context) {
    LoginStore(context).clear()
    KeyVault(context).apply {
        clearIdentity()
        resetSession()
    }
    context.applicationContext.deleteDatabase(CORE_DATABASE)
}

/** The stored fields back into a [Login]; `null` for anything incomplete. */
internal fun decodeLogin(kind: String?, packageName: String?, pubkeyHex: String?): Login? = when (kind) {
    "device" -> Login.OnDevice
    "signer" -> if (!packageName.isNullOrBlank() && pubkeyHex != null && pubkeyHex.matches(Regex("^[0-9a-f]{64}$"))) {
        Login.SignerApp(packageName, pubkeyHex)
    } else {
        null
    }
    else -> null
}

/** The core's identity signer for `login`, or `null` when an on-device
 *  login has lost its key (the keystore was reset): the user chooses again. */
fun identitySignerFor(context: Context, login: Login, vault: KeyVault): UniffiIdentitySigner? = when (login) {
    Login.OnDevice -> vault.identitySecretHex()?.let { localIdentitySigner(it) }
    is Login.SignerApp -> Nip55Signer(context, login.packageName, login.pubkeyHex)
}
