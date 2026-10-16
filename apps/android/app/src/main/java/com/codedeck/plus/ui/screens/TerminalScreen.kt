package com.codedeck.plus.ui.screens

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.EmptyState
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAttachedTerminal
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiTerminalEnded
import uniffi.client_ffi.UniffiTerminalInfo
import uniffi.client_ffi.UniffiTerminalRefusal

/** The capability a bridge advertises only when its owner turned terminals on. */
internal const val TERMINAL_CAPABILITY = "terminal"

/** `bash` for `/bin/bash`; a configured command (`tmux new -A -s phone`) as it is. */
internal fun shellName(shell: String?): String =
    shell?.takeIf { it.isNotBlank() }?.let { if (' ' in it) it else it.substringAfterLast('/') } ?: "Terminal"

/**
 * The "Terminal" group on a machine's page: open one, or the ones running
 * there — each with what runs in it and the device that opened it. A bridge
 * that does not advertise terminals says where they are switched on; the
 * phone never switches them on itself.
 */
@Composable
internal fun MachineTerminalsGroup(
    machine: UniffiMachineSummary,
    terminals: List<UniffiTerminalInfo>,
    now: Long,
    onOpen: () -> Unit,
    onAttach: (term: String) -> Unit,
) {
    if (TERMINAL_CAPABILITY !in machine.capabilities) {
        Group(title = "Terminal", footer = "Off on this machine. Its owner turns terminals on in the bridge's config (terminal.enabled).") {
            ValueRow("Terminal", subtitle = "Off") {}
        }
        return
    }
    Group(title = "Terminal", footer = "A shell on the machine. Only approved phones open one, and every terminal is recorded on the machine.") {
        terminals.forEach { t ->
            NavRow(
                shellName(t.shell),
                onClick = { onAttach(t.term) },
                subtitle = listOfNotNull(t.name?.let { "Opened by $it" }, openedAgo(t.opened.toLong(), now)).joinToString(" · "),
            )
            Divider()
        }
        NavRow("Open a terminal", onClick = onOpen)
    }
}

private fun openedAgo(openedMs: Long, now: Long): String {
    val minutes = (now - openedMs) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        else -> "${minutes / 60} h ago"
    }
}

/** What to say about a refused open, and what the owner can do about it. */
internal fun refusalText(refusal: UniffiTerminalRefusal): Pair<String, String> = when (refusal.reason) {
    "not-allowed" -> "This phone is not approved" to
        "A terminal is a shell on the machine, so each phone is approved there first. Run this on the machine, then open it again."
    "limit" -> "Too many terminals" to "The machine runs as many terminals as it allows. Close one, then open it again."
    "disabled" -> "Terminals are off" to "The machine's owner turns them on in the bridge's config (terminal.enabled)."
    "transport" -> "The terminal did not start" to "The machine could not start a shell, or this phone reached it a way terminals are not allowed (over a relay)."
    else -> "The terminal did not open" to "The machine refused it (${refusal.reason})."
}

/** Why a terminal is over, in a line. */
internal fun endedText(ended: UniffiTerminalEnded): String = when (ended.reason) {
    "exit" -> ended.code?.let { "The shell exited with code $it." } ?: "The shell exited."
    "closed" -> "The terminal was closed."
    "idle" -> "It ended after a long time with no phone attached."
    "killed" -> "The machine ended it."
    "restart" -> "The bridge restarted, and the shell with it."
    "transport" -> "The machine lost the shell."
    "not-allowed" -> "This phone was withdrawn from the machine's approved devices."
    else -> "The terminal ended (${ended.reason})."
}

/**
 * One terminal: while it opens, the shell itself ([emulator], which fills
 * the screen), why it was refused, or why it is over. Only the writer closes
 * it; a device that does not write watches, with Take over to become the
 * writer. Pure — the caller supplies the terminal and the emulator — so it
 * renders in a snapshot.
 */
@Composable
fun TerminalContent(
    attached: UniffiAttachedTerminal?,
    onBack: () -> Unit,
    onTakeOver: () -> Unit,
    onClose: () -> Unit,
    emulator: @Composable (UniffiAttachedTerminal) -> Unit,
) {
    val refusal = attached?.refusal
    val ended = attached?.ended
    if (attached != null && attached.term != null && refusal == null && ended == null) {
        RunningTerminal(attached, onBack, onTakeOver, onClose, emulator)
        return
    }
    Page(title = shellName(attached?.shell), onBack = onBack) {
        when {
            refusal != null -> Refused(refusal, onBack)
            ended != null -> EmptyState(
                icon = Icons.Outlined.PowerSettingsNew,
                title = "Terminal ended",
                body = endedText(ended),
                action = "Done",
                onAction = onBack,
                modifier = Modifier.fillMaxWidth().padding(top = Tokens.Space7),
            )
            else -> Column(
                Modifier.fillMaxWidth().padding(top = Tokens.Space7),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                CircularProgressIndicator(color = Tokens.Text, strokeWidth = 2.dp)
                Text("Opening a terminal…", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
            }
        }
    }
}

/**
 * A running terminal: one slim bar (back, what runs, and Take over or close),
 * the rest of the screen the shell's — a terminal needs its rows more than a
 * page title.
 */
@Composable
private fun RunningTerminal(
    attached: UniffiAttachedTerminal,
    onBack: () -> Unit,
    onTakeOver: () -> Unit,
    onClose: () -> Unit,
    emulator: @Composable (UniffiAttachedTerminal) -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Tokens.Bg)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Space1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
        ) {
            IconAction(Icons.AutoMirrored.Outlined.ArrowBack, "Back", onBack)
            Text(
                shellName(attached.shell),
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (attached.writer) {
                IconAction(Icons.Outlined.PowerSettingsNew, "Close the terminal", onClick = onClose, tint = Tokens.TextMuted)
            } else {
                // Another device types into it: this one watches until it
                // takes the pen, which every device of the identity is told.
                Text("Watching", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                QuietButton("Take over", onClick = onTakeOver)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = Tokens.Space2)) { emulator(attached) }
    }
}

@Composable
private fun Refused(refusal: UniffiTerminalRefusal, onBack: () -> Unit) {
    val (title, body) = refusalText(refusal)
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    EmptyState(
        icon = Icons.Outlined.Lock,
        title = title,
        body = body,
        action = "Done",
        onAction = onBack,
        modifier = Modifier.fillMaxWidth().padding(top = Tokens.Space6),
    )
    val device = refusal.device
    if (refusal.reason == "not-allowed" && device != null) {
        val command = "codedeck-bridge terminal allow $device"
        Group(title = "On the machine", footer = refusal.name?.let { "This phone is \"$it\" there; codedeck-bridge terminal pending lists it." }) {
            ValueRow("Approve this phone", subtitle = command, mono = true) {
                IconAction(
                    Icons.Outlined.ContentCopy,
                    "Copy the command",
                    onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("command", command))) } },
                    tint = Tokens.TextMuted,
                )
            }
        }
    }
}
