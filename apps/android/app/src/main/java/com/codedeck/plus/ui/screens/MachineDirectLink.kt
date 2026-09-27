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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.isDirectEndpoint

/** How the phone reaches [machine] right now, as one line. */
internal fun directLinkStatusText(machine: UniffiMachineSummary): String {
    val up = machine.directUp
    return when {
        up != null -> "Connected directly ($up)"
        machine.directAdvertised.isEmpty() && machine.directEndpoints.isEmpty() -> "Through the relays"
        else -> "Through the relays (no direct endpoint reachable)"
    }
}

/**
 * Direct link — how the phone reaches this machine (directly or through the
 * relays), the endpoints the bridge advertises, and an editor for the user's
 * own ones (a VPN or MagicDNS name the bridge cannot know), one per line,
 * tried after the advertised ones. The relays stay the fallback whenever no
 * endpoint answers; while Orbot is on only `.onion` endpoints are dialled.
 */
@Composable
fun MachineDirectLink(machine: UniffiMachineSummary, dispatch: (UniffiIntent) -> Unit) {
    var editing by remember(machine.pubkeyHex) { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
        Text(
            directLinkStatusText(machine),
            color = if (machine.directUp != null) Tokens.Success else Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )
        if (machine.directAdvertised.isNotEmpty()) {
            EndpointList("The bridge offers:", machine.directAdvertised)
            if (!machine.directPinned && machine.directAdvertised.any { it.startsWith("wss://") }) {
                Text(
                    "No certificate pin came with them, so its wss:// endpoints are not used.",
                    color = Tokens.Warn,
                    fontSize = Tokens.TextXs,
                )
            }
        }
        if (editing) {
            DirectEndpointsEditor(machine, dispatch, onDone = { editing = false })
        } else {
            if (machine.directEndpoints.isNotEmpty()) {
                EndpointList("Added on this phone:", machine.directEndpoints)
            }
            TextButton(onClick = { editing = true }) {
                Text("Direct endpoints…")
            }
        }
    }
}

@Composable
private fun EndpointList(title: String, endpoints: List<String>) {
    Text(title, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
    endpoints.forEach {
        Text(it, color = Tokens.TextDim, fontSize = Tokens.TextXs, fontFamily = Tokens.FontMono)
    }
}

/** The user's own endpoints, one per line; Save is off while any is not allowed. */
@Composable
private fun DirectEndpointsEditor(machine: UniffiMachineSummary, dispatch: (UniffiIntent) -> Unit, onDone: () -> Unit) {
    var draft by remember(machine.pubkeyHex) { mutableStateOf(machine.directEndpoints.joinToString("\n")) }
    val lines = draft.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val invalid = lines.filterNot { isDirectEndpoint(it) }
    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        placeholder = { Text("wss://laptop.tailnet.ts.net:7447") },
        supportingText = {
            Text(
                if (invalid.isEmpty()) {
                    "One per line: wss://host:port, or ws://….onion:port. Tried after the bridge's own, " +
                        "with the certificate it pinned; while Orbot is on only .onion ones are used."
                } else {
                    "Not allowed: ${invalid.first()} — use wss://, or ws:// only to an .onion address."
                },
            )
        },
        isError = invalid.isNotEmpty(),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Button(
            onClick = {
                dispatch(UniffiIntent.SetDirectEndpoints(machine = machine.pubkeyHex, endpoints = lines))
                onDone()
            },
            enabled = invalid.isEmpty(),
        ) {
            Text("Save")
        }
        TextButton(onClick = onDone) {
            Text("Cancel")
        }
    }
}
