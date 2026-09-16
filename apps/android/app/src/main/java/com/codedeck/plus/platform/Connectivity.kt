package com.codedeck.plus.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Tracks whether the device currently has a network with real internet
 * access — WebView never fires `window.online`/`offline` reliably, and a
 * native app has no such event either without this. Not wired into the
 * `Core` yet: no `Intent` exists for "network became reachable" (the
 * connection FSM's own reconnect/backoff logic is socket-driven, not
 * network-driven), so this is read-only infrastructure for a future
 * "offline" banner, exactly the shape `apps/mobile`'s own port had before a
 * screen consumed it.
 */
class Connectivity(context: Context) {
    private val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _online = MutableStateFlow(hasValidatedInternetNow())
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _online.value = true
        }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            _online.value = hasValidatedCapabilities(capabilities)
        }
        override fun onLost(network: Network) {
            _online.value = false
        }
    }

    init {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        manager.registerNetworkCallback(request, callback)
    }

    fun close() {
        runCatching { manager.unregisterNetworkCallback(callback) }
    }

    private fun hasValidatedCapabilities(capabilities: NetworkCapabilities): Boolean =
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

    private fun hasValidatedInternetNow(): Boolean {
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        return hasValidatedCapabilities(capabilities)
    }
}
