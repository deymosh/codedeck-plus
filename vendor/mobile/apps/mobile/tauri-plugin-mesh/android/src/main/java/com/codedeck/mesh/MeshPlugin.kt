package com.codedeck.mesh

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.provider.Settings
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.codedeck.mesh.core.AppCoreClient
import com.codedeck.mesh.core.NativeActions
import org.nostrvpn.app.core.NativeCore
import com.codedeck.mesh.vpn.MeshVpnService
import com.codedeck.mesh.vpn.VpnStartState
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Tauri bridge for CodeDeck's embedded nostr-vpn mesh.
 *
 * Owns the [AppCoreClient] (the engine handle) and the [MeshVpnService] lifecycle. Mirrors the
 * connect/disconnect flow nostr-vpn's MainActivity uses: dispatch `connect_vpn` into the engine,
 * then `VpnService.prepare()` for the system consent dialog, then start the foreground VpnService
 * with the engine's tunnel config. Desktop never reaches here (the laptop uses the `nvpn` CLI).
 */
@TauriPlugin
class MeshPlugin(private val activity: Activity) : Plugin(activity) {

    // Engine work (appNew / dispatch / stateJson) is heavy and JNI-blocking — it MUST NOT run on the
    // UI thread or it freezes the WebView (and Android kills the app). All engine-touching commands
    // run on this single background thread; results are resolved back to the SDK from there.
    private val engineExecutor = Executors.newSingleThreadExecutor()

    // The engine handle is created lazily — but ONLY ever from engineExecutor, never from mesh_status.
    // `@Volatile` so the cheap status path can read presence without forcing initialization.
    @Volatile private var coreInstance: AppCoreClient? = null

    private fun core(): AppCoreClient {
        var c = coreInstance
        if (c == null) {
            // CRITICAL: the engine's Rust uses ndk-context to reach the Android Context/JavaVM.
            // It MUST be seeded before appNew() or the native side aborts (SIGABRT in ndk-context).
            // nvpn's own app does this in MainActivity + the VpnService; we must too.
            NativeCore.initializeAndroidContext(activity.applicationContext)
            val dataDir = appCoreDataDir(activity)
            seedMobileConfig(dataDir)
            c = AppCoreClient(dataDir.absolutePath, appVersion())
            coreInstance = c
        }
        return c
    }

    private var pendingJoinInvoke: Invoke? = null

    private fun appVersion(): String =
        runCatching {
            activity.packageManager.getPackageInfo(activity.packageName, 0).versionName
        }.getOrNull().orEmpty().ifBlank { "0.0.0" }

    /**
     * CHEAP status — safe on the UI thread. Reports only the VpnService running flag and the engine's
     * last-known state IF the engine is already initialized. Crucially it never forces engine init,
     * so opening Settings (which calls mesh_status) can't freeze the app. `state_json` is empty until
     * the user actually joins (which builds the engine on the background thread).
     */
    private fun statusObject(): JSObject {
        val c = coreInstance
        val state = if (c != null) runCatching { c.stateJsonRaw() }.getOrDefault("") else ""
        return JSObject().apply {
            put("running", MeshVpnService.isRunning)
            put("state_json", state)
        }
    }

    /**
     * Bring the mesh tunnel up. The engine dispatch (heavy, may init the engine) runs on the
     * background thread; the VPN-consent prompt + service start hop back to the UI thread.
     */
    @Command
    fun joinMesh(invoke: Invoke) {
        engineExecutor.execute {
            val ok = runCatching { core().dispatch(NativeActions.connectVpn()) }.isSuccess
            if (!ok) { invoke.reject("failed to dispatch connect_vpn"); return@execute }
            activity.runOnUiThread {
                val prepare = VpnService.prepare(activity)
                if (prepare == null) {
                    startTunnel()
                    invoke.resolve(statusObject())
                } else {
                    // System VPN-consent dialog first; resume in the activity callback.
                    pendingJoinInvoke = invoke
                    startActivityForResult(invoke, prepare, "onVpnConsent")
                }
            }
        }
    }

    @ActivityCallback
    fun onVpnConsent(invoke: Invoke, result: androidx.activity.result.ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            startTunnel()
            invoke.resolve(statusObject())
        } else {
            engineExecutor.execute { runCatching { core().dispatch(NativeActions.disconnectVpn()) } }
            invoke.reject("VPN permission denied")
        }
    }

    @Command
    fun leaveMesh(invoke: Invoke) {
        engineExecutor.execute {
            runCatching { core().dispatch(NativeActions.disconnectVpn()) }
            activity.startService(
                Intent(activity, MeshVpnService::class.java).setAction(MeshVpnService.ACTION_DISCONNECT),
            )
            invoke.resolve(statusObject())
        }
    }

    @Command
    fun meshStatus(invoke: Invoke) {
        // Resolve immediately with cheap status (never blocks the UI thread). If the engine isn't
        // initialized yet, kick off a one-time async init on the background thread so the NEXT poll
        // reflects any persisted network (imported invite) — this is what lets the UI enable Connect
        // after a fresh launch without ever blocking.
        if (coreInstance == null) {
            engineExecutor.execute { runCatching { core() } }
        }
        invoke.resolve(statusObject())
    }

    /**
     * Open Android's Wireless Debugging settings so the user can enable it (one tap). Required so
     * the laptop can `adb connect` to this device over the mesh. Tries the dedicated screen first,
     * falling back to Developer Options, then top-level Settings.
     */
    @Command
    fun openWirelessDebugging(invoke: Invoke) {
        val candidates = listOf(
            "android.settings.APPLICATION_DEVELOPMENT_SETTINGS",
            "android.settings.DEVICE_INFO_SETTINGS",
            "android.settings.SETTINGS",
        )
        for (action in candidates) {
            try {
                val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
                invoke.resolve(JSObject().apply { put("opened", action) })
                return
            } catch (_: Exception) {
                // try next
            }
        }
        invoke.reject("could not open developer settings")
    }

    /**
     * Prepare this device for adb-over-mesh WITHOUT a USB cable or a human tap: enable Wireless
     * Debugging (we hold WRITE_SECURE_SETTINGS, granted once over USB). Wireless Debugging silently
     * turns off on idle/network change, so the Bridge calls this to recover before reconnecting.
     *
     * NOTE: we deliberately do NOT try to report the adbd-wifi listener PORT here. On Android 10+ an
     * unprivileged app cannot read other processes' sockets (`/proc/net/tcp*` shows only our own
     * uid), so adbd's port is invisible to us. The Bridge discovers the (rotating) port itself by
     * scanning the mesh IP, which needs nothing privileged from this side.
     *
     * Resolves { enabled: Boolean }  (false if WD couldn't be enabled — i.e. the one-time
     * WRITE_SECURE_SETTINGS grant hasn't been done).
     */
    @Command
    fun prepareAdb(invoke: Invoke) {
        engineExecutor.execute {
            val resolver = activity.applicationContext.contentResolver
            // `adb_wifi_enabled` lives in Settings.GLOBAL (not Secure). WRITE_SECURE_SETTINGS (granted
            // once over USB) covers writing it; targeting the wrong namespace silently throws.
            val canWrite = runCatching {
                Settings.Global.putInt(resolver, "adb_wifi_enabled", 1)
            }.isSuccess
            invoke.resolve(JSObject().apply { put("enabled", canWrite) })
        }
    }

    @InvokeArg
    internal class MeshActionArgs {
        var actionJson: String? = null
    }

    /** Generic engine-action passthrough (import invite, add/join network, settings, etc.). */
    @Command
    fun meshAction(invoke: Invoke) {
        val actionJson = invoke.parseArgs(MeshActionArgs::class.java).actionJson
        if (actionJson.isNullOrBlank()) {
            invoke.reject("actionJson is required")
            return
        }
        // Engine dispatch off the UI thread; VPN reconcile hops back to the UI thread.
        engineExecutor.execute {
            val res = runCatching {
                val before = MeshVpnService.isRunning
                val nextState = core().dispatchRaw(actionJson)
                val nowWantsVpn = JSONObject(nextState).optBoolean("vpnEnabled", before)
                if (!before && nowWantsVpn) {
                    val cfg = core().mobileTunnelConfigJson()
                    activity.runOnUiThread {
                        if (VpnService.prepare(activity) == null) startTunnelWithConfig(cfg)
                    }
                } else if (before && !nowWantsVpn) {
                    activity.runOnUiThread {
                        activity.startService(
                            Intent(activity, MeshVpnService::class.java)
                                .setAction(MeshVpnService.ACTION_DISCONNECT),
                        )
                    }
                }
                nextState
            }
            res.onSuccess { state -> invoke.resolve(JSObject().apply { put("state_json", state) }) }
               .onFailure { invoke.reject(it.message ?: "mesh action failed") }
        }
    }

    /** Start the VpnService. Fetches the tunnel config on the engine thread, then starts the
     *  foreground service on the UI thread (must not block the caller). */
    private fun startTunnel() {
        engineExecutor.execute {
            val cfg = runCatching { core().mobileTunnelConfigJson() }.getOrDefault("")
            activity.runOnUiThread { startTunnelWithConfig(cfg) }
        }
    }

    private fun startTunnelWithConfig(configJson: String) {
        VpnStartState.setUserWantsVpn(activity, true)
        val intent = Intent(activity, MeshVpnService::class.java)
            .setAction(MeshVpnService.ACTION_CONNECT)
            .putExtra(MeshVpnService.EXTRA_CONFIG_JSON, configJson)
        ContextCompat.startForegroundService(activity, intent)
    }
}
