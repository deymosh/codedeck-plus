package com.codedeck.plus.platform

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put
import org.json.JSONObject
import uniffi.client_ffi.UniffiIdentitySigner
import uniffi.client_ffi.UniffiSignerException
import java.util.UUID

/** Event kinds the core has the identity sign: commands to a bridge, relay
 *  AUTH, and Blossom upload auth. Asked for up front so the signer can
 *  answer them in the background. */
private val SIGNED_KINDS = listOf(4515, 22242, 24242)

/** How long a request that needs the user (the signer app's own prompt)
 *  may wait before it fails. */
private const val USER_APPROVAL_TIMEOUT_MS = 120_000L

/** An installed app that answers `nostrsigner:` intents. */
data class SignerAppInfo(val packageName: String, val label: String)

/** Every installed NIP-55 signer app, by label. */
fun installedSignerApps(context: Context): List<SignerAppInfo> {
    val pm = context.packageManager
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
    return pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        .map { SignerAppInfo(it.activityInfo.packageName, it.loadLabel(pm).toString()) }
        .distinctBy { it.packageName }
        .sortedBy { it.label.lowercase() }
}

/** The `get_public_key` request to `packageName`, asking up front for
 *  everything the core will need so later requests can be answered without
 *  the user. */
fun getPublicKeyIntent(packageName: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")).apply {
        `package` = packageName
        putExtra("type", "get_public_key")
        putExtra("permissions", signerPermissionsJson())
    }

/** The NIP-55 permission list [getPublicKeyIntent] asks for. */
internal fun signerPermissionsJson(): String = buildJsonArray {
    for (kind in SIGNED_KINDS) {
        addJsonObject {
            put("type", "sign_event")
            put("kind", kind)
        }
    }
    addJsonObject { put("type", "nip44_encrypt") }
    addJsonObject { put("type", "nip44_decrypt") }
}.toString()

/**
 * The phone identity held by a NIP-55 signer app. Each call first asks the
 * signer's content provider, which answers in the background once the user
 * let it remember the permission; when it cannot (no remembered permission
 * yet), the request goes through the signer's own activity, which needs the
 * user ([SignerIntents]). A request the user chose to always reject fails
 * without asking again. Calls block: the core makes them on a worker thread.
 */
class Nip55Signer(
    context: Context,
    private val packageName: String,
    private val pubkeyHex: String,
) : UniffiIdentitySigner {
    private val app = context.applicationContext

    override fun pubkeyHex(): String = pubkeyHex

    override fun signEvent(unsignedEventJson: String): String {
        resolve("SIGN_EVENT", unsignedEventJson, "")?.let { (result, event) ->
            return event ?: withSignature(unsignedEventJson, result)
        }
        val answer = viaActivity("sign_event", unsignedEventJson, peer = null)
        return answer.event ?: withSignature(unsignedEventJson, answer.result)
    }

    override fun nip44Encrypt(peerPubkeyHex: String, plaintext: String): String =
        resolve("NIP44_ENCRYPT", plaintext, peerPubkeyHex)?.first
            ?: viaActivity("nip44_encrypt", plaintext, peerPubkeyHex).result

    override fun nip44Decrypt(peerPubkeyHex: String, ciphertext: String): String =
        resolve("NIP44_DECRYPT", ciphertext, peerPubkeyHex)?.first
            ?: viaActivity("nip44_decrypt", ciphertext, peerPubkeyHex).result

    /** The content provider's `(result, event)`, or `null` when it cannot
     *  answer without the user. Throws when the user always rejects this. */
    private fun resolve(method: String, payload: String, peer: String): Pair<String, String?>? {
        val uri = Uri.parse("content://$packageName.$method")
        val cursor: Cursor = runCatching {
            // NIP-55 passes the arguments in the projection slot.
            app.contentResolver.query(uri, arrayOf(payload, peer, pubkeyHex), null, null, null)
        }.getOrNull() ?: return null
        cursor.use {
            if (it.getColumnIndex("rejected") >= 0) throw failed("the signer rejected the request")
            if (!it.moveToFirst()) return null
            val result = it.getColumnIndex("result").takeIf { i -> i >= 0 }?.let { i -> it.getString(i) } ?: return null
            val event = it.getColumnIndex("event").takeIf { i -> i >= 0 }?.let { i -> it.getString(i) }
            return result to event?.takeIf { e -> e.isNotBlank() }
        }
    }

    private fun viaActivity(type: String, payload: String, peer: String?): SignerAnswer {
        val id = UUID.randomUUID().toString()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$payload")).apply {
            `package` = packageName
            putExtra("type", type)
            putExtra("id", id)
            putExtra("current_user", pubkeyHex)
            if (peer != null) putExtra("pubkey", peer)
        }
        val answer = SignerIntents.request(app, intent, USER_APPROVAL_TIMEOUT_MS)
            ?: throw failed("the signer did not answer")
        if (answer.rejected) throw failed("the signer rejected the request")
        if (answer.id != null && answer.id != id) throw failed("the signer answered another request")
        return answer
    }

    private fun failed(detail: String) = UniffiSignerException.Failed(detail)

    /** A signed event built from `unsigned` and a bare `signature`, for a
     *  signer that returns only the signature. The core verifies it. */
    private fun withSignature(unsigned: String, signature: String): String =
        JSONObject(unsigned).put("sig", signature).toString()
}
