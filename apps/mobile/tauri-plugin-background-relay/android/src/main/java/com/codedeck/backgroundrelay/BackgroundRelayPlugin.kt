package com.codedeck.backgroundrelay

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class UpdateStateArgs {
    var text: String = ""
}

@InvokeArg
class WatchConnectivityArgs {
    lateinit var channel: Channel
}

/**
 * Webview-facing commands for the stay-connected service. The JS side owns
 * ALL policy (the settings toggle starts/stops, the connection FSM pushes
 * state text); this plugin only forwards.
 *
 * CDX-027: it is ALSO the native connectivity source. Android WebView never
 * fires window `online`/`offline`, so the connection FSM could never reach
 * its `offline` state and burned backoff against a dead radio. A
 * `ConnectivityManager.NetworkCallback` on the default network tracks the
 * real radio (INTERNET + VALIDATED capabilities) and streams changes to JS
 * over a Tauri channel; `getConnectivity` gives the boot snapshot. Policy
 * still lives in JS — this class only reports.
 */
@TauriPlugin
class BackgroundRelayPlugin(private val activity: Activity) : Plugin(activity) {

    /** Single JS watcher (the connection FSM); a new watch replaces it. */
    @Volatile
    private var connectivityChannel: Channel? = null

    /** Last truth told to JS — dedups the callback's chatter (onAvailable
     *  followed by several onCapabilitiesChanged for the same network). */
    @Volatile
    private var online: Boolean = true

    private var callbackRegistered = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        // onAvailable fires before validation — report reachable immediately
        // (reconnect can start); onCapabilitiesChanged corrects within
        // moments if the network turns out to have no validated internet.
        override fun onAvailable(network: Network) {
            updateOnline(true)
        }

        override fun onLost(network: Network) {
            updateOnline(false)
        }

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            updateOnline(hasValidatedInternet(capabilities))
        }
    }

    override fun load(webView: WebView) {
        super.load(webView)
        online = snapshotOnline()
        registerNetworkCallback()
    }

    private fun connectivityManager(): ConnectivityManager? =
        activity.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

    private fun hasValidatedInternet(capabilities: NetworkCapabilities): Boolean =
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

    /** Current truth straight from ConnectivityManager (boot snapshot). */
    private fun snapshotOnline(): Boolean {
        val cm = connectivityManager() ?: return true
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return hasValidatedInternet(capabilities)
    }

    private fun registerNetworkCallback() {
        if (callbackRegistered) return
        val cm = connectivityManager() ?: return
        try {
            cm.registerDefaultNetworkCallback(networkCallback)
            callbackRegistered = true
        } catch (_: Exception) {
            // Too many callbacks / SecurityException — JS keeps its
            // navigator.onLine fallback; getConnectivity still answers.
        }
    }

    private fun updateOnline(next: Boolean) {
        if (online == next) return
        online = next
        connectivityChannel?.send(JSObject().put("online", next))
    }

    @Command
    fun getConnectivity(invoke: Invoke) {
        online = snapshotOnline()
        invoke.resolve(JSObject().put("supported", true).put("online", online))
    }

    @Command
    fun watchConnectivity(invoke: Invoke) {
        val args = invoke.parseArgs(WatchConnectivityArgs::class.java)
        registerNetworkCallback() // in case load-time registration failed
        connectivityChannel = args.channel
        // The fresh watcher gets the current truth immediately — no gap
        // between snapshot and first change event.
        args.channel.send(JSObject().put("online", online))
        invoke.resolve(JSObject().put("success", true))
    }

    @Command
    fun unwatchConnectivity(invoke: Invoke) {
        connectivityChannel = null
        invoke.resolve(JSObject().put("success", true))
    }

    @Command
    fun startService(invoke: Invoke) {
        val intent = Intent(activity, StayConnectedService::class.java)
        ContextCompat.startForegroundService(activity, intent)
        invoke.resolve(JSObject().put("success", true))
    }

    @Command
    fun stopService(invoke: Invoke) {
        val intent = Intent(activity, StayConnectedService::class.java)
        activity.stopService(intent)
        invoke.resolve(JSObject().put("success", true))
    }

    @Command
    fun isRunning(invoke: Invoke) {
        invoke.resolve(JSObject().put("running", StayConnectedService.isRunning))
    }

    @Command
    fun updateState(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateStateArgs::class.java)
        StayConnectedService.updateStateText(activity.applicationContext, args.text)
        invoke.resolve(JSObject().put("success", true))
    }
}
