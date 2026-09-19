package com.codedeck.plus.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens

/** One choice in a [SelectField] dropdown — value is what gets dispatched,
 *  label is what the user reads (they differ for the model union, where the
 *  label is the entry's human name and the value its wire id). */
data class PickerOption(val value: String, val label: String)

/**
 * The shared `<select>`-style dropdown — bordered trigger text that opens a
 * Material3 [DropdownMenu] over the option list on tap. Started life as
 * `SettingsScreen.kt`'s private picker (the same trigger-plus-menu idiom
 * `SessionScreen.kt`'s original `EffortSelector` had established) and is now
 * THE widget for the job: SessionScreen's effort selector and
 * NewSessionScreen's backend/provider/model/effort pickers and
 * MachineProviders' default-model picker all render through it, matching the
 * reference app's native `<select>` elements for the same fields.
 *
 * `selected` not matching any option falls back to showing the raw value in
 * the trigger rather than silently showing nothing (a stored value from
 * before a ladder/union changed). The empty string — the ''-means-default
 * convention every picker here uses — shows [placeholder] instead (muted,
 * like the unmatched-raw-value fallback), so a nothing-chosen-yet field can
 * keep its "effort…"-style hint without that hint polluting the option list
 * itself.
 */
@Composable
fun SelectField(
    options: List<PickerOption>,
    selected: String,
    enabled: Boolean = true,
    placeholder: String = "",
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val currentLabel = options.firstOrNull { it.value == selected }?.label
        ?: if (selected.isEmpty()) placeholder else selected
    Box {
        Text(
            currentLabel,
            color = when {
                !enabled -> Tokens.TextDim
                selected == "" -> Tokens.TextMuted
                else -> Tokens.Text
            },
            fontSize = Tokens.TextSm,
            modifier = Modifier
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceInput)
                .clickable(enabled = enabled) { open = true }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label, color = Tokens.Text, fontSize = Tokens.TextSm) },
                    onClick = {
                        open = false
                        onSelect(option.value)
                    },
                )
            }
        }
    }
}
