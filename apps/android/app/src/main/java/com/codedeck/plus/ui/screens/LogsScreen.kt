package com.codedeck.plus.ui.screens

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.unit.dp
import com.codedeck.plus.platform.readAppLogs
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch

/** How a log line is coloured, by its logcat level (`time` format:
 *  `MM-DD hh:mm:ss.mmm L/tag(pid): message`). */
internal fun logLineLevel(line: String): Char? =
    Regex("""^\S+ \S+ ([VDIWEF])/""").find(line)?.groupValues?.get(1)?.single()

/**
 * CodeDeck+'s own log lines (the core's, the signer's, and crash reports —
 * see [readAppLogs]), newest at the bottom, for debugging on the device.
 * Refresh re-reads the log; Copy puts every line on the clipboard.
 */
@Composable
fun LogsScreen(onBack: () -> Unit) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var lines by remember { mutableStateOf<List<String>?>(null) }
    var reloads by remember { mutableIntStateOf(0) }
    val list = rememberLazyListState()

    LaunchedEffect(reloads) {
        lines = readAppLogs()
        lines?.let { if (it.isNotEmpty()) list.scrollToItem(it.lastIndex) }
    }
    LogsContent(
        lines = lines,
        list = list,
        onRefresh = { reloads++ },
        onCopy = {
            val text = lines.orEmpty().joinToString("\n")
            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("CodeDeck+ logs", text))) }
        },
        onBack = onBack,
    )
}

/** [LogsScreen]'s page from the lines read (`null`: still reading). */
@Composable
internal fun LogsContent(
    lines: List<String>?,
    onRefresh: () -> Unit,
    onCopy: () -> Unit,
    onBack: () -> Unit,
    list: LazyListState = rememberLazyListState(),
) {
    Page(
        title = "Logs",
        onBack = onBack,
        scroll = false,
        actions = {
            IconAction(Icons.Outlined.Refresh, "Refresh", onRefresh)
            IconAction(Icons.Outlined.ContentCopy, "Copy all", { if (!lines.isNullOrEmpty()) onCopy() }, tint = if (lines.isNullOrEmpty()) Tokens.TextDim else Tokens.Text)
        },
    ) {
        when {
            lines == null -> Text("Reading…", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            lines.isEmpty() -> Text("Nothing logged yet.", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            else -> Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusLg))
                    .background(Tokens.Surface)
                    .border(1.dp, Tokens.Border, RoundedCornerShape(Tokens.RadiusLg)),
            ) {
                SelectionContainer {
                    LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(Tokens.Space3)) {
                        itemsIndexed(lines) { _, line ->
                            Text(
                                line,
                                color = when (logLineLevel(line)) {
                                    'E', 'F' -> Tokens.Danger
                                    'W' -> Tokens.Warn
                                    'D', 'V' -> Tokens.TextMuted
                                    else -> Tokens.Text
                                },
                                fontSize = Tokens.TextXs,
                                fontFamily = Tokens.FontMono,
                                modifier = Modifier.padding(vertical = 2.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
