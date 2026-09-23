package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.codedeck.plus.ui.components.PickerOption
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

/** Add-form prefills for the two providers the feature was built around. */
private data class Preset(val name: String, val baseUrl: String, val models: List<ModelRow>, val defaultModel: String)

private val PRESETS = listOf(
    Preset("Kimi K3", "https://api.moonshot.ai/anthropic", listOf(ModelRow("kimi-k3", "Kimi K3")), "kimi-k3"),
    Preset("OpenRouter", "https://openrouter.ai/api", listOf(EMPTY_ROW), ""),
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
    var defaultModel by remember(machine.pubkeyHex) { mutableStateOf("") }
    /** Which profile's Delete awaits its confirm step. */
    var confirmDelete by remember(machine.pubkeyHex) { mutableStateOf<String?>(null) }
    var saving by remember(machine.pubkeyHex) { mutableStateOf(false) }

    LaunchedEffect(machine.pubkeyHex) {
        dispatch(UniffiIntent.RequestProviderProfiles(machine.pubkeyHex))
    }
    LaunchedEffect(status) { if (status != null) saving = false }

    val editingProfile = editingId?.let { id -> profiles.find { it.id == id } }
    val validModels = models.filter { it.id.trim().isNotEmpty() }
    val trimmedBaseUrl = baseUrl.trim()
    val baseUrlValid = isValidProviderBaseUrl(trimmedBaseUrl)
    val baseUrlError = trimmedBaseUrl.isNotEmpty() && !baseUrlValid
    val canSave = label.trim().isNotEmpty() && baseUrlValid && validModels.isNotEmpty()

    fun resetForm() {
        editingId = null
        label = ""
        baseUrl = ""
        token = ""
        clearToken = false
        models = listOf(EMPTY_ROW)
        defaultModel = ""
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
        models = p.models.map { ModelRow(it.id, it.label ?: "") }
        defaultModel = p.defaultModel ?: ""
        formOpen = true
    }

    fun applyPreset(preset: Preset) {
        label = preset.name
        baseUrl = preset.baseUrl
        models = preset.models
        defaultModel = preset.defaultModel
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
        val resolvedDefault = if (defaultModel.isNotEmpty() && wireModels.any { it.id == defaultModel }) defaultModel else null
        saving = true
        dispatch(
            UniffiIntent.SetProviderProfile(
                machine = machine.pubkeyHex,
                profileId = profileId,
                profile = UniffiProviderProfileWrite(
                    label = label.trim(),
                    baseUrl = baseUrl.trim(),
                    authToken = authToken,
                    models = wireModels,
                    defaultModel = resolvedDefault,
                ),
            ),
        )
        token = ""
        clearToken = false
        formOpen = false
        resetForm()
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

    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Text("AI providers", color = Tokens.Text, fontSize = Tokens.TextSm)
        Text(
            "Custom Anthropic-compatible providers (Kimi, OpenRouter, …) stored on the bridge; " +
                "new sessions can be bound to one at create time. Tokens stay on the bridge — " +
                "this phone never stores them.",
            color = Tokens.TextMuted,
            fontSize = Tokens.TextSm,
        )

        profiles.forEach { p ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusMd))
                    .background(Tokens.SurfaceRaised)
                    .padding(Tokens.Space2),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space1),
            ) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Text(p.label, color = Tokens.Text, fontSize = Tokens.TextSm, modifier = Modifier.weight(1f))
                    Text(
                        if (p.hasToken) "token set" else "no token",
                        color = if (p.hasToken) Tokens.Success else Tokens.TextDim,
                        fontSize = Tokens.TextXs,
                    )
                }
                Text(p.baseUrl, color = Tokens.TextMuted, fontSize = Tokens.TextSm, fontFamily = Tokens.FontMono)
                Text(
                    "${p.models.size} ${if (p.models.size == 1) "model" else "models"}" +
                        (p.defaultModel?.let { " · default $it" } ?: ""),
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
                        Button(onClick = { deleteProfile(p.id) }) { Text("Delete profile") }
                        TextButton(onClick = { confirmDelete = null }) { Text("Cancel") }
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        TextButton(onClick = { openEdit(p) }) { Text("Edit") }
                        TextButton(onClick = { confirmDelete = p.id }) {
                            Text("Delete…", color = Tokens.Danger)
                        }
                    }
                }
            }
        }

        if (!formOpen) {
            Button(onClick = ::openAdd) { Text("Add provider…") }
        }

        if (formOpen) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Tokens.RadiusMd))
                    .background(Tokens.SurfaceRaised)
                    .padding(Tokens.Space2),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                if (editingId == null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        PRESETS.forEach { preset ->
                            TextButton(onClick = { applyPreset(preset) }) { Text(preset.name) }
                        }
                    }
                }
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    placeholder = { Text("Label (e.g. Kimi K3)") },
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    placeholder = { Text("https://api.moonshot.ai/anthropic") },
                    modifier = Modifier.fillMaxWidth(),
                )
                if (baseUrlError) {
                    Text(providerBaseUrlError(), color = Tokens.Danger, fontSize = Tokens.TextSm)
                }
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    placeholder = { Text(if (editingProfile?.hasToken == true) "unchanged" else "API token (sk-…)") },
                    enabled = !clearToken,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
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
                        Text("Clear token (removes the stored token on save)", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    }
                }
                models.forEachIndexed { i, row ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                    ) {
                        OutlinedTextField(
                            value = row.id,
                            onValueChange = { v -> models = models.mapIndexed { j, m -> if (j == i) m.copy(id = v) else m } },
                            placeholder = { Text("model id (e.g. kimi-k3)") },
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedTextField(
                            value = row.label,
                            onValueChange = { v -> models = models.mapIndexed { j, m -> if (j == i) m.copy(label = v) else m } },
                            placeholder = { Text("label (optional)") },
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            onClick = { models = models.filterIndexed { j, _ -> j != i } },
                            enabled = models.size > 1,
                        ) {
                            Text("Remove", color = Tokens.Danger)
                        }
                    }
                }
                TextButton(onClick = { models = models + EMPTY_ROW }) { Text("Add model") }

                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
                    Text("Default model", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                    SelectField(
                        options = buildList {
                            add(PickerOption("", "First model"))
                            validModels.forEach { m ->
                                val id = m.id.trim()
                                add(PickerOption(id, m.label.trim().ifEmpty { id }))
                            }
                        },
                        selected = defaultModel,
                        onSelect = { defaultModel = it },
                    )
                }

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Button(onClick = ::save, enabled = canSave, modifier = Modifier.weight(1f)) {
                        Text("Save on bridge")
                    }
                    TextButton(
                        onClick = {
                            formOpen = false
                            resetForm()
                        },
                    ) {
                        Text("Cancel")
                    }
                }
            }
        }

        if (status != null) {
            val text = when (status.state) {
                "saving" -> "Saving on the bridge…"
                "saved" -> "Saved" + when (status.tokenValid) {
                    true -> " · token valid"
                    false -> " · token INVALID"
                    null -> ""
                }
                "failed" -> "Saving failed: ${status.error ?: "unknown error"}"
                else -> ""
            }
            Text(text, color = if (status.state == "failed") Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
    }
}
