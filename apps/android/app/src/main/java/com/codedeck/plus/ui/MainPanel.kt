package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.codedeck.plus.ui.theme.Tokens

/**
 * The right pane of the shell — port of `apps/mobile/src/ui/MainPanel.tsx`'s
 * core switch, narrowed for F3.3: no dm/marmot panel modes (F4), no swipe
 * carousel (a touch-gesture nicety, not part of this slice's own go/no-go).
 * `sessionContent` is a slot rather than a direct `SessionScreen` call so
 * this file doesn't need editing once F3.3.6 wires the real screen in — see
 * that milestone's change to `Shell.kt`, the only caller.
 */
@Composable
fun MainPanel(
    selectedMachine: String?,
    selectedSession: String?,
    isWide: Boolean,
    onOpenSidebar: () -> Unit,
    modifier: Modifier = Modifier,
    sessionContent: @Composable (machine: String, sessionId: String) -> Unit,
) {
    Column(modifier.fillMaxSize().background(Tokens.Bg)) {
        if (!isWide) {
            Row(
                Modifier.fillMaxWidth().padding(Tokens.Space2),
                horizontalArrangement = Arrangement.Start,
            ) {
                Text(
                    "☰",
                    color = Tokens.Text,
                    fontSize = Tokens.TextLg,
                    modifier = Modifier.clickable(onClick = onOpenSidebar).padding(Tokens.Space2),
                )
            }
        }
        if (selectedMachine != null && selectedSession != null) {
            sessionContent(selectedMachine, selectedSession)
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Select a session", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
                    if (!isWide) {
                        Button(
                            onClick = onOpenSidebar,
                            modifier = Modifier.padding(top = Tokens.Space3),
                        ) {
                            Text("☰ Sessions")
                        }
                    }
                }
            }
        }
    }
}
