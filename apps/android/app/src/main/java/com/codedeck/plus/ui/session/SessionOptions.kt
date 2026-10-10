package com.codedeck.plus.ui.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.DeckSheet
import com.codedeck.plus.ui.components.Dot
import com.codedeck.plus.ui.components.pulsingAlpha
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.SheetHeader
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiSessionMcp

/**
 * What a session runs its next turn with, and what it can switch to: the
 * composer's options chip shows it, [SessionOptionsSheet] changes it. Every
 * list holds only what the session's agent offers; an empty one hides its
 * part of the sheet.
 */
internal data class SessionOptions(
    /** The current model as the chip names it ([listedModelName] or [modelLabel]); null when unknown. */
    val modelName: String?,
    val model: String?,
    /** The models the session can switch to: its provider profile's, else its agent's. */
    val models: List<UniffiModelEntry>,
    val modes: List<UniffiOptionChoice>,
    /** The mode shown: one requested and not yet confirmed, else the session's. */
    val mode: String?,
    val modePending: Boolean,
    /** The agent's own default mode: the chip names the mode only when it is another. */
    val defaultMode: String?,
    val efforts: List<UniffiOptionChoice>,
    val effort: String?,
    /** `null` hides the MCP row (no servers, or an agent without MCP). */
    val mcp: UniffiSessionMcp? = null,
) {
    /** Whether the sheet has anything to change. */
    val changeable: Boolean get() = models.isNotEmpty() || modes.size >= 2 || efforts.isNotEmpty() || mcp != null
    val modeLabel: String? get() = modes.firstOrNull { it.id == mode }?.label ?: mode
    val effortLabel: String? get() = efforts.firstOrNull { it.id == effort }?.label ?: effort
}

/**
 * The composer's options chip: "Plan · Opus 5 High" — the mode when it is
 * not the agent's default (it changes what the agent may do), the model,
 * then the effort, muted. A mode change still on its way pulses. Opens
 * [SessionOptionsSheet].
 */
@Composable
internal fun SessionOptionsChip(options: SessionOptions, onClick: () -> Unit) {
    val modeShown = options.modeLabel?.takeIf { options.modes.size >= 2 && options.mode != options.defaultMode }
    val alpha = if (options.modePending) pulsingAlpha(min = 0.35f, max = 1f, halfPeriodMs = 500) else 1f
    val description = listOfNotNull(modeShown, options.modelName, options.effortLabel).joinToString(", ")
    Box(
        Modifier
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .clickable(enabled = options.changeable, onClick = onClick)
            .semantics { contentDescription = "Session options: $description" }
            .padding(horizontal = Tokens.Space2),
        contentAlignment = Alignment.CenterStart,
    ) {
        ChipLayout(
            mode = modeShown?.let {
                {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            it,
                            color = Tokens.Text,
                            fontSize = Tokens.TextSm,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false).graphicsLayer { this.alpha = alpha },
                        )
                        Text("·", color = Tokens.TextDim, fontSize = Tokens.TextSm)
                    }
                }
            },
            model = {
                Text(
                    options.modelName ?: "Model",
                    color = if (options.modelName != null) Tokens.Text else Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            trailing = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    options.effortLabel?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 1) }
                    if (options.changeable) {
                        Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, tint = Tokens.TextMuted, modifier = Modifier.size(16.dp))
                    }
                }
            },
        )
    }
}

/** Widest the chip's model name gets, even with room to spare. */
private val CHIP_MODEL_MAX = 140.dp

/**
 * The chip's three parts in a line: [trailing] (the effort and the arrow)
 * always whole; [mode] and [model] whole when they fit, else half of what
 * is left each, one's unused half going to the other — the mode stays in
 * sight (bypassing permissions is not something to hide), and so does the
 * model. A plain Row cannot do this: a weighted child keeps its share even
 * when it needs less, so a short mode would still be cut.
 */
@Composable
private fun ChipLayout(mode: (@Composable () -> Unit)?, model: @Composable () -> Unit, trailing: @Composable () -> Unit) {
    Layout(content = {
        mode?.invoke()
        model()
        trailing()
    }) { measurables, constraints ->
        val gap = 6.dp.roundToPx()
        val modeM = if (mode != null) measurables[0] else null
        val modelM = measurables[measurables.size - 2]
        val trailingP = measurables.last().measure(Constraints())
        val parts = if (modeM != null) 3 else 2
        val room = if (constraints.hasBoundedWidth) (constraints.maxWidth - trailingP.width - gap * (parts - 1)).coerceAtLeast(0) else Int.MAX_VALUE
        val modeWant = modeM?.maxIntrinsicWidth(constraints.maxHeight) ?: 0
        val modelWant = minOf(modelM.maxIntrinsicWidth(constraints.maxHeight), CHIP_MODEL_MAX.roundToPx())
        val modeWidth = if (modeWant + modelWant <= room) modeWant else minOf(modeWant, maxOf(room - modelWant, room / 2))
        val modelWidth = minOf(modelWant, room - modeWidth)
        val modeP = modeM?.measure(Constraints(maxWidth = modeWidth))
        val modelP = modelM.measure(Constraints(maxWidth = modelWidth.coerceAtLeast(0)))
        val placed = listOfNotNull(modeP, modelP, trailingP)
        val height = placed.maxOf { it.height }
        layout(placed.sumOf { it.width } + gap * (placed.size - 1), height) {
            var x = 0
            placed.forEach {
                it.place(x, (height - it.height) / 2)
                x += it.width + gap
            }
        }
    }
}

/** The pages of [SessionOptionsList]: the main one, and one per longer choice. */
internal enum class OptionsPage { Main, Models, Effort, Mode, Mcp }

/** [SessionOptionsList] in a bottom sheet. Back from one of its pages
 *  returns to the main page; only there does it close the sheet. A page
 *  keeps the main page's height, so the sheet does not jump when one opens
 *  and a longer list scrolls inside it. */
@Composable
internal fun SessionOptionsSheet(
    options: SessionOptions,
    onMode: (String) -> Unit,
    onEffort: (String) -> Unit,
    onModel: (String) -> Unit,
    /** The MCP page opened: the servers' state is asked for again. */
    onMcpOpen: () -> Unit,
    onMcpToggle: (name: String, enabled: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    DeckSheet(onDismiss) {
        var page by rememberSaveable { mutableStateOf(OptionsPage.Main) }
        BackHandler(enabled = page != OptionsPage.Main) { page = OptionsPage.Main }
        LaunchedEffect(page) { if (page == OptionsPage.Mcp) onMcpOpen() }
        var mainHeight by remember { mutableStateOf<Int?>(null) }
        val pageHeight = mainHeight?.takeIf { page != OptionsPage.Main }?.let { with(LocalDensity.current) { it.toDp() } }
        SessionOptionsList(
            options,
            page,
            onPage = { page = it },
            onMode,
            onEffort,
            onModel,
            onMcpToggle,
            onClose = onDismiss,
            modifier = if (pageHeight != null) Modifier.height(pageHeight) else Modifier.onSizeChanged { mainHeight = it.height },
        )
    }
}

/** How many models the main page lists before "More models". */
private const val SHORT_MODEL_LIST = 5

/**
 * The session's options, laid out like a model picker: the models (the
 * first few, the one in use always among them, and "More models" for the
 * rest), then a row each for effort, mode and the session's MCP servers,
 * showing the current value. A row opens its own page; a pick there goes
 * back to the main page. Apart from the sheet so a snapshot can show it.
 */
@Composable
internal fun SessionOptionsList(
    options: SessionOptions,
    page: OptionsPage,
    onPage: (OptionsPage) -> Unit,
    onMode: (String) -> Unit,
    onEffort: (String) -> Unit,
    onModel: (String) -> Unit,
    onMcpToggle: (name: String, enabled: Boolean) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(bottom = Tokens.Space4),
    ) {
        val back = Icons.AutoMirrored.Outlined.ArrowBack to { onPage(OptionsPage.Main) }
        when (page) {
            OptionsPage.Main -> {
                SheetHeader(if (options.models.isNotEmpty()) "Select model" else "Session options", null, Icons.Outlined.Close to onClose)
                if (options.models.isNotEmpty()) {
                    val current = options.models.firstOrNull { it.id == options.model }
                    val short = options.models.take(SHORT_MODEL_LIST).let { first ->
                        if (current == null || current in first) first else first.dropLast(1) + current
                    }
                    // A model the list does not (yet) carry is still the one in use.
                    if (options.model != null && current == null) {
                        ModelRow(options.modelName ?: options.model, provider = null, selected = true) {}
                    }
                    short.forEach { m -> ModelRow(m.label ?: m.id, m.provider, selected = m.id == options.model) { onModel(m.id) } }
                }
                val rows = buildList<@Composable () -> Unit> {
                    if (options.models.size > SHORT_MODEL_LIST) add { NavigationRow("More models", null) { onPage(OptionsPage.Models) } }
                    if (options.efforts.isNotEmpty()) add { NavigationRow("Effort", options.effortLabel) { onPage(OptionsPage.Effort) } }
                    if (options.modes.size >= 2) add { NavigationRow("Mode", options.modeLabel) { onPage(OptionsPage.Mode) } }
                    options.mcp?.let { mcp -> add { McpRow(mcp) { onPage(OptionsPage.Mcp) } } }
                }
                if (rows.isNotEmpty()) {
                    Column(
                        Modifier
                            .padding(horizontal = Tokens.Space4)
                            .padding(top = Tokens.Space3)
                            .clip(RoundedCornerShape(Tokens.RadiusLg))
                            .background(Tokens.SurfaceHover),
                    ) {
                        rows.forEachIndexed { i, row ->
                            if (i > 0) HorizontalDivider(thickness = 1.dp, color = Tokens.Border)
                            row()
                        }
                    }
                }
            }
            OptionsPage.Models -> {
                SheetHeader("Models", null, back)
                // Grouped by who serves them, each group named once.
                options.models.groupBy { it.provider }.entries.forEachIndexed { i, (provider, models) ->
                    if (i > 0) HorizontalDivider(Modifier.padding(top = Tokens.Space2), thickness = 1.dp, color = Tokens.Border)
                    provider?.let { ProviderLabel(it) }
                    models.forEach { m ->
                        ModelRow(m.label ?: m.id, provider = null, selected = m.id == options.model) { onModel(m.id) }
                    }
                }
            }
            OptionsPage.Effort -> {
                SheetHeader("Effort", null, back)
                options.efforts.forEach { e ->
                    ChoiceRow(e.label, e.description, selected = e.id == options.effort) {
                        onEffort(e.id)
                        onPage(OptionsPage.Main)
                    }
                }
            }
            OptionsPage.Mode -> {
                SheetHeader("Mode", null, back)
                options.modes.forEach { m ->
                    ChoiceRow(m.label, m.description, selected = m.id == options.mode) {
                        onMode(m.id)
                        onPage(OptionsPage.Main)
                    }
                }
            }
            OptionsPage.Mcp -> {
                SheetHeader("MCP servers", null, back)
                options.mcp?.let { SessionMcpList(it, onMcpToggle) }
            }
        }
    }
}

/** The name over a group of models: who serves them. */
@Composable
private fun ProviderLabel(name: String) {
    Text(
        name,
        color = Tokens.TextMuted,
        fontSize = Tokens.TextSm,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = Tokens.Space5).padding(top = Tokens.Space3, bottom = Tokens.Space1),
    )
}

@Composable
private fun ModelRow(label: String, provider: String?, selected: Boolean, onClick: () -> Unit) =
    ChoiceRow(label, provider, selected, onClick)

/** One choice: its name, a line under it, and a check on the one in use. */
@Composable
private fun ChoiceRow(label: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = !selected, onClick = onClick)
            .padding(horizontal = Tokens.Space5, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = Tokens.Text, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        if (selected) Icon(Icons.Outlined.Check, contentDescription = "In use", tint = Tokens.Text)
    }
}

/** A row that opens a page: its name, the current value, a chevron. */
@Composable
private fun NavigationRow(title: String, value: String?, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .padding(start = Tokens.Space4, end = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Text(title, color = Tokens.Text, fontSize = Tokens.TextLg, modifier = Modifier.weight(1f))
        value?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextMd, maxLines = 1) }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextMuted)
    }
}

@Composable
private fun McpRow(mcp: UniffiSessionMcp, onClick: () -> Unit) {
    val on = mcp.servers.count { it.status != "disabled" }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .padding(start = Tokens.Space4, end = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        Text("MCP servers", color = Tokens.Text, fontSize = Tokens.TextLg, modifier = Modifier.weight(1f))
        Dot(mcpOverallColor(mcp), size = 7.dp)
        Text("$on on", color = Tokens.TextMuted, fontSize = Tokens.TextMd)
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextMuted)
    }
}
