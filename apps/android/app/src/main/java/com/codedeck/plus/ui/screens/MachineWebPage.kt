package com.codedeck.plus.ui.screens

import android.Manifest
import android.content.ClipData
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.core.content.ContextCompat
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.EmptyState
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.RowSpinner
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiWebSignIn
import uniffi.client_ffi.UniffiWebSignInState

/** How long a sent code waits for the bridge's answer before the page says none came. */
private const val ANSWER_WAIT_MS = 15_000L

/**
 * The address of the bridge's web page for each of its `wss://` direct
 * endpoints: the page is served on the direct link's own port, at its root.
 * An onion endpoint serves no page, and a plain `ws://` one has no TLS to
 * serve it over.
 */
internal fun webPageUrls(machine: UniffiMachineSummary): List<String> =
    (machine.directAdvertised + machine.directEndpoints)
        .filter { it.startsWith("wss://", ignoreCase = true) }
        .map { it.substring("wss://".length).substringBefore('/').substringBefore('?') }
        .filter { it.isNotEmpty() && !it.substringBeforeLast(':').endsWith(".onion", ignoreCase = true) }
        .map { "https://$it/" }
        .distinct()

/** What a scanned QR asks of this page. */
internal sealed interface ScannedSignIn {
    data class Code(val code: String) : ScannedSignIn

    /** A web page's sign-in QR, but for another machine's page. */
    data object OtherMachine : ScannedSignIn

    data object NotSignIn : ScannedSignIn
}

/**
 * Reads `codedeck://web-sign-in?machine=<npub>&code=<code>`, the QR a web
 * page shows. A code is only sent to the machine the QR names: a browser on
 * another machine's page would otherwise be signed in to the wrong one, or a
 * code shown by one bridge be handed to another.
 */
internal fun readSignInQr(text: String, machineNpub: String): ScannedSignIn {
    val query = text.trim().removePrefix("codedeck://web-sign-in?").takeIf { it != text.trim() } ?: return ScannedSignIn.NotSignIn
    val params = query.split('&').mapNotNull { part -> part.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
    val code = params["code"]?.takeIf { it.isNotBlank() } ?: return ScannedSignIn.NotSignIn
    return if (params["machine"] == machineNpub) ScannedSignIn.Code(code) else ScannedSignIn.OtherMachine
}

/**
 * The "Web page" group on a machine's page: the addresses its web page is
 * served on (each copies, in full with its https://), and the row that opens
 * [WebSignInContent].
 */
@Composable
internal fun MachineWebPageGroup(machine: UniffiMachineSummary, onOpenWebSignIn: () -> Unit) {
    val urls = webPageUrls(machine)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Group(
        title = "Web page",
        footer = if (urls.isEmpty()) {
            "The bridge serves a dashboard on its direct link's wss:// address. Open it in a browser, then sign it in from here."
        } else {
            "The bridge's dashboard, for a browser that reaches the direct link. Sign it in from here."
        },
    ) {
        urls.forEach { url ->
            Row(
                Modifier.fillMaxWidth().padding(start = Tokens.Space4, end = Tokens.Space1, top = Tokens.Space1, bottom = Tokens.Space1),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                Text(
                    url.removePrefix("https://").removeSuffix("/"),
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                    fontFamily = Tokens.FontMono,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconAction(
                    Icons.Outlined.ContentCopy,
                    "Copy $url",
                    onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("address", url))) } },
                    tint = Tokens.TextMuted,
                )
            }
            Divider()
        }
        NavRow("Sign in a browser", onClick = onOpenWebSignIn)
    }
}

/**
 * Signing a browser in to the machine's web page: scan the QR the page shows,
 * or type its code. The phone sends the code to the bridge over its usual
 * signed path, and the bridge signs in the browser showing it. Pure — the
 * caller holds the draft and the round trip — so it renders in a snapshot.
 *
 * [signIn] is the code this phone sent and the bridge's answer; [noAnswer]
 * that the answer did not come in time; [notice] what was wrong with a scan.
 */
@Composable
fun WebSignInContent(
    signIn: UniffiWebSignIn?,
    noAnswer: Boolean,
    notice: String?,
    code: String,
    onCodeChange: (String) -> Unit,
    onSend: (String) -> Unit,
    onScan: () -> Unit,
    onBack: () -> Unit,
) {
    Page(title = "Sign in a browser", onBack = onBack) {
        if (signIn?.state == UniffiWebSignInState.SIGNED_IN) {
            EmptyState(
                icon = Icons.Outlined.Check,
                title = "Browser signed in",
                body = "It opens the dashboard now, and stays signed in for 30 days or until it is signed out.",
                action = "Done",
                onAction = onBack,
                modifier = Modifier.fillMaxWidth().padding(top = Tokens.Space7),
            )
            return@Page
        }
        val sending = signIn?.state == UniffiWebSignInState.SENDING && !noAnswer
        val error = when {
            notice != null -> notice
            noAnswer -> "No answer from the bridge. Check that it is online, then try again."
            signIn?.state == UniffiWebSignInState.NOT_MATCHED -> "That code did not match. It works once and for 5 minutes: reload the page for a new one."
            else -> null
        }
        error?.let { ErrorNote(it) }

        Group(footer = "Open the machine's web page in a browser. It shows a QR and a code.") {
            GroupBody {
                PrimaryButton("Scan the browser's QR", onClick = onScan, icon = Icons.Outlined.QrCodeScanner, enabled = !sending, modifier = Modifier.fillMaxWidth())
            }
        }
        Group(title = "Or type the code") {
            GroupBody {
                Field(
                    value = code,
                    onValueChange = onCodeChange,
                    placeholder = "ABCD-EFGH",
                    mono = true,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                )
                if (sending) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        RowSpinner()
                        Text("Signing in…", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
                    }
                } else {
                    SecondaryButton("Sign in", onClick = { onSend(code) }, enabled = code.isNotBlank())
                }
            }
        }
    }
}

/**
 * [WebSignInContent] for the machine [pubkey], from the core. Closing it
 * drops this machine's sign-in from the core, so an answer that arrives later
 * is not kept for a screen that is gone.
 */
@Composable
fun WebSignInScreen(core: CoreHost, pubkey: String, onBack: () -> Unit) {
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    val signIn = ui?.webSignIn?.get(pubkey)
    var code by rememberSaveable { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }
    var noAnswer by remember { mutableStateOf(false) }
    var scanOpen by remember { mutableStateOf(false) }
    // Each send waits for its own answer, a resend of the same code too.
    var attempt by remember { mutableIntStateOf(0) }

    fun send(sent: String) {
        notice = null
        noAnswer = false
        attempt++
        scope.launch { core.dispatch(UniffiIntent.WebSignIn(pubkey, sent)) }
    }

    DisposableEffect(pubkey) {
        onDispose { core.dispatchDetached(UniffiIntent.ClearWebSignIn(pubkey)) }
    }
    // An answer, however late, replaces "no answer": the bridge's own verdict
    // (did not match, signed in) is what the user needs to read.
    LaunchedEffect(attempt, signIn?.code, signIn?.state) {
        noAnswer = false
        if (signIn?.state == UniffiWebSignInState.SENDING) {
            delay(ANSWER_WAIT_MS)
            noAnswer = true
        }
    }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // Denied leaves the typed path; the next tap asks again.
        if (granted) scanOpen = true
    }

    Box(Modifier.fillMaxSize()) {
        WebSignInContent(
            signIn = signIn,
            noAnswer = noAnswer,
            notice = notice,
            code = code,
            onCodeChange = { code = it },
            onSend = ::send,
            onScan = {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    scanOpen = true
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            },
            onBack = onBack,
        )
        if (scanOpen) {
            PairingScanView(
                prompt = "Point the camera at the QR on the web page",
                onDecoded = { text ->
                    scanOpen = false
                    when (val scanned = readSignInQr(text, machine.npub)) {
                        is ScannedSignIn.Code -> {
                            code = scanned.code
                            send(scanned.code)
                        }
                        ScannedSignIn.OtherMachine -> notice = "That QR is another machine's web page, not this one's."
                        ScannedSignIn.NotSignIn -> notice = "That is not a web page's sign-in QR."
                    }
                },
                onDismiss = { scanOpen = false },
            )
        }
    }
}
