package com.codedeck.plus.platform

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.codedeck.plus.MainActivity
import com.codedeck.plus.R
import com.codedeck.plus.core.CoreHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_ffi.localIdentitySigner
import uniffi.client_ffi.persistedRelays
import uniffi.client_ffi.persistedTorProxyEnabled

private const val CHANNEL_ID = "codedeck_stay_connected"
private const val NOTIFICATION_ID = 1
private const val ACTION_REPOST = "com.codedeck.plus.action.REPOST_STAY_CONNECTED"

/** How often the keep-alive alarm checks the connection: the longest a
 *  silently dropped socket can pass for live while the device is awake or
 *  lightly idle (live updates themselves are pushed, not polled). Inexact:
 *  deep Doze stretches it to its own maintenance windows (typically
 *  9-15 min). A healthy check is one short wake: every relay is pinged at
 *  once and the check ends as soon as they all answer. */
private const val KEEPALIVE_EVERY_MS = 60_000L
/** Longest the device is held awake for one check. The core's own probe
 *  waits 10 s for the relays; the rest is margin to act on the result. */
private const val KEEPALIVE_WAKE_MS = 15_000L

/**
 * Owns the one long-lived [CoreHost] for the app's process lifetime — the
 * literal fix for the gap `MainActivity.kt`'s own previous doc comment
 * flagged: a plain `AndroidViewModel` survives configuration changes but not
 * process death, and process death is exactly what backgrounding without a
 * foreground service invites. `startForeground` raises this process's OOM
 * priority, which keeps the WebSockets open; the device itself is left to
 * sleep. Incoming relay traffic wakes it, and a keep-alive alarm
 * ([KeepAliveReceiver]) wakes it about every minute under a short wake lock
 * for [CoreHost.keepalive], which pings the relays, drops the ones a NAT or
 * the relay silently dropped, and brings a stalled reconnect forward.
 * Holding a wake lock for as long as the setting is on instead kept the CPU
 * running around the clock. `ProcessLifecycleOwner` (app-level
 * — "is ANY activity visible", not per-Activity `onStart`/`onStop`) drives
 * [CoreHost.pause]/[CoreHost.resume], the same "app went to background/
 * foreground" signal `apps/mobile`'s `document.visibilitychange` drove on the
 * WebView side — a debounced hint the connection FSM uses to decide whether a
 * healthy socket should be torn down (it never is) or just left alone.
 *
 * The service cannot be started/stopped from the "stay connected" toggle the
 * way mobile's controller starts/stops its plugin service: this service OWNS
 * the process's one [CoreHost], so stopping it would kill the core while
 * the app is open. Instead — mobile's `attachStayConnectedService`
 * reconciliation, ported — the service collects the setting itself and
 * promotes (foreground notification + keep-alive alarm) or demotes (alarm
 * cancelled + foreground notification removed) on every emission, the first of which
 * reconciles the persisted value at startup. The service still must exist
 * whenever the app does, foreground or not.
 */
class StayConnectedService : Service() {

    private val binder = LocalBinder()

    /** Reconciles [CoreHost.settings]'s `stayConnected` with the foreground
     *  state; cancelled in [onDestroy] with the rest of the teardown. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * The process's one [CoreHost]; `null` until it has opened. Opening
     * hydrates from the local database and can take seconds, so it runs off
     * the main thread: blocking [onCreate] on it would hold up the
     * `startForeground` the platform requires within ~5 s of
     * `startForegroundService` (a crash) and freeze the main thread (an ANR).
     */
    private val _core = MutableStateFlow<CoreHost?>(null)
    val core: StateFlow<CoreHost?> = _core.asStateFlow()

    /** Guards [destroyed] against the core finishing its open concurrently
     *  with [onDestroy], so a core that opens late is still stopped. */
    private val coreLock = Any()
    private var destroyed = false

    private var connectivity: Connectivity? = null

    /** Latest summary for the notification; written by the collector in
     *  [observe], read whenever the notification is (re)built. */
    @Volatile
    private var status = stayConnectedStatus(0, emptyList(), null, 0, 0)

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            _core.value?.resume()
        }
        override fun onStop(owner: LifecycleOwner) {
            _core.value?.pause()
        }
    }

    inner class LocalBinder : Binder() {
        fun getService(): StayConnectedService = this@StayConnectedService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        instance = this
        connectivity = Connectivity(applicationContext)
        scope.launch(Dispatchers.IO) {
            val core = openCore()
            val keep = synchronized(coreLock) {
                if (!destroyed) _core.value = core
                !destroyed
            }
            if (!keep) {
                core.stop()
                return@launch
            }
            core.start()
            // Registered only now: adding the observer replays the current
            // app visibility at once, which must reach a started core.
            withContext(Dispatchers.Main) {
                ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycleObserver)
            }
            observe(core)
        }
    }

    /** Blocking: reads the persisted settings and opens the core. */
    private fun openCore(): CoreHost {
        val aead = keystoreAead(applicationContext)
        val identity = localIdentitySigner(readOrCreateIdentitySecretHex(aead, identityFile(applicationContext)))
        val sessionKeys = KeystoreSessionKeyStore(aead, sessionKeysFile(applicationContext))
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
        return CoreHost(
            relays = relays,
            identity = identity,
            sessionKeys = sessionKeys,
            notifier = notifier,
            dbPath = dbPath,
            // Orbot's SOCKS5 default -- sent unconditionally, same as
            // apps/mobile/src/main.tsx's own `nativeCoreProxy`, so a later
            // live Tor toggle has an address to switch back to.
            proxy = "127.0.0.1:9050",
            tor = torProxyEnabled,
        )
    }

    private fun observe(core: CoreHost) {
        // Network reachability drives the connection FSM's offline/online
        // transitions; the first emission reconciles the state at startup.
        connectivity?.let { network ->
            scope.launch { network.online.collect { core.setOnline(it) } }
        }
        // The stay-connected setting drives THIS service's foreground state —
        // the settings screen only flips the stored value. Collecting here is
        // mobile's attach-reconcile too: the StateFlow replays the persisted
        // view at startup, so the first real emission applies it. (The null
        // pre-hydration replay is skipped; onStartCommand reconciles against
        // the current value right after the platform-mandated startForeground,
        // covering the window before hydration lands.)
        scope.launch {
            core.settings.collect { view ->
                val stayConnected = view?.stayConnected ?: return@collect
                if (stayConnected) promote() else demote()
            }
        }
        // Keep the notification's machines/sessions/relays summary live. Only
        // a changed summary reposts, and only while the notification is up —
        // demoted, there is nothing to update.
        scope.launch {
            combine(core.machines, core.connection, core.settings) { machines, connection, settings ->
                val all = machines?.machines.orEmpty()
                stayConnectedStatus(
                    machineCount = all.size,
                    sessionStates = all.flatMap { m -> m.sessions.map { it.state } },
                    connectionStatus = connection?.status,
                    connectedRelays = connection?.connectedRelays?.size ?: 0,
                    configuredRelays = settings?.relays?.size ?: 0,
                )
            }
                .distinctUntilChanged()
                .collect { status ->
                    this@StayConnectedService.status = status
                    if (foreground.value == true) updateNotification()
                }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_REPOST) {
            // The user swiped the notification away (possible for ongoing
            // foreground notifications since Android 14). The service kept
            // running; put the notification back while staying connected is
            // on, so the always-on connection stays visible and controllable.
            if (_core.value?.settings?.value?.stayConnected != false) repostNotification()
            return START_STICKY
        }
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
            // A platform refusal (e.g. the pre-Android-14 dataSync type's
            // time budget) — degrade instead of crashing the whole process;
            // the core still runs unforegrounded until the OS allows a retry.
            stopSelf()
        }
        if (_core.value?.settings?.value?.stayConnected == false) demote()
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
        instance = null
        scope.cancel()
        ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycleObserver)
        connectivity?.close()
        cancelKeepAlive()
        // A core still opening is stopped by the opener once it sees this.
        synchronized(coreLock) {
            destroyed = true
            _core.value
        }?.stop()
        foreground.value = null
        super.onDestroy()
    }

    /** Foreground notification + keep-alive alarm — the "stay connected on"
     *  state. Re-runnable: StateFlow's distinct emissions mean promote and
     *  demote strictly alternate, but the startForeground reconcile in
     *  [onStartCommand] can interleave, so neither helper assumes ordering. */
    private fun promote() {
        // Armed first, so even a platform refusal of the notification leaves
        // the connection checked (stopping the service instead would kill
        // the open app's core).
        scheduleKeepAlive()
        try {
            startForegroundNotification()
            foreground.value = true
        } catch (e: Exception) {
            // Same dataSync-budget refusal onStartCommand degrades on —
            // keep the alarm, report the service honestly as not foreground.
            foreground.value = false
        }
    }

    /** Cancels the keep-alive alarm and removes the foreground notification —
     *  the "stay connected off" state. The core keeps running either way;
     *  this only stops promising the OS that the process must stay alive. */
    private fun demote() {
        cancelKeepAlive()
        // A no-op when not in foreground (safe against demote-before-foreground
        // interleavings).
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground.value = false
    }

    private fun startForegroundNotification() {
        createNotificationChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, foregroundType())
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * `remoteMessaging` from Android 14: relaying messages between this phone
     * and its bridges is exactly that type, and unlike `dataSync` it has no
     * daily time budget — Android 15 stops a `dataSync` service after 6 h per
     * 24 h, which silently ended "stay connected". Older versions only know
     * `dataSync` (no budget there).
     */
    private fun foregroundType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }

    /** Re-posting under the foreground notification's own id replaces it in
     *  place; the platform drops the post silently when notifications are
     *  not permitted, which leaves nothing to update anyway. */
    private fun updateNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun repostNotification() {
        try {
            startForegroundNotification()
        } catch (e: Exception) {
            // Refused (no notification permission, platform limit) — nothing
            // to re-show; the connection itself is unaffected.
        }
    }

    /** Arms (or re-arms, replacing) the next keep-alive check. Inexact and
     *  allowed while idle: no exact-alarm permission, and the platform
     *  batches it with other wake-ups. */
    private fun scheduleKeepAlive() {
        getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + KEEPALIVE_EVERY_MS,
            keepAliveIntent(),
        )
    }

    private fun cancelKeepAlive() {
        getSystemService(AlarmManager::class.java).cancel(keepAliveIntent())
    }

    private fun keepAliveIntent(): PendingIntent = PendingIntent.getBroadcast(
        this,
        2,
        Intent(this, KeepAliveReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE,
    )

    /**
     * One keep-alive check, from [KeepAliveReceiver]: hold the device awake
     * (bounded by [KEEPALIVE_WAKE_MS] even if the check hangs) while the core
     * probes the relays, then arm the next check and let the device sleep.
     */
    fun keepAlive(broadcast: BroadcastReceiver.PendingResult) {
        val core = _core.value
        if (core == null || core.settings.value?.stayConnected == false) {
            broadcast.finish()
            return
        }
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodeDeck:KeepAlive")
            .apply { setReferenceCounted(false); acquire(KEEPALIVE_WAKE_MS) }
        scope.launch {
            try {
                withTimeoutOrNull(KEEPALIVE_WAKE_MS - 2_000) { core.keepalive() }
            } finally {
                if (core.settings.value?.stayConnected != false) scheduleKeepAlive()
                if (wakeLock.isHeld) wakeLock.release()
                broadcast.finish()
            }
        }
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
        // Fired when the user dismisses the notification; see ACTION_REPOST.
        val repostIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, StayConnectedService::class.java).setAction(ACTION_REPOST),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            // A missing small icon isn't degraded gracefully — the platform
            // hard-crashes the process with `CannotPostForegroundServiceNotificationException`
            // rather than posting an icon-less notification.
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(status.title)
            .setContentText(status.text)
            .setOngoing(true)
            // Summary updates replace the notification silently and carry
            // no meaningful post time.
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .setDeleteIntent(repostIntent)
            // Shown right away instead of after Android 12+'s up-to-10 s
            // deferral for foreground-service notifications.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        /**
         * Live foreground state for the settings screen's badge — `true`
         * promoted, `false` demoted, `null` unknown (service not yet up, or
         * gone). A companion field is process-global by nature, and this
         * service is a process singleton that owns the app's one CoreHost,
         * so there is exactly ever one writer (this service) and the state
         * has exactly one honest home.
         */
        val foreground = MutableStateFlow<Boolean?>(null)

        /** The running service, for [KeepAliveReceiver]; `null` when there
         *  is none. The service is a process singleton, set in onCreate and
         *  cleared in onDestroy, both on the main thread. */
        @Volatile
        var instance: StayConnectedService? = null
            private set
    }
}
