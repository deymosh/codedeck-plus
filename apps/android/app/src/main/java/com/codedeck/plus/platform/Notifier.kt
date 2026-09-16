package com.codedeck.plus.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import uniffi.uniffi_bridge.UniffiNotifier

private const val MESSAGES_CHANNEL_ID = "codedeck_messages"

/**
 * The Kotlin side of the `Notifier` port (`crates/uniffi-bridge/src/notifier.rs`)
 * — the real core decides WHEN to notify (`notifications`/
 * `notificationsCoordinator`, already ported); this class only posts/cancels
 * the actual Android notification when told to. `tag` is the same
 * per-session/per-peer key the core's own coordinator already computes
 * (`session_notify_tag`/`dm_notify_tag`) — reused directly as
 * [NotificationManagerCompat]'s own tag parameter, with a stable per-tag
 * integer id derived from it so a later `cancel(tag)` targets the exact
 * notification `notify(tag, ...)` posted, the same pairing
 * `NotificationManagerCompat.notify(tag, id, ...)`/`cancel(tag, id)` already
 * expects — no separate id-bookkeeping map needed.
 */
class Notifier(private val context: Context) : UniffiNotifier {

    init {
        createChannel()
    }

    override fun notify(title: String, body: String, tag: String?) {
        if (!hasPermission()) return
        val effectiveTag = tag ?: DEFAULT_TAG
        val notification = NotificationCompat.Builder(context, MESSAGES_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        NotificationManagerCompat.from(context).notify(effectiveTag, idFor(effectiveTag), notification)
    }

    override fun cancel(tag: String) {
        NotificationManagerCompat.from(context).cancel(tag, idFor(tag))
    }

    private fun idFor(tag: String): Int = tag.hashCode()

    private fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun createChannel() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            MESSAGES_CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        manager.createNotificationChannel(channel)
    }

    companion object {
        private const val DEFAULT_TAG = "codedeck-default"
    }
}
