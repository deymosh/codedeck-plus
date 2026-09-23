package com.codedeck.plus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens

/**
 * The right pane of the shell — port of `apps/mobile/src/ui/MainPanel.tsx`'s
 * core switch, narrowed: no dm/marmot panel modes (F4). `sessionContent` is a
 * slot rather than a direct `SessionScreen` call so this file doesn't need
 * editing once F3.3.6 wires the real screen in — see that milestone's change
 * to `Shell.kt`, the only caller.
 *
 * Moving to another session always goes through the sessions list: there is
 * no swipe between sessions here, so a horizontal drag inside a session
 * (a wide code block, the controls bar) never changes which one is open.
 */
@Composable
fun MainPanel(
    selectedMachine: String?,
    selectedSession: String?,
    isWide: Boolean,
    onOpenSidebar: () -> Unit,
    modifier: Modifier = Modifier,
    sessionContent: @Composable (machine: String, sessionId: String, onBack: (() -> Unit)?) -> Unit,
) {
    Column(modifier.fillMaxSize().background(Tokens.Bg)) {
        if (selectedMachine != null && selectedSession != null) {
            // On a phone the session header's back arrow returns to the
            // sessions list (`onOpenSidebar`); wide shells keep the list
            // permanently visible beside the session, so there is no back.
            sessionContent(
                selectedMachine,
                selectedSession,
                if (!isWide) onOpenSidebar else null,
            )
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Select a session", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
                    if (!isWide) {
                        Button(
                            onClick = onOpenSidebar,
                            modifier = Modifier.padding(top = Tokens.Space3),
                        ) {
                            Icon(
                                Icons.Outlined.Menu,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Text(
                                "Sessions",
                                modifier = Modifier.padding(start = Tokens.Space2),
                            )
                        }
                    }
                }
            }
        }
    }
}
