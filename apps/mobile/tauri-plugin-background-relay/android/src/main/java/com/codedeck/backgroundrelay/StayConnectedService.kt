package com.codedeck.backgroundrelay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat

/**
 * The stay-connected foreground service (plan §5 rebuild of the old
 * notification-only stub — this one is REAL).
 *
 * WHAT IT DOES: keeps the app PROCESS and the RADIO alive while the user's
 * "stay connected" toggle is on — START_STICKY, a persistent notification
 * whose text mirrors the true connection-FSM state (pushed from JS via the
 * plugin's updateState; this service only displays, it decides nothing), and
 * a partial WakeLock + WifiLock held for exactly the service's lifetime.
 *
 * WHAT IT DOES NOT DO — deliberately: it owns NO sockets. The WebView keeps
 * the relay WebSockets (its connection FSM + cheap resync-on-resume already
 * recover from brief kills); a native Kotlin socket is a Phase-7 stretch goal
 * ONLY. No BOOT_COMPLETED either — the user opens the app.
 */
class StayConnectedService : Service() {

    companion object {
        const val CHANNEL_ID = "codedeck_stay_connected"
        const val NOTIFICATION_ID = 1001
        const val EXTRA_STATE_TEXT = "stateText"

        @Volatile
        var isRunning = false
            private set

        @Volatile
        private var lastStateText: String = "Connecting…"

        /**
         * Update the persistent notification with fresh connection-FSM text.
         * No-op (beyond remembering the text) while the service is stopped.
         */
        fun updateStateText(context: Context, text: String) {
            lastStateText = text
            if (!isRunning) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager?.notify(NOTIFICATION_ID, buildNotification(context, text))
        }

        private fun buildNotification(context: Context, text: String): Notification {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val contentIntent = launch?.let {
                PendingIntent.getActivity(
                    context, 0, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle("CodeDeck")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .apply { if (contentIntent != null) setContentIntent(contentIntent) }
                .build()
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Stay connected",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the relay connection alive in the background"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_STATE_TEXT)?.let { lastStateText = it }
        val notification = buildNotification(this, lastStateText)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {
            // Android 15+ caps dataSync foreground time at ~6h/24h (see the
            // AndroidManifest.xml rationale comment). Once exhausted, this
            // throws ForegroundServiceStartNotAllowedException — synchronously,
            // so an uncaught throw here kills the whole app process, not just
            // this service. The degradation this manifest already promises
            // ("cheap resync-on-resume makes service death invisible next time
            // the app opens") only holds if we actually decline gracefully
            // instead of crashing.
            stopSelf()
            return START_NOT_STICKY
        }
        acquireLocks()
        isRunning = true
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // Android 15+ (API 35): FGS_TYPE_DATA_SYNC is time-limited (see the
    // ForegroundServiceStartNotAllowedException rationale above — the same
    // ~6h/24h budget). When a RUNNING instance's window runs out mid-flight,
    // the system calls this instead of just killing it, expecting stopSelf()
    // back promptly. Not overriding this is exactly what produced the crash
    // this comment now documents: ForegroundServiceDidNotStopInTimeException
    // — the system's own force-stop didn't complete inside its timeout, so it
    // tore down the whole process instead of just this service. There is
    // nothing to save first: this service owns no sockets (see the class
    // doc), so stopping it on the spot is always safe.
    @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    override fun onDestroy() {
        // Symmetric release — stop_service, swipe-kill, and system stop all
        // land here, so the locks can never leak past the service.
        releaseLocks()
        isRunning = false
        super.onDestroy()
    }

    private fun acquireLocks() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodeDeck:StayConnected")
                .apply { setReferenceCounted(false) }
        }
        if (wakeLock?.isHeld != true) wakeLock?.acquire()

        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "CodeDeck:StayConnected")
                .apply { setReferenceCounted(false) }
        }
        if (wifiLock?.isHeld != true) wifiLock?.acquire()
    }

    private fun releaseLocks() {
        if (wakeLock?.isHeld == true) wakeLock?.release()
        if (wifiLock?.isHeld == true) wifiLock?.release()
        wakeLock = null
        wifiLock = null
    }
}
