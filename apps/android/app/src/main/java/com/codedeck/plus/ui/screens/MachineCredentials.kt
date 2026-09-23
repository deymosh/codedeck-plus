package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiTristate

/**
 * Machine credentials (CDX-011) — port of `apps/mobile/src/ui/screens/
 * MachineCredentials.tsx`. An inline collapsible block, not a full-screen
 * replacement: a field left blank is not sent (keeps the stored value), a
 * filled field overwrites, and the explicit Clear buttons send
 * [UniffiTristate.Clear]. Both fields are password inputs and the draft is
 * wiped immediately after send — credential values are never logged and
 * never echoed back over the wire.
 *
 * `saving` is a local optimistic stamp, not a round trip through
 * `CoreHost`: it mirrors `apps/mobile/src/core/stores/nativeUi.ts`'s
 * `noteCredentialsSent` (a plain client-side "saving" marker), cleared once
 * [status] next changes — the real ack arrives through the existing
 * `CoreHost.ui` `StateFlow` on the following `UiView` refresh.
 */
@Composable
fun MachineCredentials(machinePubkey: String, status: UniffiCredentialsAck?, dispatch: (UniffiIntent) -> Unit) {
    var open by remember(machinePubkey) { mutableStateOf(false) }
    var apiKey by remember(machinePubkey) { mutableStateOf("") }
    var pat by remember(machinePubkey) { mutableStateOf("") }
    var saving by remember(machinePubkey) { mutableStateOf(false) }
    /** "key" / "pat" while a clear awaits confirmation. */
    var confirmClear by remember(machinePubkey) { mutableStateOf<String?>(null) }

    LaunchedEffect(status) { if (status != null) saving = false }

    if (!open) {
        Button(onClick = { open = true }) {
            Text("Machine credentials…")
        }
        return
    }

    fun send(anthropicApiKey: UniffiTristate, githubPat: UniffiTristate) {
        saving = true
        dispatch(UniffiIntent.SetCredentials(machinePubkey, anthropicApiKey, githubPat))
    }

    fun save() {
        val key = apiKey.trim()
        val token = pat.trim()
        if (key.isEmpty() && token.isEmpty()) return
        send(
            if (key.isNotEmpty()) UniffiTristate.Set(key) else UniffiTristate.Keep,
            if (token.isNotEmpty()) UniffiTristate.Set(token) else UniffiTristate.Keep,
        )
        apiKey = ""
        pat = ""
    }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Text("Machine credentials", color = Tokens.Text, fontSize = Tokens.TextSm)
        Text(
            "Stored on the bridge host and fed into Claude Code sessions started " +
                "there (API key / GitHub token). Leave a field empty to keep the current value.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            placeholder = { Text("ANTHROPIC_API_KEY (sk-ant-…)") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pat,
            onValueChange = { pat = it },
            placeholder = { Text("GitHub PAT (ghp_…)") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        // Two rows: all four buttons on one row did not fit a phone.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Button(
                onClick = ::save,
                enabled = apiKey.trim().isNotEmpty() || pat.trim().isNotEmpty(),
                modifier = Modifier.weight(1f),
            ) {
                Text("Save on bridge")
            }
            TextButton(onClick = { open = false }) {
                Text("Close")
            }
        }
        // Clearing deletes the stored secret on the bridge, so it asks first,
        // like removing a machine or a provider does.
        val pending = confirmClear
        if (pending == null) {
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                TextButton(onClick = { confirmClear = "key" }) {
                    Text("Clear API key", color = Tokens.Danger)
                }
                TextButton(onClick = { confirmClear = "pat" }) {
                    Text("Clear GitHub PAT", color = Tokens.Danger)
                }
            }
        } else {
            Text(
                if (pending == "key") "Delete the API key stored on the bridge?" else "Delete the GitHub PAT stored on the bridge?",
                color = Tokens.Text,
                fontSize = Tokens.TextSm,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                TextButton(onClick = {
                    if (pending == "key") send(UniffiTristate.Clear, UniffiTristate.Keep)
                    else send(UniffiTristate.Keep, UniffiTristate.Clear)
                    confirmClear = null
                }) {
                    Text("Delete", color = Tokens.Danger)
                }
                TextButton(onClick = { confirmClear = null }) {
                    Text("Cancel")
                }
            }
        }
        if (status != null) {
            val text = when (status.state) {
                "saving" -> "Saving on the bridge…"
                "saved" -> {
                    val keySuffix = when (status.keyValid) {
                        true -> " (valid)"
                        false -> " (INVALID)"
                        null -> ""
                    }
                    "Saved · API key: ${if (status.hasAnthropicKey == true) "set" else "none"}$keySuffix" +
                        " · GitHub PAT: ${if (status.hasGithubPat == true) "set" else "none"}"
                }
                "failed" -> "Saving failed: ${status.error ?: "unknown error"}"
                else -> ""
            }
            Text(text, color = if (status.state == "failed") Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}
