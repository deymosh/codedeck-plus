package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.RowSpinner
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiAgent

/** Sessions start only on an agent that is installed. */
internal val UniffiAgent.ready: Boolean get() = installState == "ready"

/** A state a newer bridge reports and this app does not know: nothing to
 *  offer for it but an update. */
private val UniffiAgent.stateUnknown: Boolean get() = installState == "unknown"

/** The agent's name in a picker, with why it cannot run a session yet. */
internal fun agentPickerLabel(agent: UniffiAgent): String = when (agent.installState) {
    "ready" -> agent.displayName
    "installing" -> "${agent.displayName} (installing)"
    "failed" -> "${agent.displayName} (install failed)"
    "unknown" -> "${agent.displayName} (update the app)"
    else -> "${agent.displayName} (not installed)"
}

/** Where the agent stands on the machine, and whether that is a failure. */
private fun installLine(agent: UniffiAgent): Pair<String, Boolean> {
    agent.actionFailure?.let { return it to true }
    return when {
        agent.actionBusy == "remove" -> "Removing…" to false
        agent.actionBusy == "install" || agent.installState == "installing" -> "Installing…" to false
        agent.installState == "failed" -> "Install failed: ${agent.installError.orEmpty()}" to true
        agent.installState == "not_installed" -> "Not installed" to false
        agent.stateUnknown -> "Update the app to see where it stands" to false
        agent.removable -> "Installed by CodeDeck" to false
        else -> "On the machine" to false
    }
}

/**
 * One agent and where it stands on its machine, with what can be done
 * about it: Install while it is missing (Retry once an install failed), a
 * spinner while the bridge works, and Remove for one CodeDeck installed when
 * [onRemove] is given. An agent the machine has of its own has no action.
 */
@Composable
internal fun AgentInstallRow(agent: UniffiAgent, onInstall: () -> Unit, onRemove: (() -> Unit)?) {
    val (line, failed) = installLine(agent)
    val working = agent.actionBusy != null || agent.installState == "installing"
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = Tokens.Space4, end = Tokens.Space3, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(agent.displayName, color = Tokens.Text, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(line, color = if (failed) Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        when {
            working -> RowSpinner()
            !agent.ready && !agent.stateUnknown -> SecondaryButton(if (agent.installState == "failed") "Retry" else "Install", onClick = onInstall)
            agent.removable && onRemove != null -> QuietButton("Remove", onClick = onRemove, danger = true)
        }
    }
}
