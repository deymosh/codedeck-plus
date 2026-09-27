package com.codedeck.plus.platform

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The logcat tags CodeDeck+ itself writes under: the Rust core
 * (`crates/client-ffi`'s logger), the NIP-55 signer, and the runtime's own
 * crash reports. Nothing else the process logs (the framework, libraries)
 * is shown.
 */
private val APP_LOG_TAGS = listOf("codedeck", SIGNER_LOG_TAG, "AndroidRuntime")

/** The most lines [readAppLogs] returns. */
private const val MAX_LOG_LINES = 3000

/**
 * CodeDeck+'s own log lines, oldest first, from logcat's buffer. An app reads
 * only its own lines there, so this includes an earlier run of the app (the
 * crash that ended it, say) for as long as the buffer holds it. Neither the
 * core nor the signer logs secrets, payloads or message content.
 */
suspend fun readAppLogs(): List<String> = withContext(Dispatchers.IO) {
    val command = listOf("logcat", "-d", "-v", "time", "-t", "$MAX_LOG_LINES", "-s") + APP_LOG_TAGS.map { "$it:V" }
    runCatching {
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        process.inputStream.bufferedReader().useLines { lines ->
            lines.filter { it.isNotBlank() && !it.startsWith("---------") }.toList()
        }.also { process.waitFor() }
    }.getOrElse { listOf("Could not read the log: ${it.message}") }
}
