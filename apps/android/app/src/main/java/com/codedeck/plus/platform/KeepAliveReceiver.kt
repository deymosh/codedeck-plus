package com.codedeck.plus.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Target of the stay-connected keep-alive alarm. The alarm manager holds the
 * device awake only while [onReceive] runs, so the receiver hands its
 * [BroadcastReceiver.PendingResult] to the running [StayConnectedService],
 * which takes its own short wake lock for the check and finishes the
 * broadcast when done. No service (process restarted, stay-connected off):
 * nothing to check.
 */
class KeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val service = StayConnectedService.instance ?: return
        service.keepAlive(goAsync())
    }
}
