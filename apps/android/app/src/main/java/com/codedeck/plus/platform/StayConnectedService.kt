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
import com.codedeck.plus.R
import com.codedeck.plus.core.CoreBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.persistedRelays
import uniffi.uniffi_bridge.persistedTorProxyEnabled

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
 *
 * The service cannot be started/stopped from the "stay connected" toggle the
 * way mobile's controller starts/stops its plugin service: this service OWNS
 * the process's one [CoreBridge], so stopping it would kill the core while
 * the app is open. Instead — mobile's `attachStayConnectedService`
 * reconciliation, ported — the service collects the setting itself and
 * promotes (foreground notification + locks) or demotes (locks released +
 * foreground notification removed) on every emission, the first of which
 * reconciles the persisted value at startup. The service still must exist
 * whenever the app does, foreground or not.
 */
class StayConnectedService : Service() {

    private val binder = LocalBinder()

    /** Reconciles [CoreBridge.settings]'s `stayConnected` with the foreground
     *  state; cancelled in [onDestroy] with the rest of the teardown. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

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
        // `Core::spawn` dials its WebSocket transport from the constructor's
        // `relays` argument alone -- it never falls back to whatever it
        // separately hydrates from the db once already running -- so an
        // empty list here would leave every boot connected to nothing,
        // regardless of what the user actually has persisted. `persistedRelays`/
        // `persistedTorProxyEnabled` are the same pre-init read
        // `apps/mobile`'s `createPhoneCoreNative.ts` does from its own KV
        // before calling `core.init`, against the SAME db file `Core` is
        // about to open below.
        val dbPath = applicationContext.getDatabasePath("codedeck.db").absolutePath
        val relays = persistedRelays(dbPath)
        val torProxyEnabled = persistedTorProxyEnabled(dbPath)
        bridge = CoreBridge(
            relays = relays,
            identitySecretHex = identitySecretHex,
            notifier = notifier,
            dbPath = dbPath,
            // Orbot's SOCKS5 default -- sent unconditionally, same as
            // apps/mobile/src/main.tsx's own `nativeCoreProxy`, so a later
            // live Tor toggle has an address to switch back to.
            proxy = "127.0.0.1:9050",
            tor = torProxyEnabled,
        )
        bridge.start()
        connectivity = Connectivity(applicationContext)
        ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
        // The stay-connected setting drives THIS service's foreground state —
        // the settings screen only flips the stored value. Collecting here is
        // mobile's attach-reconcile too: the StateFlow replays the persisted
        // view at startup, so the first real emission applies it. (The null
        // pre-hydration replay is skipped; onStartCommand reconciles against
        // the current value right after the platform-mandated startForeground,
        // covering the window before hydration lands.)
        scope.launch {
            bridge.settings.collect { view ->
                val stayConnected = view?.stayConnected ?: return@collect
                if (stayConnected) promote() else demote()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // MainActivity launches this service via startForegroundService, which
        // gives the process ~5s to reach foreground or kills it outright
        // (ForegroundServiceDidNotStartInTimeException) — so this call stays
        // UNCONDITIONAL even when the setting is off, and the demotion below
        // (or the collector's, once hydration lands) removes the notification
        // straight after. A brief foreground flash on launch with the setting
        // off is the accepted cost of that platform rule.
        try {
            startForegroundNotification()
        } catch (e: Exception) {
            // Android 15's ~6h/24h dataSync FGS budget (or any other platform
            // refusal) — degrade instead of crashing the whole process; the
            // bridge still runs unforegrounded until the OS allows a retry.
            stopSelf()
        }
        if (bridge.settings.value?.stayConnected == false) demote()
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
        scope.cancel()
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver)
        connectivity?.close()
        releaseLocks()
        if (::bridge.isInitialized) bridge.stop()
        foreground.value = null
        super.onDestroy()
    }

    /** Foreground notification + wakelock/wifilock — the "stay connected on"
     *  state. Re-runnable: StateFlow's distinct emissions mean promote and
     *  demote strictly alternate, but the startForeground reconcile in
     *  [onStartCommand] can interleave, so neither helper assumes ordering. */
    private fun promote() {
        // The locks are the actual keep-alive — take them first, so even a
        // platform refusal of the notification leaves the connection as
        // protected as the OS allows (stopping the service instead would kill
        // the open app's core).
        acquireLocks()
        try {
            startForegroundNotification()
            foreground.value = true
        } catch (e: Exception) {
            // Same dataSync-budget refusal onStartCommand degrades on —
            // keep the locks, report the service honestly as not foreground.
            foreground.value = false
        }
    }

    /** Releases the locks and removes the foreground notification — the
     *  "stay connected off" state. The core keeps running either way; this
     *  only stops promising the OS that the process must stay awake. */
    private fun demote() {
        releaseLocks()
        // A no-op when not in foreground (safe against demote-before-foreground
        // interleavings).
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground.value = false
    }

    private fun startForegroundNotification() {
        createNotificationChannel()
        val notification = buildNotification()
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
    }

    private fun acquireLocks() {
        // Held already (promote without an intervening demote) — re-acquiring
        // would orphan the still-held locks.
        if (wakeLock != null || wifiLock != null) return
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CodeDeck:StayConnected",
        ).apply { setReferenceCounted(false); acquire() }

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = (
            // LOW_LATENCY is the only non-deprecated radio mode (API 29+;
            // from 34 the platform maps a legacy HIGH_PERF onto it anyway).
            // Its screen-off pause costs nothing here — the PARTIAL_WAKE_LOCK
            // above is the actual keep-alive.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                wifiManager.createWifiLock(
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY,
                    "CodeDeck:StayConnected",
                )
            } else {
                // Pre-Q has no LOW_LATENCY; HIGH_PERF is the only valid mode.
                @Suppress("DEPRECATION")
                wifiManager.createWifiLock(
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    "CodeDeck:StayConnected",
                )
            }
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
            // rather than posting an icon-less notification.
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("CodeDeck+")
            .setContentText("Staying connected")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .build()
    }

    companion object {
        /**
         * Live foreground state for the settings screen's badge — `true`
         * promoted, `false` demoted, `null` unknown (service not yet up, or
         * gone). A companion field is process-global by nature, and this
         * service is a process singleton that owns the app's one CoreBridge,
         * so there is exactly ever one writer (this service) and the state
         * has exactly one honest home.
         */
        val foreground = MutableStateFlow<Boolean?>(null)
    }
}
