package com.codedeck.plus.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.codedeck.plus.R
import uniffi.client_ffi.UniffiNotifier

private const val CODEDECK_SCHEME = "codedeck"
private const val SESSION_HOST = "session"

/** Tag format from `session_notify_tag` in crates/client-core's
 *  notifications.rs: `session:<machine>:<sessionId>`. `:` cannot occur in
 *  either part, so the last one splits unambiguously. */
private const val TAG_SESSION_PREFIX = "session:"

/** One channel per attention class, not per event type — the setting users
 *  actually want ("mute finished pings, keep permission prompts") is
 *  inexpressible with a single channel. */
private const val CHANNEL_MESSAGES_ID = "codedeck_messages"
private const val CHANNEL_ACTION_ID = "codedeck_action_needed"
private const val CHANNEL_UPDATES_ID = "codedeck_session_updates"

internal data class ChannelSpec(
    val id: String,
    val name: String,
    val importance: Int,
    val priority: Int,
)

private val CHANNEL_MESSAGES =
    ChannelSpec(CHANNEL_MESSAGES_ID, "Messages", NotificationManager.IMPORTANCE_DEFAULT, NotificationCompat.PRIORITY_DEFAULT)
private val CHANNEL_ACTION =
    ChannelSpec(CHANNEL_ACTION_ID, "Action needed", NotificationManager.IMPORTANCE_HIGH, NotificationCompat.PRIORITY_HIGH)
private val CHANNEL_UPDATES =
    ChannelSpec(CHANNEL_UPDATES_ID, "Session updates", NotificationManager.IMPORTANCE_LOW, NotificationCompat.PRIORITY_LOW)

/** Kind (from `NotifyEvent::kind_str` in crates/client-core) → channel.
 *  Unknown kinds land on Messages rather than being dropped. */
internal fun channelFor(kind: String): ChannelSpec = when (kind) {
    "permission-request", "question", "plan-approval" -> CHANNEL_ACTION
    "session-finished", "session-failed" -> CHANNEL_UPDATES
    else -> CHANNEL_MESSAGES
}

/**
 * The Kotlin side of the `Notifier` port (`crates/client-ffi/src/notifier.rs`)
 * — the real core decides WHEN to notify (`notifications`/
 * `notificationsCoordinator`, already ported); this class only posts/cancels
 * the actual Android notification when told to. `tag` is the same
 * per-session/per-peer key the core's own coordinator already computes
 * (`session_notify_tag`/`dm_notify_tag`) — reused directly as
 * [NotificationManagerCompat]'s own tag parameter, with a stable per-tag
 * integer id derived from it so a later `cancel(tag)` targets the exact
 * notification `notify(tag, ...)` posted, the same pairing
 * `NotificationManagerCompat.notify(tag, id, ...)`/`cancel(tag, id)` already
 * expects — no separate id-bookkeeping map needed. `kind` picks the
 * notification channel.
 */
class Notifier(private val context: Context) : UniffiNotifier {

    init {
        createChannels()
    }

    override fun notify(title: String, body: String, tag: String?, kind: String) {
        if (!hasPermission()) return
        val effectiveTag = tag ?: DEFAULT_TAG
        val channel = channelFor(kind)
        val builder = NotificationCompat.Builder(context, channel.id)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            // Long bodies (command previews, questions) expand instead of
            // truncating; short ones render unchanged.
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(channel.priority)

        sessionFromTag(effectiveTag)?.let { (machine, sessionId) ->
            builder.setContentIntent(sessionPendingIntent(context, machine, sessionId))
        }

        val notification = builder.build()
        NotificationManagerCompat.from(context).notify(effectiveTag, idFor(effectiveTag), notification)
    }

    override fun cancel(tag: String) {
        NotificationManagerCompat.from(context).cancel(tag, idFor(tag))
    }

    private fun idFor(tag: String): Int = tag.hashCode()

    /** The notification's tap target, or null for tags that aren't
     *  session-scoped (e.g. `dm:`) — those post without a tap action. */
    private fun sessionFromTag(tag: String): Pair<String, String>? {
        if (!tag.startsWith(TAG_SESSION_PREFIX)) return null
        val rest = tag.removePrefix(TAG_SESSION_PREFIX)
        val separator = rest.lastIndexOf(':')
        if (separator <= 0 || separator == rest.lastIndex) return null
        return rest.take(separator) to rest.substring(separator + 1)
    }

    /** `codedeck://session/<machine>/<sessionId>` — Uri percent-encodes each
     *  segment and MainActivity reads them back decoded; no manual URL
     *  encoding on either side. */
    private fun sessionPendingIntent(
        context: Context,
        machine: String,
        sessionId: String,
    ): PendingIntent {
        val uri = Uri.Builder()
            .scheme(CODEDECK_SCHEME)
            .authority(SESSION_HOST)
            .appendPath(machine)
            .appendPath(sessionId)
            .build()
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .setPackage(context.packageName)
        return PendingIntent.getActivity(
            context,
            idFor("$machine:$sessionId"),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun createChannels() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        for (channel in listOf(CHANNEL_MESSAGES, CHANNEL_ACTION, CHANNEL_UPDATES)) {
            manager.createNotificationChannel(
                NotificationChannel(channel.id, channel.name, channel.importance),
            )
        }
    }

    private fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val DEFAULT_TAG = "codedeck-default"
    }
}
