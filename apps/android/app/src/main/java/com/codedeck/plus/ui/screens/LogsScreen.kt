package com.codedeck.plus.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Surface
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.codedeck.plus.platform.readAppLogs
import com.codedeck.plus.ui.theme.Tokens

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
    val clipboard = LocalClipboardManager.current
    var lines by remember { mutableStateOf<List<String>?>(null) }
    var reloads by remember { mutableIntStateOf(0) }
    val list = rememberLazyListState()

    LaunchedEffect(reloads) {
        lines = readAppLogs()
        lines?.let { if (it.isNotEmpty()) list.scrollToItem(it.lastIndex) }
    }

    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space3),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Icon(
                    Icons.AutoMirrored.Outlined.ArrowBack,
                    contentDescription = "Back",
                    tint = Tokens.TextMuted,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .clickable(onClick = onBack)
                        .padding(Tokens.Space2)
                        .size(20.dp),
                )
                Text("Logs", color = Tokens.Text, fontSize = Tokens.TextLg, modifier = Modifier.weight(1f))
                TextButton(onClick = { reloads++ }) { Text("Refresh") }
                TextButton(
                    onClick = { clipboard.setText(AnnotatedString(lines.orEmpty().joinToString("\n"))) },
                    enabled = !lines.isNullOrEmpty(),
                ) { Text("Copy") }
            }
            val shown = lines
            when {
                shown == null -> Text("Reading…", color = Tokens.TextMuted, fontSize = Tokens.TextSm, modifier = Modifier.padding(Tokens.Space3))
                shown.isEmpty() -> Text("Nothing logged yet.", color = Tokens.TextMuted, fontSize = Tokens.TextSm, modifier = Modifier.padding(Tokens.Space3))
                else -> SelectionContainer(Modifier.weight(1f)) {
                    LazyColumn(state = list, modifier = Modifier.fillMaxSize().padding(horizontal = Tokens.Space3)) {
                        itemsIndexed(shown) { _, line ->
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
                                modifier = Modifier.padding(vertical = 1.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
