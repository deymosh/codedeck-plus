package com.codedeck.plus.ui.screens

import android.Manifest
import android.content.ClipData
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.EmptyState
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PageLoading
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiPairingView

/** This build's fixed device label — mirrors `apps/mobile/src/ui/label.ts`'s
 *  `PHONE_LABEL`, sent with every `BeginPairing`/`BeginManualPairing`/
 *  `ConfirmStagedPairing` so the bridge's own pairing UI can tell devices
 *  apart. A per-device editable label is out of this screen's scope. */
private const val PHONE_LABEL = "Android"

/**
 * The pairing screen, rendered as a full-screen replacement the shell
 * swaps in (same pattern `SettingsScreen.kt` established): port of
 * `apps/mobile/src/ui/screens/PairingScreen.tsx`'s flow states, including
 * the in-app QR camera scan ([PairingScanView]). Its decoded text
 * lands in the same `url` field a manual paste fills and is dispatched via
 * the same [UniffiIntent.BeginPairing] — one path, no scan-specific parsing.
 *
 * A scanned/pasted/deep-linked URL is never parsed on this side: the raw
 * string crosses straight into [UniffiIntent.BeginPairing]/
 * [UniffiIntent.StagePairing] and `client_core::stores::pairing::
 * parse_pairing_url` does the real parsing, surfacing failure via
 * `phase == "failed"` / `error` — unlike the TSX screen, which parses
 * client-side before dispatch (see that file's own `parsePairingUrl`).
 *
 * The pairing-link text is state at THIS level, not inside [PairingForm]:
 * the reference's screen-level state holds it across every phase branch, so
 * whatever the camera or a paste put there is still in the field when a
 * failed pairing returns the form — PairingForm leaves composition on each
 * phase swap and would drop it.
 *
 * "This phone's npub" asks the live core for its own identity
 * ([CoreHost.identityNpub] — the core derived it at construction from the
 * same secret it holds) so the secret never leaves the FFI layer for a mere
 * display string.
 */
@Composable
fun PairingScreen(core: CoreHost, onClose: () -> Unit) {
    val pairing by core.pairing.collectAsState()
    val scope = rememberCoroutineScope()

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }

    // One-shot fetch — the identity is fixed for the process's life, so it is
    // never re-fetched on recomposition. Only the npub is kept; the secret it
    // came from stays inside the core.
    var selfNpub by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        selfNpub = withContext(Dispatchers.IO) {
            runCatching { core.identityNpub() }.getOrNull()
        }
    }

    val view = pairing
    if (view == null) {
        PageLoading()
    } else {
        PairingBody(view = view, selfNpub = selfNpub, dispatch = ::dispatch, onClose = onClose)
    }
}

@Composable
internal fun PairingBody(
    view: UniffiPairingView,
    selfNpub: String?,
    dispatch: (UniffiIntent) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var url by remember { mutableStateOf("") }
    var scanOpen by remember { mutableStateOf(false) }

    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // Denied — including Android's instant deny once "don't ask again"
        // was picked — just leaves the form untouched; the paste path
        // remains, and the next tap re-requests like the reference does.
        if (granted) scanOpen = true
    }

    fun startScan() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            scanOpen = true
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    Box(Modifier.fillMaxSize()) {
        Page(title = "Pair a machine", onBack = onClose, backLabel = "Close") {
            val staged = view.staged
            when {
                // CDX-013: a deep link arrived without direct user action —
                // show what it wants to pair with and require an explicit
                // tap. Nothing has been sent to the bridge yet.
                staged != null && view.phase == "idle" -> StagedConfirm(machineLabel(staged.machine), staged.npub, staged.relays, dispatch)
                view.phase == "awaiting-ack" -> AwaitingAck(view.candidate?.machine?.let(::machineLabel), dispatch)
                view.phase == "paired" -> Paired(view.candidate?.machine?.let(::machineLabel), dispatch, onClose)
                else -> PairingForm(
                    view = view,
                    selfNpub = selfNpub,
                    url = url,
                    onUrlChange = { url = it },
                    onScanTap = { startScan() },
                    dispatch = dispatch,
                )
            }
        }

        // Rendered only while open AND after CAMERA is granted (the
        // launcher above gates it), so PairingScanView's binding effect
        // runs exactly once per granted+open window.
        if (scanOpen) {
            PairingScanView(
                onDecoded = { decoded ->
                    // One path, same as a paste: the raw string fills the
                    // visible field AND crosses into BeginPairing
                    // unparsed — the Rust side parses, and its failure
                    // surfaces as this view's "failed" phase.
                    url = decoded
                    dispatch(UniffiIntent.BeginPairing(decoded.trim(), PHONE_LABEL))
                    scanOpen = false
                },
                onDismiss = { scanOpen = false },
            )
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
    Group(
        title = "Pair with this machine?",
        footer = "A pairing link asked to connect this phone. Continue only if you opened it yourself, from your own bridge.",
    ) {
        ValueRow("Machine", subtitle = machine) {}
        Divider()
        ValueRow("Key", subtitle = shortKey(npub), mono = true) {}
        Divider()
        ValueRow("Relays", subtitle = relays.joinToString("\n") { it.removePrefix("wss://") }, mono = true) {}
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        PrimaryButton("Pair with $machine", onClick = { dispatch(UniffiIntent.ConfirmStagedPairing(PHONE_LABEL)) }, modifier = Modifier.weight(1f))
        QuietButton("Dismiss", onClick = { dispatch(UniffiIntent.DismissStagedPairing) })
    }
}

@Composable
private fun AwaitingAck(machine: String?, dispatch: (UniffiIntent) -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(top = Tokens.Space7),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        CircularProgressIndicator(color = Tokens.Text, strokeWidth = 2.dp)
        Text("Pairing with ${machine ?: "the machine"}…", color = Tokens.Text, fontSize = Tokens.TextXl)
        Text(
            "Waiting for the bridge to answer. Its pairing window must still be open.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextMd,
            textAlign = TextAlign.Center,
        )
        QuietButton("Cancel", onClick = { dispatch(UniffiIntent.ResetPairing) })
    }
}

@Composable
private fun Paired(machine: String?, dispatch: (UniffiIntent) -> Unit, onClose: () -> Unit) {
    EmptyState(
        icon = Icons.Outlined.Check,
        title = "Paired with ${machine ?: "the machine"}",
        body = "Its sessions appear on the home screen. Start one from there.",
        action = "Done",
        onAction = {
            dispatch(UniffiIntent.ResetPairing)
            onClose()
        },
        modifier = Modifier.fillMaxWidth().padding(top = Tokens.Space7),
    )
}

@Composable
private fun PairingForm(
    view: UniffiPairingView,
    selfNpub: String?,
    url: String,
    onUrlChange: (String) -> Unit,
    onScanTap: () -> Unit,
    dispatch: (UniffiIntent) -> Unit,
) {
    var manualNpub by remember { mutableStateOf("") }
    var manualToken by remember { mutableStateOf("") }
    var manualRelays by remember { mutableStateOf("") }

    if (view.phase == "failed") {
        Text(
            "Pairing failed: ${view.error ?: "rejected"}. Open a fresh pairing window on the bridge and try again.",
            color = Tokens.Danger,
            fontSize = Tokens.TextSm,
            modifier = Modifier.padding(horizontal = Tokens.Space2),
        )
    }

    Group(footer = "On the machine, run codedeck-bridge and scan the code it shows when its pairing window opens.") {
        GroupBody {
            PrimaryButton("Scan the pairing code", onClick = onScanTap, icon = Icons.Outlined.QrCodeScanner, modifier = Modifier.fillMaxWidth())
        }
    }

    Group(title = "Or paste the pairing link") {
        GroupBody {
            Field(value = url, onValueChange = onUrlChange, placeholder = "codedeck://pair?npub=…", mono = true)
            SecondaryButton("Pair", onClick = { dispatch(UniffiIntent.BeginPairing(url.trim(), PHONE_LABEL)) }, enabled = url.isNotBlank())
        }
    }

    Group(
        title = "Or enter it by hand",
        footer = "The relays are the bridge's: the phone has none of its own, so the request goes there.",
    ) {
        GroupBody {
            Field(value = manualNpub, onValueChange = { manualNpub = it }, label = "Bridge npub", placeholder = "npub1…", mono = true)
            Field(value = manualToken, onValueChange = { manualToken = it }, label = "One-time token", mono = true)
            Field(value = manualRelays, onValueChange = { manualRelays = it }, label = "Relays", placeholder = "wss://relay.example.com", mono = true)
            SecondaryButton(
                "Pair",
                onClick = {
                    dispatch(UniffiIntent.BeginManualPairing(manualNpub.trim(), manualToken.trim(), manualRelays.trim(), PHONE_LABEL))
                },
                enabled = manualNpub.isNotBlank() && manualToken.isNotBlank() && manualRelays.isNotBlank(),
            )
        }
    }

    selfNpub?.let { npub ->
        val clipboard = LocalClipboard.current
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        Group(title = "This phone", footer = "The key the bridge will know this phone by.") {
            ValueRow("Key", subtitle = npub, mono = true) {
                IconAction(Icons.Outlined.ContentCopy, "Copy npub", onClick = {
                    val clipData = ClipData.newPlainText("npub", npub)
                    scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(clipData)) }
                    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                }, tint = Tokens.TextMuted)
            }
        }
    }
}
