package com.codedeck.plus.ui.transcript.rows

import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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
 * opens straight on its own page. A sub-agent's call shows the steps it took
 * on its page, and those open the same way. [live] says the turn still
 * runs, so a call without a result is running rather than cut short.
 * [openAt] opens it on a step instead: the seqs from the group's step down
 * to the one to show.
 *
 * Back, the system's or the header's, goes where the header's arrow does:
 * from a step to the steps it was opened from, and from the page it opened
 * on to [onBackOut] when it was opened from somewhere else (the activity
 * sheet). Only where there is nothing to go back to does it close.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolGroupSheet(
    group: DisplayEntry.ToolGroup,
    live: Boolean,
    openAt: List<Long>?,
    onDismiss: () -> Unit,
    onBackOut: (() -> Unit)? = null,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
    ) {
        val start = openAt ?: listOfNotNull(loneStep(group)?.seq)
        var path by remember(group.seq, openAt) { mutableStateOf(start) }
        val back = sheetBack(group, path, entry = start, onBackOut) { path = it }
        BackHandler(enabled = back != null) { back?.invoke() }
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding()) {
            ToolSheetContent(
                group = group,
                live = live,
                openPath = path,
                onOpenPath = { path = it },
                onClose = onDismiss,
                onBack = back,
            )
        }
    }
}

/** Where Back goes from [path]: out to [onBackOut] from the [entry] page
 *  when there is one, else up a step — or nowhere (the sheet closes) on
 *  the timeline and on a lone call's own page. */
internal fun sheetBack(
    group: DisplayEntry.ToolGroup,
    path: List<Long>,
    entry: List<Long>,
    onBackOut: (() -> Unit)?,
    onPath: (List<Long>) -> Unit,
): (() -> Unit)? = when {
    onBackOut != null && path == entry -> onBackOut
    path.isEmpty() || (path.size == 1 && loneStep(group) != null) -> null
    else -> { { onPath(path.dropLast(1)) } }
}

/** The one step a group is, when it is a lone call. */
private fun loneStep(group: DisplayEntry.ToolGroup): ToolStep? =
    if (group.subject != null) group.steps.singleOrNull { it is ToolStep.Call } else null

/** The step [path] leads to: each seq names a step among the previous
 *  one's sub-agent steps, starting from the group's. */
private fun resolve(group: DisplayEntry.ToolGroup, path: List<Long>): ToolStep? {
    var steps = group.steps
    var step: ToolStep? = null
    for (seq in path) {
        step = steps.firstOrNull { it.seq == seq } ?: return null
        steps = (step as? ToolStep.Call)?.children.orEmpty()
    }
    return step
}

/** The sheet's content, apart so a snapshot can show it without a window:
 *  the timeline, or the page of the step [openPath] leads to. [onBack]
 *  overrides where a step page's arrow goes ([ToolGroupSheet] says). */
@Composable
fun ToolSheetContent(
    group: DisplayEntry.ToolGroup,
    live: Boolean,
    openPath: List<Long>,
    onOpenPath: (List<Long>) -> Unit,
    onClose: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val step = resolve(group, openPath)
    Column(Modifier.fillMaxWidth().padding(bottom = Tokens.Space5)) {
        if (step == null) {
            SheetHeader(
                title = group.summary,
                subtitle = null,
                leading = Icons.Outlined.Close to onClose,
            )
            Timeline(group.steps, live, showAgent = true) { onOpenPath(listOf(it)) }
        } else {
            // A lone call's page is the whole sheet: nothing to go back to.
            val lone = openPath.size == 1 && loneStep(group) != null
            SheetHeader(
                title = stepTitle(step),
                subtitle = stepStatus(step, live),
                subtitleColor = if ((step as? ToolStep.Call)?.failed == true) Tokens.Danger else Tokens.TextMuted,
                leading = when {
                    onBack != null -> Icons.AutoMirrored.Outlined.ArrowBack to onBack
                    lone -> Icons.Outlined.Close to onClose
                    else -> Icons.AutoMirrored.Outlined.ArrowBack to { onOpenPath(openPath.dropLast(1)) }
                },
            )
            StepPage(step, live) { onOpenPath(openPath + it) }
        }
    }
}

/** Steps on the line joining them; a tap opens one by its seq. */
@Composable
private fun Timeline(steps: List<ToolStep>, live: Boolean, showAgent: Boolean, inset: Dp = Tokens.Space5, onOpen: (Long) -> Unit) {
    steps.forEachIndexed { i, s ->
        TimelineRow(s, live, first = i == 0, last = i == steps.lastIndex, showAgent = showAgent, inset = inset) { onOpen(s.seq) }
    }
}

/** A sheet's top line: Close or Back, and its title centred. */
@Composable
internal fun SheetHeader(
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
    is ToolStep.Call -> if (step.todos.isNotEmpty()) "Plan" else step.toolName
    is ToolStep.Thinking -> "Thinking"
    is ToolStep.Text -> "Sub-agent"
    is ToolStep.Result -> "Result"
}

private fun stepStatus(step: ToolStep, live: Boolean): String? = when (step) {
    is ToolStep.Call -> when {
        step.background != null && step.result?.isError != true -> backgroundStatus(step.background)
        step.result == null -> if (live) "Running" else "No result"
        step.failed -> "Failed"
        else -> "Completed"
    }
    else -> null
}

/** Where a background task stands, as a call's status says it. */
internal fun backgroundStatus(status: String): String = when (status) {
    "running" -> "Running in the background"
    "completed" -> "Finished in the background"
    "failed" -> "Failed in the background"
    "stopped" -> "Stopped"
    else -> status
}

/** "3 tool uses": how much a sub-agent did. */
internal fun toolUses(steps: List<ToolStep>): String? {
    val n = steps.count { it is ToolStep.Call }
    return if (n == 0) null else if (n == 1) "1 tool use" else "$n tool uses"
}

/** One step on the timeline: its icon on the line joining the steps, what
 *  it did, and — for a call that failed — the first line of why. A step
 *  taken by a sub-agent names it when [showAgent]; on that agent's own page
 *  it goes without saying. */
@Composable
private fun TimelineRow(step: ToolStep, live: Boolean, first: Boolean, last: Boolean, showAgent: Boolean, inset: Dp, onOpen: () -> Unit) {
    val call = step as? ToolStep.Call
    val running = call != null && call.result == null && live
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clickable(onClick = onOpen)
            .padding(horizontal = inset),
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
            val aside = listOfNotNull(
                call?.takeIf { it.isSubAgent && showAgent }?.let { "by ${it.subagent ?: "a sub-agent"}" },
                call?.children?.let(::toolUses),
                call?.background?.takeIf { it == "running" }?.let(::backgroundStatus),
            )
            if (aside.isNotEmpty()) {
                Text(aside.joinToString(", "), color = Tokens.TextDim, fontSize = Tokens.TextXs)
            }
        }
    }
}

@Composable
private fun Connector(visible: Boolean, modifier: Modifier) {
    Box(modifier.width(1.dp).background(if (visible) Tokens.BorderStrong else Color.Transparent))
}

private fun stepLine(step: ToolStep, running: Boolean) = when (step) {
    // A plan's title only repeats what writing one does.
    is ToolStep.Call -> if (step.todos.isNotEmpty()) {
        AnnotatedString(if (running) "Updating the plan" else "Updated the plan")
    } else {
        verbAndSubject(if (running) step.activeVerb else step.verb, step.title, mono = !step.proseTitle)
    }
    is ToolStep.Thinking -> verbAndSubject("Thought", null, step.text.firstLine()?.let { " · $it" }.orEmpty())
    is ToolStep.Text -> verbAndSubject(step.text, null)
    is ToolStep.Result -> verbAndSubject("Result", step.text.firstLine())
}

private fun String.firstLine(): String? = lineSequence().firstOrNull { it.isNotBlank() }?.trim()

/** A step shown whole: what it was given, what it changed, what came back.
 *  A sub-agent's steps open by their seq through [onOpenChild]. */
@Composable
private fun StepPage(step: ToolStep, live: Boolean, onOpenChild: (Long) -> Unit) {
    Column(Modifier.padding(horizontal = Tokens.Space4), verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
        when (step) {
            is ToolStep.Call -> CallPage(step, live, onOpenChild)
            is ToolStep.Thinking -> Section(null) {
                Prose(if (step.redacted) "The model's reasoning for this step was withheld by its provider." else step.text)
            }
            is ToolStep.Text -> Section(null) { Prose(step.text) }
            is ToolStep.Result -> Section("Output") { CodeBlock(step.text, color = if (step.isError) Tokens.Danger else Tokens.Text) }
        }
    }
}

@Composable
private fun CallPage(call: ToolStep.Call, live: Boolean, onOpenChild: (Long) -> Unit) {
    val given = call.input ?: call.title
    when {
        call.todos.isNotEmpty() -> Section("Plan") { TodoList(call.todos, live) }
        call.toolKind == "execute" -> Section("Command") { CodeBlock(given) }
        call.toolKind == "agent" -> {
            Section("Task") { Prose(call.title) }
            call.input?.let { Section("Instructions") { Prose(it) } }
            if (call.children.isNotEmpty()) {
                Section(toolUses(call.children)?.let { "Steps, $it" } ?: "Steps") {
                    Column {
                        // Its steps run while it has not reported back.
                        Timeline(call.children, live && call.result == null, showAgent = false, inset = 0.dp, onOpen = onOpenChild)
                    }
                }
            }
        }
        call.toolKind in setOf("edit", "delete", "move") -> if (call.diffs.isEmpty()) Section("File") { CodeBlock(call.title) }
        call.toolKind == "read" -> Section("File") { CodeBlock(given) }
        else -> if (given.isNotBlank()) Section("Input") { CodeBlock(given) }
    }
    call.diffs.forEach { FileChange(it) }
    call.result?.let { result ->
        // A plan's result only acknowledges it.
        if (result.text.isNotBlank() && (call.todos.isEmpty() || result.isError)) {
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
