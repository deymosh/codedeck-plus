package com.codedeck.plus

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.Shell
import com.codedeck.plus.ui.theme.CodeDeckTheme
import kotlinx.coroutines.launch
import java.security.SecureRandom

/**
 * Owns the one `CoreBridge` for the process's lifetime — an ephemeral,
 * throwaway identity for now (no SecureStore/Keystore port yet; that lands
 * with the platform-ports work). Proves the FFI round trip end to end: the
 * `.so` loads, `Core.new` spawns, `start()` drives the connection FSM, and
 * `connection` reflects a real status change back into Compose.
 */
class MainViewModel : ViewModel() {
    private val identitySecretHex = ByteArray(32).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }

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
