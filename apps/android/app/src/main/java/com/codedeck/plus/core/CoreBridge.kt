package com.codedeck.plus.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import uniffi.client_runtime.ActionFailedKind
import uniffi.client_runtime.ConnectionView
import uniffi.client_runtime.CoreEvent
import uniffi.uniffi_bridge.Core
import uniffi.uniffi_bridge.CoreListener
import uniffi.uniffi_bridge.UniffiIntent

/**
 * The Kotlin-side counterpart to `apps/mobile/src/core/nativeCore.ts` and
 * `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriObserver`: owns the
 * generated `Core` object, implements the generated `CoreListener` callback
 * interface, and republishes each callback as a `StateFlow` a Composable can
 * collect. Nothing here understands the wire protocol, a session, or a
 * transcript — that is entirely `crates/client-runtime`'s job on the other
 * side of the FFI boundary.
 */
class CoreBridge(relays: List<String>, identitySecretHex: String) : CoreListener {
    private val _connection = MutableStateFlow<ConnectionView?>(null)
    val connection: StateFlow<ConnectionView?> = _connection.asStateFlow()

    private val _events = MutableStateFlow<CoreEvent?>(null)
    val events: StateFlow<CoreEvent?> = _events.asStateFlow()

    private val core: Core = Core(relays, identitySecretHex, this)

    fun start() = core.start()

    fun stop() = core.stop()

    suspend fun dispatch(intent: UniffiIntent) = core.dispatch(intent)

    override fun connectionChanged(view: ConnectionView) {
        _connection.value = view
    }

    override fun onEvent(event: CoreEvent) {
        _events.value = event
    }

    override fun actionFailed(kind: ActionFailedKind) {
        // Also surfaced as a CoreEvent.ActionFailed on `events` (client-runtime
        // emits both) — nothing extra to do here yet. A dedicated toast/banner
        // channel is a screen-level concern, added when a screen exists.
    }
}
