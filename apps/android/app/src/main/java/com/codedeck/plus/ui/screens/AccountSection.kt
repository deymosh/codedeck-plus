package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.codedeck.plus.platform.Login
import com.codedeck.plus.ui.theme.Tokens

/** The label of the app with `packageName`, or the package name itself. */
private fun appLabel(context: android.content.Context, packageName: String): String = runCatching {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
}.getOrDefault(packageName)

/**
 * Who this phone is logged in as, and logging out. Logging out deletes
 * everything the phone keeps for the identity (paired machines, transcripts,
 * settings) — and, for a key kept on this phone, the key itself, which is
 * why the confirmation says so plainly.
 */
@Composable
fun AccountSection(npub: String, login: Login?, onLogOut: () -> Unit) {
    val context = LocalContext.current
    var confirming by remember { mutableStateOf(false) }
    val signerLabel = (login as? Login.SignerApp)?.let { remember(it.packageName) { appLabel(context, it.packageName) } }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Text(
            if (signerLabel != null) "Key held by $signerLabel" else "Key stored on this phone",
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
        )
        Text(npub, color = Tokens.TextDim, fontSize = Tokens.TextXs, fontFamily = Tokens.FontMono)
        if (confirming) {
            Text(
                if (signerLabel != null) {
                    "Log out? Your key stays in $signerLabel. This phone forgets its paired machines, " +
                        "transcripts and settings; you can log back in and pair again."
                } else {
                    "Log out? This deletes the secret key from this phone. Without a copy of it you " +
                        "cannot log in as this identity again. Paired machines, transcripts and " +
                        "settings are deleted too."
                },
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                TextButton(onClick = onLogOut) {
                    Text("Log out", color = Tokens.Danger)
                }
                TextButton(onClick = { confirming = false }) {
                    Text("Cancel")
                }
            }
        } else {
            TextButton(onClick = { confirming = true }) {
                Text("Log out…", color = Tokens.Danger)
            }
        }
    }
}
