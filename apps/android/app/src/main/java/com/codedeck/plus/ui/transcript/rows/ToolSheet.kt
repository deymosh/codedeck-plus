package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.CodeBlock
import com.codedeck.plus.ui.components.DiffStat
import com.codedeck.plus.ui.components.ThinkingGlyph
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.FileDiffView
import com.codedeck.plus.ui.transcript.ToolStep

/**
 * A tool group's details, over the conversation. A group of several steps
 * opens on their timeline, and a tap on a step shows it whole; a lone call
 * opens straight on its own page. [live] says the turn still runs, so a
 * call without a result is running rather than cut short.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolGroupSheet(group: DisplayEntry.ToolGroup, live: Boolean, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
    ) {
        var openStep by remember(group.seq) { mutableStateOf(loneStep(group)?.seq) }
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding()) {
            ToolSheetContent(
                group = group,
                live = live,
                openStep = openStep,
                onOpenStep = { openStep = it },
                onClose = onDismiss,
            )
        }
    }
}

/** The one step a group is, when it is a lone call. */
private fun loneStep(group: DisplayEntry.ToolGroup): ToolStep? =
    if (group.subject != null) group.steps.singleOrNull { it is ToolStep.Call } else null

/** The sheet's content, apart so a snapshot can show it without a window:
 *  the timeline, or the page of step [openStep]. */
@Composable
fun ToolSheetContent(
    group: DisplayEntry.ToolGroup,
    live: Boolean,
    openStep: Long?,
    onOpenStep: (Long?) -> Unit,
    onClose: () -> Unit,
) {
    val step = group.steps.firstOrNull { it.seq == openStep }
    Column(Modifier.fillMaxWidth().padding(bottom = Tokens.Space5)) {
        if (step == null) {
            SheetHeader(
                title = group.summary,
                subtitle = null,
                leading = Icons.Outlined.Close to onClose,
            )
            group.steps.forEachIndexed { i, s ->
                TimelineRow(s, live, first = i == 0, last = i == group.steps.lastIndex) { onOpenStep(s.seq) }
            }
        } else {
            // A lone call's page is the whole sheet: nothing to go back to.
            val lone = loneStep(group) != null
            SheetHeader(
                title = stepTitle(step),
                subtitle = stepStatus(step, live),
                subtitleColor = if ((step as? ToolStep.Call)?.failed == true) Tokens.Danger else Tokens.TextMuted,
                leading = if (lone) Icons.Outlined.Close to onClose else Icons.AutoMirrored.Outlined.ArrowBack to { onOpenStep(null) },
            )
            StepPage(step)
        }
    }
}

@Composable
private fun SheetHeader(
    title: String,
    subtitle: String?,
    leading: Pair<androidx.compose.ui.graphics.vector.ImageVector, () -> Unit>,
    subtitleColor: Color = Tokens.TextMuted,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Space2).padding(bottom = Tokens.Space3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = leading.second) {
            Icon(leading.first, contentDescription = if (leading.first == Icons.Outlined.Close) "Close" else "Back", tint = Tokens.Text)
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                title,
                color = Tokens.Text,
                fontSize = Tokens.TextLg,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) Text(subtitle, color = subtitleColor, fontSize = Tokens.TextSm)
        }
        // Balances the leading button, so the title sits on the centre line.
        Spacer(Modifier.width(Tokens.TapMin))
    }
}

private fun stepTitle(step: ToolStep): String = when (step) {
    is ToolStep.Call -> step.toolName
    is ToolStep.Thinking -> "Thinking"
    is ToolStep.Text -> "Sub-agent"
    is ToolStep.Result -> "Result"
}

private fun stepStatus(step: ToolStep, live: Boolean): String? = when (step) {
    is ToolStep.Call -> when {
        step.result == null -> if (live) "Running" else "No result"
        step.failed -> "Failed"
        else -> "Completed"
    }
    else -> null
}

/** One step on the timeline: its icon on the line joining the steps, what
 *  it did, and — for a call that failed — the first line of why. */
@Composable
private fun TimelineRow(step: ToolStep, live: Boolean, first: Boolean, last: Boolean, onOpen: () -> Unit) {
    val call = step as? ToolStep.Call
    val running = call != null && call.result == null && live
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clickable(onClick = onOpen)
            .padding(horizontal = Tokens.Space5),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Column(Modifier.width(24.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            Connector(visible = !first, Modifier.height(10.dp))
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                if (running) {
                    ThinkingGlyph(fontSize = Tokens.TextMd)
                } else {
                    Icon(
                        stepIcon(step),
                        contentDescription = null,
                        tint = if (call?.failed == true) Tokens.Danger else Tokens.TextMuted,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Connector(visible = !last, Modifier.weight(1f))
        }
        Column(
            Modifier.weight(1f).heightIn(min = 44.dp).padding(top = 10.dp, bottom = Tokens.Space3),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text(
                    stepLine(step, running),
                    color = Tokens.Text,
                    fontSize = Tokens.TextMd,
                    maxLines = if (step is ToolStep.Text) 3 else 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (call != null && call.added + call.removed > 0) DiffStat(call.added, call.removed)
            }
            val why = call?.result?.takeIf { it.isError }?.text?.lineSequence()?.firstOrNull { it.isNotBlank() }
            if (why != null) {
                Text(why, color = Tokens.Danger, fontSize = Tokens.TextSm, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (call?.isSubAgent == true) {
                Text("by ${call.subagent ?: "a sub-agent"}", color = Tokens.TextDim, fontSize = Tokens.TextXs)
            }
        }
    }
}

@Composable
private fun Connector(visible: Boolean, modifier: Modifier) {
    Box(modifier.width(1.dp).background(if (visible) Tokens.BorderStrong else Color.Transparent))
}

private fun stepLine(step: ToolStep, running: Boolean) = when (step) {
    is ToolStep.Call -> verbAndSubject(if (running) step.activeVerb else step.verb, step.title)
    is ToolStep.Thinking -> verbAndSubject("Thought", null, step.text.firstLine()?.let { " · $it" }.orEmpty())
    is ToolStep.Text -> verbAndSubject(step.text, null)
    is ToolStep.Result -> verbAndSubject("Result", step.text.firstLine())
}

private fun String.firstLine(): String? = lineSequence().firstOrNull { it.isNotBlank() }?.trim()

/** A step shown whole: what it was given, what it changed, what came back. */
@Composable
private fun StepPage(step: ToolStep) {
    Column(Modifier.padding(horizontal = Tokens.Space4), verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
        when (step) {
            is ToolStep.Call -> CallPage(step)
            is ToolStep.Thinking -> Section(null) {
                Prose(if (step.redacted) "The model's reasoning for this step was withheld by its provider." else step.text)
            }
            is ToolStep.Text -> Section(null) { Prose(step.text) }
            is ToolStep.Result -> Section("Output") { CodeBlock(step.text, color = if (step.isError) Tokens.Danger else Tokens.Text) }
        }
    }
}

@Composable
private fun CallPage(call: ToolStep.Call) {
    val given = call.input ?: call.title
    when (call.toolKind) {
        "execute" -> Section("Command") { CodeBlock(given) }
        "agent" -> {
            Section("Task") { Prose(call.title) }
            call.input?.let { Section("Instructions") { Prose(it) } }
        }
        "edit", "delete", "move" -> if (call.diffs.isEmpty()) Section("File") { CodeBlock(call.title) }
        "read" -> Section("File") { CodeBlock(given) }
        else -> if (given.isNotBlank()) Section("Input") { CodeBlock(given) }
    }
    call.diffs.forEach { FileChange(it) }
    call.result?.let { result ->
        if (result.text.isNotBlank()) {
            val label = when {
                result.isError -> "Error"
                call.toolKind == "agent" -> "Report"
                else -> "Output"
            }
            Section(label) {
                if (call.toolKind == "agent" && !result.isError) Prose(result.text)
                else CodeBlock(result.text, color = if (result.isError) Tokens.Danger else Tokens.Text)
            }
        }
    }
}

/** One changed file: its name over its folder, the lines it gained and
 *  lost, and the change. A file written from nothing reads as the file
 *  itself, numbered from its first line. */
@Composable
private fun FileChange(diff: FileDiffView) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Column(Modifier.weight(1f)) {
                Text(diff.path.substringAfterLast('/'), color = Tokens.Text, fontSize = Tokens.TextSm, fontFamily = Tokens.FontMono, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val dir = diff.path.substringBeforeLast('/', "")
                if (dir.isNotEmpty()) {
                    Text(dir, color = Tokens.TextDim, fontSize = Tokens.TextXs, fontFamily = Tokens.FontMono, maxLines = 1, overflow = TextOverflow.StartEllipsis)
                }
            }
            DiffStat(diff.added, diff.removed)
        }
        if (diff.removed == 0 && diff.lines.all { it.type == "add" }) {
            CodeBlock(diff.lines.joinToString("\n") { it.text }, lineNumbers = true)
        } else {
            DiffLines(
                diff.lines,
                Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusMd))
                    .background(Tokens.SurfaceInput)
                    .padding(vertical = Tokens.Space2),
                fontSize = Tokens.TextSm,
            )
        }
        if (diff.truncated) Text("Only the start of this change was sent.", color = Tokens.TextDim, fontSize = Tokens.TextXs)
    }
}

@Composable
private fun Section(label: String?, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        if (label != null) Text(label, color = Tokens.TextMuted, fontSize = Tokens.TextSm, fontWeight = FontWeight.Medium)
        content()
    }
}

@Composable
private fun Prose(text: String) {
    SelectionContainer {
        Text(text, color = Tokens.Text, fontSize = Tokens.TextMd, lineHeight = Tokens.TextMd * 1.45f)
    }
}
