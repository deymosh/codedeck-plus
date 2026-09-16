package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiPairingView

/** This build's fixed device label — mirrors `apps/mobile/src/ui/label.ts`'s
 *  `PHONE_LABEL`, sent with every `BeginPairing`/`BeginManualPairing`/
 *  `ConfirmStagedPairing` so the bridge's own pairing UI can tell devices
 *  apart. A per-device editable label is out of this screen's scope. */
private const val PHONE_LABEL = "Android"

/**
 * F4.2.2 — pairing screen, rendered as a full-screen replacement the shell
 * swaps in (same pattern `SettingsScreen.kt` established): port of
 * `apps/mobile/src/ui/screens/PairingScreen.tsx`'s flow states minus the
 * in-app QR camera (F4.2.4 adds `CameraX`/ML Kit and wires its result into
 * the same [UniffiIntent.BeginPairing] this screen's "Pair with link"
 * button already dispatches — a scanned QR is parsed exactly like a pasted
 * link, one path, so this screen needs no change when that lands).
 *
 * A scanned/pasted/deep-linked URL is never parsed on this side: the raw
 * string crosses straight into [UniffiIntent.BeginPairing]/
 * [UniffiIntent.StagePairing] and `client_core::stores::pairing::
 * parse_pairing_url` does the real parsing, surfacing failure via
 * `phase == "failed"` / `error` — unlike the TSX screen, which parses
 * client-side before dispatch (see that file's own `parsePairingUrl`).
 *
 * Deliberately omitted: "this phone's npub" (TSX shows it read from a local
 * identity store; Android's identity secret has no npub-encoding path
 * exposed over the FFI yet, and adding one is out of this milestone's
 * scope) and the CDX-028 mesh-join banner (Mesh is F6, off by default).
 */
@Composable
fun PairingScreen(bridge: CoreBridge, onClose: () -> Unit) {
    val pairing by bridge.pairing.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
    }

    val view = pairing
    if (view == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
    } else {
        PairingBody(view = view, dispatch = ::dispatch, onClose = onClose)
    }
}

@Composable
private fun PairingBody(
    view: UniffiPairingView,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
) {
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Pair a machine", color = Tokens.Text, fontSize = Tokens.TextLg, modifier = Modifier.weight(1f))
                Text(
                    "×",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXl,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .clickable(onClick = onClose)
                        .padding(Tokens.Space2),
                )
            }

            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space4),
            ) {
                val staged = view.staged
                when {
                    // CDX-013: a deep link arrived without direct user action —
                    // show what it wants to pair with and require an explicit
                    // tap. Nothing has been sent to the bridge yet.
                    staged != null && view.phase == "idle" -> StagedConfirm(staged.machine, staged.npub, staged.relays, dispatch)
                    view.phase == "awaiting-ack" -> AwaitingAck(view.candidate?.machine, dispatch)
                    view.phase == "paired" -> Paired(view.candidate?.machine, dispatch, onClose)
                    else -> PairingForm(view, dispatch)
                }
            }
        }
    }
}

@Composable
private fun StagedConfirm(
    machine: String,
    npub: String,
    relays: List<String>,
    dispatch: (UniffiIntent) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Banner(
            "A pairing link wants to connect this phone to a machine. Only continue " +
                "if YOU opened this link (e.g. from your own bridge).",
            Tokens.Warn,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Tokens.RadiusMd))
                .background(Tokens.SurfaceRaised)
                .padding(Tokens.Space3),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                Text("Machine: $machine", color = Tokens.Text, fontSize = Tokens.TextSm)
                Text(
                    "Bridge npub: ${npub.take(12)}…${npub.takeLast(6)}",
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                    fontFamily = Tokens.FontMono,
                )
                Text("Relays: ${relays.joinToString(", ")}", color = Tokens.Text, fontSize = Tokens.TextSm)
            }
        }
        Button(onClick = { dispatch(UniffiIntent.ConfirmStagedPairing(PHONE_LABEL)) }) {
            Text("Pair with $machine")
        }
        Text(
            "Dismiss",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .clickable { dispatch(UniffiIntent.DismissStagedPairing) }
                .padding(Tokens.Space2),
        )
    }
}

@Composable
private fun AwaitingAck(machine: String?, dispatch: (UniffiIntent) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Banner(
            "Pairing with ${machine ?: "bridge"}… waiting for the bridge to answer " +
                "(the pairing window on the bridge must be open).",
            Tokens.TextMuted,
        )
        Text(
            "Cancel",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .clickable { dispatch(UniffiIntent.ResetPairing) }
                .padding(Tokens.Space2),
        )
    }
}

@Composable
private fun Paired(machine: String?, dispatch: (UniffiIntent) -> Unit, onClose: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Banner("Paired with ${machine ?: "bridge"}.", Tokens.Success)
        Button(
            onClick = {
                dispatch(UniffiIntent.ResetPairing)
                onClose()
            },
        ) {
            Text("Go to machines")
        }
    }
}

@Composable
private fun PairingForm(view: UniffiPairingView, dispatch: (UniffiIntent) -> Unit) {
    var url by remember { mutableStateOf("") }
    var manualNpub by remember { mutableStateOf("") }
    var manualToken by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
        if (view.phase == "failed") {
            Banner("Pairing failed: ${view.error ?: "rejected"}. Open a fresh pairing window on the bridge and try again.", Tokens.Danger)
        }

        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Text("Pairing link (from the bridge QR / codedeck pair)", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                placeholder = { Text("codedeck://pair?npub=…") },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { dispatch(UniffiIntent.BeginPairing(url.trim(), PHONE_LABEL)) },
                enabled = url.isNotBlank(),
            ) {
                Text("Pair with link")
            }
        }

        Text("or manually", color = Tokens.TextDim, fontSize = Tokens.TextSm)

        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            OutlinedTextField(
                value = manualNpub,
                onValueChange = { manualNpub = it },
                label = { Text("Bridge npub") },
                placeholder = { Text("npub1…") },
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = manualToken,
                onValueChange = { manualToken = it },
                label = { Text("One-time token") },
                placeholder = { Text("token from the bridge pairing screen") },
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    dispatch(UniffiIntent.BeginManualPairing(manualNpub.trim(), manualToken.trim(), PHONE_LABEL))
                },
                enabled = manualNpub.isNotBlank() && manualToken.isNotBlank(),
            ) {
                Text("Pair manually")
            }
        }
    }
}

@Composable
private fun Banner(text: String, accent: androidx.compose.ui.graphics.Color) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
        Text(text, color = accent, fontSize = Tokens.TextSm)
    }
}
