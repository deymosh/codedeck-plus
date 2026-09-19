package com.codedeck.plus.platform

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import uniffi.uniffi_bridge.UniffiHttpHeader
import uniffi.uniffi_bridge.UniffiHttpException
import uniffi.uniffi_bridge.UniffiHttpResponse
import uniffi.uniffi_bridge.UniffiHttpFetch

/**
 * The Kotlin side of the `HttpFetch` port (see `UniffiHttpFetch` in
 * `crates/uniffi-bridge/src/lib.rs`): the real transport the core uses for
 * Blossom image upload/download. Plain `HttpURLConnection` — deliberately
 * no extra HTTP dependency.
 *
 * SOCKS support is not optional here: when Tor is on, these calls are the
 * phone's network path for image bytes and they must leave through Orbot
 * exactly like the relay sockets do. Going direct would both deanonymize
 * the upload (the Blossom server sees the device IP instead of Tor's exit)
 * and strand users whose network blocks the Blossom host — the repo's
 * network paths never bypass the configured proxy. [setProxy] receives the
 * same bare `host:port` string the WS transport dials (see the Rust trait's
 * doc comment for the format), so one setting moves the relay path and this
 * path together.
 *
 * Every method is invoked from a Rust worker thread (the adapter hops off
 * the core loop before calling in) — safe to block for minutes on a slow
 * Tor upload, but it must not touch main-thread-only state.
 */
class CoreHttpFetch : UniffiHttpFetch {

    /** Current SOCKS proxy, or null for direct — swapped live by [setProxy]. */
    @Volatile
    private var proxy: Proxy? = null

    override fun put(url: String, headers: List<UniffiHttpHeader>, body: ByteArray): UniffiHttpResponse =
        exchange(url, "PUT", headers, body)

    override fun get(url: String): UniffiHttpResponse =
        exchange(url, "GET", emptyList(), null)

    override fun setProxy(proxy: String?) {
        if (proxy == null) {
            this.proxy = null
            return
        }
        // A malformed address leaves the previous setting in place rather
        // than falling back to direct: silently going direct when Tor is
        // expected would be exactly the proxy bypass the port exists to
        // prevent (mirrors `ReqwestHttpFetch::set_proxy`'s behavior).
        parseSocksProxy(proxy)?.let { this.proxy = it }
    }

    /**
     * Parse the wire's bare `host:port` SOCKS5 address (e.g. `127.0.0.1:9050`;
     * bracketed IPv6 `[::1]:9050` also accepted) — NO `socks5://` scheme, the
     * caller never sends one. Returns null for anything unparseable.
     * [InetSocketAddress.createUnresolved] keeps hostname resolution on the
     * SOCKS server (Orbot), never on the device — the remote-DNS behavior the
     * relay path gets from its own SOCKS dialing.
     */
    private fun parseSocksProxy(addr: String): Proxy? {
        val spec = addr.trim()
        val host: String
        val port: Int
        if (spec.startsWith("[")) {
            val close = spec.indexOf(']')
            val colon = if (close >= 0) spec.indexOf(':', close) else -1
            if (close < 0 || colon < 0) return null
            host = spec.substring(1, close)
            port = spec.substring(colon + 1).toIntOrNull() ?: return null
        } else {
            val colon = spec.lastIndexOf(':')
            if (colon <= 0) return null
            host = spec.substring(0, colon)
            port = spec.substring(colon + 1).toIntOrNull() ?: return null
        }
        if (port !in 1..65535) return null
        return Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved(host, port))
    }

    /**
     * One blocking HTTP exchange. Non-2xx statuses come back as a normal
     * [UniffiHttpResponse] with the server's error-stream body — the caller
     * inspects `status` and wants the error text; only a failure to reach
     * the server at all throws [UniffiHttpException.Failed].
     */
    private fun exchange(url: String, method: String, headers: List<UniffiHttpHeader>, body: ByteArray?): UniffiHttpResponse {
        val conn = URL(url).openConnection(proxy ?: Proxy.NO_PROXY) as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            for (header in headers) {
                conn.setRequestProperty(header.name, header.value)
            }
            if (body != null) {
                conn.doOutput = true
                // Streaming mode writes the body straight through instead of
                // buffering a second copy — multi-MB images on a phone are
                // not a rounding error.
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val bytes = stream?.let { readAll(it) } ?: ByteArray(0)
            return UniffiHttpResponse(status.toUShort(), bytes)
        } catch (e: IOException) {
            val detail = e.message ?: "no detail"
            throw UniffiHttpException.Failed("$method $url failed: ${e.javaClass.simpleName}: $detail")
        } finally {
            conn.disconnect()
        }
    }

    /** `InputStream.readAllBytes` needs API 33; read in chunks instead. */
    private fun readAll(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(BUFFER_SIZE)
        while (true) {
            val n = stream.read(chunk)
            if (n < 0) break
            out.write(chunk, 0, n)
        }
        return out.toByteArray()
    }

    private companion object {
        // Generous on purpose: a several-MB upload over Tor on mobile data
        // routinely outlasts socket defaults (see BLOSSOM_*_TIMEOUT_MS on the
        // Rust side for the retry budget these sit inside).
        const val CONNECT_TIMEOUT_MS = 60_000
        const val READ_TIMEOUT_MS = 120_000
        const val BUFFER_SIZE = 64 * 1024
    }
}
