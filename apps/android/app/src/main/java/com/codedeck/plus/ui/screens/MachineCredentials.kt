package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
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
        true -> ", valid"
        false -> ", rejected"
        null -> ""
    }
    return base + validity
}

/**
 * Machine credentials — every secret the bridge declares, its own (e.g. a
 * GitHub token) and each agent's (e.g. an API key), grouped by owner, with
 * whether each is set; "Change credentials" opens them for editing. A field
 * left blank is not sent (keeps the
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

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Text(
            "Kept on the machine and handed to the sessions started there. They never come back to the phone.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )
        groups.forEach { group ->
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text(group.title, color = Tokens.Text, fontSize = Tokens.TextMd, fontWeight = FontWeight.SemiBold)
                group.credentials.forEach { cred ->
                    val dk = draftKey(group, cred.id)
                    if (open) {
                        Field(
                            value = drafts[dk].orEmpty(),
                            onValueChange = { drafts[dk] = it },
                            label = cred.label,
                            placeholder = if (cred.present) "Leave empty to keep it" else null,
                            supporting = credentialStatusText(cred),
                            isError = cred.valid == false,
                            visualTransformation = PasswordVisualTransformation(),
                        )
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                            Text(cred.label, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
                            Chip(
                                credentialStatusText(cred),
                                color = when {
                                    cred.valid == false -> Tokens.Danger
                                    cred.present || cred.fromEnv -> Tokens.Success
                                    else -> Tokens.TextDim
                                },
                            )
                        }
                    }
                    // Clearing deletes the stored secret on the bridge, so it
                    // asks first. A value from the bridge's environment
                    // cannot be cleared here.
                    if (open && cred.present && !cred.fromEnv) {
                        if (confirmClear == dk) {
                            Text("Delete ${cred.label} stored on the machine?", color = Tokens.Text, fontSize = Tokens.TextSm)
                            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                                SecondaryButton("Delete", danger = true, onClick = {
                                    send(group, listOf(UniffiCredentialWrite(cred.id, UniffiTristate.Clear)))
                                    confirmClear = null
                                })
                                QuietButton("Cancel", onClick = { confirmClear = null })
                            }
                        } else {
                            QuietButton("Delete ${cred.label}", danger = true, onClick = { confirmClear = dk })
                        }
                    }
                }
                if (open) {
                    PrimaryButton(
                        "Save ${group.title}",
                        onClick = { save(group) },
                        enabled = group.credentials.any { !drafts[draftKey(group, it.id)].isNullOrBlank() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        if (open) {
            QuietButton("Done", onClick = {
                open = false
                drafts.clear()
            })
        } else {
            SecondaryButton("Change credentials", onClick = { open = true })
        }
        val text = when {
            saving -> "Saving on the machine…"
            status == null -> null
            status.state == "saving" -> "Saving on the machine…"
            status.state == "saved" -> "Saved"
            status.state == "failed" -> "Saving failed: ${status.error ?: "unknown error"}"
            else -> null
        }
        if (text != null) {
            Text(text, color = if (status?.state == "failed" && !saving) Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}
