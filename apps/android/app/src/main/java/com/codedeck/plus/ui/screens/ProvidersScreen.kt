package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.ExpandableRow
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.components.ValueRow
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiProviderModelWrite
import uniffi.client_ffi.UniffiProviderProfileAck
import uniffi.client_ffi.UniffiProviderProfileInfo
import uniffi.client_ffi.UniffiProviderProfileWrite
import uniffi.client_ffi.UniffiTristate
import uniffi.client_ffi.isValidProviderBaseUrl
import uniffi.client_ffi.providerBaseUrlError

/** Draft row of the models editor ('' label = omit on the wire). */
private data class ModelRow(val id: String, val label: String)

private val EMPTY_ROW = ModelRow("", "")

/**
 * Human-legible profile id from the label (house slug style), suffixed on
 * collision so re-adding "Kimi K3" never silently overwrites a profile.
 */
private fun profileIdFromLabel(label: String, taken: Set<String>): String {
    val base = label.lowercase().trim().replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "profile" }
    if (base !in taken) return base
    var n = 2
    while ("$base-$n" in taken) n++
    return "$base-$n"
}

/** Add-form prefills for two common providers. [fromProvider]: the
 *  provider lists its own models, so none are typed. */
private data class Preset(
    val name: String,
    val baseUrl: String,
    val models: List<ModelRow>,
    val defaultModel: String,
    val fromProvider: Boolean,
)

private val PRESETS = listOf(
    Preset("Kimi K3", "https://api.moonshot.ai/anthropic", listOf(ModelRow("kimi-k3", "Kimi K3")), "kimi-k3", fromProvider = false),
    Preset("OpenRouter", "https://openrouter.ai/api", listOf(EMPTY_ROW), "", fromProvider = true),
)

/** The agents a provider can be for. */
internal fun providerAgents(machine: UniffiMachineSummary): List<UniffiAgent> =
    machine.agents.filter { it.supportsProviders || it.supportsProviderModels }

/** What a provider does for [agent]. */
internal fun providerUse(agent: UniffiAgent): String =
    if (agent.supportsProviderModels) {
        "Its models join ${agent.displayName}'s model list, beside the providers ${agent.displayName} already has."
    } else {
        "A new ${agent.displayName} session can run on it instead of ${agent.displayName}'s own account."
    }

/** What the open editor is: a new provider, or the profile with this id. */
sealed interface ProviderEditor {
    data object New : ProviderEditor
    data class Existing(val id: String) : ProviderEditor
}

/**
 * One agent's AI providers on a machine — its provider profiles, kept per
 * agent like its plugins and MCP servers: an endpoint that speaks one
 * agent's API need not speak another's. A list page with an Add button;
 * adding or editing opens the editor in its place, and Back returns.
 *
 * A profile saved before profiles had an agent is offered on every agent's
 * page, to be taken over with one tap.
 */
@Composable
fun ProvidersContent(
    machine: UniffiMachineSummary,
    agentId: String,
    status: UniffiProviderProfileAck?,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    /** Opens straight on the editor (for a snapshot). */
    startEditing: ProviderEditor? = null,
    /** The provider shown opened (for a snapshot). */
    openProfile: String? = null,
    /** The core's base URL rule — a native call, so a snapshot, which cannot
     *  load the core, passes its own. */
    validBaseUrl: (String) -> Boolean = ::isValidProviderBaseUrl,
) {
    val agent = machine.agents.firstOrNull { it.id == agentId }
    val agentName = agent?.displayName ?: agentId
    val known = providerAgents(machine).map { it.id }.toSet()
    val own = machine.providerProfiles.filter { it.agent == agentId }
    // Profiles from before profiles named their agent.
    val unassigned = machine.providerProfiles.filter { it.agent !in known }

    var editor by remember(machine.pubkeyHex, agentId) { mutableStateOf(startEditing) }
    var confirmDelete by remember(machine.pubkeyHex, agentId) { mutableStateOf<String?>(null) }
    /** A change made from the list (refresh, take over, delete) awaits its ack. */
    var busy by remember(machine.pubkeyHex, agentId) { mutableStateOf(false) }

    LaunchedEffect(machine.pubkeyHex) { dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex)) }
    LaunchedEffect(status) { if (status != null && status.state != "saving") busy = false }

    fun write(profileId: String, profile: UniffiProviderProfileWrite?) {
        busy = true
        dispatch(UniffiIntent.SetProviderProfile(machine = machine.pubkeyHex, profileId = profileId, profile = profile))
    }

    /** The same profile for [forAgent], its token kept and its models read
     *  again when they are the provider's. */
    fun rewrite(p: UniffiProviderProfileInfo, forAgent: String) = UniffiProviderProfileWrite(
        agent = forAgent,
        label = p.label,
        baseUrl = p.baseUrl,
        authToken = UniffiTristate.Keep,
        models = if (p.modelsFromProvider) emptyList() else p.models.map { UniffiProviderModelWrite(it.id, it.label) },
        modelsFromProvider = p.modelsFromProvider,
        defaultModel = p.defaultModel,
    )

    val open = editor
    if (open != null) {
        ProviderEditorPage(
            machine = machine,
            agentId = agentId,
            agentName = agentName,
            editing = (open as? ProviderEditor.Existing)?.let { e -> own.firstOrNull { it.id == e.id } },
            status = status,
            dispatch = dispatch,
            validBaseUrl = validBaseUrl,
            onDone = { editor = null },
        )
        return
    }

    Page(
        title = "$agentName providers",
        subtitle = machineLabel(machine.name),
        onBack = onBack,
        bottomBar = { PrimaryButton("Add a provider", onClick = { editor = ProviderEditor.New }, modifier = Modifier.fillMaxWidth()) },
    ) {
        if (own.isEmpty()) {
            Group {
                GroupBody {
                    Text("No providers yet", color = Tokens.Text, fontSize = Tokens.TextLg)
                    Text(
                        "A provider is an API endpoint $agentName can use: a service such as OpenRouter or Kimi, " +
                            "or a gateway of your own, on this machine or your network. " + agent?.let(::providerUse).orEmpty(),
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                    )
                }
            }
        } else {
            Group(footer = agent?.let { providerUse(it) + " Tokens stay on the machine; this phone never stores them." }) {
                own.forEachIndexed { i, p ->
                    if (i > 0) Divider()
                    ProfileRow(p, startOpen = p.id == openProfile) {
                        if (confirmDelete == p.id) {
                            Text(
                                if (agent?.supportsProviderModels == true) {
                                    "Delete ${p.label}? Its models leave $agentName's list."
                                } else {
                                    "Delete ${p.label}? Sessions on it fail at their next restart instead of " +
                                        "falling back to $agentName's own account."
                                },
                                color = Tokens.Danger,
                                fontSize = Tokens.TextSm,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                                SecondaryButton("Delete provider", onClick = {
                                    confirmDelete = null
                                    write(p.id, null)
                                }, danger = true)
                                QuietButton("Cancel", onClick = { confirmDelete = null })
                            }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                                QuietButton("Edit", onClick = { editor = ProviderEditor.Existing(p.id) })
                                if (p.modelsFromProvider && p.hasToken) {
                                    QuietButton("Refresh models", onClick = { write(p.id, rewrite(p, agentId)) }, enabled = !busy)
                                }
                                QuietButton("Delete", onClick = { confirmDelete = p.id }, danger = true)
                            }
                        }
                    }
                }
            }
        }

        if (unassigned.isNotEmpty()) {
            Group(
                title = "Saved without an agent",
                footer = "Saved before each provider was kept for one agent, so no agent uses them. " +
                    "Use one for $agentName if it speaks the API $agentName uses.",
            ) {
                unassigned.forEachIndexed { i, p ->
                    if (i > 0) Divider()
                    ProfileRow(p, startOpen = p.id == openProfile) {
                        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                            QuietButton("Use for $agentName", onClick = { write(p.id, rewrite(p, agentId)) }, enabled = !busy && p.hasToken)
                            QuietButton("Delete", onClick = { write(p.id, null) }, danger = true, enabled = !busy)
                        }
                    }
                }
            }
        }

        ProfileStatus(status)
    }
}

/** "3 models", "1 model". */
private fun modelCount(n: Int) = "$n ${if (n == 1) "model" else "models"}"

/**
 * One provider: its name and endpoint, with a chip for what matters most —
 * why its agent does not offer it, a missing token, or how many models it
 * has. Opened, it lists its models and then [actions].
 */
@Composable
private fun ProfileRow(p: UniffiProviderProfileInfo, startOpen: Boolean, actions: @Composable () -> Unit) {
    var open by remember(p.id) { mutableStateOf(startOpen) }
    ExpandableRow(
        p.label,
        p.baseUrl,
        enabled = p.error == null,
        open = open,
        onOpenChange = { open = it },
        subtitleMono = true,
        openSubtitleLines = 3,
        trailing = {
            when {
                p.error != null -> Chip("not offered", color = Tokens.Danger, border = Tokens.Danger.copy(alpha = 0.4f))
                !p.hasToken -> Chip("no token", color = Tokens.Warn, border = Tokens.Warn.copy(alpha = 0.4f))
                else -> Chip(modelCount(p.models.size))
            }
        },
    ) {
        Column(Modifier.padding(top = Tokens.Space2), verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            // Why the agent does not offer its models (its name is taken, say).
            p.error?.let { Text(it, color = Tokens.Danger, fontSize = Tokens.TextSm) }
            Text(
                (if (p.modelsFromProvider) "Models read from the provider at the last save" else "Models typed in by hand") +
                    if (p.hasToken) " · token set" else " · no token, so nothing runs on it",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
            )
            ProfileModels(p)
            actions()
        }
    }
}

/**
 * A profile's models, under the provider a gateway routes each to when the
 * endpoint names one (the part of the model's group after the profile's
 * name); its default marked.
 */
@Composable
private fun ProfileModels(p: UniffiProviderProfileInfo) {
    // Those under no other provider first, so none reads as part of a group.
    val byUpstream = p.models
        .groupBy { m -> m.provider?.removePrefix(p.label)?.removePrefix(" · ")?.takeIf { it.isNotEmpty() } }
        .entries
        .sortedBy { it.key != null }
    val default = p.defaultModel ?: p.models.firstOrNull()?.id
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        byUpstream.forEach { (upstream, models) ->
            if (upstream != null) Text(upstream, color = Tokens.TextMuted, fontSize = Tokens.TextXs, fontWeight = FontWeight.Medium)
            models.forEach { m ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Text(
                        m.label ?: m.id,
                        color = Tokens.Text,
                        fontSize = Tokens.TextMd,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (m.id == default) Chip("default")
                    m.contextWindow?.let { Text(contextSize(it), color = Tokens.TextDim, fontSize = Tokens.TextXs, fontFamily = Tokens.FontMono) }
                }
            }
        }
    }
}

/** A context window as people write it: 1M, 200K, 128K (2^17 tokens). */
internal fun contextSize(tokens: UInt): String {
    val n = tokens.toLong()
    fun scaled(unit: Long, binary: Long, suffix: String): String =
        "${if (n % binary == 0L) n / binary else Math.round(n.toDouble() / unit)}$suffix"
    return when {
        n >= 1_000_000L -> scaled(1_000_000L, 1L shl 20, "M")
        n >= 1_000L -> scaled(1_000L, 1L shl 10, "K")
        else -> n.toString()
    }
}

/** The last save's outcome, in words. */
@Composable
private fun ProfileStatus(status: UniffiProviderProfileAck?) {
    if (status == null) return
    when (status.state) {
        "saving" -> Text("Saving on the machine…", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        "saved" -> Text(
            "Saved" + when (status.tokenValid) {
                true -> ", token valid"
                false -> ", but the provider rejected the token"
                null -> ""
            },
            color = if (status.tokenValid == false) Tokens.Warn else Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )
        "failed" -> ErrorNote("Saving failed: ${status.error ?: "unknown error"}")
    }
}

/** The editor of one provider: a new one when [editing] is null. Its token
 *  leaves the form once sent; the rest stays until the machine confirms, so
 *  a failed save can be corrected instead of retyped. */
@Composable
private fun ProviderEditorPage(
    machine: UniffiMachineSummary,
    agentId: String,
    agentName: String,
    editing: UniffiProviderProfileInfo?,
    status: UniffiProviderProfileAck?,
    dispatch: (UniffiIntent) -> Unit,
    validBaseUrl: (String) -> Boolean,
    onDone: () -> Unit,
) {
    val key = editing?.id ?: ""
    var label by remember(key) { mutableStateOf(editing?.label.orEmpty()) }
    var baseUrl by remember(key) { mutableStateOf(editing?.baseUrl.orEmpty()) }
    var token by remember(key) { mutableStateOf("") }
    var clearToken by remember(key) { mutableStateOf(false) }
    /** The machine reads the models from the provider instead of [models]. */
    var fromProvider by remember(key) { mutableStateOf(editing?.modelsFromProvider ?: true) }
    var models by remember(key) {
        mutableStateOf(editing?.takeIf { !it.modelsFromProvider }?.models?.map { ModelRow(it.id, it.label.orEmpty()) } ?: listOf(EMPTY_ROW))
    }
    var defaultModel by remember(key) { mutableStateOf(editing?.defaultModel.orEmpty()) }
    var awaitingSave by remember(key) { mutableStateOf(false) }

    LaunchedEffect(status) {
        if (awaitingSave && status != null && status.state != "saving") {
            awaitingSave = false
            if (status.state == "saved") onDone()
        }
    }

    val validModels = models.filter { it.id.trim().isNotEmpty() }
    val trimmedBaseUrl = baseUrl.trim()
    // Only once there is something to check: an empty field is not an error yet.
    val baseUrlValid = trimmedBaseUrl.isNotEmpty() && validBaseUrl(trimmedBaseUrl)
    val baseUrlError = trimmedBaseUrl.isNotEmpty() && !baseUrlValid
    // Reading the provider's list takes its token: a new one, or the stored one.
    val hasTokenToUse = token.trim().isNotEmpty() || (editing?.hasToken == true && !clearToken)
    val canSave = !awaitingSave && label.trim().isNotEmpty() && baseUrlValid &&
        (if (fromProvider) hasTokenToUse else validModels.isNotEmpty())
    // What the default-model picker offers: the typed list, or what the
    // provider listed at the last save.
    val defaultChoices: List<Pair<String, String>> =
        if (fromProvider) {
            editing?.takeIf { it.modelsFromProvider }?.models.orEmpty().map { it.id to (it.label ?: it.id) }
        } else {
            validModels.map { m -> m.id.trim() to m.label.trim().ifEmpty { m.id.trim() } }
        }

    fun save() {
        val profileId = editing?.id ?: profileIdFromLabel(label, machine.providerProfiles.map { it.id }.toSet())
        val wireModels = validModels.map { m -> UniffiProviderModelWrite(id = m.id.trim(), label = m.label.trim().ifEmpty { null }) }
        val authToken = when {
            clearToken -> UniffiTristate.Clear
            token.trim().isNotEmpty() -> UniffiTristate.Set(token.trim())
            else -> UniffiTristate.Keep
        }
        // A provider-listed default the provider no longer lists is dropped
        // by the machine, which reads the list anew.
        val resolvedDefault = when {
            defaultModel.isEmpty() -> null
            fromProvider || wireModels.any { it.id == defaultModel } -> defaultModel
            else -> null
        }
        dispatch(
            UniffiIntent.SetProviderProfile(
                machine = machine.pubkeyHex,
                profileId = profileId,
                profile = UniffiProviderProfileWrite(
                    agent = agentId,
                    label = label.trim(),
                    baseUrl = trimmedBaseUrl,
                    authToken = authToken,
                    models = if (fromProvider) emptyList() else wireModels,
                    modelsFromProvider = fromProvider,
                    defaultModel = resolvedDefault,
                ),
            ),
        )
        token = ""
        clearToken = false
        awaitingSave = true
    }

    Page(
        title = editing?.let { "Edit ${it.label}" } ?: "Add a provider",
        subtitle = "$agentName · ${machineLabel(machine.name)}",
        onBack = onDone,
        bottomBar = {
            PrimaryButton(if (awaitingSave) "Saving…" else "Save on the machine", onClick = ::save, enabled = canSave, modifier = Modifier.fillMaxWidth())
        },
    ) {
        if (editing == null) {
            Group(title = "Start from") {
                GroupBody {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        PRESETS.forEach { preset ->
                            QuietButton(preset.name, onClick = {
                                label = preset.name
                                baseUrl = preset.baseUrl
                                models = preset.models
                                defaultModel = preset.defaultModel
                                fromProvider = preset.fromProvider
                            })
                        }
                    }
                }
            }
        }
        Group(
            title = "Endpoint",
            footer = "It must speak the API $agentName uses. http:// works only for this machine or an address on your own network.",
        ) {
            GroupBody {
                Field(value = label, onValueChange = { label = it }, label = "Name", placeholder = "My gateway")
                Field(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = "Base URL",
                    placeholder = "https://api.example.com",
                    mono = true,
                    isError = baseUrlError,
                    supporting = if (baseUrlError) providerBaseUrlError() else null,
                )
                Field(
                    value = token,
                    onValueChange = { token = it },
                    label = "API token",
                    placeholder = if (editing?.hasToken == true) "unchanged" else "sk-…",
                    visualTransformation = PasswordVisualTransformation(),
                )
                if (editing?.hasToken == true) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        Checkbox(
                            checked = clearToken,
                            onCheckedChange = {
                                clearToken = it
                                if (it) token = ""
                            },
                        )
                        Text("Delete the stored token when saving", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    }
                }
            }
        }
        Group(
            title = "Models",
            footer = if (fromProvider) "The machine asks the provider for its model list every time you save, with the token above." else null,
        ) {
            GroupBody {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Checkbox(checked = fromProvider, onCheckedChange = { fromProvider = it })
                    Text("Read the models from the provider", color = Tokens.Text, fontSize = Tokens.TextMd)
                }
                if (!fromProvider) {
                    models.forEachIndexed { i, row ->
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                        ) {
                            Field(
                                value = row.id,
                                onValueChange = { v -> models = models.mapIndexed { j, m -> if (j == i) m.copy(id = v) else m } },
                                placeholder = "model id",
                                mono = true,
                                modifier = Modifier.weight(1f),
                            )
                            Field(
                                value = row.label,
                                onValueChange = { v -> models = models.mapIndexed { j, m -> if (j == i) m.copy(label = v) else m } },
                                placeholder = "label",
                                modifier = Modifier.weight(1f),
                            )
                            IconAction(
                                Icons.Outlined.Close,
                                "Remove model",
                                onClick = { models = models.filterIndexed { j, _ -> j != i } },
                                tint = if (models.size > 1) Tokens.TextMuted else Tokens.TextDim,
                                // A provider keeps at least one model.
                                enabled = models.size > 1,
                            )
                        }
                    }
                    QuietButton("Add model", onClick = { models = models + EMPTY_ROW })
                }
            }
            Divider()
            ValueRow("Default model") {
                SelectField(
                    options = buildList {
                        add(PickerOption("", "First model"))
                        defaultChoices.forEach { (id, name) -> add(PickerOption(id, name)) }
                    },
                    selected = defaultModel,
                    onSelect = { defaultModel = it },
                )
            }
        }
        ProfileStatus(status.takeIf { awaitingSave || it?.state == "failed" })
    }
}

/** [ProvidersContent] for one agent of the machine [pubkey], from the core;
 *  closes when the machine goes away. */
@Composable
fun ProvidersScreen(core: CoreHost, pubkey: String, agentId: String, onBack: () -> Unit) {
    val ui by core.ui.collectAsState()
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    ProvidersContent(
        machine,
        agentId,
        status = ui?.providerProfileStatus?.get(pubkey),
        dispatch = { intent -> scope.launch { core.dispatch(intent) } },
        onBack = onBack,
    )
}
