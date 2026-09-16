package com.codedeck.plus

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.platform.readOrCreateIdentitySecretHex
import com.codedeck.plus.ui.Shell
import com.codedeck.plus.ui.theme.CodeDeckTheme
import kotlinx.coroutines.launch

/**
 * Owns the one `CoreBridge` for the process's lifetime, keyed to the real
 * persisted identity (`platform/SecureIdentityStore.kt`): generated once on
 * first launch, Keystore-encrypted at rest, and re-read on every subsequent
 * launch, so pairing survives a process death. Proves the FFI round trip
 * end to end: the `.so` loads, `Core.new` spawns, `start()` drives the
 * connection FSM, and `connection` reflects a real status change back into
 * Compose.
 */
class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val identitySecretHex = readOrCreateIdentitySecretHex(getApplication())

    val bridge = CoreBridge(relays = emptyList(), identitySecretHex = identitySecretHex)

    init {
        viewModelScope.launch { bridge.start() }
    }

    override fun onCleared() {
        bridge.stop()
    }
}

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CodeDeckTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Shell(viewModel.bridge)
                }
            }
        }
    }
}
