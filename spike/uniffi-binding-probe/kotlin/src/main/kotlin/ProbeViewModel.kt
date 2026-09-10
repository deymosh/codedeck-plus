package probe

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import uniffi.client_core_probe.Core
import uniffi.client_core_probe.CoreEvent
import uniffi.client_core_probe.CoreException
import uniffi.client_core_probe.CoreListener
import uniffi.client_core_probe.Intent
import uniffi.client_core_probe.ProbeView

/**
 * Illustrative — the shape a real Compose `ViewModel` would take over the
 * generated bindings. Compiles (proves the API is ergonomic), not run here.
 *
 * Note how little glue there is: the sealed `CoreEvent` folds into a
 * `StateFlow`, `dispatch` is a normal `suspend fun` in a coroutine, and
 * `CoreException` subclasses are caught like any Kotlin exception.
 */
class ProbeViewModel(
    private val core: Core,
    private val scope: CoroutineScope,
) {
    private val _view = MutableStateFlow(core.snapshot())
    val view: StateFlow<ProbeView> = _view.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    private val listener = object : CoreListener {
        override fun onEvent(event: CoreEvent) {
            when (event) {
                is CoreEvent.StateChanged,
                is CoreEvent.TranscriptAppended -> _view.value = core.snapshot()
                is CoreEvent.ActionFailed -> _lastError.value = event.kind
            }
        }
    }

    fun start() {
        core.subscribe(listener)
        core.start()
    }

    fun send(session: String, text: String) = scope.launch {
        try {
            core.dispatch(Intent.SendInput(session, text))
        } catch (e: CoreException.Rejected) {
            _lastError.value = "rejected: ${e.reason}"
        } catch (e: CoreException.NotStarted) {
            _lastError.value = "not started"
        }
    }

    fun stop() {
        core.stop()
        core.close()
    }
}
