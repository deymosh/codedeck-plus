package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.session.formatSize
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiSettingsView

/**
 * A Blossom server address the phone will upload to: https with a host, or
 * http to an onion service (Tor encrypts the whole path to one).
 */
internal fun isBlossomUrl(url: String): Boolean {
    val trimmed = url.trim()
    if (trimmed.any { it.isWhitespace() }) return false
    val host = blossomHost(trimmed).substringBefore(':').lowercase()
    return when {
        trimmed.startsWith("https://") -> host.isNotEmpty()
        trimmed.startsWith("http://") -> host.endsWith(".onion") && host.removeSuffix(".onion").let { it.isNotEmpty() && !it.endsWith('.') }
        else -> false
    }
}

/** The host of a server address, for saying where uploads go. */
internal fun blossomHost(url: String): String =
    url.trim().removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore('?').substringBefore('#')

/**
 * Where the files attached to sessions go: the user's Blossom server, or —
 * with none set — the relays, in chunks, which caps their size. The page
 * says which is in force before anything else.
 */
@Composable
internal fun UploadsPage(view: UniffiSettingsView, dispatch: (UniffiIntent) -> Unit, onBack: () -> Unit) {
    val current = view.blossomServer.trim()
    var draft by remember(current) { mutableStateOf(current) }
    val valid = isBlossomUrl(draft)
    Page(title = "Uploads", onBack = onBack) {
        Group(
            title = "Blossom server",
            footer = "Files are encrypted on this phone before they leave it: the server only ever holds ciphertext, and " +
                "the key travels inside your encrypted message to the machine. The server does see your account " +
                "sign each upload.",
        ) {
            GroupBody {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Dot(if (current.isNotEmpty()) Tokens.Success else Tokens.TextDim)
                    Text(
                        if (current.isNotEmpty()) {
                            "Uploading to ${blossomHost(current)}, files up to ${formatSize(view.maxUploadBytes.toLong())}"
                        } else {
                            "No server: files go through your relays, up to ${formatSize(view.maxUploadBytes.toLong())} each"
                        },
                        color = Tokens.Text,
                        fontSize = Tokens.TextMd,
                    )
                }
                Field(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = "https://blossom.example.com",
                    mono = true,
                    isError = draft.isNotBlank() && !valid,
                    supporting = if (draft.isNotBlank() && !valid) "Use an https:// address, or http:// for a .onion." else null,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    SecondaryButton(
                        "Save",
                        onClick = { dispatch(UniffiIntent.SetBlossomServer(draft.trim())) },
                        enabled = valid && draft.trim() != current,
                    )
                    if (current.isNotEmpty()) {
                        QuietButton("Remove server", danger = true, onClick = { dispatch(UniffiIntent.SetBlossomServer("")) })
                    }
                }
            }
        }
    }
}
