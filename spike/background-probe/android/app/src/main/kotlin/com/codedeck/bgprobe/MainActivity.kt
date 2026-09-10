package com.codedeck.bgprobe

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.codedeck.bgprobe.databinding.ActivityMainBinding

/**
 * Minimal dashboard: starts/stops the service and shows the running delivery
 * count + seconds since the last heartbeat. `adb logcat -s bgprobe` has the
 * full stream for the background matrix.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private var lastMs = 0L
    private var received = 0L
    private var reconnects = 0L
    private var connected = false
    private var startedMs = 0L

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            i ?: return
            received = i.getLongExtra("received", received)
            lastMs = i.getLongExtra("last", lastMs)
            reconnects = i.getLongExtra("reconnects", reconnects)
            connected = i.getBooleanExtra("connected", connected)
            startedMs = i.getLongExtra("started", startedMs)
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.start.setOnClickListener {
            maybeAskNotifications()
            startService(Intent(this, RelayService::class.java))
        }
        b.startWl.setOnClickListener {
            maybeAskNotifications()
            startService(Intent(this, RelayService::class.java).putExtra(RelayService.EXTRA_WAKELOCK, true))
        }
        b.stop.setOnClickListener { stopService(Intent(this, RelayService::class.java)) }
        render()
    }

    override fun onResume() {
        super.onResume()
        val flags = if (Build.VERSION.SDK_INT >= 33) Context.RECEIVER_NOT_EXPORTED else 0
        registerReceiver(receiver, IntentFilter(RelayService.ACTION_STATS), flags)
        render()
    }

    override fun onPause() {
        super.onPause()
        runCatching { unregisterReceiver(receiver) }
    }

    private fun render() {
        val now = System.currentTimeMillis()
        val sinceHb = if (lastMs == 0L) "never" else "${(now - lastMs) / 1000}s ago"
        val uptime = if (startedMs == 0L) "-" else "${(now - startedMs) / 1000}s"
        b.status.text = buildString {
            append("connected: $connected\n")
            append("heartbeats received: $received\n")
            append("last heartbeat: $sinceHb\n")
            append("reconnects: $reconnects\n")
            append("probe uptime: $uptime\n")
        }
    }

    private fun maybeAskNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
