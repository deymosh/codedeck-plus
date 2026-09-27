package com.codedeck.plus.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** What a signer app's activity answered. */
data class SignerAnswer(
    val result: String,
    /** The signed event JSON, for `sign_event`. */
    val event: String?,
    val id: String?,
    val rejected: Boolean,
)

/** Reads a signer activity's result; `null` when it failed or was dismissed
 *  without an answer. */
fun signerAnswerOf(resultCode: Int, data: Intent?): SignerAnswer? {
    if (resultCode != Activity.RESULT_OK || data == null) return null
    val rejected = data.getBooleanExtra("rejected", false) ||
        data.getStringExtra("rejected")?.toBooleanStrictOrNull() == true
    return SignerAnswer(
        result = data.getStringExtra("result").orEmpty(),
        event = data.getStringExtra("event")?.takeIf { it.isNotBlank() },
        id = data.getStringExtra("id"),
        rejected = rejected,
    )
}

/**
 * Requests that need the signer app's own activity (the user approves in
 * it). The core asks from a worker thread and blocks; the activity runs
 * them one at a time while it is visible. Requested while the app is in
 * the background, the user is notified and the request waits until they
 * open the app or it times out.
 */
object SignerIntents {
    class Request(val intent: Intent) {
        internal val answer = CompletableFuture<SignerAnswer?>()
    }

    private val lock = Any()
    private val queue = ArrayDeque<Request>()
    private val _next = MutableStateFlow<Request?>(null)

    /** The request the activity should run next, if any. */
    val next: StateFlow<Request?> = _next.asStateFlow()

    /** Set by the activity while it can run requests. */
    @Volatile
    var visible: Boolean = false

    /** The request the activity has handed to the signer, awaiting its
     *  result; kept here so it survives the activity being recreated. */
    @Volatile
    var inFlight: Request? = null

    /** Blocking: queue `intent` and wait up to `timeoutMs` for its answer. */
    fun request(context: Context, intent: Intent, timeoutMs: Long): SignerAnswer? {
        val request = Request(intent)
        synchronized(lock) {
            queue.addLast(request)
            if (_next.value == null) _next.value = request
        }
        if (!visible) Notifier(context).signerApprovalNeeded()
        val answer = runCatching { request.answer.get(timeoutMs, TimeUnit.MILLISECONDS) }.getOrNull()
        finish(request, null)
        return answer
    }

    /** The activity ran `request`: hand its answer to the waiting caller
     *  and move on to the next one. */
    fun finish(request: Request, answer: SignerAnswer?) {
        request.answer.complete(answer)
        synchronized(lock) {
            queue.remove(request)
            _next.value = queue.firstOrNull()
        }
    }
}
