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
import com.codedeck.plus.ui.components.Toggle
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
    "Your paired machines and quick prompts, encrypted to your key: only you can read it."

/** How the devices that share it keep in step. */
private const val BACKUP_SHARED = "Your devices backing up here keep in step; each keeps its own settings."

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

/** What the backup on the relay holds, at a glance: when it was saved and
 *  how many machines are in it. */
@Composable
private fun BackupSummary(backup: UniffiBackupView, relay: String, now: Long) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Icon(Icons.Outlined.CloudSync, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(28.dp))
        Column {
            Text(
                backup.savedAt?.let { "Saved ${whenSaved(it.toLong(), now)}" } ?: "Backup is on",
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.Medium,
            )
            val held = backup.machines?.let { "${machinesText(it)}, on " }.orEmpty()
            Text("$held${relayHost(relay)}", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}

/**
 * The config backup: off, it asks for a relay; on, it says when it last
 * saved and offers a save now and turning it off. Turning it on merges what
 * the identity's other devices saved there with this one's.
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
        footer = "$BACKUP_HOLDS $BACKUP_SHARED The relay only sees that you saved something, and when." +
            if (torOn) " It goes through Orbot, like your other relays." else "",
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
    var turningOff by remember { mutableStateOf(false) }
    Group(footer = "$BACKUP_HOLDS $BACKUP_SHARED It saves itself a little after each change.") {
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
                    "Turn off backup? This phone stops keeping in step with ${relayHost(relay)}; your other devices go on. " +
                        "You can also ask the relay to delete the backup, for every device; relays usually do, but none has to.",
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                )
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SecondaryButton("Turn off and delete it everywhere", danger = true, onClick = {
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
        val busy = status is UniffiBackupStatus.Checking || status is UniffiBackupStatus.Saving
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
                UniffiBackupStatus.Checking -> "Checking the backup…"
                UniffiBackupStatus.Saving -> "Backing up…"
                is UniffiBackupStatus.Failed -> "Not backed up"
                else -> if (savedAt != null) "Backed up ${whenSaved(savedAt, now)}" else "Not backed up yet"
            },
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
        )
    }
    if (status is UniffiBackupStatus.Failed) ErrorNote(status.reason)
}

/**
 * Right after logging in: join the backup another device keeps, or skip.
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
                    "Enter the relay your other device backs up to: its machines and quick prompts come here, and " +
                        "your devices keep in step. Only you can read it.",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextMd,
                    lineHeight = 20.sp,
                )
            }
            when {
                relay != null && (status is UniffiBackupStatus.Checking || status is UniffiBackupStatus.Saving) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = Tokens.TextMuted, strokeWidth = 2.dp)
                        Text("Looking on ${relayHost(relay)}…", color = Tokens.Text, fontSize = Tokens.TextMd)
                    }
                relay != null && status !is UniffiBackupStatus.Failed -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
                    BackupSummary(backup, relay, now)
                    PrimaryButton("Continue", onClick = onDone)
                }
                else -> Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                    val valid = isBackupRelay(draft)
                    // A .onion relay is reachable only through Orbot.
                    val onionWithoutTor = valid && !torOn && relayHost(draft).substringBefore(':').endsWith(".onion")
                    Field(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = "wss://relay.example.com",
                        mono = true,
                        isError = draft.isNotBlank() && !valid,
                        supporting = when {
                            draft.isNotBlank() && !valid -> "Use a wss:// address, or ws:// for a .onion."
                            onionWithoutTor -> "A .onion relay is reached through Orbot: turn it on below."
                            else -> null
                        },
                    )
                    OrbotSwitch(torOn) { dispatch(UniffiIntent.SetTorEnabled(it)) }
                    if (status is UniffiBackupStatus.Failed) ErrorNote(status.reason)
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2), verticalAlignment = Alignment.CenterVertically) {
                        PrimaryButton("Look for a backup", onClick = { dispatch(UniffiIntent.SetBackupRelay(draft.trim())) }, enabled = valid)
                        QuietButton("Skip", onClick = skip)
                    }
                }
            }
        }
    }
}

/** Orbot on or off, right where the relay is entered: a backup kept on a
 *  .onion relay can only be reached through it, and the user may not have
 *  set it up yet on a new phone. The same setting as Connection's. */
@Composable
private fun OrbotSwitch(on: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Route through Orbot", color = Tokens.Text, fontSize = Tokens.TextMd)
            Text(
                "For a .onion relay, or to keep the relay from seeing this phone's address. Orbot must be running.",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
            )
        }
        Toggle(on, onChange)
    }
}
