package com.codedeck.bgprobe

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import uniffi.heartbeat_core.HeartbeatProbe
import uniffi.heartbeat_core.ProbeEvent
import uniffi.heartbeat_core.ProbeListener

/**
 * The probe's whole point: the Nostr socket lives HERE, in a Rust core owned by
 * this foreground service — not in a WebView. If deliveries keep arriving while
 * the app is backgrounded / Dozed, the plan's F1 thesis holds.
 */
class RelayService : Service() {

    private var probe: HeartbeatProbe? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, notification("starting…"))

        if (probe == null) {
            if (intent?.getBooleanExtra(EXTRA_WAKELOCK, false) == true) {
                val pm = getSystemService(POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bgprobe:wl").apply { acquire() }
                Log.i(TAG, "partial wakelock acquired")
            }
            val relay = intent?.getStringExtra(EXTRA_RELAY) ?: BuildConfig.RELAY_URL
            val p = HeartbeatProbe()
            p.subscribe(object : ProbeListener {
                override fun onEvent(event: ProbeEvent) {
                    val s = p.stats()
                    updateNotification(
                        "HB ${s.received} · reconn ${s.reconnects} · " +
                            if (s.connected) "connected" else "offline"
                    )
                    sendBroadcast(
                        Intent(ACTION_STATS).setPackage(packageName)
                            .putExtra("received", s.received.toLong())
                            .putExtra("last", s.lastHeartbeatMs)
                            .putExtra("reconnects", s.reconnects.toLong())
                            .putExtra("connected", s.connected)
                            .putExtra("started", s.startedMs)
                    )
                    Log.i(TAG, "event=$event stats=$s")
                }
            })
            Log.i(TAG, "starting probe against $relay")
            p.start(relay, "aa", "bb")
            probe = p
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy — stopping probe")
        probe?.stop()
        probe = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "bgprobe", NotificationManager.IMPORTANCE_LOW)
            )
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("bgprobe")
            .setContentText(text)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification(text))
    }

    companion object {
        const val TAG = "bgprobe"
        const val CHANNEL = "bgprobe"
        const val NOTIF_ID = 1
        const val ACTION_STATS = "com.codedeck.bgprobe.STATS"
        const val EXTRA_RELAY = "relay"
        const val EXTRA_WAKELOCK = "wakelock"
    }
}
