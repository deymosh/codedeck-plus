import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import uniffi.client_core_probe.Core
import uniffi.client_core_probe.CoreEvent
import uniffi.client_core_probe.CoreException
import uniffi.client_core_probe.CoreListener
import uniffi.client_core_probe.CryptoException
import uniffi.client_core_probe.Intent
import uniffi.client_core_probe.decryptFrom
import uniffi.client_core_probe.encryptTo
import uniffi.client_core_probe.generateKeypair
import uniffi.client_core_probe.keypairFromSecret
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** A foreign listener: Rust calls back into this on its bg thread. */
private class Collector : CoreListener {
    val events = CopyOnWriteArrayList<CoreEvent>()
    override fun onEvent(event: CoreEvent) {
        // exhaustive `when` on the sealed class — the Compose-side match
        when (event) {
            is CoreEvent.StateChanged -> events.add(event)
            is CoreEvent.TranscriptAppended -> events.add(event)
            is CoreEvent.ActionFailed -> events.add(event)
        }
    }
}

class ProbeTest {

    @Test
    fun nip44RoundTripAndTypedError() {
        val a = generateKeypair()
        val b = generateKeypair()

        val ct = encryptTo(a.secretHex, b.publicHex, "hola mundo")
        val pt = decryptFrom(b.secretHex, a.publicHex, ct)
        assertEquals("hola mundo", pt)

        assertFailsWith<CryptoException.BadKey> { keypairFromSecret("not-hex") }
    }

    @Test
    fun suspendDispatchTypedErrorsAndCallbacks() = runBlocking {
        val core = Core()
        val col = Collector()
        core.subscribe(col)

        // dispatch before start -> typed NotStarted, as a normal Kotlin exception
        assertFailsWith<CoreException.NotStarted> {
            core.dispatch(Intent.Interrupt("s"))
        }

        core.start()

        // typed Rejected via the async path
        val rejected = assertFailsWith<CoreException.Rejected> {
            core.dispatch(Intent.ForceReject("busy"))
        }
        assertEquals("busy", rejected.reason)

        // a successful async dispatch drives a callback
        core.dispatch(Intent.SendInput("s", "hi"))
        assertTrue(col.events.any { it is CoreEvent.StateChanged }, "SendInput should have emitted StateChanged")

        core.stop()
        core.close()
    }

    @Test
    fun concurrencyStormWhileBackgroundTaskEmits() = runBlocking {
        val core = Core()
        val col = Collector()
        core.subscribe(col)
        core.start()

        // 50 concurrent suspend dispatches while the Rust bg "socket" task emits
        (0 until 50).map { i ->
            async { core.dispatch(Intent.SendInput("s", "m$i")) }
        }.awaitAll()

        core.stop()

        val stateChanges = col.events.count { it is CoreEvent.StateChanged }
        val appended = col.events.count { it is CoreEvent.TranscriptAppended }
        assertEquals(50, stateChanges, "one StateChanged per SendInput, none lost/dup under contention")
        assertTrue(appended >= 1, "bg task emitted during the storm")

        core.close()
    }

    @Test
    fun lifecycleNoEventsAfterStop() = runBlocking {
        val core = Core()
        val col = Collector()
        core.subscribe(col)

        core.start()
        Thread.sleep(700)
        core.stop()
        val afterStop = col.events.size
        assertTrue(afterStop >= 2, "bg task should have emitted a few, got $afterStop")

        Thread.sleep(500)
        assertEquals(afterStop, col.events.size, "no events after stop()")
        assertTrue(!core.snapshot().running)

        core.close()
    }
}
