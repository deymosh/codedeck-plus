package com.codedeck.mesh.vpn

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class MeshVpnBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        if (!VpnStartState.userWantsVpn(context)) {
            return
        }
        runCatching {
            MeshVpnService.startRestore(context)
        }.onFailure { error ->
            Log.w("MeshVpnBootReceiver", "Failed to restore VPN service", error)
        }
    }
}
