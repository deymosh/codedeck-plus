package com.codedeck.plus.platform

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.codedeck.plus.MainActivity
import com.codedeck.plus.core.CoreBridge

private const val CHANNEL_ID = "codedeck_stay_connected"
private const val NOTIFICATION_ID = 1

/**
 * Owns the one long-lived [CoreBridge] for the app's process lifetime — the
 * literal fix for the gap `MainActivity.kt`'s own previous doc comment
 * flagged: a plain `AndroidViewModel` survives configuration changes but not
 * process death, and process death is exactly what backgrounding without a
 * foreground service invites. `startForeground` raises this process's OOM
 * priority; the `WakeLock`/`WifiLock` pair keeps the CPU and Wi-Fi radio from
 * sleeping out from under an open WebSocket. `ProcessLifecycleOwner` (app-level
 * — "is ANY activity visible", not per-Activity `onStart`/`onStop`) drives
 * [CoreBridge.pause]/[CoreBridge.resume], the same "app went to background/
 * foreground" signal `apps/mobile`'s `document.visibilitychange` drove on the
 * WebView side — a debounced hint the connection FSM uses to decide whether a
 * healthy socket should be torn down (it never is) or just left alone.
 */
class StayConnectedService : Service() {

    private val binder = LocalBinder()

    lateinit var bridge: CoreBridge
        private set

    private var connectivity: Connectivity? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            if (::bridge.isInitialized) bridge.resume()
        }
        override fun onStop(owner: LifecycleOwner) {
            if (::bridge.isInitialized) bridge.pause()
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): StayConnectedService = this@StayConnectedService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        val identitySecretHex = readOrCreateIdentitySecretHex(applicationContext)
        val notifier = Notifier(applicationContext)
        bridge = CoreBridge(relays = emptyList(), identitySecretHex = identitySecretHex, notifier = notifier)
        bridge.start()
        connectivity = Connectivity(applicationContext)
        acquireLocks()
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Android 15's ~6h/24h dataSync FGS budget (or any other platform
            // refusal) — degrade instead of crashing the whole process; the
            // bridge still runs unforegrounded until the OS allows a retry.
            stopSelf()
        }
        return START_STICKY
    }

    @androidx.annotation.RequiresApi(35)
    override fun onTimeout(startId: Int, fgsType: Int) {
        // The OS force-ended this FGS window (Android 15+) — must stop
        // promptly or the process is killed outright
        // (ForegroundServiceDidNotStopInTimeException).
        stopSelf(startId)
    }

    override fun onDestroy() {
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver)
        connectivity?.close()
        releaseLocks()
        if (::bridge.isInitialized) bridge.stop()
        super.onDestroy()
    }

    private fun acquireLocks() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CodeDeck:StayConnected",
        ).apply { setReferenceCounted(false); acquire() }

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "CodeDeck:StayConnected",
        ).apply { setReferenceCounted(false); acquire() }
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock = null
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Stay connected",
            NotificationManager.IMPORTANCE_LOW,
        )
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            // A missing small icon isn't degraded gracefully — the platform
            // hard-crashes the process with `CannotPostForegroundServiceNotificationException`
            // rather than posting an icon-less notification. A stock system
            // glyph stands in until a real launcher/notification icon exists
            // (branding pass, same "not part of F3/F4.1's scope" note the
            // manifest's own `android:icon` comment already makes).
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("CodeDeck+")
            .setContentText("Staying connected")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }
}
