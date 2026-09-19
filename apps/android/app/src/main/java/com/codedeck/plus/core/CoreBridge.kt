package com.codedeck.plus.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import uniffi.client_runtime.ActionFailedKind
import uniffi.client_runtime.ConnectionView
import uniffi.client_runtime.CoreEvent
import uniffi.client_runtime.SliceId
import uniffi.uniffi_bridge.Core
import uniffi.uniffi_bridge.CoreListener
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiMachinesView
import uniffi.uniffi_bridge.UniffiNotifier
import uniffi.uniffi_bridge.UniffiOutboxView
import uniffi.uniffi_bridge.UniffiPairingView
import uniffi.uniffi_bridge.UniffiPendingSessionsView
import uniffi.uniffi_bridge.UniffiQuickPromptsView
import uniffi.uniffi_bridge.UniffiSettingsView
import uniffi.uniffi_bridge.UniffiTranscriptRowsView
import uniffi.uniffi_bridge.UniffiUiView

/**
 * The Kotlin-side counterpart to `apps/mobile/src/core/nativeCore.ts` and
 * `apps/mobile/src-tauri/src/corebridge.rs`'s `TauriObserver`: owns the
 * generated `Core` object, implements the generated `CoreListener` callback
 * interface, and republishes each callback as a `StateFlow`/`Flow` a
 * Composable can collect. Nothing here understands the wire protocol, a
 * session, or a transcript — that is entirely `crates/client-runtime` and
 * `crates/uniffi-bridge`'s job on the other side of the FFI boundary.
 *
 * `CoreListener`'s callbacks are plain (non-`suspend`) Kotlin functions
 * invoked from the core's own background thread — refreshing a `*View` needs
 * a `suspend` call back across the FFI boundary, so this class owns a small
 * `CoroutineScope` to launch those from a synchronous callback, the same
 * shape `MainActivity.kt`'s `MainViewModel` already uses `viewModelScope`
 * for.
 */
class CoreBridge(relays: List<String>, identitySecretHex: String, notifier: UniffiNotifier) : CoreListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _connection = MutableStateFlow<ConnectionView?>(null)
    val connection: StateFlow<ConnectionView?> = _connection.asStateFlow()

    private val _events = MutableStateFlow<CoreEvent?>(null)
    val events: StateFlow<CoreEvent?> = _events.asStateFlow()

    private val _machines = MutableStateFlow<UniffiMachinesView?>(null)
    val machines: StateFlow<UniffiMachinesView?> = _machines.asStateFlow()

    /** Selection + optimistic card-response bookkeeping — see
     *  `crates/uniffi-bridge/src/views.rs`'s doc comment for why this is a
     *  narrowed projection rather than the real (much larger) `UiView`. */
    private val _ui = MutableStateFlow<UniffiUiView?>(null)
    val ui: StateFlow<UniffiUiView?> = _ui.asStateFlow()

    private val _outbox = MutableStateFlow<UniffiOutboxView?>(null)
    val outbox: StateFlow<UniffiOutboxView?> = _outbox.asStateFlow()

    private val _settings = MutableStateFlow<UniffiSettingsView?>(null)
    val settings: StateFlow<UniffiSettingsView?> = _settings.asStateFlow()

    private val _quickPrompts = MutableStateFlow<UniffiQuickPromptsView?>(null)
    val quickPrompts: StateFlow<UniffiQuickPromptsView?> = _quickPrompts.asStateFlow()

    /** Placeholder cards for sessions the bridge announced but that never
     *  became real (`pending`) or failed to start (`failed`, stays until the
     *  user dismisses) — the sidebar renders them above/interleaved with the
     *  real session cards. */
    private val _pendingSessions = MutableStateFlow<UniffiPendingSessionsView?>(null)
    val pendingSessions: StateFlow<UniffiPendingSessionsView?> = _pendingSessions.asStateFlow()

    private val _pairing = MutableStateFlow<UniffiPairingView?>(null)
    val pairing: StateFlow<UniffiPairingView?> = _pairing.asStateFlow()

    private val core: Core = Core(relays, identitySecretHex, this, notifier)

    fun start() {
        core.start()
        // First hydration: nothing has changed yet, so no `StateChanged`
        // will fire on its own — fetch each slice once up front. Mirrors
        // `apps/mobile`'s `hydrateFromCore` fix (see this repo's own
        // addendum on the C1 regression that pattern closed): without an
        // explicit initial fetch, a freshly-attached listener has nothing to
        // show until the first unrelated event happens to land.
        refreshMachines()
        refreshUi()
        refreshOutbox()
        refreshSettings()
        refreshQuickPrompts()
        refreshPendingSessions()
        refreshPairing()
    }

    fun stop() = core.stop()

    /** The OS backgrounded the app — debounced, never tears a healthy socket.
     *  Called from `platform/StayConnectedService.kt`'s `ProcessLifecycleOwner`
     *  observer. */
    fun pause() = core.pause()

    /** The OS foregrounded the app. */
    fun resume() = core.resume()

    suspend fun dispatch(intent: UniffiIntent) = core.dispatch(intent)

    /**
     * The phone's own Nostr id in bech32 `npub1…` form — derived by the core
     * at construction from the identity secret it holds, so callers get the
     * answer without ever touching that secret themselves. A pure field read
     * on the Rust side; screens still fetch it once off the main thread (see
     * `PairingScreen`).
     */
    fun identityNpub(): String = core.identityNpub()

    /**
     * One session's grouped, ready-to-render transcript — emits once
     * immediately, then again on every `CoreEvent` that could have changed
     * it: `TranscriptAppended` naming this exact session, or a `StateChanged`
     * on the `TRANSCRIPT` slice (sync-status-only changes, e.g. a gap being
     * filled) or the `UI` slice (a card being answered flips
     * `respondedCards`, which `TranscriptRowsView`'s pending-permission
     * projection reads). A screen collects this for as long as it shows that
     * session; cancelling the collection (leaving the screen) stops it.
     */
    fun transcriptFlow(machine: String, sessionId: String): Flow<UniffiTranscriptRowsView> = flow {
        emit(core.transcriptView(machine, sessionId))
        events.collect { event ->
            val relevant = when (event) {
                is CoreEvent.TranscriptAppended -> event.machine == machine && event.sessionId == sessionId
                is CoreEvent.StateChanged -> event.slice == SliceId.TRANSCRIPT || event.slice == SliceId.UI
                else -> false
            }
            if (relevant) emit(core.transcriptView(machine, sessionId))
        }
    }

    override fun connectionChanged(view: ConnectionView) {
        _connection.value = view
    }

    override fun onEvent(event: CoreEvent) {
        _events.value = event
        when (event) {
            is CoreEvent.StateChanged -> when (event.slice) {
                SliceId.MACHINES -> refreshMachines()
                SliceId.UI -> refreshUi()
                SliceId.OUTBOX -> refreshOutbox()
                SliceId.SETTINGS -> refreshSettings()
                SliceId.QUICK_PROMPTS -> refreshQuickPrompts()
                SliceId.PENDING_SESSIONS -> refreshPendingSessions()
                SliceId.PAIRING -> refreshPairing()
                else -> {}
            }
            else -> {}
        }
    }

    override fun actionFailed(kind: ActionFailedKind) {
        // Also surfaced as a CoreEvent.ActionFailed on `events` (client-runtime
        // emits both) — nothing extra to do here yet. A dedicated toast/banner
        // channel is a screen-level concern, added when a screen exists.
    }

    private fun refreshMachines() {
        scope.launch { _machines.value = core.machinesView() }
    }

    private fun refreshUi() {
        scope.launch { _ui.value = core.uiView() }
    }

    private fun refreshOutbox() {
        scope.launch { _outbox.value = core.outboxView() }
    }

    private fun refreshSettings() {
        scope.launch { _settings.value = core.settingsView() }
    }

    private fun refreshQuickPrompts() {
        scope.launch { _quickPrompts.value = core.quickPromptsView() }
    }

    private fun refreshPendingSessions() {
        scope.launch { _pendingSessions.value = core.pendingSessionsView() }
    }

    private fun refreshPairing() {
        scope.launch { _pairing.value = core.pairingView() }
    }
}
