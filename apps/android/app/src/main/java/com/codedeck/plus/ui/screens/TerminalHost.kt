package com.codedeck.plus.ui.screens

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.platform.DeviceUnlock
import com.codedeck.plus.platform.TerminalPrefs
import com.codedeck.plus.ui.components.EmptyState
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.theme.Tokens
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionCallbacks
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import kotlinx.coroutines.channels.Channel
import uniffi.client_ffi.UniffiAttachedTerminal
import uniffi.client_ffi.UniffiIntent
import uniffi.client_runtime.CoreEvent
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.math.ceil

/** Lines of scrollback the phone keeps; the bridge's 256 KiB ring is the history that matters. */
private const val TRANSCRIPT_ROWS = 2000

/**
 * Random per process. An unlock is saved with the page so a rotation does not
 * ask again, but a page restored into a new process (the app was killed in
 * the background) must: the saved token no longer matches.
 */
private val PROCESS_TOKEN = UUID.randomUUID().toString()

/**
 * One terminal on screen, driven by [machine]'s shell: the vendored Termux
 * emulator draws what the shell writes ([session], fed from
 * `CoreEvent.TerminalOutput`), and what the user types — keys, the keyboard,
 * the extra-keys row, a paste — goes back through [send] as intents, which
 * the core paces, numbers and retries. Only the writer's input and size
 * count; a device that watches sends neither.
 */
internal class RemoteTerminal(
    private val machine: String,
    private val context: Context,
    textSp: Int,
    private val send: (UniffiIntent) -> Unit,
    private val onTextSp: (Int) -> Unit,
) : TerminalSessionClient, TerminalSessionCallbacks, TerminalViewClient {
    val session = TerminalSession(TRANSCRIPT_ROWS, this, this)
    var view: TerminalView? = null
    var echo: View? = null

    /** The terminal as the core last reported it. */
    var attached: UniffiAttachedTerminal? = null
        private set

    /** Sticky modifiers from the extra-keys row: each applies to the next key, then lets go. */
    var ctrl by mutableStateOf(false)
    var alt by mutableStateOf(false)

    var textSp: Int = textSp
        private set

    /** Collects the bytes of a paste while the emulator encodes it, so they go as one event. */
    private var pasting: ByteArrayOutputStream? = null

    /** The size the shell was last told (by the open, or a resize). */
    private var sentSize: Pair<Int, Int>? = null
    private var viewSize: Pair<Int, Int>? = null

    fun update(next: UniffiAttachedTerminal) {
        val wasWriter = attached?.writer == true
        attached = next
        // A device that just took the pen tells the shell its own size.
        if (next.writer && !wasWriter) sentSize = null
        sendSize()
        echo?.invalidate()
    }

    /** The open itself carries this size, so the first layout need not repeat it. */
    fun opened(cols: Int, rows: Int) {
        sentSize = cols to rows
    }

    private fun sendSize() {
        val a = attached ?: return
        val term = a.term ?: return
        val size = viewSize ?: return
        if (!a.writer || size == sentSize) return
        sentSize = size
        send(UniffiIntent.ResizeTerminal(machine, term, size.first.toUShort(), size.second.toUShort()))
    }

    private fun writerTerm(): String? = attached?.takeIf { it.writer }?.term

    fun textPx(sp: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp.toFloat(), context.resources.displayMetrics).toInt()

    private fun setTextSp(sp: Int) {
        val next = sp.coerceIn(TerminalPrefs.MIN_TEXT_SP, TerminalPrefs.MAX_TEXT_SP)
        if (next == textSp) return
        textSp = next
        onTextSp(next)
        view?.setTextSize(textPx(next))
        echo?.invalidate()
    }

    /** A key from the extra-keys row. */
    fun press(key: ExtraKey) {
        val view = view ?: return
        if (writerTerm() == null || session.emulator == null) return
        when (key) {
            ExtraKey.Ctrl -> ctrl = !ctrl
            ExtraKey.Alt -> alt = !alt
            ExtraKey.Pipe, ExtraKey.Tilde, ExtraKey.Slash -> view.inputCodePoint(key.label[0].code, false, false)
            else -> {
                var mod = 0
                if (readControlKey()) mod = mod or KeyHandler.KEYMOD_CTRL
                if (readAltKey()) mod = mod or KeyHandler.KEYMOD_ALT
                view.handleKeyCode(key.keyCode, mod)
            }
        }
    }

    // --- TerminalSessionCallbacks: toward the shell ---------------------------

    override fun onInput(data: ByteArray) {
        val term = writerTerm() ?: return
        pasting?.let { it.write(data); return }
        send(UniffiIntent.TerminalInput(machine, term, data, session.isAlternateBufferActive))
    }

    override fun onResize(columns: Int, rows: Int) {
        viewSize = columns to rows
        sendSize()
    }

    // --- TerminalSessionClient: from the emulator -----------------------------

    override fun onTextChanged(changedSession: TerminalSession) {
        view?.onScreenUpdated()
        echo?.invalidate()
    }

    override fun onTitleChanged(changedSession: TerminalSession) {}
    override fun onSessionFinished(finishedSession: TerminalSession) {}

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("terminal", text))
    }

    override fun onPasteTextFromClipboard(session: TerminalSession) {
        val term = writerTerm() ?: return
        val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return
        val text = clip.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString() ?: return
        val emulator = session.emulator ?: return
        // The emulator wraps the text in bracketed-paste marks when the
        // program asked for them; collect what it writes and send it whole.
        val bytes = ByteArrayOutputStream().also { pasting = it }
        try {
            emulator.paste(text)
        } finally {
            pasting = null
        }
        if (bytes.size() > 0) send(UniffiIntent.TerminalPaste(machine, term, bytes.toByteArray()))
    }

    override fun onBell(session: TerminalSession) {}
    override fun onColorsChanged(session: TerminalSession) { view?.invalidate() }
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun getTerminalCursorStyle(): Int? = null

    // Nothing the emulator logs is written anywhere: it can quote the
    // shell's output, and that may hold a secret.
    override fun logError(tag: String?, message: String?) {}
    override fun logWarn(tag: String?, message: String?) {}
    override fun logInfo(tag: String?, message: String?) {}
    override fun logDebug(tag: String?, message: String?) {}
    override fun logVerbose(tag: String?, message: String?) {}
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
    override fun logStackTrace(tag: String?, e: Exception?) {}

    // --- TerminalViewClient: the view's gestures and keys ---------------------

    /** Pinch: a step of one sp once the fingers have moved a tenth apart, kept for every terminal. */
    override fun onScale(scale: Float): Float {
        if (scale in 0.9f..1.1f) return scale
        setTextSp(textSp + if (scale > 1f) 1 else -1)
        return 1f
    }

    override fun onSingleTapUp(e: MotionEvent) {
        val view = view ?: return
        if (writerTerm() == null) return
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(view, 0)
    }

    override fun shouldBackButtonBeMappedToEscape(): Boolean = false

    // No suggestions or autocorrect: a shell wants the characters typed.
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) {}
    // A watching device's keys still reach the emulator, which hands them to
    // onInput; that drops them, so Back and the rest keep working.
    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean = false
    override fun onLongPress(event: MotionEvent): Boolean = false

    override fun readControlKey(): Boolean = ctrl.also { if (it) ctrl = false }
    override fun readAltKey(): Boolean = alt.also { if (it) alt = false }
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean = false
    override fun onEmulatorSet() {}
}

/** The extra-keys row: what a phone keyboard lacks for a shell. */
internal enum class ExtraKey(val label: String, val keyCode: Int = 0, val icon: ImageVector? = null) {
    Esc("ESC", KeyEvent.KEYCODE_ESCAPE),
    Ctrl("CTRL"),
    Alt("ALT"),
    Tab("TAB", KeyEvent.KEYCODE_TAB),
    Left("Left", KeyEvent.KEYCODE_DPAD_LEFT, Icons.AutoMirrored.Outlined.KeyboardArrowLeft),
    Up("Up", KeyEvent.KEYCODE_DPAD_UP, Icons.Outlined.KeyboardArrowUp),
    Down("Down", KeyEvent.KEYCODE_DPAD_DOWN, Icons.Outlined.KeyboardArrowDown),
    Right("Right", KeyEvent.KEYCODE_DPAD_RIGHT, Icons.AutoMirrored.Outlined.KeyboardArrowRight),
    Pipe("|"),
    Tilde("~"),
    Slash("/"),
}

/**
 * The keys a phone keyboard lacks for a shell, in one row under it. CTRL and
 * ALT stay lit until the next key, which they modify. Pure, for snapshots.
 */
@Composable
internal fun ExtraKeysRow(ctrl: Boolean, alt: Boolean, onKey: (ExtraKey) -> Unit) {
    Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = Tokens.Space1, vertical = 2.dp)) {
        ExtraKey.entries.forEach { key ->
            val on = (key == ExtraKey.Ctrl && ctrl) || (key == ExtraKey.Alt && alt)
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(if (on) Tokens.SurfaceHover else Tokens.Bg)
                    .clickable { onKey(key) },
                contentAlignment = Alignment.Center,
            ) {
                val color = if (on) Tokens.Text else Tokens.TextMuted
                val icon = key.icon
                if (icon != null) {
                    Icon(icon, contentDescription = key.label, tint = color, modifier = Modifier.size(20.dp))
                } else {
                    Text(
                        key.label,
                        color = color,
                        fontSize = if (key.label.length > 1) Tokens.TextXs else Tokens.TextMd,
                        fontFamily = Tokens.FontMono,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }
        }
    }
}

/**
 * What the user typed and the shell has not echoed yet, as it will most
 * likely look: [UniffiAttachedTerminal.waitingInput] holds the printable keys
 * the core is still pacing on the normal screen. A backspace takes one back;
 * any other control key means the shell decides what happens, so nothing is
 * predicted past it.
 */
internal fun predictedEcho(waiting: ByteArray): String {
    val out = StringBuilder()
    for (ch in waiting.decodeToString()) {
        when {
            ch == '\u007f' || ch == '\b' -> if (out.isNotEmpty()) out.setLength(out.length - 1)
            ch < ' ' -> return ""
            else -> out.append(ch)
        }
    }
    return out.toString()
}

/**
 * Draws [predictedEcho] dimmed at the cursor, over the terminal: typing shows
 * at once on a link that takes a round trip to echo it. Only on the normal
 * screen at the bottom of the scrollback, where the cursor is where the
 * shell will put those characters.
 */
private class PredictedEchoView(context: Context, private val terminal: RemoteTerminal) : View(context) {
    private val text = Paint().apply {
        typeface = Typeface.MONOSPACE
        isAntiAlias = true
        color = Tokens.TextMuted.toArgb()
    }
    private val cell = Paint().apply { color = Tokens.Bg.toArgb() }

    override fun onDraw(canvas: Canvas) {
        val a = terminal.attached ?: return
        if (!a.writer || a.waitingInput.isEmpty()) return
        val view = terminal.view ?: return
        val emulator = terminal.session.emulator ?: return
        if (emulator.isAlternateBufferActive || view.topRow != 0) return
        val predicted = predictedEcho(a.waitingInput)
        if (predicted.isEmpty()) return
        text.textSize = terminal.textPx(terminal.textSp).toFloat()
        val row = emulator.cursorRow
        val x = view.getPointX(emulator.cursorCol).toFloat()
        // The renderer puts row r's baseline where row r + 1 starts.
        val baseline = view.getPointY(row + 1).toFloat()
        canvas.drawRect(x, baseline + text.ascent(), x + text.measureText(predicted), baseline + text.descent(), cell)
        canvas.drawText(predicted, x, baseline, text)
    }
}

/**
 * The shell itself: the Termux view filling the space, the predicted echo
 * over it, and — for the writer — the extra-keys row under it.
 */
@Composable
internal fun TerminalEmulatorHost(terminal: RemoteTerminal, attached: UniffiAttachedTerminal) {
    Column(Modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx ->
                FrameLayout(ctx).apply {
                    val view = TerminalView(ctx, null).apply {
                        // The client and the text size first: attaching sizes
                        // the emulator, which reads both.
                        setTerminalViewClient(terminal)
                        setTextSize(terminal.textPx(terminal.textSp))
                        isFocusable = true
                        isFocusableInTouchMode = true
                        attachSession(terminal.session)
                    }
                    terminal.view = view
                    val echo = PredictedEchoView(ctx, terminal)
                    terminal.echo = echo
                    addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
                    addView(echo, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
                }
            },
            update = { terminal.update(attached) },
            onRelease = {
                terminal.view = null
                terminal.echo = null
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
        if (attached.writer) ExtraKeysRow(terminal.ctrl, terminal.alt, terminal::press)
    }
}

/** The columns and rows the terminal's area will hold at [textSp], estimated from the window before it is laid out. */
private fun estimateSize(context: Context, textSp: Int, widthDp: Int, heightDp: Int): Pair<Int, Int> {
    val metrics = context.resources.displayMetrics
    val paint = Paint().apply {
        typeface = Typeface.MONOSPACE
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, textSp.toFloat(), metrics)
    }
    val lineSpacing = ceil(paint.fontSpacing).toInt()
    val ascent = ceil(paint.ascent()).toInt()
    // The slim bar, the extra-keys row, the side padding and the system bars.
    val width = (widthDp - 16) * metrics.density
    val height = (heightDp - 48 - 40 - 48) * metrics.density
    val cols = (width / paint.measureText("X")).toInt().coerceAtLeast(4)
    val rows = ((height - (lineSpacing + ascent)) / lineSpacing).toInt().coerceAtLeast(4)
    return cols to rows
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/**
 * A terminal on [machine]: [term] attaches to one its list names, read-only
 * until a takeover; null opens a new one, in [session]'s directory when set.
 * With "Lock terminals" on, the device's unlock prompt
 * comes first. Leaving the page detaches (the shell keeps running); a
 * rotation does not, and the recreated page takes the same terminal back.
 */
@Composable
fun TerminalScreen(core: CoreHost, machine: String, term: String?, session: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { TerminalPrefs(context) }
    var unlocked by rememberSaveable { mutableStateOf<String?>(null) }
    if (prefs.requireUnlock && unlocked != PROCESS_TOKEN) {
        val available = remember { DeviceUnlock.available(context) }
        var asks by remember { mutableStateOf(0) }
        LaunchedEffect(asks) {
            if (available && DeviceUnlock.ask(context, "Open a terminal")) unlocked = PROCESS_TOKEN
        }
        TerminalLockedContent(available, onUnlock = { asks++ }, onBack = onBack)
        return
    }

    val ui by core.ui.collectAsState()
    val attached = ui?.terminals?.attached?.takeIf { it.machine == machine }
    // One consumer, in order: keystrokes dispatched from separate launches
    // could reach the core out of order.
    val outbox = remember { Channel<UniffiIntent>(Channel.UNLIMITED) }
    LaunchedEffect(outbox) { for (intent in outbox) core.dispatch(intent) }
    val terminal = remember(machine) {
        RemoteTerminal(machine, context, prefs.textSp, send = { outbox.trySend(it) }, onTextSp = { prefs.textSp = it })
    }
    val configuration = LocalConfiguration.current

    DisposableEffect(terminal) {
        // The output sink is in place before the open or attach is sent, so
        // a replay that answers at once is drawn.
        val sink: (CoreEvent.TerminalOutput) -> Unit = { if (it.machine == machine) terminal.session.feed(it.bytes) }
        core.terminalOutput = sink
        val current = core.ui.value?.terminals?.attached
            ?.takeIf { it.machine == machine && it.refusal == null && it.ended == null }
        val first = when {
            term != null -> UniffiIntent.AttachTerminal(machine, term)
            // The page was recreated (a rotation) over the terminal it had:
            // the new screen is blank, so it is replayed.
            current?.term != null -> UniffiIntent.AttachTerminal(machine, current.term!!)
            // Its open is still on the way; the answer lands in the view.
            current?.openId != null -> null
            else -> {
                val (cols, rows) = estimateSize(context, terminal.textSp, configuration.screenWidthDp, configuration.screenHeightDp)
                terminal.opened(cols, rows)
                UniffiIntent.OpenTerminal(machine, session, cols.toUShort(), rows.toUShort())
            }
        }
        first?.let { outbox.trySend(it) }
        onDispose {
            if (core.terminalOutput === sink) core.terminalOutput = null
            if (context.activity()?.isChangingConfigurations != true) core.dispatchDetached(UniffiIntent.DetachTerminal(machine))
        }
    }

    TerminalContent(
        attached = attached,
        onBack = onBack,
        onTakeOver = { attached?.term?.let { outbox.trySend(UniffiIntent.TakeOverTerminal(machine, it)) } },
        onClose = {
            attached?.term?.let { outbox.trySend(UniffiIntent.CloseTerminal(machine, it)) }
        },
        emulator = { a -> TerminalEmulatorHost(terminal, a) },
    )
}

/** The page before a terminal opens when the phone asks for its unlock first. */
@Composable
internal fun TerminalLockedContent(available: Boolean, onUnlock: () -> Unit, onBack: () -> Unit) {
    Page(title = "Terminal", onBack = onBack) {
        EmptyState(
            icon = Icons.Outlined.Fingerprint,
            title = "Unlock to open",
            body = if (available) {
                "Terminals on this phone open after your fingerprint or screen lock."
            } else {
                "This phone has no fingerprint or screen lock to ask for. Set one up, or turn off " +
                    "Lock terminals in Settings, Account."
            },
            action = if (available) "Unlock" else "Done",
            onAction = if (available) onUnlock else onBack,
            modifier = Modifier.fillMaxWidth().padding(top = Tokens.Space7),
        )
    }
}
