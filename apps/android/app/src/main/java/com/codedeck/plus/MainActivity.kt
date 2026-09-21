package com.codedeck.plus

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.ui.Shell
import com.codedeck.plus.ui.theme.CodeDeckTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Holds the [CoreBridge] reference handed back once [MainActivity] binds to
 * [StayConnectedService] — the service, not this `ViewModel`, owns the
 * `CoreBridge`'s actual lifecycle (see that class's own doc comment for why
 * a plain `ViewModel` isn't enough: it survives configuration changes but
 * not process death).
 */
class MainViewModel : ViewModel() {
    private val _bridge = MutableStateFlow<CoreBridge?>(null)
    val bridge: StateFlow<CoreBridge?> = _bridge.asStateFlow()

    /** Deep link arriving before the bridge attached; replayed in [attach].
     *  Main-thread-only access, so a plain var holds. */
    private var pendingSession: Pair<String, String>? = null

    fun attach(bridge: CoreBridge) {
        _bridge.value = bridge
        pendingSession?.let { (machine, sessionId) ->
            pendingSession = null
            dispatchSelectSession(machine, sessionId)
        }
    }

    fun selectSession(machine: String, sessionId: String) {
        if (_bridge.value != null) {
            dispatchSelectSession(machine, sessionId)
        } else {
            pendingSession = machine to sessionId
        }
    }

    private fun dispatchSelectSession(machine: String, sessionId: String) {
        viewModelScope.launch {
            _bridge.value?.dispatch(uniffi.uniffi_bridge.UniffiIntent.SelectSession(machine, sessionId))
        }
    }
}

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op either way — Notifier.notify() re-checks itself before every post */ }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val service = (binder as? StayConnectedService.LocalBinder)?.getService() ?: return
            viewModel.attach(service.bridge)
        }
        override fun onServiceDisconnected(name: ComponentName?) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleDeepLink(intent)
        // Draws behind the status/navigation bars on every supported API
        // level — targetSdk 35+ enforces this regardless. The app consumes
        // the bar + keyboard insets itself (the root Surface below); without
        // that, headers render under the clock/battery area and the keyboard
        // covers the composer.
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Launched unconditionally of the "stay connected" setting: this
        // service hosts the CoreBridge the whole app runs on, so it must
        // exist whenever the app does. It reconciles its own foreground
        // state against the setting (see StayConnectedService).
        ContextCompat.startForegroundService(this, Intent(this, StayConnectedService::class.java))
        setContent {
            CodeDeckTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .systemBarsPadding()
                        .imePadding(),
                ) {
                    val bridge by viewModel.bridge.collectAsState()
                    val current = bridge
                    if (current != null) {
                        // Density and fontScale multiply together so dp spacing
                        // and sp text scale as one, like the TSX multiplier.
                        val settings by current.settings.collectAsState()
                        val scale = settings?.uiScale?.toFloat() ?: 1f
                        val d = LocalDensity.current
                        CompositionLocalProvider(
                            LocalDensity provides Density(d.density * scale, d.fontScale * scale),
                        ) { Shell(current) }
                    } else {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        bindService(Intent(this, StayConnectedService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        unbindService(connection)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "codedeck" || uri.host != "session") return
        // Notifier.kt builds codedeck://session/<machine>/<sessionId> — one
        // path segment per key part, already decoded by Uri here.
        val segments = uri.pathSegments
        if (segments.size == 2 && segments.none { it.isBlank() }) {
            viewModel.selectSession(segments[0], segments[1])
        }
    }
}
