package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.Note
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.RowSpinner
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary

/**
 * The permissions an agent keeps from "Always allow" answers on a machine:
 * one group per project, each rule the tool and the pattern a call must
 * match. Removing one makes the agent ask again; it asks for nothing else,
 * so there is no confirmation. Pure — the caller supplies the machine and a
 * dispatcher — so it renders the same in a snapshot.
 */
@Composable
fun PermissionRulesContent(machine: UniffiMachineSummary, agentId: String, dispatch: (UniffiIntent) -> Unit, onBack: () -> Unit) {
    val agentName = machine.agents.firstOrNull { it.id == agentId }?.displayName ?: agentId
    val held = machine.permissionRules.firstOrNull { it.agent == agentId }
    LaunchedEffect(machine.pubkeyHex, agentId) { dispatch(UniffiIntent.RequestPermissionRules(machine.pubkeyHex, agentId)) }

    Page(title = "$agentName permissions", subtitle = machineLabel(machine.name), onBack = onBack) {
        if (held?.error != null && held.rules.isNotEmpty()) ErrorNote(held.error!!)
        when {
            held == null -> Note("Asking the machine…")
            held.error != null && held.rules.isEmpty() -> ErrorNote(held.error!!)
            held.rules.isEmpty() -> Group {
                GroupBody {
                    Text("Nothing always allowed", color = Tokens.Text, fontSize = Tokens.TextLg)
                    Text(
                        "Answer a permission card with \"Always allow\" and $agentName stops asking for calls like it in that project. " +
                            "Each one shows here, to remove when you want to be asked again.",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                    )
                }
            }
            else -> {
                held.rules.groupBy { it.project }.forEach { (project, rules) ->
                    Group(title = project) {
                        rules.forEachIndexed { i, rule ->
                            if (i > 0) GroupScope.Divider()
                            ValueRow(rule.tool, subtitle = rule.pattern, mono = true) {
                                if (rule.id in held.busy) {
                                    RowSpinner()
                                } else {
                                    QuietButton("Remove", onClick = {
                                        dispatch(UniffiIntent.RemovePermissionRules(machine.pubkeyHex, agentId, listOf(rule.id)))
                                    }, danger = true)
                                }
                            }
                        }
                    }
                }
                Text(
                    "Every session of $agentName in that project runs a call matching one of these without asking — " +
                        "even in Ask mode. Remove one to be asked again.",
                    color = Tokens.TextDim,
                    fontSize = Tokens.TextXs,
                    modifier = Modifier.padding(horizontal = Tokens.Space2),
                )
            }
        }
    }
}

/** [PermissionRulesContent] for [agentId] on the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun PermissionRulesScreen(core: CoreHost, pubkey: String, agentId: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    PermissionRulesContent(machine, agentId, dispatch = { intent -> scope.launch { core.dispatch(intent) } }, onBack = onBack)
}
