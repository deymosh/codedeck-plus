package com.codedeck.plus.ui.session

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.ThinkingGlyph
import com.codedeck.plus.ui.gsd.GsdStrip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.PendingPermissionSummary
import com.codedeck.plus.ui.transcript.TranscriptList
import com.codedeck.plus.ui.transcript.parseDisplayEntries
import com.codedeck.plus.ui.transcript.parsePendingPermission
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiTranscriptRowsView
import uniffi.client_ffi.UniffiUsageData

/**
 * A transcript view with its JSON payloads already decoded. Built off the main
 * thread: a long transcript's `displayEntriesJson` is large, and decoding it
 * inside composition on every append would stall frames during a streaming
 * turn. [of] reuses the previous decode for any payload whose JSON did not
 * change (a sync-status-only update, or an append that leaves the pending
 * permission alone), which also keeps the decoded list referentially stable
 * so the transcript does not recompose for nothing.
 */
private class ParsedTranscript(
    val view: UniffiTranscriptRowsView,
    val displayEntries: List<DisplayEntry>,
    val pendingPermission: PendingPermissionSummary?,
) {
    companion object {
        fun of(view: UniffiTranscriptRowsView, previous: ParsedTranscript?): ParsedTranscript = ParsedTranscript(
            view = view,
            displayEntries = if (previous != null && previous.view.displayEntriesJson == view.displayEntriesJson) {
                previous.displayEntries
            } else {
                parseDisplayEntries(view.displayEntriesJson)
            },
            pendingPermission = if (previous != null && previous.view.pendingPermissionJson == view.pendingPermissionJson) {
                previous.pendingPermission
            } else {
                view.pendingPermissionJson?.let(::parsePendingPermission)
            },
        )
    }
}

/** The effort ladder the wire accepts (`SetEffort.level`'s own spellings). */
private val EFFORT_LEVELS = listOf("low", "medium", "high", "xhigh", "max", "auto")

/** Legacy mode cycle order + compact display labels (`core/modeCycle.ts`). */
private val MODE_CYCLE = listOf("plan", "default", "acceptEdits")
private val MODE_LABELS = mapOf("plan" to "PLAN", "default" to "YOLO", "acceptEdits" to "EDITS")
private const val MODE_TAP_COOLDOWN_MS = 600L
private const val MODE_CONFIRM_TIMEOUT_MS = 8_000L

/** The backstop is the send budget plus a grace, so the bounded stages inside
 *  (the file read, the Rust-side upload stages) always get to report their
 *  own, more specific failure first. */
private const val SESSION_IMAGE_SEND_BACKSTOP_MS = SESSION_IMAGE_SEND_BUDGET_MS + 5_000L

/**
 * The session screen, top to bottom: [SessionTopBar] (back, title,
 * workspace), the GSD strip, the transcript, the [ThinkingIndicator] with
 * Stop while a turn runs, the always-visible pending-permission bar, the
 * staged image-attachment strip, quick prompts, the [SendFailedBar] with
 * Retry, [SessionControlsBar] (model/context, mode, effort, usage) and the
 * input bar (attach / text field / mic / Send). Port of `SessionScreen.tsx`,
 * including the image flow.
 *
 * While the session waits on a question, text sent from the input bar is
 * that question's custom answer — exactly what the card's own "type your
 * own answer" field sends.
 */
@Composable
fun SessionScreen(
    core: CoreHost,
    machine: String,
    sessionId: String,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val machinesView by core.machines.collectAsState()
    val uiView by core.ui.collectAsState()
    val outboxView by core.outbox.collectAsState()
    val settings by core.settings.collectAsState()
    val quickPromptsView by core.quickPrompts.collectAsState()
    val scope = rememberCoroutineScope()

    val machineSummary = machinesView?.machines?.firstOrNull { it.pubkeyHex == machine }
    val session = machineSummary?.sessions?.firstOrNull { it.id == sessionId }
    // Image attach is gated on the machine advertising the `images`
    // capability in its heartbeat; without the string the attach affordance
    // is not RENDERED at all (a hard gate on the wire, not a hidden one).
    val canAttachImages = machineSummary?.capabilities?.contains("images") == true

    var transcript by remember(machine, sessionId) { mutableStateOf<ParsedTranscript?>(null) }
    LaunchedEffect(machine, sessionId) {
        var previous: ParsedTranscript? = null
        core.transcriptFlow(machine, sessionId)
            .distinctUntilChanged()
            .map { view -> ParsedTranscript.of(view, previous).also { previous = it } }
            .flowOn(Dispatchers.Default)
            .collect { transcript = it }
    }
    val transcriptView = transcript?.view
    val displayEntries = transcript?.displayEntries.orEmpty()
    val pendingPermission: PendingPermissionSummary? = transcript?.pendingPermission

    val sessionKey = "$machine $sessionId"
    val respondedCards = uiView?.respondedCards?.get(sessionKey)?.toSet().orEmpty()
    val planChoices = uiView?.planApprovalChoices.orEmpty()

    var draft by remember(machine, sessionId) { mutableStateOf("") }
    val inputFocus = remember { FocusRequester() }

    // Image attachment: staged pick -> processed (read + resize + compress)
    // + uploaded on Send, all inside the single Rust dispatch (Blossom
    // first, relay chunks as fallback) with the draft as the accompanying
    // text. `attachGeneration` is the abandonment guard: it rises on every
    // attach and remove, and a completion belonging to a stale generation
    // writes NOTHING back — no banner about an attachment the user already
    // dropped, no `draft = ""` over text they have since retyped, no
    // `uploading = false` stomping a newer upload. The in-flight dispatch
    // itself cannot be cancelled once it reaches Rust; only reacting to it
    // can stop.
    val context = LocalContext.current
    var pendingImage by remember(machine, sessionId) { mutableStateOf<PickedImage?>(null) }
    var uploading by remember(machine, sessionId) { mutableStateOf(false) }
    var uploadError by remember(machine, sessionId) { mutableStateOf<String?>(null) }
    val attachGeneration = remember(machine, sessionId) { AttachGeneration() }

    // Photo picker: no storage permission — the system picker mediates
    // access. ImageOnly is the analog of the reference's hidden
    // `accept="image/*"` file input.
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        attachGeneration.bump() // a fresh pick abandons any in-flight send
        // The reference resets these synchronously at pick time: the spinner
        // and any stale banner die the moment a new image is chosen, NOT when
        // the staging read finishes (which here, unlike the reference's
        // already-local File, can take seconds on a cloud-backed provider).
        uploading = false
        uploadError = null
        scope.launch {
            val staged = withTimeoutOrNull(IMAGE_READ_TIMEOUT_MS) {
                runInterruptible(Dispatchers.IO) {
                    readPickedImage(context.contentResolver, uri)
                }
            }
            if (staged != null) {
                pendingImage = staged
            } else {
                // A provider that surrenders neither metadata nor decodable
                // bytes within the budget stages nothing: the current
                // attachment (if any) stays, and the read-failure banner is
                // the honest surface.
                uploadError = "Failed to read file (timed out after $IMAGE_READ_TIMEOUT_MS ms)"
            }
        }
    }

    fun pickImage() {
        imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    // The remove handler stays live mid-upload: a read or upload that has
    // not come back leaves the chip with this icon as its ONLY exit, so
    // disabling it would make a stalled send unrecoverable on-screen.
    fun removePendingImage() {
        attachGeneration.bump()
        pendingImage = null
        uploading = false
        uploadError = null
    }

    // Mic/STT: hand the whole interaction to the ANDROID SYSTEM speech
    // recognizer — its activity holds RECORD_AUDIO itself, so this app
    // declares and requests no mic permission. Recognized text APPENDS to
    // the draft (same appendToDraft contract as quick prompts — never an
    // auto-send); cancel, a missing recognizer, or an empty result just
    // refocuses the input, never an error surface (the reference's
    // `recognizeSpeech()` null fallback).
    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val text = if (result.resultCode == Activity.RESULT_OK) {
            result.data
                ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                ?.firstOrNull()
                ?.trim()
                .orEmpty()
        } else {
            ""
        }
        if (text.isNotEmpty()) draft = appendToDraft(draft, text) else inputFocus.requestFocus()
    }
    fun dictate() {
        micLauncher.launch(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            },
        )
    }

    fun dispatch(intent: UniffiIntent) {
        scope.launch { core.dispatch(intent) }
    }

    /**
     * Send the staged image: read + resize + compress off the main thread,
     * then the single Rust dispatch that uploads (Blossom first, relay
     * chunks as fallback) and publishes the `upload-image` command. The
     * backstop stops the SPINNER, not the send — the Rust loop keeps going
     * past it, so the image can still land after the banner shows. A
     * dispatch that resolves but failed internally (Blossom unreachable AND
     * the chunk fallback exhausted) reports through the core's ActionFailed
     * event rather than a thrown error, so resolution clears the composer
     * exactly as it does in the reference.
     */
    fun sendWithImage(text: String) {
        val staged = pendingImage ?: return
        if (uploading) return
        val generation = attachGeneration.current
        val abandoned = { generation != attachGeneration.current }
        uploading = true
        uploadError = null
        scope.launch {
            var processed: ProcessedImage? = null
            var failure: String? = null
            try {
                processed = withTimeoutOrNull(IMAGE_READ_TIMEOUT_MS) {
                    runInterruptible(Dispatchers.IO) {
                        processPickedImage(context.contentResolver, staged)
                    }
                }
                if (processed == null) {
                    failure = "Failed to read file (timed out after $IMAGE_READ_TIMEOUT_MS ms)"
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                failure = err.message ?: err.javaClass.simpleName
            }
            if (processed == null) {
                if (!abandoned()) {
                    uploadError = failure
                    uploading = false
                }
                return@launch
            }
            if (abandoned()) return@launch

            // The reference's catch covers the dispatch too: an FFI-level
            // failure is a banner, never a crash. Timeout keeps its own
            // branch below — it is not an error thrown, it is the backstop.
            val completed = try {
                withTimeoutOrNull(SESSION_IMAGE_SEND_BACKSTOP_MS) {
                    core.dispatch(
                        UniffiIntent.SendSessionImage(
                            machine = machine,
                            sessionId = sessionId,
                            text = text,
                            image = processed.bytes,
                            filename = processed.filename,
                            mimeType = processed.mimeType,
                        ),
                    )
                }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                if (!abandoned()) {
                    uploadError = err.message ?: err.javaClass.simpleName
                    uploading = false
                }
                return@launch
            }
            if (abandoned()) return@launch
            if (completed == null) {
                // The attachment stays staged: the send may still land, and
                // retry (or the always-live remove) is one tap either way.
                uploadError =
                    "TimeoutError: image send timed out after $SESSION_IMAGE_SEND_BACKSTOP_MS ms"
            } else {
                pendingImage = null
                draft = ""
            }
            uploading = false
        }
    }

    // Question-group progress, shared with the transcript's cards — see
    // TranscriptList for why it is kept locally at all.
    var locallyAdvanced by remember(machine, sessionId) { mutableStateOf(setOf<String>()) }
    // The question the session is blocked on, if any. Plain input sent while
    // the session waits on a question does not answer it — the message is
    // delivered and then sits there — so the composer sends the question's
    // custom reply instead, the same intent the card's own text field sends.
    val activeQuestion = if (session?.state == "waiting_question") {
        activeQuestionOf(displayEntries, respondedCards + locallyAdvanced)
    } else {
        null
    }

    fun send() {
        val text = draft.trim()
        if (pendingImage != null) {
            sendWithImage(text)
            return
        }
        if (text.isEmpty()) return
        draft = ""
        if (activeQuestion != null) {
            activeQuestion.advanceKey?.let { locallyAdvanced = locallyAdvanced + it }
            dispatch(
                UniffiIntent.AnswerQuestion(
                    machine = machine,
                    sessionId = sessionId,
                    text = text,
                    optionCount = activeQuestion.optionCount,
                ),
            )
            return
        }
        dispatch(
            UniffiIntent.SendInput(
                machine = machine,
                sessionId = sessionId,
                text = text,
                inputId = UUID.randomUUID().toString(),
            ),
        )
    }

    // --- Mode cycle (CDX-046): the confirmed mode comes from the machines
    // view; a tap shows the REQUESTED mode pulsing until either the
    // mode-confirmed lands (settling the request) or the revert window closes
    // (the request may have been lost — the button must not lie).
    val modeCycle = remember(machine, sessionId) { ModeCycleUi() }
    val confirmedMode = session?.permissionMode
    LaunchedEffect(confirmedMode) {
        val pending = modeCycle.pending
        if (pending != null && confirmedMode == pending) {
            modeCycle.revertJob?.cancel()
            modeCycle.pending = null
        }
    }
    fun tapMode() {
        val now = SystemClock.elapsedRealtime()
        if (now - modeCycle.lastTapAtMs < MODE_TAP_COOLDOWN_MS) return
        modeCycle.lastTapAtMs = now
        val displayed = modeCycle.pending ?: confirmedMode ?: "plan"
        val next = MODE_CYCLE[(MODE_CYCLE.indexOf(displayed) + 1).mod(MODE_CYCLE.size)]
        modeCycle.pending = next
        // Restart the revert window: only the LATEST request's confirmation
        // (or its absence) decides what the button ends up showing.
        modeCycle.revertJob?.cancel()
        modeCycle.revertJob = scope.launch {
            delay(MODE_CONFIRM_TIMEOUT_MS)
            modeCycle.pending = null
        }
        dispatch(UniffiIntent.SetMode(machine = machine, sessionId = sessionId, mode = next))
    }

    fun insertPrompt(text: String) {
        draft = appendToDraft(draft, text)
        inputFocus.requestFocus()
    }

    // Refresh the subscription-usage snapshot on open: the bridge only
    // publishes usage when asked; unsupported SDKs publish nothing and the
    // header just shows no usage badge.
    LaunchedEffect(machine, sessionId) {
        core.dispatch(UniffiIntent.RequestUsage(machine = machine, sessionId = sessionId))
    }

    // --- Outbox: the "send failed" bar shows this session's oldest failed
    // item; Retry re-publishes it (the transcript's per-row Retry covers the
    // rest).
    val failedOutbox = outboxView?.items.orEmpty().filter {
        it.machine == machine && it.sessionId == sessionId && it.state == "failed"
    }
    val oldestFailed = failedOutbox.minByOrNull { it.createdAt }
    fun retryOldestFailed() {
        oldestFailed?.let { oldest ->
            dispatch(UniffiIntent.RetryOutboxItem(machine = machine, id = oldest.id))
        }
    }

    Column(modifier.fillMaxSize()) {
        SessionTopBar(
            title = session?.title?.takeIf { it.isNotBlank() }
                ?: session?.project?.takeIf { it.isNotBlank() }
                ?: session?.cwd?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
                ?: "Session",
            workspace = session?.cwd,
            sessionState = session?.state,
            onBack = onBack,
        )

        GsdStrip(
            core = core,
            machine = machine,
            sessionId = sessionId,
            gsd = session?.gsd,
            sessionState = session?.state,
        )

        TranscriptList(
            displayEntries = displayEntries,
            outboxItems = outboxView?.items.orEmpty(),
            machine = machine,
            sessionId = sessionId,
            syncState = transcriptView?.syncState ?: "idle",
            contiguous = transcriptView?.contiguous ?: true,
            respondedCards = respondedCards,
            planApprovalChoices = planChoices,
            locallyAdvanced = locallyAdvanced,
            onAdvance = { id -> locallyAdvanced = locallyAdvanced + id },
            dispatch = ::dispatch,
            modifier = Modifier.weight(1f),
        )

        // The session's activity, where Claude Code shows it: the last line.
        // The waiting states have their own surfaces (the permission bar
        // below, question cards in the transcript), so only a running turn
        // gets a line here, with the Stop that belongs to it.
        if (session?.state == "running") {
            ThinkingIndicator(onStop = { dispatch(UniffiIntent.Interrupt(machine = machine, sessionId = sessionId)) })
        }

        pendingPermission?.let { pending ->
            PendingPermissionBar(pending) { allow ->
                dispatch(
                    UniffiIntent.RespondPermission(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = pending.requestId,
                        allow = allow,
                        modifier = null,
                    ),
                )
            }
        }

        // Staged-attachment strip: thumbnail, name, size (or the literal
        // "uploading…" the device checks read) and the always-live remove.
        pendingImage?.let { staged ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Tokens.SurfaceRaised)
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                staged.thumbnail?.let { thumb ->
                    Image(
                        bitmap = thumb,
                        contentDescription = "attachment preview",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .border(1.dp, Tokens.Border, RoundedCornerShape(Tokens.RadiusSm)),
                    )
                }
                Text(
                    staged.displayName,
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    if (uploading) {
                        "uploading…"
                    } else {
                        "${max(1, (staged.sizeBytes / 1024.0).roundToInt())} KB"
                    },
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                )
                IconButton(onClick = ::removePendingImage) {
                    Icon(Icons.Outlined.Close, contentDescription = "Remove attachment", tint = Tokens.TextMuted)
                }
            }
        }
        uploadError?.let { error ->
            // Same banner placement and tone as the reference's
            // `{uploadError && <div className={s.bannerError}>…</div>}`.
            Text(
                "Image upload failed: $error",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.Danger.copy(alpha = 0.12f))
                    .padding(Tokens.Space2),
            )
        }

        // Quick prompts: hidden entirely when the user has none defined; a tap
        // APPENDS the prompt into the draft — never an auto-send.
        val prompts = quickPromptsView?.prompts.orEmpty()
        if (prompts.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                prompts.forEach { prompt ->
                    Text(
                        prompt.label,
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextXs,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .widthIn(max = 160.dp)
                            .clip(RoundedCornerShape(Tokens.RadiusSm))
                            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                            .background(Tokens.Text.copy(alpha = 0.03f))
                            .clickable { insertPrompt(prompt.text) }
                            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                    )
                }
            }
        }

        // A failed send sits right above the controls, the same way the
        // running turn's line does, with the message it failed to deliver.
        oldestFailed?.let { failed ->
            SendFailedBar(text = failed.text, failedCount = failedOutbox.size, onRetry = ::retryOldestFailed)
        }

        SessionControlsBar(
            effortLevel = session?.effortLevel,
            permissionMode = confirmedMode,
            modeLabel = MODE_LABELS[modeCycle.pending ?: confirmedMode] ?: "PLAN",
            modePending = modeCycle.pending != null,
            model = session?.model,
            contextPercentage = session?.contextPercentage,
            contextWindow = session?.contextWindow?.toLong(),
            onEffortSelect = { level ->
                if (level != session?.effortLevel) {
                    dispatch(UniffiIntent.SetEffort(machine = machine, sessionId = sessionId, level = level))
                }
            },
            onModeTap = ::tapMode,
            showUsageBadge = settings?.showUsageBadge ?: false,
            usage = session?.usage,
        )

        // Composer order matches the reference: attach, text field, mic, Send.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Space1, vertical = Tokens.Space2),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (canAttachImages) {
                // Dimmed while an upload runs, so the disabled state is visible.
                IconButton(onClick = ::pickImage, enabled = !uploading) {
                    Icon(
                        Icons.Outlined.AttachFile,
                        contentDescription = "Attach image",
                        tint = if (uploading) Tokens.TextDim else Tokens.TextMuted,
                    )
                }
            }
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text(if (activeQuestion != null) "Type your answer…" else "Message the session…") },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                maxLines = 6,
                modifier = Modifier.weight(1f).focusRequester(inputFocus),
            )
            IconButton(onClick = ::dictate) {
                Icon(Icons.Outlined.Mic, contentDescription = "Dictate with voice", tint = Tokens.TextMuted)
            }
            Button(
                onClick = ::send,
                enabled = (draft.isNotBlank() || pendingImage != null) && !uploading,
            ) {
                Text("Send")
            }
        }
    }
}

/** Mode-cycle display state: what the button shows is the pending request
 *  while one is in flight, else the last confirmed mode. */
private class ModeCycleUi {
    var pending by mutableStateOf<String?>(null)
    // `SystemClock.elapsedRealtime()` is always >= 0, so 0L reads as "the
    // cooldown last fired at boot" and always lets the very first tap
    // through. `Long.MIN_VALUE` looked like a stronger "never tapped"
    // sentinel but isn't one: `now - Long.MIN_VALUE` overflows `Long` (wraps
    // to a huge NEGATIVE number, not a huge positive one), which made
    // `tapMode()`'s cooldown check pass on every single call — the very
    // first tap always looked like it was still inside the cooldown window
    // and returned before ever updating this field, so the mode button did
    // nothing for the rest of the screen's lifetime (device-observed
    // 2026-09-19: PLAN/YOLO/EDITS never responded to any tap).
    var lastTapAtMs = 0L
    var revertJob: Job? = null
}

/** Attachment-send generation counter: bumped on every attach and remove so
 *  a completion belonging to an abandoned send is detectable and dropped.
 *  Plain integer — only composables' callbacks touch it, never composition. */
private class AttachGeneration {
    var current: Int = 0
    fun bump() {
        current++
    }
}

/** The unanswered question a composer send answers: its option count (what
 *  `AnswerQuestion` needs to reach the free-text reply) and, for a
 *  sub-question of a group, the key that advances the group's card. */
internal data class ActiveQuestion(val optionCount: ULong, val advanceKey: String?)

/** The newest question card still awaiting a reply, or null when the newest
 *  one is already answered — an older unanswered card is a stale one. */
internal fun activeQuestionOf(entries: List<DisplayEntry>, responded: Set<String>): ActiveQuestion? {
    val newest = entries.lastOrNull { it is DisplayEntry.Question || it is DisplayEntry.QuestionGroup }
    return when (newest) {
        is DisplayEntry.Question -> {
            val done = newest.answered != null || (newest.toolUseId != null && newest.toolUseId in responded)
            if (done) null else ActiveQuestion((newest.question.options?.size ?: 0).toULong(), advanceKey = null)
        }
        is DisplayEntry.QuestionGroup -> {
            if (newest.answered != null) return null
            val index = newest.questions.indices.firstOrNull { "${newest.toolUseId}:q$it" !in responded }
                ?: return null
            ActiveQuestion(
                (newest.questions[index].options?.size ?: 0).toULong(),
                advanceKey = "${newest.toolUseId}:q$index",
            )
        }
        else -> null
    }
}

/** Tapping a quick prompt joins the fragment onto the draft: an empty or
 *  whitespace-only draft takes it verbatim, otherwise trailing whitespace is
 *  stripped and exactly one space joins the two. */
internal fun appendToDraft(draft: String, fragment: String): String =
    if (draft.isBlank()) fragment else "${draft.trimEnd()} $fragment"

/**
 * The session's single top bar: back, and what this session is and where it
 * works (title over the workspace path). The session's own state is not
 * repeated here: a running turn has the [ThinkingIndicator] line, waiting
 * sessions have the permission bar or a question card, and a failed send
 * has the [SendFailedBar], each with the control that answers it. The relay
 * link state lives on the sessions list.
 */
@Composable
internal fun SessionTopBar(
    title: String,
    workspace: String?,
    sessionState: String?,
    onBack: (() -> Unit)?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Surface)
            .padding(end = Tokens.Space2, start = if (onBack == null) Tokens.Space3 else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Sessions", tint = Tokens.Text)
            }
        }
        Column(Modifier.weight(1f).padding(vertical = Tokens.Space2)) {
            Text(
                title,
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // The workspace, trimmed from the START: the end of a path (the
            // project folder) is the part that tells sessions apart. A state
            // with no surface of its own (e.g. an ended session) leads it.
            val quietState = sessionState?.takeIf {
                it !in setOf("running", "idle", "waiting_permission", "waiting_question")
            }
            val subtitle = listOfNotNull(quietState, workspace?.takeIf { it.isNotBlank() }).joinToString(" · ")
            if (subtitle.isNotEmpty()) {
                Text(
                    subtitle,
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    fontFamily = Tokens.FontMono,
                    maxLines = 1,
                    overflow = TextOverflow.StartEllipsis,
                )
            }
        }
    }
}

/**
 * What the next turn runs with — model and context used, permission mode,
 * effort — then subscription usage, in one slim scrollable bar right above
 * the input, where Claude Code shows its own mode.
 */
@Composable
internal fun SessionControlsBar(
    effortLevel: String?,
    permissionMode: String?,
    modeLabel: String,
    modePending: Boolean,
    model: String?,
    contextPercentage: Double?,
    contextWindow: Long?,
    onEffortSelect: (String) -> Unit,
    onModeTap: () -> Unit,
    showUsageBadge: Boolean,
    usage: UniffiUsageData?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        if (model != null) {
            ModelContextChip(model = model, contextPercentage = contextPercentage, contextWindow = contextWindow)
        }
        if (permissionMode != null) {
            ModeButton(modeLabel, modePending, onModeTap)
        }
        EffortSelector(effortLevel, onEffortSelect)
        val badges = usageBadges(usage, System.currentTimeMillis())
        if (showUsageBadge && badges.isNotEmpty()) {
            UsageBox(usage, badges)
        }
    }
}

/** The running turn's last line: the spinner, "Thinking…", and its Stop. */
@Composable
internal fun ThinkingIndicator(onStop: () -> Unit) {
    val alpha = pulsingAlpha(min = 0.55f, max = 1f, halfPeriodMs = 900)
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Space2, end = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ThinkingGlyph()
        Text(
            "Thinking…",
            color = Tokens.Accent,
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .weight(1f)
                .padding(start = Tokens.Space1)
                .graphicsLayer { this.alpha = alpha },
        )
        TextButton(onClick = onStop) {
            Text("Stop", color = Tokens.Danger, fontSize = Tokens.TextSm)
        }
    }
}

/** The oldest failed send's line, laid out like [ThinkingIndicator]: what
 *  failed to go out (plus how many more are waiting behind it) and its
 *  Retry. */
@Composable
internal fun SendFailedBar(text: String, failedCount: Int, onRetry: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Warn.copy(alpha = 0.12f))
            .padding(start = Tokens.Space2, end = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (failedCount > 1) "Send failed ($failedCount)" else "Send failed",
            color = Tokens.Warn,
            fontSize = Tokens.TextSm,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Text(
            text.replace('\n', ' '),
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = Tokens.Space2),
        )
        TextButton(onClick = onRetry) {
            Text("Retry", color = Tokens.Text, fontSize = Tokens.TextSm)
        }
    }
}

/** Effort dropdown — the reference's `<select>`: shows the current level
 *  ("effort…" until the bridge reports one), opens the ladder on tap. A thin
 *  wrapper over the shared [SelectField]: the placeholder carries the muted
 *  "effort…" trigger for the not-yet-reported state without putting a
 *  phantom "effort…" entry into the ladder itself. */
@Composable
private fun EffortSelector(current: String?, onSelect: (String) -> Unit) {
    SelectField(
        options = EFFORT_LEVELS.map { PickerOption(it, it) },
        selected = current ?: "",
        placeholder = "effort…",
        onSelect = onSelect,
    )
}

/** The PLAN → YOLO → EDITS cycle button. While a request is in flight the
 *  label is the REQUESTED mode, pulsing like the legacy `setting-pending`. */
@Composable
private fun ModeButton(label: String, pending: Boolean, onTap: () -> Unit) {
    val alpha = if (pending) pulsingAlpha(min = 0.35f, max = 1f, halfPeriodMs = 500) else 1f
    Text(
        label,
        color = Tokens.Text,
        fontSize = Tokens.TextXs,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .graphicsLayer { this.alpha = alpha }
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.Text.copy(alpha = 0.03f))
            .clickable(onClick = onTap)
            .padding(horizontal = Tokens.ChipPadH, vertical = Tokens.ChipPadV),
    )
}

/** The 5h/7d subscription-usage box: the reported windows on one line, the
 *  worst utilization coloring the whole rectangle (warn ≥75, critical ≥90,
 *  critical also straight off a badge's ≥90 flag). */
@Composable
private fun UsageBox(usage: UniffiUsageData?, badges: List<UsageBadgeData>) {
    val accent = when (usageSeverity(usage, badges)) {
        "critical" -> Tokens.Danger
        "warn" -> Tokens.Warn
        else -> Tokens.TextMuted
    }
    val fill = when (usageSeverity(usage, badges)) {
        "critical" -> Tokens.Danger.copy(alpha = 0.10f)
        "warn" -> Tokens.Warn.copy(alpha = 0.10f)
        else -> Tokens.Text.copy(alpha = 0.03f)
    }
    // One line ("5h 61% · 7d 23%") so it stays as short as the other chips
    // in the controls bar.
    Row(
        Modifier
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .border(1.dp, accent, RoundedCornerShape(Tokens.RadiusSm))
            .background(fill)
            .padding(horizontal = Tokens.ChipPadH, vertical = Tokens.ChipPadV),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        badges.forEachIndexed { i, badge ->
            val description = badge.resetCountdown?.let { "${badge.text}, $it" } ?: badge.text
            Text(
                (if (i > 0) " · " else "") + badge.text,
                color = accent,
                fontSize = Tokens.TextXs,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                modifier = Modifier.semantics { contentDescription = description },
            )
        }
    }
}

@Composable
private fun pulsingAlpha(min: Float, max: Float, halfPeriodMs: Int): Float {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(
        initialValue = min,
        targetValue = max,
        animationSpec = infiniteRepeatable(
            animation = tween(halfPeriodMs, easing = EaseInOut),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pulseAlpha",
    )
    return alpha
}

@Composable
private fun PendingPermissionBar(pending: PendingPermissionSummary, onRespond: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Warn.copy(alpha = 0.12f))
            .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
    ) {
        val label = if (pending.isSubAgent) {
            "${pending.agentLabel ?: "Sub-agent"}: ${pending.toolName} needs permission"
        } else {
            "${pending.toolName} needs permission"
        }
        Column(Modifier.weight(1f)) {
            Text(label, color = Tokens.Text, fontSize = Tokens.TextSm, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // What the approval is actually for (the command, the path, or
            // for OpenCode the rule, e.g. "Access outside the project: …").
            if (pending.description.isNotBlank() && pending.description != label) {
                Text(
                    pending.description,
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The highest-stakes taps in the app: full-size buttons.
        TextButton(onClick = { onRespond(true) }) {
            Text("Allow", color = Tokens.Success, fontSize = Tokens.TextSm)
        }
        TextButton(onClick = { onRespond(false) }) {
            Text("Deny", color = Tokens.Danger, fontSize = Tokens.TextSm)
        }
    }
}

// --- Compact model tag for the header badge (port of
// `apps/mobile/src/ui/modelLabel.ts`, itself the old app's `modelLabel`):
// the ctxBox shares a narrow header row with the cwd, the connection chip
// and the usage box, so the model shows as a terse tag ("O5", "S4.6") rather
// than the SDK's raw id.

/** Known model id → compact tag — `modelLabel.ts`'s TAGS table. */
private val MODEL_TAGS = listOf(
    "claude-opus-5" to "O5",
    "claude-opus-4-8" to "O4.8",
    "claude-opus-4-7" to "O4.7",
    "claude-sonnet-5" to "S5",
    "claude-sonnet-4-6" to "S4.6",
    "claude-haiku-4-5-20251001" to "H4.5",
    "claude-fable-5" to "F5",
)

/** `claude-opus-5[1m]` / `claude-opus-5-1m` → `claude-opus-5`: the 1M-ness
 *  is already legible in the context figure beside the tag (`90k/1M`). */
private fun stripContextMarker(id: String): String = id
    .replace(Regex("\\[1m]", RegexOption.IGNORE_CASE), "")
    .replace(Regex("-1m\\b", RegexOption.IGNORE_CASE), "")

/**
 * Compact tag for a model id; `?` when the session has no model recorded —
 * honest rather than guessing. Known ids map through [MODEL_TAGS]; an
 * unknown/custom model (a provider profile's id, a new release) gets its
 * `claude-` vendor prefix and any `-YYYYMMDD` date suffix stripped. Non-
 * claude ids (an OpenCode `<provider>/<model>` id, for one) pass through
 * UNCHANGED — the header pairs this with the chip's marquee below for
 * exactly those.
 */
internal fun modelLabel(id: String?): String {
    if (id.isNullOrEmpty()) return "?"
    val base = stripContextMarker(id)
    MODEL_TAGS.firstOrNull { (modelId) -> modelId == base }?.let { return it.second }
    return base.replace(Regex("^claude-"), "").replace(Regex("-\\d{8}$"), "")
}

/** Widest the model tag in [ModelContextChip] gets before it marquees. */
private val MODEL_TAG_MAX_WIDTH = 160.dp

/**
 * The controls bar's model+context chip — port of the reference's `.ctxBox`
 * (model tag accent/bold, then the `pct% · used/window` figure, muted).
 *
 * The model tag renders [modelLabel], the reference's own header convention
 * (`SessionScreen.tsx` shows `modelLabel(…)`, not the raw id) — claude ids
 * collapse to tags like O5/S4.6 outright. But modelLabel deliberately passes
 * NON-claude ids through unchanged (the custom-provider label above has no
 * `claude-` prefix and no date suffix, so it comes back at full length), so
 * the tag carries `basicMarquee` — inert on a short tag, scrolling only a
 * genuinely-overflowing long one.
 *
 * The sizing policy is a hand-rolled [Layout] rather than a `Row` because
 * it is a PRIORITY, not a split: the context figure is what the user reads,
 * so its Text measures FIRST at its full intrinsic width and never
 * truncates; the model tag gets whatever width is left (bounded, marquee
 * takes over). A `Row` cannot express this — plain children split by
 * measurement order (both truncate when tight: the long-model case squeezed
 * context to a fragment even while it marqueed, device-observed
 * 2026-09-19), and `weight(1f)` on the tag would make this chip itself
 * expand to all leftover header width (a Row with a weighted child fills
 * its constraints), starving the chips next to it. The chip stays
 * wrap-content: its measured width is exactly the two children plus
 * padding, whatever that comes to.
 */
@Composable
private fun ModelContextChip(
    model: String,
    contextPercentage: Double?,
    contextWindow: Long?,
) {
    Layout(
        content = {
            Text(
                modelLabel(model),
                color = Tokens.Accent,
                fontWeight = FontWeight.Bold,
                fontSize = Tokens.TextXs,
                maxLines = 1,
                modifier = Modifier.basicMarquee(iterations = Int.MAX_VALUE),
            )
            contextBadge(contextPercentage, contextWindow)?.let { ctx ->
                Text(
                    " · $ctx",
                    // Same thresholds as the usage box: warn from 75 %, danger from 90 %.
                    color = when {
                        (contextPercentage ?: 0.0) >= 90.0 -> Tokens.Danger
                        (contextPercentage ?: 0.0) >= 75.0 -> Tokens.Warn
                        else -> Tokens.TextMuted
                    },
                    fontSize = Tokens.TextXs,
                    maxLines = 1,
                )
            }
        },
        modifier = Modifier
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.Text.copy(alpha = 0.03f)),
    ) { measurables, constraints ->
        val hpad = Tokens.ChipPadH.roundToPx()
        val vpad = Tokens.ChipPadV.roundToPx()
        // In a scrolling row the width is unbounded; subtracting padding from
        // Constraints.Infinity yields an invalid constraint, so the children
        // measure unbounded there too.
        val bounded = constraints.hasBoundedWidth
        val inner = if (bounded) (constraints.maxWidth - hpad * 2).coerceAtLeast(0) else Constraints.Infinity
        // Context (the second child, when the badge produced one) measures
        // first at its full intrinsic width — it never truncates.
        val contextPlaceable = measurables.getOrNull(1)
            ?.measure(Constraints(maxWidth = inner, maxHeight = constraints.maxHeight))
        val contextWidth = contextPlaceable?.width ?: 0
        // The model tag gets whatever is left (capped, so one long provider
        // label cannot take the whole bar), and the marquee takes over past
        // that instead of an ellipsis.
        val modelCap = MODEL_TAG_MAX_WIDTH.roundToPx()
        val modelMaxWidth = if (bounded) (inner - contextWidth).coerceIn(0, modelCap) else modelCap
        val modelPlaceable = measurables[0].measure(
            Constraints(maxWidth = modelMaxWidth, maxHeight = constraints.maxHeight),
        )
        val width = modelPlaceable.width + contextWidth + hpad * 2
        val height = maxOf(modelPlaceable.height, contextPlaceable?.height ?: 0) + vpad * 2
        layout(width, height) {
            modelPlaceable.place(hpad, vpad)
            contextPlaceable?.place(hpad + modelPlaceable.width, vpad)
        }
    }
}

// --- Subscription-usage presentation helpers (port of `ui/usageFormat.ts`'s
// header subset).

/** Compact token count: 950 → "950", 84_200 → "84k", 1_240_000 → "1.2M" —
 *  port of `apps/mobile/src/ui/usageFormat.ts`'s `formatTokens`. */
private fun formatTokens(n: Long): String = when {
    n < 0 -> "?"
    n < 1_000 -> n.toString()
    n < 1_000_000 -> "${(n / 1000.0).roundToInt()}k"
    else -> {
        val millions = n / 1_000_000.0
        // Whole millions print without a trailing ".0" (JS's own number-to-
        // string coercion does this for free; Kotlin's Double interpolation
        // doesn't, so it's spelled out here) — one decimal place otherwise.
        val rounded = if (millions >= 10) millions.roundToInt().toDouble() else (millions * 10).roundToInt() / 10.0
        val label = if (rounded == rounded.toLong().toDouble()) rounded.toLong().toString() else rounded.toString()
        "${label}M"
    }
}

/** "pct% · used/window" (bare "pct%" when the window is unknown) — port of
 *  `usageFormat.ts`'s `contextBadge`. The header previously showed only the
 *  bare percentage (missing the reference's own `used/window` token count
 *  entirely) even though `UniffiSessionSummary.contextWindow` already
 *  carries the denominator — nothing upstream was missing, this call site
 *  just wasn't reading it (device-observed 2026-09-19). */
private fun contextBadge(contextPercentage: Double?, contextWindow: Long?): String? {
    if (contextPercentage == null || !contextPercentage.isFinite()) return null
    val pct = contextPercentage.roundToInt().coerceIn(0, 100)
    if (contextWindow == null || contextWindow <= 0) return "$pct%"
    val used = (pct / 100.0 * contextWindow).roundToInt().toLong()
    return "$pct% · ${formatTokens(used)}/${formatTokens(contextWindow)}"
}

private data class UsageBadgeData(val text: String, val resetCountdown: String?, val critical: Boolean)

private fun usageBadges(usage: UniffiUsageData?, nowMs: Long): List<UsageBadgeData> {
    if (usage?.available != true) return emptyList()
    val badges = mutableListOf<UsageBadgeData>()
    for ((label, window) in listOf("5h" to usage.fiveHour, "7d" to usage.sevenDay)) {
        val utilization = window?.utilization?.takeIf { it.isFinite() } ?: continue
        val pct = utilization.coerceIn(0.0, 100.0).roundToInt()
        badges.add(
            UsageBadgeData(
                text = "$label $pct%",
                resetCountdown = formatReset(window.resetsAt, nowMs),
                critical = pct >= 90,
            ),
        )
    }
    return badges
}

/** Severity for the usage BOX: the worst utilization across the reported
 *  windows colors the whole rectangle; ≥90 critical comes straight from the
 *  badges' own flag. */
private fun usageSeverity(usage: UniffiUsageData?, badges: List<UsageBadgeData>): String =
    when {
        badges.any { it.critical } -> "critical"
        listOfNotNull(
            usage?.fiveHour,
            usage?.sevenDay,
            usage?.sevenDayOpus,
            usage?.sevenDaySonnet,
        ).any { window -> (window.utilization?.takeIf { it.isFinite() } ?: 0.0) >= 75.0 } -> "warn"
        else -> "ok"
    }

/** Coarse reset countdown — carried in the badge row's accessibility
 *  description: the reference keeps it on each badge's tooltip, which has no
 *  touch-device surface, so visually the phone shows the percentage only,
 *  same as mobile on touch. */
private fun formatReset(resetsAt: String?, nowMs: Long): String? {
    val target = resetsAt?.let(::parseWireTimestamp) ?: return null
    val diffMs = target - nowMs
    if (diffMs <= 0) return "resetting…"
    val totalMin = diffMs / 60_000
    val days = totalMin / 1440
    val hours = (totalMin % 1440) / 60
    val mins = totalMin % 60
    return when {
        days > 0 -> "resets in ${days}d ${hours}h"
        hours > 0 -> "resets in ${hours}h ${mins}m"
        else -> "resets in ${mins}m"
    }
}

/** `Date.parse`'s ISO tolerance, tiered: `Z`-suffixed instants, then explicit
 *  offsets, then a bare local timestamp read as UTC. */
private fun parseWireTimestamp(value: String): Long? = try {
    Instant.parse(value).toEpochMilli()
} catch (_: DateTimeParseException) {
    try {
        OffsetDateTime.parse(value).toInstant().toEpochMilli()
    } catch (_: DateTimeParseException) {
        try {
            LocalDateTime.parse(value).toInstant(ZoneOffset.UTC).toEpochMilli()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}
