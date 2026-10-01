package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.ui.components.ActionRow
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiBackupStatus
import uniffi.client_ffi.UniffiBackupView
import uniffi.client_ffi.UniffiIntent
import java.text.DateFormat
import java.util.Date

/** What the backup holds, said once for the settings page and the restore step. */
private const val BACKUP_HOLDS =
    "Your paired machines, settings, quick prompts and this phone's session keys, encrypted to your key: only you can read it."

/** A relay address the backup may use: `wss://` with a host, `ws://` only to an onion service. */
internal fun isBackupRelay(url: String): Boolean {
    val trimmed = url.trim()
    if (trimmed.any { it.isWhitespace() }) return false
    val host = trimmed.substringAfter("://").substringBefore('/').substringBefore(':').lowercase()
    return when {
        trimmed.startsWith("wss://") -> host.isNotEmpty()
        trimmed.startsWith("ws://") -> host.endsWith(".onion") && host.length > ".onion".length
        else -> false
    }
}

/** A relay's host, for saying where the backup is. */
internal fun relayHost(url: String): String = url.trim().substringAfter("://").substringBefore('/')

/** When something happened, as a person says it: "just now", "5 min ago", "3 h ago", or the date. */
internal fun whenSaved(at: Long, now: Long): String {
    val minutes = (now - at) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        minutes < 24 * 60 -> "${minutes / 60} h ago"
        else -> "on " + DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(at))
    }
}

private fun machinesText(n: UInt): String = when (n) {
    0u -> "no machines"
    1u -> "1 machine"
    else -> "$n machines"
}

/**
 * The config backup: off, it asks for a relay; on, it says when it last
 * saved and offers a save now and turning it off. A backup found on the
 * relay waits for a choice before anything is saved over it.
 */
@Composable
internal fun BackupPage(
    backup: UniffiBackupView,
    torOn: Boolean,
    now: Long,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
) {
    Page(title = "Backup", onBack = onBack) {
        val relay = backup.relay
        if (relay == null) {
            BackupOff(backup.status, torOn, dispatch)
        } else {
            BackupOn(relay, backup, now, dispatch)
        }
    }
}

@Composable
private fun BackupOff(status: UniffiBackupStatus, torOn: Boolean, dispatch: (UniffiIntent) -> Unit) {
    var draft by rememberSaveable { mutableStateOf("") }
    val valid = isBackupRelay(draft)
    Group(
        title = "Back up to a relay",
        footer = "$BACKUP_HOLDS A new phone logged in as you restores it from the same relay. The relay only sees that " +
            "you saved something, and when." + if (torOn) " It goes through Orbot, like your other relays." else "",
    ) {
        GroupBody {
            Field(
                value = draft,
                onValueChange = { draft = it },
                placeholder = "wss://relay.example.com",
                mono = true,
                isError = draft.isNotBlank() && !valid,
                supporting = when {
                    draft.isNotBlank() && !valid -> "Use a wss:// address, or ws:// for a .onion."
                    status is UniffiBackupStatus.Failed -> status.reason
                    else -> null
                },
            )
            SecondaryButton("Turn on backup", onClick = { dispatch(UniffiIntent.SetBackupRelay(draft.trim())) }, enabled = valid)
        }
    }
}

@Composable
private fun BackupOn(relay: String, backup: UniffiBackupView, now: Long, dispatch: (UniffiIntent) -> Unit) {
    val status = backup.status
    if (status is UniffiBackupStatus.Found) {
        FoundBackup(status, relay, now, dispatch)
        return
    }
    var turningOff by remember { mutableStateOf(false) }
    Group(footer = "$BACKUP_HOLDS It saves itself a little after each change.") {
        GroupBody { BackupStatusLine(status, backup.savedAt?.toLong(), now) }
        ValueRow("Relay", subtitle = relay, mono = true) {}
        GroupBody {
            SecondaryButton(
                "Back up now",
                onClick = { dispatch(UniffiIntent.BackupNow) },
                enabled = status !is UniffiBackupStatus.Saving && status !is UniffiBackupStatus.Checking,
            )
        }
    }
    Group {
        if (turningOff) {
            GroupBody {
                Text(
                    "Turn off backup? This phone stops saving to ${relayHost(relay)}. You can also ask the relay to delete " +
                        "what is there; relays usually do, but none has to.",
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                )
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SecondaryButton("Turn off and delete it", danger = true, onClick = {
                        turningOff = false
                        dispatch(UniffiIntent.DisableBackup(delete = true))
                    })
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        SecondaryButton("Turn off, keep it", onClick = {
                            turningOff = false
                            dispatch(UniffiIntent.DisableBackup(delete = false))
                        })
                        QuietButton("Cancel", onClick = { turningOff = false })
                    }
                }
            }
        } else {
            ActionRow("Turn off backup", onClick = { turningOff = true }, danger = true)
        }
    }
}

/** One line of what the backup is doing, with a dot or a spinner. */
@Composable
private fun BackupStatusLine(status: UniffiBackupStatus, savedAt: Long?, now: Long) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        val busy = status is UniffiBackupStatus.Checking || status is UniffiBackupStatus.Saving || status is UniffiBackupStatus.Importing
        if (busy) {
            CircularProgressIndicator(Modifier.size(12.dp), color = Tokens.TextMuted, strokeWidth = 1.5.dp)
        } else {
            Dot(
                when {
                    status is UniffiBackupStatus.Failed -> Tokens.Danger
                    savedAt != null -> Tokens.Success
                    else -> Tokens.TextDim
                },
            )
        }
        Text(
            when (status) {
                UniffiBackupStatus.Checking -> "Looking for a backup…"
                UniffiBackupStatus.Saving -> "Backing up…"
                UniffiBackupStatus.Importing -> "Restoring…"
                is UniffiBackupStatus.Failed -> "Not backed up"
                else -> if (savedAt != null) "Backed up ${whenSaved(savedAt, now)}" else "Not backed up yet"
            },
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
        )
    }
    if (status is UniffiBackupStatus.Failed) ErrorNote(status.reason)
}

/** A backup is on the relay already: restore it, or let this phone's replace it. */
@Composable
private fun FoundBackup(found: UniffiBackupStatus.Found, relay: String, now: Long, dispatch: (UniffiIntent) -> Unit) {
    var replacing by remember { mutableStateOf(false) }
    Group(
        title = "A backup is already there",
        footer = "Restoring adds the machines this phone does not have and takes the backup's settings and quick " +
            "prompts. Nothing is saved to the relay until you choose.",
    ) {
        GroupBody {
            FoundSummary(found, relay, now)
            if (replacing) {
                Text(
                    "Replace it with this phone's setup? What the backup holds and this phone lacks is lost.",
                    color = Tokens.Danger,
                    fontSize = Tokens.TextSm,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SecondaryButton("Replace it", danger = true, onClick = { dispatch(UniffiIntent.KeepLocalConfig) })
                    QuietButton("Cancel", onClick = { replacing = false })
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                    PrimaryButton("Restore", onClick = { dispatch(UniffiIntent.ImportBackup) })
                    QuietButton("Keep this phone's", onClick = { replacing = true })
                }
            }
        }
    }
}

/** The found backup's date and size, the thing the choice is about. */
@Composable
private fun FoundSummary(found: UniffiBackupStatus.Found, relay: String, now: Long) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Icon(Icons.Outlined.CloudSync, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(28.dp))
        Column {
            Text(
                "Saved ${whenSaved(found.savedAt.toLong(), now)}",
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.Medium,
            )
            Text("${machinesText(found.machines)}, on ${relayHost(relay)}", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}

/**
 * Right after logging in: restore a backup made on another phone, or skip.
 * Shown once, before the app proper; [onDone] leaves for the app.
 */
@Composable
internal fun RestoreContent(
    backup: UniffiBackupView,
    torOn: Boolean,
    dispatch: (UniffiIntent) -> Unit,
    onDone: () -> Unit,
    now: Long = System.currentTimeMillis(),
) {
    var draft by rememberSaveable { mutableStateOf("") }
    // Set once Restore is tapped, so the idle state after it reads as done
    // rather than as "nothing was there".
    var restoring by rememberSaveable { mutableStateOf(false) }
    val status = backup.status
    val relay = backup.relay
    val skip = {
        if (relay != null) dispatch(UniffiIntent.DisableBackup(delete = false))
        onDone()
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(Tokens.Bg), contentAlignment = Alignment.TopCenter) {
        val viewport = maxHeight
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .heightIn(min = viewport)
                .padding(horizontal = Tokens.Space5, vertical = Tokens.Space6),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space5, Alignment.CenterVertically),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text("Restore your setup?", color = Tokens.Text, fontSize = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp)
                Text(
                    "If you backed up another phone, enter the relay it saved to: its machines, settings and quick " +
                        "prompts come back here. The backup is encrypted to your key, so only you can read it.",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextMd,
                    lineHeight = 20.sp,
                )
            }
            when {
                status is UniffiBackupStatus.Found && relay != null -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
                    FoundSummary(status, relay, now)
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                        PrimaryButton("Restore", onClick = {
                            restoring = true
                            dispatch(UniffiIntent.ImportBackup)
                        })
                        QuietButton("Skip", onClick = skip)
                    }
                }
                status is UniffiBackupStatus.Checking || status is UniffiBackupStatus.Importing || status is UniffiBackupStatus.Saving ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = Tokens.TextMuted, strokeWidth = 2.dp)
                        Text(
                            if (status is UniffiBackupStatus.Checking) "Looking on ${relayHost(relay.orEmpty())}…" else "Restoring…",
                            color = Tokens.Text,
                            fontSize = Tokens.TextMd,
                        )
                    }
                relay != null && status !is UniffiBackupStatus.Failed -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
                    Text(
                        if (restoring) {
                            "Restored. Your machines reconnect as each one is heard from. Backup stays on, so this phone saves its changes there too."
                        } else {
                            "No backup on ${relayHost(relay)} yet. Backup is on, so this phone saves its setup there from now on."
                        },
                        color = Tokens.Text,
                        fontSize = Tokens.TextMd,
                        lineHeight = 20.sp,
                    )
                    PrimaryButton("Continue", onClick = onDone)
                }
                else -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                    val valid = isBackupRelay(draft)
                    Field(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = "wss://relay.example.com",
                        mono = true,
                        isError = draft.isNotBlank() && !valid,
                        supporting = if (draft.isNotBlank() && !valid) "Use a wss:// address, or ws:// for a .onion." else null,
                    )
                    if (status is UniffiBackupStatus.Failed) ErrorNote(status.reason)
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                        PrimaryButton("Look for a backup", onClick = { dispatch(UniffiIntent.SetBackupRelay(draft.trim())) }, enabled = valid)
                        QuietButton("Skip", onClick = skip)
                    }
                    if (torOn) Text("Goes through Orbot.", color = Tokens.TextDim, fontSize = Tokens.TextXs)
                }
            }
        }
    }
}
