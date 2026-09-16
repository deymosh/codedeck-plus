package com.codedeck.plus.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import com.codedeck.plus.ui.theme.Tokens

/**
 * Minimal new-session bottom sheet — a single Create button, dispatching
 * `Intent::CreateSession { machine }` exactly as it's already mapped (no
 * cwd/model/effort fields). The full folder/model/effort picker
 * (`NewSessionModal.tsx`'s actual scope) is F4 — this sheet exists in F3.3
 * only to satisfy the master plan's own F3 go/no-go line about a
 * `ModalBottomSheet` for a new session, with real Compose gestures
 * (swipe-to-dismiss, drag handle) instead of a stub dialog.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(machinePubkey: String, onCreate: (machine: String) -> Unit, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState()
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().padding(Tokens.Space5)) {
            Text(
                "Start a new session",
                color = Tokens.Text,
                fontSize = Tokens.TextLg,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = Tokens.Space4),
            )
            Button(onClick = { onCreate(machinePubkey) }, modifier = Modifier.fillMaxWidth()) {
                Text("Create")
            }
        }
    }
}
