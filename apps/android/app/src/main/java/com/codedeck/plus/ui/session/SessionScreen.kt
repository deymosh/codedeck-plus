package com.codedeck.plus.ui.session

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.speech.RecognizerIntent
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.outlined.Description
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
import com.codedeck.plus.ui.components.pulsingAlpha
import com.codedeck.plus.ui.gsd.GsdStrip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.ActivityView
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.PendingPermissionSummary
import com.codedeck.plus.ui.transcript.parseActivity
import com.codedeck.plus.ui.transcript.TranscriptList
import com.codedeck.plus.ui.transcript.TranscriptRows
import com.codedeck.plus.ui.transcript.parsePendingPermission
import com.codedeck.plus.ui.transcript.questionCardKey
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
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiSessionMcp
import uniffi.client_ffi.UniffiTranscriptDelta
import uniffi.client_ffi.UniffiUsageData

/**
 * The session's transcript, decoded: the core's deltas applied in order, off
 * the main thread. Each delta carries only the rows that changed, so a
 * streaming turn decodes one row per append however long the transcript is,
 * and an update that changes no row keeps the list referentially stable.
 */
private class ParsedTranscript(
    val view: UniffiTranscriptDelta,
    val rows: TranscriptRows,
    val pendingPermission: PendingPermissionSummary?,
    val activity: ActivityView?,
) {
    val displayEntries: List<DisplayEntry> get() = rows.entries

    companion object {
        /** `previous` itself when [view] changes nothing it shows, so the
         *  screen does not recompose for an update that only re-read it. */
        fun of(view: UniffiTranscriptDelta, previous: ParsedTranscript?): ParsedTranscript =
            if (previous != null && !view.full && view.changed.isEmpty() &&
                view.order.size == previous.rows.entries.size &&
                view.pendingPermissionJson == previous.view.pendingPermissionJson &&
                view.activityJson == previous.view.activityJson &&
                view.syncState == previous.view.syncState &&
                view.contiguous == previous.view.contiguous
            ) {
                previous
            } else {
                parse(view, previous)
            }

        private fun parse(view: UniffiTranscriptDelta, previous: ParsedTranscript?): ParsedTranscript = ParsedTranscript(
            view = view,
            rows = TranscriptRows.apply(
                previous?.rows ?: TranscriptRows.EMPTY,
                full = view.full,
                order = view.order,
                changed = view.changed.map { it.key to it.json },
            ),
            pendingPermission = if (previous != null && previous.view.pendingPermissionJson == view.pendingPermissionJson) {
                previous.pendingPermission
            } else {
                view.pendingPermissionJson?.let(::parsePendingPermission)
            },
            activity = if (previous != null && previous.view.activityJson == view.activityJson) {
                previous.activity
            } else {
                view.activityJson?.let(::parseActivity)
            },
        )
    }
}

private const val MODE_CONFIRM_TIMEOUT_MS = 8_000L

/** The backstop is the send budget plus a grace, so the bounded stages inside
 *  (the file read, the Rust-side upload stages) always get to report their
 *  own, more specific failure first. */
private const val SESSION_FILE_SEND_BACKSTOP_MS = SESSION_FILE_SEND_BUDGET_MS + 5_000L

/**
 * The session screen, top to bottom: [SessionTopBar] (back, title,
 * workspace), the GSD strip, the transcript (whose last line says what a
 * running turn is doing), the always-visible pending-permission bar, the
 * staged image-attachment strip, quick prompts, the [SendFailedBar] with
 * Retry, and the [Composer]: the text over one row of controls — attach,
 * the options chip (mode, model, effort: [SessionOptionsSheet]), the context
 * ring ([ContextDetails]), dictation and Send, which is Stop while a turn
 * runs and nothing is typed. Port of `SessionScreen.tsx`,
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
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
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
    val canAttachFiles = machineSummary?.capabilities?.contains("files") == true
    // The session's agent as the bridge advertises it: its modes and effort
    // levels are what the options sheet offers.
    val agent = machineSummary?.agents?.firstOrNull { it.id == session?.agent }

    var transcript by remember(machine, sessionId) { mutableStateOf<ParsedTranscript?>(null) }
    LaunchedEffect(machine, sessionId) {
        var previous: ParsedTranscript? = null
        // Every delta is applied, in order: each builds on the one before.
        core.transcriptFlow(machine, sessionId)
            .map { view -> ParsedTranscript.of(view, previous).also { previous = it } }
            // One row the JSON decoders cannot parse ends this collection
            // (the transcript stops updating) rather than crashing the app.
            .catch { e ->
                Log.w("codedeck", "transcript decode ended: ${e::class.simpleName}: ${e.message?.take(160)}")
            }
            .flowOn(Dispatchers.Default)
            .collect { transcript = it }
    }
    val transcriptView = transcript?.view
    val displayEntries = transcript?.displayEntries.orEmpty()
    val pendingPermission: PendingPermissionSummary? = transcript?.pendingPermission

    val sessionKey = "$machine $sessionId"
    // Remembered: a fresh set on every recomposition (each keystroke in the
    // composer) would make the transcript recompose along with it.
    val respondedCards = remember(uiView, sessionKey) { uiView?.respondedCards?.get(sessionKey)?.toSet().orEmpty() }
    val planChoices = uiView?.planApprovalChoices.orEmpty()

    var draft by remember(machine, sessionId) { mutableStateOf("") }
    val inputFocus = remember { FocusRequester() }

    // Attachment: staged pick -> processed (read, and a huge image
    // downscaled) + uploaded on Send, all inside the single Rust dispatch
    // (the user's Blossom server when set, else relay chunks) with the draft
    // as the accompanying text. `attachGeneration` is the abandonment guard: it rises on every
    // attach and remove, and a completion belonging to a stale generation
    // writes NOTHING back — no banner about an attachment the user already
    // dropped, no `draft = ""` over text they have since retyped, no
    // `uploading = false` stomping a newer upload. The in-flight dispatch
    // itself cannot be cancelled once it reaches Rust; only reacting to it
    // can stop.
    val context = LocalContext.current
    var pendingFile by remember(machine, sessionId) { mutableStateOf<PickedFile?>(null) }
    var uploading by remember(machine, sessionId) { mutableStateOf(false) }
    var uploadError by remember(machine, sessionId) { mutableStateOf<String?>(null) }
    val attachGeneration = remember(machine, sessionId) { AttachGeneration() }

    // Both pickers are the system's own, so the app needs no storage
    // permission: the photo picker for photos, the document picker for any
    // other file.
    fun stage(uri: Uri?) {
        if (uri == null) return
        attachGeneration.bump() // a fresh pick abandons any in-flight send
        // The reference resets these synchronously at pick time: the spinner
        // and any stale banner die the moment a new image is chosen, NOT when
        // the staging read finishes (which here, unlike the reference's
        // already-local File, can take seconds on a cloud-backed provider).
        uploading = false
        uploadError = null
        scope.launch {
            val staged = withTimeoutOrNull(FILE_READ_TIMEOUT_MS) {
                runInterruptible(Dispatchers.IO) {
                    readPickedFile(context.contentResolver, uri)
                }
            }
            if (staged != null) {
                pendingFile = staged
            } else {
                // A provider that surrenders neither metadata nor decodable
                // bytes within the budget stages nothing: the current
                // attachment (if any) stays, and the read-failure banner is
                // the honest surface.
                uploadError = "Failed to read file (timed out after $FILE_READ_TIMEOUT_MS ms)"
            }
        }
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), ::stage)
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), ::stage)

    fun pickPhoto() {
        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }
    fun pickFile() {
        filePicker.launch(arrayOf("*/*"))
    }

    // The remove handler stays live mid-upload: a read or upload that has
    // not come back leaves the chip with this icon as its ONLY exit, so
    // disabling it would make a stalled send unrecoverable on-screen.
    fun removePendingFile() {
        attachGeneration.bump()
        pendingFile = null
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
     * Send the staged file: read (and downscale a huge image) off the main
     * thread, then the single Rust dispatch that uploads (the user's Blossom
     * server when set, else relay chunks) and publishes the `upload-file`
     * command. A file over the limit is refused here, before any upload. The
     * backstop stops the SPINNER, not the send — the Rust loop keeps going
     * past it, so the file can still land after the banner shows. A
     * dispatch that resolves but failed internally (Blossom unreachable AND
     * the chunk fallback exhausted) reports through the core's ActionFailed
     * event rather than a thrown error, so resolution clears the composer
     * exactly as it does in the reference.
     */
    fun sendWithFile(text: String) {
        val staged = pendingFile ?: return
        val maxBytes = (settings?.maxUploadBytes ?: 0uL).toLong()
        val blossom = !settings?.blossomServer.isNullOrBlank()
        if (uploading) return
        val generation = attachGeneration.current
        val abandoned = { generation != attachGeneration.current }
        uploading = true
        uploadError = null
        scope.launch {
            var processed: ProcessedFile? = null
            var failure: String? = null
            try {
                processed = withTimeoutOrNull(FILE_READ_TIMEOUT_MS) {
                    runInterruptible(Dispatchers.IO) {
                        processPickedFile(context.contentResolver, staged, maxBytes, blossom)
                    }
                }
                if (processed == null) {
                    failure = "Failed to read file (timed out after $FILE_READ_TIMEOUT_MS ms)"
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
                withTimeoutOrNull(SESSION_FILE_SEND_BACKSTOP_MS) {
                    core.dispatch(
                        UniffiIntent.SendSessionFile(
                            machine = machine,
                            sessionId = sessionId,
                            text = text,
                            `data` = processed.bytes,
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
                    "TimeoutError: the file send timed out after $SESSION_FILE_SEND_BACKSTOP_MS ms"
            } else {
                pendingFile = null
                draft = ""
            }
            uploading = false
        }
    }

    // The question the session is blocked on, if any. Plain input sent while
    // the session waits on a question does not answer it — the message is
    // delivered and then sits there — so the composer sends the question's
    // free-text answer instead, the same intent the card's own text field
    // sends.
    val activeQuestion = if (session?.state == "waiting_question") {
        activeQuestionOf(displayEntries, respondedCards)
    } else {
        null
    }

    fun send() {
        val text = draft.trim()
        if (pendingFile != null) {
            sendWithFile(text)
            return
        }
        if (text.isEmpty()) return
        draft = ""
        if (activeQuestion != null) {
            dispatch(
                UniffiIntent.AnswerQuestion(
                    machine = machine,
                    sessionId = sessionId,
                    requestId = activeQuestion.requestId,
                    index = activeQuestion.index.toUInt(),
                    selected = emptyList(),
                    text = text,
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

    // --- Mode (CDX-046): picked in the options sheet. The confirmed mode
    // comes from the machines view; a pick shows the REQUESTED mode pulsing
    // until either option-confirmed lands (settling the request) or the
    // revert window closes (the request may have been lost — the chip must
    // not lie).
    val modes = agent?.modes.orEmpty()
    val modeRequest = remember(machine, sessionId) { ModeRequestUi() }
    val confirmedMode = session?.mode
    LaunchedEffect(confirmedMode) {
        val pending = modeRequest.pending
        if (pending != null && confirmedMode == pending) {
            modeRequest.revertJob?.cancel()
            modeRequest.pending = null
        }
    }
    fun selectMode(next: String) {
        if (next == (modeRequest.pending ?: confirmedMode)) return
        modeRequest.pending = next
        // Restart the revert window: only the LATEST request's confirmation
        // (or its absence) decides what the chip ends up showing.
        modeRequest.revertJob?.cancel()
        modeRequest.revertJob = scope.launch {
            delay(MODE_CONFIRM_TIMEOUT_MS)
            modeRequest.pending = null
        }
        dispatch(UniffiIntent.SetOption(machine = machine, sessionId = sessionId, option = "mode", value = next))
    }
    val displayedMode = modeRequest.pending ?: confirmedMode

    fun insertPrompt(text: String) {
        draft = appendToDraft(draft, text)
        inputFocus.requestFocus()
    }

    // Refresh the usage snapshot on open and whenever a turn ends (the
    // session's cost grows with each): the bridge only publishes usage when
    // asked. An agent whose catalog entry says it has no usage is not asked
    // (it would publish nothing); until the catalog is known the effect
    // waits, and fires once it says yes.
    // The agent's model list names the session's model in the options chip,
    // and is what the options sheet switches between.
    LaunchedEffect(machine, agent?.id, agent?.supportsModels) {
        val id = agent?.id
        if (id != null && agent.supportsModels) core.dispatch(UniffiIntent.RequestModels(machine = machine, agent = id))
    }

    val supportsUsage = agent?.supportsUsage == true
    val turnRunning = session?.state == "running"
    LaunchedEffect(machine, sessionId, supportsUsage, turnRunning) {
        if (supportsUsage && !turnRunning) core.dispatch(UniffiIntent.RequestUsage(machine = machine, sessionId = sessionId))
    }

    // Slash commands: the menu opens while the draft is a bare `/name` (not
    // while it answers a question), and every opening asks the bridge
    // again — the list changes as plugins and skills come and go, and a
    // phone that never types `/` never asks.
    val supportsCommands = agent?.supportsCommands == true
    val commandQuery = if (supportsCommands && activeQuestion == null) slashQuery(draft) else null
    val commandMenuOpen = commandQuery != null
    LaunchedEffect(machine, sessionId, commandMenuOpen) {
        if (commandMenuOpen) core.dispatch(UniffiIntent.RequestCommands(machine = machine, sessionId = sessionId))
    }

    // MCP servers: the agent reports them once the session runs, so they
    // are asked for then, and again whenever the sheet opens.
    val supportsMcp = agent?.supportsMcp == true
    val sessionLive = session?.state in setOf("running", "idle", "waiting_permission", "waiting_question")
    var mcpSheetOpen by remember(machine, sessionId) { mutableStateOf(false) }
    LaunchedEffect(machine, sessionId, supportsMcp, sessionLive, mcpSheetOpen) {
        if (supportsMcp && sessionLive) core.dispatch(UniffiIntent.RequestSessionMcp(machine = machine, sessionId = sessionId))
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
            supportsGsd = agent?.supportsGsd == true,
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
            running = session?.state == "running",
            activity = transcript?.activity,
            canStopTasks = agent?.supportsTasks == true,
            dispatch = ::dispatch,
            modifier = Modifier.weight(1f),
        )

        pendingPermission?.let { pending ->
            PendingPermissionBar(pending) { optionId ->
                dispatch(
                    UniffiIntent.RespondPermission(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = pending.requestId,
                        optionId = optionId,
                    ),
                )
            }
        }

        // Staged-attachment strip: thumbnail, name, size (or the literal
        // "uploading…" the device checks read) and the always-live remove.
        pendingFile?.let { staged ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Tokens.SurfaceRaised)
                    .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                val tile = Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .border(1.dp, Tokens.Border, RoundedCornerShape(Tokens.RadiusSm))
                val thumb = staged.thumbnail
                if (thumb != null) {
                    Image(bitmap = thumb, contentDescription = "attachment preview", contentScale = ContentScale.Crop, modifier = tile)
                } else {
                    Box(tile.background(Tokens.SurfaceHover), contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Description, contentDescription = null, tint = Tokens.TextMuted)
                    }
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
                        formatSize(staged.sizeBytes)
                    },
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                )
                IconButton(onClick = ::removePendingFile) {
                    Icon(Icons.Outlined.Close, contentDescription = "Remove attachment", tint = Tokens.TextMuted)
                }
            }
        }
        uploadError?.let { error ->
            // Same banner placement and tone as the reference's
            // `{uploadError && <div className={s.bannerError}>…</div>}`.
            Text(
                "Upload failed: $error",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.Danger.copy(alpha = 0.12f))
                    .padding(Tokens.Space2),
            )
        }

        // The command menu takes the quick prompts' place while it is open;
        // a pick leaves `/name ` in the draft for its arguments.
        if (commandQuery != null) {
            SlashCommandMenu(session?.commands, commandQuery) { command ->
                draft = "/${command.name} "
                inputFocus.requestFocus()
            }
        } else {
            // Quick prompts (none: no strip); a tap puts the prompt in the draft.
            QuickPromptStrip(quickPromptsView?.prompts.orEmpty(), ::insertPrompt)
        }

        // A failed send sits right above the controls, the same way the
        // running turn's line does, with the message it failed to deliver.
        oldestFailed?.let { failed ->
            SendFailedBar(text = failed.text, failedCount = failedOutbox.size, onRetry = ::retryOldestFailed)
        }

        // What the next turn runs with, for the composer's options chip and
        // its sheet. A session bound to a provider profile runs on that
        // profile's models; any other on its agent's list, which for an agent
        // whose profiles add models already carries theirs.
        val agentModels = machineSummary?.models?.firstOrNull { it.agent == session?.agent }?.models
        val agentProfiles = machineSummary?.providerProfiles.orEmpty().filter { it.agent == session?.agent }
        val boundProfile = session?.providerId?.let { id -> agentProfiles.firstOrNull { it.id == id } }
        val sessionOptions = SessionOptions(
            modelName = session?.model?.let { m ->
                listedModelName(m, listOfNotNull(agentModels) + agentProfiles.map { it.models }) ?: modelLabel(m)
            },
            model = session?.model,
            models = when {
                boundProfile != null -> boundProfile.models
                agent?.supportsModels == true -> agentModels.orEmpty()
                else -> emptyList()
            },
            modes = modes,
            mode = displayedMode,
            modePending = modeRequest.pending != null,
            defaultMode = agent?.defaultMode,
            // The session model's own levels, for an agent whose levels
            // differ by model; else the agent's.
            efforts = agentModels?.firstOrNull { it.id == session?.model }?.efforts?.takeIf { it.isNotEmpty() }
                ?: agent?.efforts.orEmpty(),
            effort = session?.effort,
            mcp = session?.mcp?.takeIf { supportsMcp && it.servers.isNotEmpty() },
        )
        var optionsSheetOpen by remember(machine, sessionId) { mutableStateOf(false) }
        if (optionsSheetOpen) {
            SessionOptionsSheet(
                sessionOptions,
                onMode = ::selectMode,
                onEffort = { level ->
                    if (level != session?.effort) {
                        dispatch(UniffiIntent.SetOption(machine = machine, sessionId = sessionId, option = "effort", value = level))
                    }
                },
                onModel = { id ->
                    optionsSheetOpen = false
                    if (id != session?.model) {
                        dispatch(UniffiIntent.SetOption(machine = machine, sessionId = sessionId, option = "model", value = id))
                    }
                },
                onMcp = {
                    optionsSheetOpen = false
                    mcpSheetOpen = true
                },
                onDismiss = { optionsSheetOpen = false },
            )
        }
        var contextSheetOpen by remember(machine, sessionId) { mutableStateOf(false) }
        if (contextSheetOpen) {
            ContextSheet(
                percentage = session?.contextPercentage,
                window = session?.contextWindow?.toLong(),
                usage = session?.usage,
                nowMs = System.currentTimeMillis(),
                onDismiss = { contextSheetOpen = false },
            )
        }
        val sessionMcp = session?.mcp
        if (mcpSheetOpen && sessionMcp != null) {
            SessionMcpSheet(
                sessionMcp,
                onToggle = { name, enabled ->
                    dispatch(UniffiIntent.ToggleSessionMcp(machine = machine, sessionId = sessionId, name = name, enabled = enabled))
                },
                onDismiss = { mcpSheetOpen = false },
            )
        }
        // A usage limit running out marks the context ring, when the user
        // asked for that warning; the ring's details always list every limit.
        val limitAlert = if (settings?.showUsageBadge == true) usageAlert(usageWindows(session?.usage, System.currentTimeMillis())) else null

        Composer(
            draft = draft,
            onDraftChange = { draft = it },
            placeholder = if (activeQuestion != null) "Type your answer…" else "Message…",
            canAttach = canAttachFiles,
            uploading = uploading,
            canSend = (draft.isNotBlank() || pendingFile != null) && !uploading,
            onStop = if (session?.state == "running") {
                { dispatch(UniffiIntent.Interrupt(machine = machine, sessionId = sessionId)) }
            } else {
                null
            },
            onAttachPhoto = ::pickPhoto,
            onAttachFile = ::pickFile,
            onDictate = ::dictate,
            onSend = ::send,
            focusRequester = inputFocus,
            options = { SessionOptionsChip(sessionOptions) { optionsSheetOpen = true } },
            meter = { ContextRing(session?.contextPercentage, limitAlert) { contextSheetOpen = true } },
        )
    }
}

/** Mode-request display state: what the chip shows is the pending request
 *  while one is in flight, else the last confirmed mode. */
private class ModeRequestUi {
    var pending by mutableStateOf<String?>(null)
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

/** The unanswered question a composer send answers: its ask and index. */
internal data class ActiveQuestion(val requestId: String, val index: Int)

/** The first unanswered question of the newest ask, or null when that ask is
 *  already answered — an older unanswered card is a stale one. */
internal fun activeQuestionOf(entries: List<DisplayEntry>, responded: Set<String>): ActiveQuestion? {
    val newest = entries.lastOrNull { it is DisplayEntry.Question } as? DisplayEntry.Question ?: return null
    if (newest.answered != null) return null
    val next = newest.questions.firstOrNull { questionCardKey(newest.requestId, it.index) !in responded }
        ?: return null
    return ActiveQuestion(newest.requestId, next.index)
}

/** Tapping a quick prompt joins the fragment onto the draft: an empty or
 *  whitespace-only draft takes it verbatim, otherwise trailing whitespace is
 *  stripped and exactly one space joins the two. */
internal fun appendToDraft(draft: String, fragment: String): String =
    if (draft.isBlank()) fragment else "${draft.trimEnd()} $fragment"

/**
 * The session's single top bar: back, and what this session is and where it
 * works (title over the workspace path). The session's own state is not
 * repeated here: a running turn has the transcript's activity line, waiting
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

/** The oldest failed send's line, right above the controls: what
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

/** A session's cost as a pill: "$0.42", "<$0.01" below a cent; nothing for
 *  a free (or unpriced) session. */
internal fun sessionCost(usd: Double): String? = when {
    !usd.isFinite() || usd <= 0.0 -> null
    usd < 0.01 -> "<$0.01"
    usd < 100.0 -> "$" + String.format(java.util.Locale.ROOT, "%.2f", usd)
    else -> "$" + String.format(java.util.Locale.ROOT, "%.0f", usd)
}

@Composable
private fun PendingPermissionBar(pending: PendingPermissionSummary, onRespond: (optionId: String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Warn.copy(alpha = 0.12f))
            .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
    ) {
        val label = when {
            pending.hook != null -> "${pending.hookPlugin ?: "A hook"} asks before ${pending.toolName} runs"
            pending.isSubAgent -> "${pending.agentLabel ?: "Sub-agent"}: ${pending.toolName} needs permission"
            else -> "${pending.toolName} needs permission"
        }
        // What the approval is actually for: a hook's own reason, else the
        // call's title (the command, the path), else the agent's description.
        val detail = pending.reason?.takeIf { pending.hook != null && it.isNotBlank() }
            ?: pending.title.takeIf { it.isNotBlank() }
            ?: pending.description.orEmpty()
        Column(Modifier.weight(1f)) {
            Text(label, color = Tokens.Text, fontSize = Tokens.TextSm, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail.isNotBlank() && detail != label) {
                Text(
                    detail,
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The highest-stakes taps in the app: full-size buttons. The bar has
        // room for the one-time choices; "always" options stay on the card.
        pending.options.filter { it.kind == "allow_once" || it.kind == "reject_once" }.forEach { option ->
            TextButton(onClick = { onRespond(option.id) }) {
                Text(
                    option.label,
                    color = if (option.isReject) Tokens.Danger else Tokens.Success,
                    fontSize = Tokens.TextSm,
                )
            }
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

/**
 * The name a model list gives the session's model [id] — its agent's list,
 * or a provider profile's — for a model [MODEL_TAGS] has no compact tag
 * for: an OpenCode or gateway id such as `ccr/OpenCode Go/deepseek-v4.1-flash`
 * reads as `deepseek-v4.1-flash`, as in the model picker. Null when the tag
 * table knows it, or no list names it.
 */
internal fun listedModelName(id: String?, lists: List<List<UniffiModelEntry>>): String? {
    if (id.isNullOrEmpty() || MODEL_TAGS.any { (modelId) -> modelId == stripContextMarker(id) }) return null
    return lists.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == id }?.label?.takeIf { it.isNotBlank() } }
}

// --- Subscription-usage presentation helpers (port of `ui/usageFormat.ts`'s
// header subset).

/** Compact token count: 950 → "950", 84_200 → "84k", 1_240_000 → "1.2M" —
 *  port of `apps/mobile/src/ui/usageFormat.ts`'s `formatTokens`. */
internal fun formatTokens(n: Long): String = when {
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

/** One usage limit the agent reports: its label ("5h"), how much of it is
 *  used, and when it resets. */
internal data class UsageWindowData(val label: String, val percent: Int, val resetCountdown: String?)

/** Every usage limit the agent reports, in its order. */
internal fun usageWindows(usage: UniffiUsageData?, nowMs: Long): List<UsageWindowData> {
    if (usage?.available != true) return emptyList()
    return usage.windows.mapNotNull { window ->
        val utilization = window.utilization?.takeIf { it.isFinite() } ?: return@mapNotNull null
        UsageWindowData(window.label, utilization.coerceIn(0.0, 100.0).roundToInt(), formatReset(window.resetsAt, nowMs))
    }
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
