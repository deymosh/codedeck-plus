package com.codedeck.plus

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.platform.KeyVault
import com.codedeck.plus.platform.Login
import com.codedeck.plus.platform.LoginStore
import com.codedeck.plus.platform.Notifier
import com.codedeck.plus.platform.SignerAppInfo
import com.codedeck.plus.platform.SignerIntents
import com.codedeck.plus.platform.StayConnectedService
import com.codedeck.plus.platform.freshSecretHex
import com.codedeck.plus.platform.getPublicKeyIntent
import com.codedeck.plus.platform.installedSignerApps
import com.codedeck.plus.platform.signerAnswerOf
import com.codedeck.plus.ui.OpenSessionRequest
import com.codedeck.plus.ui.Shell
import com.codedeck.plus.ui.screens.WelcomeBusy
import com.codedeck.plus.ui.screens.WelcomeScreen
import com.codedeck.plus.ui.theme.CodeDeckTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.client_ffi.pubkeyHexOf
import uniffi.client_ffi.secretHexOf

/**
 * Holds the [CoreHost] reference handed back once [MainActivity] binds to
 * [StayConnectedService] — the service, not this `ViewModel`, owns the
 * `CoreHost`'s actual lifecycle (see that class's own doc comment for why
 * a plain `ViewModel` isn't enough: it survives configuration changes but
 * not process death).
 */
class MainViewModel : ViewModel() {
    private val _core = MutableStateFlow<CoreHost?>(null)
    val core: StateFlow<CoreHost?> = _core.asStateFlow()

    /**
     * A session a notification tap / deep link asked to open, held until the
     * shell consumes it — which also covers a link arriving before the core
     * attached, since the shell only composes once it has. The shell both
     * navigates and selects: selecting alone would not open anything when
     * the session is already the core's selection.
     */
    private val _openRequest = MutableStateFlow<OpenSessionRequest?>(null)
    val openRequest: StateFlow<OpenSessionRequest?> = _openRequest.asStateFlow()

    /** Whether a login exists; until one does, the welcome screen shows and
     *  no core runs. */
    val loggedIn = MutableStateFlow<Boolean?>(null)
    val welcomeBusy = MutableStateFlow<WelcomeBusy?>(null)
    val welcomeError = MutableStateFlow<String?>(null)
    val signers = MutableStateFlow<List<SignerAppInfo>>(emptyList())

    fun attach(core: CoreHost) {
        _core.value = core
    }

    fun requestOpenSession(machine: String, sessionId: String) {
        _openRequest.value = OpenSessionRequest(machine, sessionId)
    }

    fun openRequestHandled() {
        _openRequest.value = null
    }
}

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op either way — Notifier.notify() re-checks itself before every post */ }

    /** Runs the core's signer requests that need the signer app's activity. */
    private val signerRequest =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val request = SignerIntents.inFlight ?: return@registerForActivityResult
            SignerIntents.inFlight = null
            SignerIntents.finish(request, signerAnswerOf(result.resultCode, result.data))
        }

    /** The welcome screen's `get_public_key` round trip. */
    private val publicKeyRequest =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val chosen = (viewModel.welcomeBusy.value as? WelcomeBusy.Signer)?.packageName
                ?: return@registerForActivityResult
            val answer = signerAnswerOf(result.resultCode, result.data)
            val pubkey = answer?.takeUnless { it.rejected }?.result?.let { pubkeyHexOf(it) }
            if (pubkey == null) {
                viewModel.welcomeBusy.value = null
                viewModel.welcomeError.value = "The signer app did not share a key."
                return@registerForActivityResult
            }
            val packageName = result.data?.getStringExtra("package")?.takeIf { it.isNotBlank() } ?: chosen
            logIn(Login.SignerApp(packageName, pubkey)) { vault -> vault.clearIdentity() }
        }

    /** Whether this activity is bound to the service. */
    private var bound = false

    /** Waits for the bound service's core to finish opening (the spinner
     *  shows meanwhile); cancelled with the binding. */
    private var attachJob: Job? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val service = (binder as? StayConnectedService.LocalBinder)?.getService() ?: return
            attachJob?.cancel()
            attachJob = lifecycleScope.launch {
                viewModel.attach(service.core.filterNotNull().first())
            }
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            attachJob?.cancel()
        }
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
        // Only when not already granted: onCreate reruns on every
        // configuration change, and each launch is an activity-result round
        // trip even when the system answers without showing a dialog.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        // Launched unconditionally of the "stay connected" setting: this
        // service hosts the CoreHost the whole app runs on, so it must
        // exist whenever the app does. It reconciles its own foreground
        // state against the setting (see StayConnectedService).
        val login = LoginStore(this).load()
        viewModel.loggedIn.value = login != null
        if (login != null) startCore()
        runSignerRequests()
        setContent {
            CodeDeckTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .systemBarsPadding()
                        .imePadding(),
                ) {
                    val core by viewModel.core.collectAsState()
                    val loggedIn by viewModel.loggedIn.collectAsState()
                    val current = core
                    if (loggedIn == false) {
                        val signers by viewModel.signers.collectAsState()
                        val busy by viewModel.welcomeBusy.collectAsState()
                        val error by viewModel.welcomeError.collectAsState()
                        WelcomeScreen(
                            signers = signers,
                            busy = busy,
                            error = error,
                            onUseSigner = ::useSigner,
                            onCreateKey = { logIn(Login.OnDevice) { vault -> vault.setIdentity(freshSecretHex()) } },
                            onImportKey = ::importKey,
                        )
                    } else if (current != null) {
                        // Density and fontScale multiply together so dp spacing
                        // and sp text scale as one, like the TSX multiplier.
                        val settings by current.settings.collectAsState()
                        val openRequest by viewModel.openRequest.collectAsState()
                        val scale = settings?.uiScale?.toFloat() ?: 1f
                        val d = LocalDensity.current
                        CompositionLocalProvider(
                            LocalDensity provides Density(d.density * scale, d.fontScale * scale),
                        ) {
                            Shell(
                                current,
                                openRequest = openRequest,
                                onOpenRequestHandled = viewModel::openRequestHandled,
                            )
                        }
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
        SignerIntents.visible = true
        Notifier(this).cancelSignerApproval()
        if (viewModel.loggedIn.value == true) {
            bind()
        } else {
            // Refreshed on every return: the user may have just installed one.
            viewModel.signers.value = installedSignerApps(this)
        }
    }

    override fun onStop() {
        SignerIntents.visible = false
        attachJob?.cancel()
        if (bound) {
            unbindService(connection)
            bound = false
        }
        super.onStop()
    }

    private fun bind() {
        if (!bound) {
            bound = bindService(Intent(this, StayConnectedService::class.java), connection, Context.BIND_AUTO_CREATE)
        }
    }

    /** Starts the service that owns the core; only once a login exists. */
    private fun startCore() {
        // Launched unconditionally of the "stay connected" setting: this
        // service hosts the CoreHost the whole app runs on, so it must
        // exist whenever the app does. It reconciles its own foreground
        // state against the setting (see StayConnectedService).
        ContextCompat.startForegroundService(this, Intent(this, StayConnectedService::class.java))
    }

    /** Hands the core's queued signer requests to the signer app, one at a
     *  time, while this activity is visible. */
    private fun runSignerRequests() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                SignerIntents.next.collect { request ->
                    if (request == null || SignerIntents.inFlight != null) return@collect
                    SignerIntents.inFlight = request
                    try {
                        signerRequest.launch(request.intent)
                    } catch (e: ActivityNotFoundException) {
                        SignerIntents.inFlight = null
                        SignerIntents.finish(request, null)
                    }
                }
            }
        }
    }

    private fun useSigner(signer: SignerAppInfo) {
        viewModel.welcomeError.value = null
        viewModel.welcomeBusy.value = WelcomeBusy.Signer(signer.packageName)
        try {
            publicKeyRequest.launch(getPublicKeyIntent(signer.packageName))
        } catch (e: ActivityNotFoundException) {
            viewModel.welcomeBusy.value = null
            viewModel.welcomeError.value = "Could not open ${signer.label}."
        }
    }

    private fun importKey(input: String) {
        val secret = secretHexOf(input)
        if (secret == null) {
            viewModel.welcomeError.value = "That is not an nsec or a hex secret key."
            return
        }
        logIn(Login.OnDevice) { vault -> vault.setIdentity(secret) }
    }

    /** Store `login` (after `prepare` set up its keys, off the main thread),
     *  give it a fresh session key, and start the core. */
    private fun logIn(login: Login, prepare: (KeyVault) -> Unit) {
        viewModel.welcomeError.value = null
        if (viewModel.welcomeBusy.value == null) viewModel.welcomeBusy.value = WelcomeBusy.Key
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val vault = KeyVault(applicationContext)
                    prepare(vault)
                    vault.resetSession()
                    LoginStore(applicationContext).save(login)
                }.isSuccess
            }
            viewModel.welcomeBusy.value = null
            if (!ok) {
                viewModel.welcomeError.value = "Could not store the key on this device."
                return@launch
            }
            viewModel.loggedIn.value = true
            startCore()
            bind()
        }
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
            viewModel.requestOpenSession(segments[0], segments[1])
        }
    }
}
