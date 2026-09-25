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
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiCredentialStatus
import uniffi.client_ffi.UniffiCredentialWrite
import uniffi.client_ffi.UniffiCredentialsAck
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiTristate

/** One set of credentials the bridge stores: its own (`agent == null`) or one agent's. */
private data class CredentialGroup(val agent: String?, val title: String, val credentials: List<UniffiCredentialStatus>)

/** A one-line status for a stored credential, from what the bridge reports. */
internal fun credentialStatusText(status: UniffiCredentialStatus): String {
    val base = when {
        status.fromEnv -> "set in the bridge environment"
        status.present -> "set"
        else -> "not set"
    }
    val validity = when (status.valid) {
        true -> " (valid)"
        false -> " (INVALID)"
        null -> ""
    }
    return base + validity
}

/**
 * Machine credentials — an inline collapsible block listing every secret the
 * bridge declares: its own (e.g. a GitHub token) and each agent's (e.g. an
 * API key), grouped by owner. A field left blank is not sent (keeps the
 * stored value), a filled field overwrites, and Clear sends
 * [UniffiTristate.Clear] after a confirmation. All fields are password inputs
 * and a group's drafts are wiped immediately after send — values are never
 * logged, and the bridge never echoes them back (only presence/validity).
 *
 * `saving` is a local optimistic marker cleared once [status] next changes;
 * the real ack arrives through the next `UiView` refresh.
 */
@Composable
fun MachineCredentials(machine: UniffiMachineSummary, status: UniffiCredentialsAck?, dispatch: (UniffiIntent) -> Unit) {
    val groups = buildList {
        if (machine.credentials.isNotEmpty()) add(CredentialGroup(null, "Bridge", machine.credentials))
        machine.agents.filter { it.credentials.isNotEmpty() }.forEach {
            add(CredentialGroup(it.id, it.displayName, it.credentials))
        }
    }
    if (groups.isEmpty()) return

    val key = machine.pubkeyHex
    var open by remember(key) { mutableStateOf(false) }
    /** Drafts keyed by "<agent or empty>/<credential id>". */
    val drafts = remember(key) { mutableStateMapOf<String, String>() }
    var saving by remember(key) { mutableStateOf(false) }
    /** The draft key of a credential whose clear awaits confirmation. */
    var confirmClear by remember(key) { mutableStateOf<String?>(null) }

    LaunchedEffect(status) { if (status != null) saving = false }

    if (!open) {
        Button(onClick = { open = true }) {
            Text("Machine credentials…")
        }
        return
    }

    fun draftKey(group: CredentialGroup, id: String) = "${group.agent.orEmpty()}/$id"

    fun send(group: CredentialGroup, values: List<UniffiCredentialWrite>) {
        if (values.isEmpty()) return
        saving = true
        dispatch(UniffiIntent.SetCredentials(machine = key, agent = group.agent, values = values))
    }

    fun save(group: CredentialGroup) {
        val values = group.credentials.mapNotNull { cred ->
            drafts[draftKey(group, cred.id)]?.trim()?.takeIf { it.isNotEmpty() }
                ?.let { UniffiCredentialWrite(cred.id, UniffiTristate.Set(it)) }
        }
        send(group, values)
        group.credentials.forEach { drafts.remove(draftKey(group, it.id)) }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Text("Machine credentials", color = Tokens.Text, fontSize = Tokens.TextSm)
        Text(
            "Stored on the bridge host and fed into the sessions started there. " +
                "Leave a field empty to keep the current value.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )
        groups.forEach { group ->
            Text(group.title, color = Tokens.Text, fontSize = Tokens.TextSm)
            group.credentials.forEach { cred ->
                val dk = draftKey(group, cred.id)
                OutlinedTextField(
                    value = drafts[dk].orEmpty(),
                    onValueChange = { drafts[dk] = it },
                    placeholder = { Text(cred.label) },
                    supportingText = { Text(credentialStatusText(cred)) },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                // Clearing deletes the stored secret on the bridge, so it asks
                // first, like removing a machine or a provider does. A value
                // coming from the bridge's environment cannot be cleared here.
                if (cred.present && !cred.fromEnv) {
                    if (confirmClear == dk) {
                        Text("Delete ${cred.label} stored on the bridge?", color = Tokens.Text, fontSize = Tokens.TextSm)
                        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                            TextButton(onClick = {
                                send(group, listOf(UniffiCredentialWrite(cred.id, UniffiTristate.Clear)))
                                confirmClear = null
                            }) {
                                Text("Delete", color = Tokens.Danger)
                            }
                            TextButton(onClick = { confirmClear = null }) {
                                Text("Cancel")
                            }
                        }
                    } else {
                        TextButton(onClick = { confirmClear = dk }) {
                            Text("Clear ${cred.label}", color = Tokens.Danger)
                        }
                    }
                }
            }
            Button(
                onClick = { save(group) },
                enabled = group.credentials.any { !drafts[draftKey(group, it.id)].isNullOrBlank() },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Save ${group.title} credentials")
            }
        }
        TextButton(onClick = { open = false }) {
            Text("Close")
        }
        val text = when {
            saving -> "Saving on the bridge…"
            status == null -> null
            status.state == "saving" -> "Saving on the bridge…"
            status.state == "saved" -> "Saved"
            status.state == "failed" -> "Saving failed: ${status.error ?: "unknown error"}"
            else -> null
        }
        if (text != null) {
            Text(text, color = if (status?.state == "failed" && !saving) Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}
