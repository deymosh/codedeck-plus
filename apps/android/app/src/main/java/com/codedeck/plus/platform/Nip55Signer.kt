package com.codedeck.plus.platform

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.util.Log
import androidx.core.net.toUri
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.put
import org.json.JSONObject
import uniffi.client_ffi.UniffiIdentitySigner
import uniffi.client_ffi.UniffiSignerException
import uniffi.client_ffi.npubOf
import java.util.UUID

/** Event kinds the core has the identity sign: commands to a bridge, relay
 *  AUTH, and Blossom upload auth. Asked for up front so the signer can
 *  answer them in the background. */
private val SIGNED_KINDS = listOf(4515, 22242, 24242)

/** How long a request that needs the user (the signer app's own prompt)
 *  may wait before it fails. */
private const val USER_APPROVAL_TIMEOUT_MS = 120_000L

/** How long to wait before asking a content provider whose query failed
 *  (rather than answered) once more: the signer's process may be starting. */
private const val PROVIDER_RETRY_MS = 300L

/** Logcat tag for why a request did or did not get a background answer.
 *  Payloads, keys and results are never logged. */
internal const val SIGNER_LOG_TAG = "CodeDeckSigner"
private const val TAG = SIGNER_LOG_TAG

/** An installed app that answers `nostrsigner:` intents. */
data class SignerAppInfo(val packageName: String, val label: String)

/** Every installed NIP-55 signer app, by label. */
fun installedSignerApps(context: Context): List<SignerAppInfo> {
    val pm = context.packageManager
    val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri())
    return pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        .map { SignerAppInfo(it.activityInfo.packageName, it.loadLabel(pm).toString()) }
        .distinctBy { it.packageName }
        .sortedBy { it.label.lowercase() }
}

/** The `get_public_key` request to `packageName`, asking up front for
 *  everything the core will need so later requests can be answered without
 *  the user. */
fun getPublicKeyIntent(packageName: String): Intent =
    Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri()).apply {
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

/** What a signer's content provider said to one request. */
internal sealed interface ProviderAnswer {
    data class Answered(val result: String, val event: String?) : ProviderAnswer

    /** No remembered permission (NIP-55: a null cursor): only the user can
     *  answer, in the signer's own activity. */
    data object NeedsApproval : ProviderAnswer

    /** The user chose to always reject this request. */
    data object Rejected : ProviderAnswer

    /** The query itself failed: that says nothing about permissions. */
    data class Failed(val error: Throwable) : ProviderAnswer
}

/**
 * The phone identity held by a NIP-55 signer app. Each call first asks the
 * signer's content provider, which answers in the background once the user
 * let it remember the permission. Only when the provider says it holds no
 * remembered permission does the request go through the signer's own
 * activity, which needs the user ([SignerIntents], which notifies while the
 * app is in the background). A request the user chose to always reject
 * fails without asking again, and so does one whose provider query failed
 * twice while the app is in the background: a failure is not a missing
 * permission, so it is not worth interrupting the user for. Calls block:
 * the core makes them on a worker thread.
 */
class Nip55Signer(
    context: Context,
    private val packageName: String,
    private val pubkeyHex: String,
) : UniffiIdentitySigner {
    private val app = context.applicationContext

    /** The identity as the signer's current user. NIP-55 names pubkeys in
     *  hex, but a signer that keys its accounts by npub (Amber's approval
     *  activity) finds the account only from an npub; its content provider
     *  takes either. */
    private val currentUser: String = npubOf(pubkeyHex) ?: pubkeyHex

    override fun pubkeyHex(): String = pubkeyHex

    override fun signEvent(unsignedEventJson: String): String {
        val kind = runCatching { JSONObject(unsignedEventJson).getInt("kind") }.getOrNull()
        // The second slot is the request's pubkey: for a signature, the
        // event's author, which is the identity.
        val answer = ask("SIGN_EVENT", "kind $kind", unsignedEventJson, pubkeyHex)
            ?: viaActivity("sign_event", unsignedEventJson, peer = null).let { ProviderAnswer.Answered(it.result, it.event) }
        return answer.event ?: withSignature(unsignedEventJson, answer.result)
    }

    override fun nip44Encrypt(peerPubkeyHex: String, plaintext: String): String {
        val text = signerPlaintext(plaintext)
        return ask("NIP44_ENCRYPT", "", text, peerPubkeyHex)?.result
            ?: viaActivity("nip44_encrypt", text, peerPubkeyHex).result
    }

    override fun nip44Decrypt(peerPubkeyHex: String, ciphertext: String): String =
        ask("NIP44_DECRYPT", "", ciphertext, peerPubkeyHex)?.result
            ?: viaActivity("nip44_decrypt", ciphertext, peerPubkeyHex).result

    /** The provider's answer, or `null` when only the user can give one (go
     *  through the activity). Throws when the request is always rejected, or
     *  when the provider failed twice while the app is in the background. */
    private fun ask(method: String, what: String, payload: String, peer: String): ProviderAnswer.Answered? {
        var answer = resolve(method, payload, peer)
        if (answer is ProviderAnswer.Failed) {
            Thread.sleep(PROVIDER_RETRY_MS)
            answer = resolve(method, payload, peer)
        }
        return when (answer) {
            is ProviderAnswer.Answered -> answer
            ProviderAnswer.Rejected -> {
                Log.i(TAG, "$method $what: always rejected in the signer")
                throw failed("the signer rejected the request")
            }
            ProviderAnswer.NeedsApproval -> {
                Log.i(TAG, "$method $what: the signer holds no remembered permission; asking the user")
                null
            }
            is ProviderAnswer.Failed -> {
                Log.w(TAG, "$method $what: the signer's provider failed (${answer.error.javaClass.simpleName})")
                if (!SignerIntents.visible) throw failed("the signer did not answer")
                null
            }
        }
    }

    private fun resolve(method: String, payload: String, peer: String): ProviderAnswer {
        val uri = "content://$packageName.$method".toUri()
        val cursor: Cursor = try {
            // NIP-55 passes the arguments in the projection slot.
            app.contentResolver.query(uri, arrayOf(payload, peer, currentUser), null, null, null)
                ?: return ProviderAnswer.NeedsApproval
        } catch (e: Exception) {
            return ProviderAnswer.Failed(e)
        }
        return cursor.use { providerAnswerOf(it) }
    }

    private fun viaActivity(type: String, payload: String, peer: String?): SignerAnswer {
        val id = UUID.randomUUID().toString()
        val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:$payload".toUri()).apply {
            `package` = packageName
            putExtra("type", type)
            putExtra("id", id)
            putExtra("current_user", currentUser)
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
     *  signer that returns only the signature. The core verifies it; an
     *  `unsigned` the JSON parser refuses is a signer failure like any
     *  other (same type `ask`/`viaActivity` throw). */
    private fun withSignature(unsigned: String, signature: String): String =
        try {
            JSONObject(unsigned).put("sig", signature).toString()
        } catch (e: Exception) {
            throw failed("the signer's answer is not valid JSON: ${e.javaClass.simpleName}")
        }
}

/**
 * The plaintext to hand a signer for encryption. A signer may file an
 * encryption under a permission that depends on what the plaintext looks
 * like, and Amber does so inconsistently for JSON that is not a Nostr event
 * (the core's messages): its content provider files anything starting with
 * `{` as an event, while its approval activity, failing to parse one, files
 * it as clear text — so an "always" given in the activity is never found in
 * the background. A leading space makes both see clear text; JSON ignores it,
 * so the bridge decodes the message unchanged.
 */
internal fun signerPlaintext(plaintext: String): String =
    if (plaintext.startsWith("{")) " $plaintext" else plaintext

/** Read a provider's cursor: a `rejected` column, a first row with `result`
 *  (and `event` for a signature), or nothing (only the user can answer). */
internal fun providerAnswerOf(cursor: Cursor): ProviderAnswer {
    if (cursor.getColumnIndex("rejected") >= 0) return ProviderAnswer.Rejected
    if (!cursor.moveToFirst()) return ProviderAnswer.NeedsApproval
    val result = cursor.getColumnIndex("result").takeIf { it >= 0 }?.let { cursor.getString(it) }
        ?: return ProviderAnswer.NeedsApproval
    val event = cursor.getColumnIndex("event").takeIf { it >= 0 }?.let { cursor.getString(it) }
    return ProviderAnswer.Answered(result, event?.takeIf { it.isNotBlank() })
}
