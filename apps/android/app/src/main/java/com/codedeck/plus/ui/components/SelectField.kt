package com.codedeck.plus.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.codedeck.plus.ui.theme.Tokens

/** One choice in a [SelectField] dropdown — value is what gets dispatched,
 *  label is what the user reads (they differ for the model union, where the
 *  label is the entry's human name and the value its wire id). */
data class PickerOption(val value: String, val label: String)

/**
 * The shared `<select>`-style dropdown — bordered trigger text that opens the
 * option list CENTERED on screen as a modal ([Dialog]) sheet. That centered
 * surface is deliberate: the TSX reference's pickers are bare native
 * `<select>` elements with no custom popup styling (`.select` only sets
 * border/padding/typography), so on a phone the option list renders as the
 * browser's own centered system sheet — this Dialog reproduces that behavior,
 * replacing an earlier anchored Material3 `DropdownMenu` whose width also
 * swung with the longest option label. Here the sheet is a fixed fraction of
 * the screen ([DialogProperties] with `usePlatformDefaultWidth = false` lets
 * the 0.85 width fraction size against the SCREEN, not the platform's default
 * dialog box) regardless of option content, capped at a fraction of the
 * screen's height with the option column scrolling past it — the Model picker
 * can carry dozens of entries. The current selection is highlighted, the way
 * a native select sheet marks the chosen value.
 *
 * Started life as `SettingsScreen.kt`'s private picker (the trigger-plus-list
 * idiom `SessionScreen.kt`'s original `EffortSelector` had established) and
 * is now THE widget for the job: SessionScreen's effort selector and
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
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
            modifier = Modifier
                .minimumInteractiveComponentSize()
                .clip(RoundedCornerShape(Tokens.RadiusSm))
                .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusSm))
                .background(Tokens.SurfaceInput)
                .clickable(enabled = enabled) { open = true }
                .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
        ) {
            Text(
                currentLabel,
                color = when {
                    !enabled -> Tokens.TextDim
                    selected == "" -> Tokens.TextMuted
                    else -> Tokens.Text
                },
                fontSize = Tokens.TextSm,
            )
            // The trigger otherwise looks like plain bordered text, not
            // something tappable — a small affordance glyph, the same plain-
            // Unicode-glyph idiom this app already uses for its other
            // chrome (SessionsScreen's "+", NavChevron's "‹"/"›") rather than
            // pulling in a Material icon for one character.
            Text("▾", color = if (enabled) Tokens.TextMuted else Tokens.TextDim, fontSize = Tokens.TextXs)
        }
        if (open) {
            Dialog(
                onDismissRequest = { open = false },
                properties = DialogProperties(usePlatformDefaultWidth = false),
            ) {
                BoxWithConstraints {
                    val sheetWidth = maxWidth * 0.85f
                    val sheetMaxHeight = maxHeight * 0.6f
                    Column(
                        Modifier
                            .width(sheetWidth)
                            .heightIn(max = sheetMaxHeight)
                            .clip(RoundedCornerShape(Tokens.RadiusMd))
                            .background(Tokens.SurfaceRaised)
                            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusMd))
                            .padding(vertical = Tokens.Space1),
                    ) {
                        Column(Modifier.verticalScroll(rememberScrollState())) {
                            options.forEach { option ->
                                val isSelected = option.value == selected
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            open = false
                                            onSelect(option.value)
                                        }
                                        .padding(
                                            horizontal = Tokens.Space3,
                                            vertical = Tokens.Space2,
                                        ),
                                ) {
                                    Text(
                                        option.label,
                                        // The chosen value reads at a glance in a
                                        // long list (a native select sheet marks it
                                        // the same way); everything else stays the
                                        // plain body color.
                                        color = if (isSelected) Tokens.Accent else Tokens.Text,
                                        fontWeight = if (isSelected) FontWeight.Bold else null,
                                        fontSize = Tokens.TextSm,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
