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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.codedeck.plus.ui.theme.Tokens

/** One choice in a [SelectField] dropdown — value is what gets dispatched,
 *  label is what the user reads (they differ for the model union, where the
 *  label is the entry's human name and the value its wire id). [group] is
 *  who offers it — a model's provider — for lists where the same label can
 *  come from more than one place. */
data class PickerOption(val value: String, val label: String, val group: String? = null)

/** The options of a model list, one per model, grouped by provider in the
 *  order providers first appear. */
fun modelPickerOptions(models: List<uniffi.client_ffi.UniffiModelEntry>): List<PickerOption> =
    models.map { PickerOption(it.id, it.label ?: it.id, it.provider) }
        .groupBy { it.group }
        .values
        .flatten()

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
    val current = options.firstOrNull { it.value == selected }
    val currentLabel = current?.label
        ?: if (selected.isEmpty()) placeholder else selected
    // Groups are named only when there is more than one to tell apart.
    val grouped = options.mapNotNull { it.group }.distinct().size > 1
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space1),
            modifier = Modifier
                .minimumInteractiveComponentSize()
                .widthIn(max = 220.dp)
                .clip(RoundedCornerShape(Tokens.RadiusPill))
                .background(Tokens.SurfaceHover)
                .clickable(enabled = enabled) { open = true }
                .padding(start = Tokens.Space3, end = Tokens.Space2, top = 6.dp, bottom = 6.dp),
        ) {
            // The provider, when named, sits smaller above the name rather
            // than beside it, so a long name and provider both still fit.
            Column(Modifier.weight(1f, fill = false)) {
                current?.group?.takeIf { grouped }?.let {
                    Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextXs, lineHeight = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(
                    currentLabel,
                    color = when {
                        !enabled -> Tokens.TextDim
                        selected == "" -> Tokens.TextMuted
                        else -> Tokens.Text
                    },
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            // Says the value is a choice, not plain text.
            Icon(
                Icons.Outlined.UnfoldMore,
                contentDescription = null,
                tint = if (enabled) Tokens.TextMuted else Tokens.TextDim,
                modifier = Modifier.size(16.dp),
            )
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
                            .clip(RoundedCornerShape(Tokens.RadiusXl))
                            .background(Tokens.SurfaceRaised)
                            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusXl))
                            .padding(vertical = Tokens.Space2),
                    ) {
                        Column(Modifier.verticalScroll(rememberScrollState())) {
                            options.forEachIndexed { i, option ->
                                val isSelected = option.value == selected
                                if (grouped && option.group != null && option.group != options.getOrNull(i - 1)?.group) {
                                    Text(
                                        option.group,
                                        color = Tokens.TextMuted,
                                        fontSize = Tokens.TextXs,
                                        fontWeight = FontWeight.Medium,
                                        modifier = Modifier.padding(start = Tokens.Space4, end = Tokens.Space4, top = if (i == 0) Tokens.Space2 else Tokens.Space4, bottom = Tokens.Space1),
                                    )
                                }
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            open = false
                                            onSelect(option.value)
                                        }
                                        .padding(
                                            horizontal = Tokens.Space4,
                                            vertical = Tokens.Space3,
                                        ),
                                ) {
                                    Text(
                                        option.label,
                                        // The chosen value reads at a glance in a
                                        // long list: bolder, and checked.
                                        color = Tokens.Text,
                                        fontWeight = if (isSelected) FontWeight.SemiBold else null,
                                        fontSize = Tokens.TextMd,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (isSelected) {
                                        Icon(Icons.Outlined.Check, contentDescription = "Selected", tint = Tokens.Text, modifier = Modifier.size(18.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
