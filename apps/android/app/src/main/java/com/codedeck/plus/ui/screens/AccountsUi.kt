package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.sp
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.NavRow
import com.codedeck.plus.ui.components.Note
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.RowSpinner
import com.codedeck.plus.ui.components.Segmented
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiAccountAction
import uniffi.client_ffi.UniffiAccountConnection
import uniffi.client_ffi.UniffiAccountField
import uniffi.client_ffi.UniffiAccountMethod
import uniffi.client_ffi.UniffiAgentAccount
import uniffi.client_ffi.UniffiAgentAccounts
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiSignIn

/** Where the accounts flow of a providers page is: choosing a provider, or
 *  connecting the one with this id. */
sealed interface AccountsStep {
    data object Picker : AccountsStep
    data class Connect(val account: String) : AccountsStep
}

/** The code a device sign-in's instructions name ("Enter code: WFZW-JRCC"),
 *  shown large so it can be read across to another device. */
internal fun signInCode(instructions: String): String? =
    Regex("""code:?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)""", RegexOption.IGNORE_CASE).find(instructions)?.groupValues?.get(1)

/** Whether [field] is asked, given the answers so far. */
internal fun fieldAsked(field: UniffiAccountField, answers: Map<String, String>): Boolean =
    field.`when`.all { c -> (answers[c.key] ?: "") == c.value != c.not }

/** How a connection reads under its provider's name. */
private fun connectionLine(c: UniffiAccountConnection): String = when (c.kind) {
    "env" -> "From the machine's environment"
    "sign-in" -> "Signed in · ${c.label}"
    else -> "Key · ${c.label}"
}

/** A method's name on a segmented switch. */
private fun methodName(m: UniffiAccountMethod): String = when (m.kind) {
    "key" -> "API key"
    else -> m.label ?: "Sign in"
}

/**
 * The providers an agent is connected to on the machine: one row per key,
 * sign-in or variable of the environment, each removable from here except
 * the environment's. Where a provider has several, the one in use is marked
 * and another can be made the one.
 */
@Composable
internal fun ConnectedAccounts(
    held: UniffiAgentAccounts?,
    agentName: String,
    act: (account: String, UniffiAccountAction) -> Unit,
) {
    when {
        held == null -> Note("Asking the machine…")
        held.connected.isEmpty() && held.error != null -> ErrorNote(held.error!!)
        held.connected.isEmpty() -> Unit
        else -> {
            held.error?.let { ErrorNote(it) }
            Group(
                title = "Connected",
                footer = "Keys and sign-ins kept on the machine. $agentName uses them at once — no restart, no session cut.",
            ) {
                var first = true
                held.connected.forEach { account ->
                    val busy = account.id in held.busy
                    val several = account.connections.size > 1
                    account.connections.forEach { c ->
                        if (!first) GroupScope.Divider()
                        first = false
                        ValueRow(account.name, subtitle = connectionLine(c) + if (several && c.active) " · in use" else "") {
                            when {
                                busy -> RowSpinner()
                                several && !c.active && c.kind != "env" ->
                                    QuietButton("Use", onClick = { act(account.id, UniffiAccountAction.Activate(c.id)) })
                                c.removable ->
                                    QuietButton("Remove", onClick = { act(account.id, UniffiAccountAction.Remove(c.id)) }, danger = true)
                                else -> Unit
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Every provider the agent can connect, to search and pick from, with a
 * custom endpoint first — the agent's own catalogue does not have a gateway
 * of the user's.
 */
@Composable
internal fun AccountPickerPage(
    machine: UniffiMachineSummary,
    agentId: String,
    agentName: String,
    held: UniffiAgentAccounts?,
    dispatch: (UniffiIntent) -> Unit,
    onCustom: () -> Unit,
    onPick: (String) -> Unit,
    onBack: () -> Unit,
    query: String = "",
) {
    var search by remember { mutableStateOf(query) }
    LaunchedEffect(machine.pubkeyHex, agentId) { dispatch(UniffiIntent.RequestAccounts(machine.pubkeyHex, agentId, all = true)) }
    val all = held?.all
    Page(title = "Connect a provider", subtitle = "$agentName on ${machineLabel(machine.name)}", onBack = onBack, backLabel = "Cancel") {
        Field(search, { search = it }, placeholder = "Search providers")
        if (search.isBlank()) {
            Group {
                NavRow("Custom endpoint", onClick = onCustom, subtitle = "An OpenAI-compatible API, or a gateway of your own")
            }
        }
        when {
            all == null && held?.error != null -> ErrorNote(held.error!!)
            all == null -> Note("Asking the machine…")
            else -> {
                val q = search.trim().lowercase()
                val shown = all.filter { q.isEmpty() || it.name.lowercase().contains(q) || it.id.contains(q) }
                    .filter { it.methods.isNotEmpty() }
                if (shown.isEmpty()) {
                    Note("No provider called \"${search.trim()}\".")
                } else {
                    Group(title = if (q.isEmpty()) "Providers $agentName knows" else null) {
                        shown.forEachIndexed { i, account ->
                            if (i > 0) GroupScope.Divider()
                            NavRow(
                                account.name,
                                onClick = { onPick(account.id) },
                                subtitle = account.methods.map { if (it.kind == "key") "Key" else "Sign in" }.distinct().joinToString(" · "),
                                value = if (account.connections.isNotEmpty()) "Connected" else null,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Connecting one provider: its methods side by side (an API key, a sign-in
 * to a subscription), the method's questions — each asked only when the
 * answers so far call for it — and the key, which goes to the machine and
 * never comes back.
 */
@Composable
internal fun AccountConnectPage(
    machine: UniffiMachineSummary,
    account: UniffiAgentAccount,
    agentName: String,
    onConnect: (UniffiAccountAction) -> Unit,
    onBack: () -> Unit,
) {
    val methods = account.methods
    var chosen by remember(account.id) { mutableIntStateOf(methods.indexOfFirst { it.kind == "sign-in" }.takeIf { it >= 0 } ?: 0) }
    val method = methods.getOrNull(chosen)
    val answers = remember(account.id, chosen) { mutableStateMapOf<String, String>() }
    var key by remember(account.id) { mutableStateOf("") }
    // A default is an answer until another is given.
    val effective = method?.fields.orEmpty().associate { it.key to (answers[it.key] ?: it.defaultValue.orEmpty()) }
    val asked = method?.fields.orEmpty().filter { fieldAsked(it, effective) }
    val answered = asked.all { f -> !f.required || effective[f.key].orEmpty().isNotBlank() }
    val canConnect = method != null && answered && (method.kind != "key" || key.isNotBlank())

    fun connect() {
        val m = method ?: return
        // Only what is asked goes: an answer to a field the form no longer
        // asks would be taken as a choice.
        val given = asked.mapNotNull { f -> effective[f.key]?.takeIf { it.isNotBlank() }?.let { f.key to it } }.toMap()
        onConnect(
            if (m.kind == "key") UniffiAccountAction.Key(m.id, key.trim(), null, given)
            else UniffiAccountAction.SignIn(m.id, null, given),
        )
    }

    Page(
        title = account.name,
        subtitle = "$agentName on ${machineLabel(machine.name)}",
        onBack = onBack,
        bottomBar = {
            PrimaryButton(if (method?.kind == "key") "Save key" else "Sign in", onClick = ::connect, enabled = canConnect, modifier = Modifier.fillMaxWidth())
        },
    ) {
        if (methods.size > 1) {
            Segmented(methods.map(::methodName), selected = chosen, onSelect = { chosen = it }, track = Tokens.SurfaceInput)
        }
        if (method == null) {
            Note("$agentName cannot connect ${account.name} from a phone.")
            return@Page
        }
        if (asked.isNotEmpty() || method.kind == "key") {
            Group {
                GroupBody {
                    asked.forEach { f -> AccountFieldInput(f, answers[f.key] ?: f.defaultValue.orEmpty()) { answers[f.key] = it } }
                    if (method.kind == "key") {
                        Field(
                            key,
                            { key = it },
                            label = "API key",
                            mono = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        )
                    }
                }
            }
        }
        Text(
            if (method.kind == "key") {
                "The key is kept on the machine, for ${account.name}'s models in $agentName. This phone does not keep it."
            } else {
                "You sign in in your browser, on this phone or any other device. The sign-in is kept on the machine."
            },
            color = Tokens.TextDim,
            fontSize = Tokens.TextXs,
            modifier = Modifier.padding(horizontal = Tokens.Space2),
        )
    }
}

/** One question of a method: a choice when it has options, text otherwise. */
@Composable
private fun AccountFieldInput(f: UniffiAccountField, value: String, onChange: (String) -> Unit) {
    if (f.options.isNotEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            Text(f.title, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
            SelectField(f.options.map { PickerOption(it.id, it.label) }, selected = value, placeholder = "Choose", onSelect = onChange)
        }
    } else {
        Field(value, onChange, label = f.title, placeholder = f.placeholder, supporting = f.description, mono = true)
    }
}

/**
 * A sign-in under way: the code to enter, large and selectable, the button
 * that opens the provider's page, and — for a provider that sends the
 * browser back to the machine — where to paste the address the browser
 * fails to open. It stays until the machine says how it went.
 */
@Composable
internal fun SignInPage(
    accountName: String,
    signIn: UniffiSignIn,
    onFinish: (String) -> Unit,
    onCancel: () -> Unit,
    onDone: () -> Unit,
    onRetry: () -> Unit,
    pasted: String = "",
) {
    val uri = LocalUriHandler.current
    var address by remember(signIn.attemptId) { mutableStateOf(pasted) }
    val waiting = signIn.status == "started"
    Page(
        title = "Sign in to $accountName",
        onBack = if (waiting) onCancel else onDone,
        backLabel = if (waiting) "Cancel" else "Back",
        bottomBar = {
            when {
                waiting -> PrimaryButton(
                    "Open sign-in page",
                    onClick = { signIn.url?.let(uri::openUri) },
                    enabled = signIn.url != null,
                    modifier = Modifier.fillMaxWidth(),
                )
                signIn.status == "complete" -> PrimaryButton("Done", onClick = onDone, modifier = Modifier.fillMaxWidth())
                else -> SecondaryButton("Try again", onClick = onRetry, modifier = Modifier.fillMaxWidth())
            }
        },
    ) {
        when (signIn.status) {
            "started" -> {
                if (signIn.url == null) {
                    Note("Asking the machine…")
                    return@Page
                }
                val code = signIn.instructions?.let(::signInCode)
                Group {
                    GroupBody {
                        if (code != null) {
                            Text("Enter this code on the sign-in page", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                            SelectionContainer {
                                Text(code, color = Tokens.Text, fontSize = 32.sp, fontWeight = FontWeight.Medium, fontFamily = Tokens.FontMono, letterSpacing = 2.sp)
                            }
                        } else if (signIn.pasteBack) {
                            // The agent's own words assume its browser runs on the machine
                            // ("this window will close automatically"); here it does not.
                            Text("Sign in on the page the button opens.", color = Tokens.Text, fontSize = Tokens.TextMd)
                        } else {
                            signIn.instructions?.let { Text(it, color = Tokens.Text, fontSize = Tokens.TextMd) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RowSpinner()
                            Text("Waiting for you to sign in…", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                        }
                    }
                }
                if (signIn.pasteBack) {
                    Group(
                        title = "Then",
                        footer = "After you sign in, your browser opens a page on the machine that does not load here. " +
                            "Copy that page's address and paste it, and the machine finishes the sign-in.",
                    ) {
                        GroupBody {
                            Field(address, { address = it }, placeholder = "http://127.0.0.1:…/auth/callback?code=…", mono = true)
                            Row { SecondaryButton("Finish sign-in", onClick = { onFinish(address.trim()) }, enabled = address.isNotBlank()) }
                        }
                    }
                }
            }
            "complete" -> Group {
                GroupBody {
                    Text("Signed in", color = Tokens.Text, fontSize = Tokens.TextLg)
                    Text("$accountName is connected; its models are in the model list now.", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                }
            }
            else -> ErrorNote(
                signIn.error ?: when (signIn.status) {
                    "expired" -> "The sign-in ran out of time."
                    "cancelled" -> "The sign-in was cancelled."
                    else -> "The sign-in did not work."
                },
            )
        }
    }
}
