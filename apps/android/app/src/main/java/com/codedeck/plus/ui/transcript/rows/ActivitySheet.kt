package com.codedeck.plus.ui.transcript.rows

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.RadioButtonChecked
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.ThinkingGlyph
import com.codedeck.plus.ui.components.pulsingAlpha
import com.codedeck.plus.ui.components.DeckSheet
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.ActivityView
import com.codedeck.plus.ui.transcript.AgentActivity
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.TaskActivity
import com.codedeck.plus.ui.transcript.TodoItem
import com.codedeck.plus.ui.transcript.ToolStep

/** A checklist item still to do or being done. */
private val TodoItem.open: Boolean get() = status == "pending" || status == "in_progress"

/** The session has something going on worth a line above the composer: a
 *  sub-agent or a background task still running, or a plan not done. */
fun ActivityView.ongoing(): Boolean =
    agents.any { !it.finished } || tasks.any { it.running } || todos.any { it.open }

/** A sub-agent's latest step as a line: the call it waits on, else the one
 *  it made last. Mirrors the core's `AgentView.current`. */
internal fun agentCurrent(children: List<ToolStep>): String? = when (val last = children.lastOrNull()) {
    is ToolStep.Call -> "${if (last.result == null) last.activeVerb else last.verb} ${last.title}"
    is ToolStep.Thinking -> "Thinking"
    is ToolStep.Text -> last.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim()
    else -> null
}

private fun taskIcon(kind: String): ImageVector = when (kind) {
    "shell" -> Icons.Outlined.Terminal
    "agent" -> Icons.Outlined.SmartToy
    else -> Icons.Outlined.Build
}

/** Where an item's segment sits on the meter: done first, so the bar fills
 *  from the left however the agent orders its list. */
private fun meterRank(status: String) = when (status) {
    "completed" -> 0
    "in_progress" -> 1
    "pending" -> 2
    else -> 3
}

/**
 * The plan as one bar cut into a segment per item: done is solid, the item
 * being worked on breathes while [live], what is left is a faint track and a
 * dropped item fainter still. How far along the agent is, read at a glance.
 */
@Composable
fun PlanMeter(todos: List<TodoItem>, live: Boolean, modifier: Modifier = Modifier) {
    val pulse = pulsingAlpha(min = 0.35f, max = 1f, halfPeriodMs = 700)
    Row(modifier.height(4.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        todos.sortedBy { meterRank(it.status) }.forEach { item ->
            val color = when (item.status) {
                "completed" -> Tokens.Text
                "in_progress" -> Tokens.Text
                "cancelled" -> Tokens.Border
                else -> Tokens.BorderStrong
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .graphicsLayer { alpha = if (item.status == "in_progress") (if (live) pulse else 0.6f) else 1f }
                    .background(color),
            )
        }
    }
}

/** The plan item by item: done ones struck through, the one being worked on
 *  as the agent says it ("Running the tests") and bright, the rest plain. */
@Composable
fun TodoList(todos: List<TodoItem>, live: Boolean) {
    Column {
        todos.forEach { item ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 32.dp).padding(vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                    when (item.status) {
                        "in_progress" -> if (live) ThinkingGlyph(fontSize = Tokens.TextMd) else StatusIcon(Icons.Outlined.RadioButtonChecked, Tokens.Text)
                        "completed" -> StatusIcon(Icons.Outlined.Check, Tokens.TextMuted)
                        "cancelled" -> StatusIcon(Icons.Outlined.Close, Tokens.TextDim)
                        else -> StatusIcon(Icons.Outlined.RadioButtonUnchecked, Tokens.TextDim)
                    }
                }
                Text(
                    if (item.status == "in_progress") item.activeText ?: item.text else item.text,
                    color = when (item.status) {
                        "in_progress" -> Tokens.Text
                        "pending" -> Tokens.Text
                        "completed" -> Tokens.TextMuted
                        else -> Tokens.TextDim
                    },
                    fontSize = Tokens.TextMd,
                    fontWeight = if (item.status == "in_progress") FontWeight.Medium else FontWeight.Normal,
                    textDecoration = if (item.status == "completed" || item.status == "cancelled") TextDecoration.LineThrough else null,
                )
            }
        }
    }
}

@Composable
private fun StatusIcon(icon: ImageVector, tint: Color) {
    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
}

/** A count beside its icon: how many sub-agents or background commands
 *  are running. */
@Composable
private fun Counter(icon: ImageVector, count: Int, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(icon, contentDescription = label, tint = Tokens.TextMuted, modifier = Modifier.size(16.dp))
        Text("$count", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
    }
}

/**
 * The line above the composer while the session has something going on:
 * the plan's meter, what the agent says it is doing, and how many
 * sub-agents and background commands run. A tap opens the activity sheet.
 */
@Composable
fun ActivityBar(activity: ActivityView, live: Boolean, onOpen: () -> Unit) {
    val runningAgents = activity.agents.filter { !it.finished }
    val runningTasks = activity.tasks.filter { it.running }
    val doing = activity.todos.firstOrNull { it.status == "in_progress" }
    val headline = when {
        doing != null -> doing.activeText ?: doing.text
        runningAgents.isNotEmpty() -> runningAgents.first().let { it.current ?: it.title }
        runningTasks.isNotEmpty() -> runningTasks.first().title
        else -> activity.todos.firstOrNull { it.open }?.text ?: "Activity"
    }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .clickable(onClickLabel = "Show activity", onClick = onOpen)
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        if (activity.todos.isNotEmpty()) PlanMeter(activity.todos, live, Modifier.width(48.dp))
        Text(
            headline,
            color = Tokens.Text,
            fontSize = Tokens.TextSm,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (runningAgents.isNotEmpty()) Counter(Icons.Outlined.SmartToy, runningAgents.size, "Sub-agents running")
        if (runningTasks.isNotEmpty()) Counter(Icons.Outlined.Terminal, runningTasks.size, "Background tasks running")
        Icon(Icons.Outlined.KeyboardArrowUp, contentDescription = null, tint = Tokens.TextDim, modifier = Modifier.size(18.dp))
    }
}

/** The activity sheet over the conversation; see [ActivitySheetContent]. */
@Composable
fun ActivitySheet(
    activity: ActivityView,
    live: Boolean,
    canStop: Boolean,
    onOpenAgent: (AgentActivity) -> Unit,
    onStopTask: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    DeckSheet(onDismiss, skipPartiallyExpanded = false) {
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding()) {
            ActivitySheetContent(activity, live, canStop, onOpenAgent, onStopTask, onDismiss)
        }
    }
}

/**
 * What the session has going on beside the conversation: the plan, the
 * sub-agents (a tap opens the one on its own page) and the background
 * tasks, each running one with Stop when the agent can stop it ([canStop]).
 */
@Composable
fun ActivitySheetContent(
    activity: ActivityView,
    live: Boolean,
    canStop: Boolean,
    onOpenAgent: (AgentActivity) -> Unit,
    onStopTask: (String) -> Unit,
    onClose: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(bottom = Tokens.Space5), verticalArrangement = Arrangement.spacedBy(Tokens.Space4)) {
        SheetHeader(title = "Activity", subtitle = null, leading = Icons.Outlined.Close to onClose)
        if (activity.todos.isNotEmpty()) {
            Column(Modifier.padding(horizontal = Tokens.Space5), verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionTitle("Plan", Modifier.weight(1f))
                    Text(
                        "${activity.todos.count { it.status == "completed" }} of ${activity.todos.size} done",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                    )
                }
                PlanMeter(activity.todos, live, Modifier.fillMaxWidth().padding(bottom = Tokens.Space1))
                TodoList(activity.todos, live)
            }
        }
        if (activity.agents.isNotEmpty()) {
            Column {
                SectionTitle("Agents", Modifier.padding(horizontal = Tokens.Space5, vertical = Tokens.Space1))
                activity.agents.forEach { AgentLine(it, live) { onOpenAgent(it) } }
            }
        }
        if (activity.tasks.isNotEmpty()) {
            Column {
                SectionTitle("In the background", Modifier.padding(horizontal = Tokens.Space5, vertical = Tokens.Space1))
                activity.tasks.forEach { TaskLine(it, live, canStop) { onStopTask(it.taskId) } }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Tokens.TextMuted, fontSize = Tokens.TextSm, fontWeight = FontWeight.Medium, modifier = modifier)
}

/** The leading mark of a line: the running glyph, or [icon] in [tint]. */
@Composable
private fun LineMark(running: Boolean, icon: ImageVector, tint: Color) {
    Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
        if (running) ThinkingGlyph(fontSize = Tokens.TextMd) else Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

/** One sub-agent: what it was asked, then its kind and what it is doing
 *  (or how it ended). */
@Composable
private fun AgentLine(agent: AgentActivity, live: Boolean, onOpen: () -> Unit) {
    val running = !agent.finished && live
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = Tokens.Space5, vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        LineMark(
            running,
            when {
                agent.failed -> Icons.Outlined.ErrorOutline
                agent.finished -> Icons.Outlined.Check
                else -> Icons.Outlined.SmartToy
            },
            if (agent.failed) Tokens.Danger else Tokens.TextMuted,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(agent.title, color = Tokens.Text, fontSize = Tokens.TextMd, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val detail = when {
                agent.failed -> "Failed"
                agent.finished -> "Reported back" + (if (agent.toolUses > 0) " after ${plural(agent.toolUses, "tool use")}" else "")
                else -> agent.current ?: "Starting"
            }
            Text(
                listOfNotNull(agent.label, detail).joinToString(": "),
                color = if (agent.failed) Tokens.Danger else Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = "Open", tint = Tokens.TextDim, modifier = Modifier.size(18.dp))
    }
}

private fun plural(n: Int, noun: String) = if (n == 1) "1 $noun" else "$n ${noun}s"

/** One background task: its command or title, where it stands, and Stop
 *  while it runs. */
@Composable
private fun TaskLine(task: TaskActivity, live: Boolean, canStop: Boolean, onStop: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space2).padding(vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        // A task outlives the turn that started it, so it runs whether or
        // not the turn does; the glyph only moves while the screen is live.
        LineMark(task.running && live, taskIcon(task.taskKind), if (task.status == "failed") Tokens.Danger else Tokens.TextMuted)
        Column(Modifier.weight(1f).padding(vertical = Tokens.Space1), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                task.title,
                color = Tokens.Text,
                fontSize = if (task.taskKind == "shell") Tokens.TextSm else Tokens.TextMd,
                fontFamily = if (task.taskKind == "shell") Tokens.FontMono else null,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val state = when (task.status) {
                "running" -> "Running"
                "completed" -> "Finished"
                "failed" -> "Failed"
                "stopped" -> "Stopped"
                else -> task.status
            }
            Text(
                listOfNotNull(state, task.summary).joinToString(": "),
                color = if (task.status == "failed") Tokens.Danger else Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (task.running && canStop) QuietButton("Stop", onClick = onStop, danger = true)
    }
}

/**
 * A background task in the conversation, as a quiet line: what ran and how
 * it ended ("Background command `cargo watch` failed"), with the agent's
 * word on it below when it gave one. The status word alone carries colour,
 * and only when it failed.
 */
@Composable
fun TaskRow(task: DisplayEntry.Task) {
    val noun = when (task.taskKind) {
        "shell" -> "Background command"
        "agent" -> "Background agent"
        else -> "Background task"
    }
    val (word, color) = when (task.status) {
        "running" -> "started" to Tokens.TextMuted
        "completed" -> "finished" to Tokens.TextMuted
        "failed" -> "failed" to Tokens.Danger
        "stopped" -> "was stopped" to Tokens.TextMuted
        else -> task.status to Tokens.TextMuted
    }
    Column(
        Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = Tokens.Space1, vertical = Tokens.Space1),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(
                if (task.status == "stopped") Icons.Outlined.StopCircle else taskIcon(task.taskKind),
                contentDescription = null,
                tint = Tokens.TextDim,
                modifier = Modifier.size(16.dp),
            )
            Text(
                verbAndSubject(noun, task.title),
                color = Tokens.TextMuted,
                fontSize = Tokens.TextMd,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(word, color = color, fontSize = Tokens.TextMd, maxLines = 1)
        }
        task.summary?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                color = Tokens.TextDim,
                fontSize = Tokens.TextSm,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 22.dp),
            )
        }
    }
}
