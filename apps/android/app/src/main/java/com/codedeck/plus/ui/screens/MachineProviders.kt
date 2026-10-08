package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.IconAction
import com.codedeck.plus.ui.components.PickerOption
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.SelectField
import com.codedeck.plus.ui.theme.Tokens
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
 * collision so re-adding "Kimi K3" never silently overwrites a profile. Port
 * of `MachineProviders.tsx`'s `profileIdFromLabel`.
 */
private fun profileIdFromLabel(label: String, taken: Set<String>): String {
    val base = label.lowercase().trim().replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "profile" }
    if (base !in taken) return base
    var n = 2
    while ("$base-$n" in taken) n++
    return "$base-$n"
}

/** Add-form prefills for the two providers the feature was built around.
 *  [fromProvider]: the provider lists its own models, so none are typed. */
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

/**
 * Machine AI provider profiles (CDX-062) — port of `apps/mobile/src/ui/
 * screens/MachineProviders.tsx`. The caller gates this on
 * `machine.capabilities.contains(CAP_CUSTOM_PROVIDERS)` before invoking it
 * (mirrors the TSX's cap gate) — Compose has no rules-of-hooks constraint
 * forcing the gate to live inside this composable.
 *
 * One disclosed narrowing from the TSX: `UniffiMachineSummary.providerProfiles`
 * is a plain (non-optional) list on this FFI surface, so there is no "not yet
 * answered" vs. "answered empty" distinction to render a "Loading provider
 * profiles…" state for — the same narrowing `NewSessionScreen.kt` already
 * accepted for this same field.
 */
@Composable
fun MachineProviders(machine: UniffiMachineSummary, status: UniffiProviderProfileAck?, dispatch: (UniffiIntent) -> Unit) {
    val profiles = machine.providerProfiles

    var formOpen by remember(machine.pubkeyHex) { mutableStateOf(false) }
    /** Profile id being edited; null = the add form. */
    var editingId by remember(machine.pubkeyHex) { mutableStateOf<String?>(null) }
    var label by remember(machine.pubkeyHex) { mutableStateOf("") }
    var baseUrl by remember(machine.pubkeyHex) { mutableStateOf("") }
    var token by remember(machine.pubkeyHex) { mutableStateOf("") }
    var clearToken by remember(machine.pubkeyHex) { mutableStateOf(false) }
    var models by remember(machine.pubkeyHex) { mutableStateOf(listOf(EMPTY_ROW)) }
    /** The bridge reads the models from the provider instead of [models]. */
    var fromProvider by remember(machine.pubkeyHex) { mutableStateOf(true) }
    var defaultModel by remember(machine.pubkeyHex) { mutableStateOf("") }
    /** Which profile's Delete awaits its confirm step. */
    var confirmDelete by remember(machine.pubkeyHex) { mutableStateOf<String?>(null) }
    var saving by remember(machine.pubkeyHex) { mutableStateOf(false) }

    LaunchedEffect(machine.pubkeyHex) {
        dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
    }

    /** A save of the open form is waiting for the bridge's ack. */
    var awaitingSave by remember(machine.pubkeyHex) { mutableStateOf(false) }
    val editingProfile = editingId?.let { id -> profiles.find { it.id == id } }
    val validModels = models.filter { it.id.trim().isNotEmpty() }
    val trimmedBaseUrl = baseUrl.trim()
    // Only once there is something to check: an empty field is not an error yet.
    val baseUrlValid = trimmedBaseUrl.isNotEmpty() && isValidProviderBaseUrl(trimmedBaseUrl)
    val baseUrlError = trimmedBaseUrl.isNotEmpty() && !baseUrlValid
    // Reading the provider's list takes its token: a new one, or the stored one.
    val hasTokenToUse = token.trim().isNotEmpty() || (editingProfile?.hasToken == true && !clearToken)
    val canSave = label.trim().isNotEmpty() && baseUrlValid &&
        (if (fromProvider) hasTokenToUse else validModels.isNotEmpty())
    // What the default-model picker offers: the typed list, or what the
    // provider listed at the profile's last save.
    val defaultChoices: List<Pair<String, String>> =
        if (fromProvider) {
            editingProfile?.takeIf { it.modelsFromProvider }?.models.orEmpty().map { it.id to (it.label ?: it.id) }
        } else {
            validModels.map { m -> m.id.trim() to m.label.trim().ifEmpty { m.id.trim() } }
        }

    fun resetForm() {
        editingId = null
        label = ""
        baseUrl = ""
        token = ""
        clearToken = false
        models = listOf(EMPTY_ROW)
        fromProvider = true
        defaultModel = ""
    }

    LaunchedEffect(status) {
        if (status == null) return@LaunchedEffect
        saving = false
        if (awaitingSave && status.state != "saving") {
            awaitingSave = false
            if (status.state == "saved") {
                formOpen = false
                resetForm()
            }
        }
    }

    fun openAdd() {
        resetForm()
        formOpen = true
    }

    fun openEdit(p: UniffiProviderProfileInfo) {
        editingId = p.id
        label = p.label
        baseUrl = p.baseUrl
        token = ""
        clearToken = false
        models = if (p.modelsFromProvider) listOf(EMPTY_ROW) else p.models.map { ModelRow(it.id, it.label ?: "") }
        fromProvider = p.modelsFromProvider
        defaultModel = p.defaultModel ?: ""
        formOpen = true
    }

    fun applyPreset(preset: Preset) {
        label = preset.name
        baseUrl = preset.baseUrl
        models = preset.models
        defaultModel = preset.defaultModel
        fromProvider = preset.fromProvider
    }

    fun save() {
        val profileId = editingId ?: profileIdFromLabel(label, profiles.map { it.id }.toSet())
        val wireModels = validModels.map { m ->
            UniffiProviderModelWrite(id = m.id.trim(), label = m.label.trim().ifEmpty { null })
        }
        val authToken = when {
            clearToken -> UniffiTristate.Clear
            token.trim().isNotEmpty() -> UniffiTristate.Set(token.trim())
            else -> UniffiTristate.Keep
        }
        // A provider-listed default the provider no longer lists is dropped
        // by the bridge, which reads the list anew.
        val resolvedDefault = when {
            defaultModel.isEmpty() -> null
            fromProvider || wireModels.any { it.id == defaultModel } -> defaultModel
            else -> null
        }
        saving = true
        dispatch(
            UniffiIntent.SetProviderProfile(
                machine = machine.pubkeyHex,
                profileId = profileId,
                profile = UniffiProviderProfileWrite(
                    label = label.trim(),
                    baseUrl = baseUrl.trim(),
                    authToken = authToken,
                    models = if (fromProvider) emptyList() else wireModels,
                    modelsFromProvider = fromProvider,
                    defaultModel = resolvedDefault,
                ),
            ),
        )
        // The secret leaves component state at once; the rest of the form
        // stays open until the bridge confirms, so a failed save can be
        // corrected and retried instead of retyped (see LaunchedEffect(status)).
        token = ""
        clearToken = false
        awaitingSave = true
    }

    /** Read a provider's model list again, changing nothing else. */
    fun refreshModels(p: UniffiProviderProfileInfo) {
        saving = true
        dispatch(
            UniffiIntent.SetProviderProfile(
                machine = machine.pubkeyHex,
                profileId = p.id,
                profile = UniffiProviderProfileWrite(
                    label = p.label,
                    baseUrl = p.baseUrl,
                    authToken = UniffiTristate.Keep,
                    models = emptyList(),
                    modelsFromProvider = true,
                    defaultModel = p.defaultModel,
                ),
            ),
        )
    }

    fun deleteProfile(profileId: String) {
        confirmDelete = null
        saving = true
        dispatch(UniffiIntent.SetProviderProfile(machine = machine.pubkeyHex, profileId = profileId, profile = null))
        if (editingId == profileId) {
            formOpen = false
            resetForm()
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Text(
            "Providers and gateways (OpenRouter, Kimi, your own router, …) kept on the bridge. A new " +
                "session can run on one, when its agent speaks the provider's API. Their tokens stay on " +
                "the bridge; this phone never stores them.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )

        profiles.forEach { p ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusLg))
                    .background(Tokens.SurfaceInput)
                    .padding(Tokens.Space3),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space1),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Text(p.label, color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
                    Chip(
                        if (p.hasToken) "token set" else "no token",
                        color = if (p.hasToken) Tokens.Success else Tokens.TextDim,
                        border = if (p.hasToken) Tokens.Success.copy(alpha = 0.4f) else Tokens.Border,
                    )
                }
                Text(p.baseUrl, color = Tokens.TextMuted, fontSize = Tokens.TextSm, fontFamily = Tokens.FontMono)
                Text(
                    "${p.models.size} ${if (p.models.size == 1) "model" else "models"}" +
                        (if (p.modelsFromProvider) " from the provider" else "") +
                        (p.defaultModel?.let { ", default $it" } ?: ""),
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                )
                if (confirmDelete == p.id) {
                    Text(
                        "Delete ${p.label} from the bridge? Sessions bound to it will fail on their " +
                            "next restart instead of silently falling back to Anthropic.",
                        color = Tokens.Danger,
                        fontSize = Tokens.TextSm,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        SecondaryButton("Delete provider", onClick = { deleteProfile(p.id) }, danger = true)
                        QuietButton("Cancel", onClick = { confirmDelete = null })
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        QuietButton("Edit", onClick = { openEdit(p) })
                        if (p.modelsFromProvider && p.hasToken) {
                            QuietButton("Refresh models", onClick = { refreshModels(p) }, enabled = !saving)
                        }
                        QuietButton("Delete", onClick = { confirmDelete = p.id }, danger = true)
                    }
                }
            }
        }

        if (!formOpen) {
            SecondaryButton("Add provider", onClick = ::openAdd)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                if (editingId == null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                        PRESETS.forEach { preset -> QuietButton(preset.name, onClick = { applyPreset(preset) }) }
                    }
                }
                Field(value = label, onValueChange = { label = it }, label = "Name", placeholder = "Kimi K3")
                Field(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = "Base URL",
                    placeholder = "https://api.moonshot.ai/anthropic",
                    mono = true,
                    isError = baseUrlError,
                    supporting = if (baseUrlError) providerBaseUrlError() else null,
                )
                Field(
                    value = token,
                    onValueChange = { token = it },
                    label = "API token",
                    placeholder = if (editingProfile?.hasToken == true) "unchanged" else "sk-…",
                    visualTransformation = PasswordVisualTransformation(),
                )
                if (editingProfile?.hasToken == true) {
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
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Checkbox(checked = fromProvider, onCheckedChange = { fromProvider = it })
                    Text("Read the models from the provider", color = Tokens.Text, fontSize = Tokens.TextSm)
                }
                if (fromProvider) {
                    Text(
                        "The bridge asks the provider for its model list each time you save, with the token above.",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                    )
                } else models.forEachIndexed { i, row ->
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
                if (!fromProvider) QuietButton("Add model", onClick = { models = models + EMPTY_ROW })

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Text("Default model", color = Tokens.Text, fontSize = Tokens.TextMd, modifier = Modifier.weight(1f))
                    SelectField(
                        options = buildList {
                            add(PickerOption("", "First model"))
                            defaultChoices.forEach { (id, name) -> add(PickerOption(id, name)) }
                        },
                        selected = defaultModel,
                        onSelect = { defaultModel = it },
                    )
                }

                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    PrimaryButton("Save on the bridge", onClick = ::save, enabled = canSave, modifier = Modifier.weight(1f))
                    QuietButton("Cancel", onClick = {
                        formOpen = false
                        resetForm()
                    })
                }
            }
        }

        if (status != null) {
            val text = when (status.state) {
                "saving" -> "Saving on the bridge…"
                "saved" -> "Saved" + when (status.tokenValid) {
                    true -> ", token valid"
                    false -> ", token rejected"
                    null -> ""
                }
                "failed" -> "Saving failed: ${status.error ?: "unknown error"}"
                else -> ""
            }
            Text(text, color = if (status.state == "failed") Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}
