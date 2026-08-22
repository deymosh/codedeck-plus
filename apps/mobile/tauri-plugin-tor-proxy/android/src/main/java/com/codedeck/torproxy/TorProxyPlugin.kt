package com.codedeck.torproxy

import android.app.Activity
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executor

@InvokeArg
class EnableArgs {
    var host: String = "127.0.0.1"
    var port: Int = 9050
}

/**
 * Routes the WebView's outbound traffic — including the relay WebSockets the
 * JS core opens (see relayTransport.ts) — through a local SOCKS5 proxy
 * (Orbot), via androidx.webkit.ProxyController.setProxyOverride.
 *
 * This is PROCESS-WIDE: it applies to every WebView in the app, not one
 * instance, which is why `enable`/`disable` don't need a WebView reference
 * the way BackgroundRelayPlugin's connectivity commands do.
 *
 * setProxyOverride only affects connections opened AFTER it resolves — the
 * JS side must call `enable` before opening its first relay WebSocket (see
 * main.tsx, which does this before constructing the relay transport).
 *
 * Orbot itself is not launched or managed here — this only configures where
 * the WebView's traffic goes; if Orbot's SOCKS proxy isn't actually
 * listening, connections just fail the way any unreachable proxy would (the
 * existing connection FSM already surfaces that as "relay unreachable").
 */
@TauriPlugin
class TorProxyPlugin(private val activity: Activity) : Plugin(activity) {

    /** setProxyOverride's callback executor — run synchronously on the
     *  calling thread, matching Invoke.resolve()'s own expectations. */
    private val immediateExecutor = Executor { it.run() }

    @Command
    fun enable(invoke: Invoke) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            // Old WebView provider — tell JS rather than silently proxying nothing.
            invoke.resolve(JSObject().put("supported", false))
            return
        }
        val args = invoke.parseArgs(EnableArgs::class.java)
        val config = ProxyConfig.Builder()
            .addProxyRule("socks5://${args.host}:${args.port}")
            .build()
        try {
            ProxyController.getInstance().setProxyOverride(config, immediateExecutor) {
                invoke.resolve(JSObject().put("supported", true))
            }
        } catch (e: Exception) {
            invoke.reject("failed to set proxy override: ${e.message}")
        }
    }

    @Command
    fun disable(invoke: Invoke) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            invoke.resolve(JSObject().put("success", true))
            return
        }
        try {
            ProxyController.getInstance().clearProxyOverride(immediateExecutor) {
                invoke.resolve(JSObject().put("success", true))
            }
        } catch (e: Exception) {
            invoke.reject("failed to clear proxy override: ${e.message}")
        }
    }
}
