package com.codedeck.plus.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the device's default network can reach the internet right now —
 * fed to the core's connection FSM (`StayConnectedService`): going offline
 * parks the connection instead of retrying against a dead radio, and coming
 * back reconnects at once with a fresh backoff rather than after the current
 * retry delay, which under Tor can be long.
 *
 * Tracks the DEFAULT network, so losing Wi-Fi while mobile data carries on
 * is a switch, not an outage. Only the INTERNET capability counts, not
 * VALIDATED: "offline" closes live sockets, and validation is known to fail
 * on networks that reach relays fine (captive-portal false negatives, some
 * VPNs), so requiring it would cut working connections.
 */
class Connectivity(context: Context) {
    private val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _online = MutableStateFlow(hasInternetNow())
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Refined by the onCapabilitiesChanged that always follows.
            _online.value = true
        }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            _online.value = hasInternet(capabilities)
        }
        override fun onLost(network: Network) {
            _online.value = false
        }
    }

    init {
        manager.registerDefaultNetworkCallback(callback)
    }

    fun close() {
        runCatching { manager.unregisterNetworkCallback(callback) }
    }

    private fun hasInternet(capabilities: NetworkCapabilities): Boolean =
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)

    private fun hasInternetNow(): Boolean {
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        return hasInternet(capabilities)
    }
}
