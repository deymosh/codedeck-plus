package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Psychology
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material.icons.outlined.SubdirectoryArrowRight
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.components.DiffStat
import com.codedeck.plus.ui.components.ThinkingGlyph
import com.codedeck.plus.ui.components.pulsingAlpha
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.ToolStep

/** The icon a tool kind is drawn with, in rows and in the sheet. */
internal fun toolKindIcon(kind: String): ImageVector = when (kind) {
    "read" -> Icons.Outlined.Visibility
    "edit" -> Icons.Outlined.Description
    "delete" -> Icons.Outlined.Delete
    "move" -> Icons.Outlined.DriveFileMove
    "search" -> Icons.Outlined.Search
    "execute" -> Icons.Outlined.Terminal
    "think" -> Icons.Outlined.Checklist
    "fetch" -> Icons.Outlined.Language
    "switch_mode" -> Icons.Outlined.SwapHoriz
    "agent" -> Icons.Outlined.SmartToy
    else -> Icons.Outlined.Build
}

internal fun stepIcon(step: ToolStep): ImageVector = when (step) {
    is ToolStep.Call -> toolKindIcon(step.toolKind)
    is ToolStep.Thinking -> Icons.Outlined.Psychology
    is ToolStep.Text -> Icons.Outlined.ChatBubbleOutline
    is ToolStep.Result -> Icons.Outlined.SubdirectoryArrowRight
}

/** A verb followed by what it acted on, in the monospace face when that is
 *  code ([mono]): "Ran" + "npm test". */
internal fun verbAndSubject(verb: String, subject: String?, suffix: String = "", mono: Boolean = true): AnnotatedString = buildAnnotatedString {
    append(verb)
    if (!subject.isNullOrBlank()) {
        append(" ")
        if (mono) withStyle(SpanStyle(fontFamily = Tokens.FontMono, fontSize = Tokens.TextSm)) { append(subject) } else append(subject)
    }
    append(suffix)
}

/** A call's title is prose, not code, for a sub-agent's task or a plan. */
internal val ToolStep.Call.proseTitle: Boolean get() = toolKind == "agent" || toolKind == "think"

/**
 * A run of tool activity as one quiet line of the conversation: what it
 * did ("Ran 3 commands, read a file", or "Ran" and the command), how many
 * calls failed, the lines it changed, and a chevron — the details open in
 * a sheet. While [live] and a call is still waiting on its result, the
 * running glyph leads the line.
 */
@Composable
fun ToolGroupRow(group: DisplayEntry.ToolGroup, live: Boolean, onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 36.dp)
            .clickable(onClick = onOpen)
            .padding(horizontal = Tokens.Space1, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (live && group.runningCall != null) {
            ThinkingGlyph(color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
        Text(
            verbAndSubject(group.summary, group.subject),
            color = Tokens.TextMuted,
            fontSize = Tokens.TextMd,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (group.failed > 0) {
            Text(
                if (group.subject != null) "failed" else "${group.failed} failed",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                maxLines = 1,
            )
        }
        if (group.added + group.removed > 0) DiffStat(group.added, group.removed)
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = "Show details",
            tint = Tokens.TextDim,
            modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * What the agent is doing right now, as the conversation's last line: the
 * call it waits on ("Running" + its command) when the last row is tool
 * activity, else "Thinking". Null when there is nothing to say beyond
 * that the turn runs.
 */
fun activityOf(entries: List<DisplayEntry>): ToolStep.Call? =
    (entries.lastOrNull() as? DisplayEntry.ToolGroup)?.runningCall

/**
 * The running turn's line at the end of the transcript: the spinner glyph
 * and what the agent is doing. While it waits on a sub-agent, the line says
 * what that agent was asked, and under it what the agent is doing now.
 * Tapping it opens the activity it names, when [onOpen] is given.
 */
@Composable
fun ActivityRow(call: ToolStep.Call?, onOpen: (() -> Unit)?) {
    val alpha = pulsingAlpha(min = 0.55f, max = 1f, halfPeriodMs = 900)
    if (call != null && call.toolKind == "agent") {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp)
                .then(if (onOpen != null) Modifier.clickable(onClick = onOpen) else Modifier)
                .padding(horizontal = Tokens.Space1, vertical = Tokens.Space1),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ThinkingGlyph(fontSize = Tokens.TextMd)
            Column(Modifier.weight(1f)) {
                Text(
                    "${call.activeVerb} ${call.title}",
                    color = Tokens.Text,
                    fontSize = Tokens.TextMd,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.graphicsLayer { this.alpha = alpha },
                )
                Text(
                    agentCurrent(call.children) ?: "Starting",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (onOpen != null) {
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = "Show details",
                    tint = Tokens.TextDim,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        return
    }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 36.dp)
            .then(if (onOpen != null) Modifier.clickable(onClick = onOpen) else Modifier)
            .padding(horizontal = Tokens.Space1, vertical = Tokens.Space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ThinkingGlyph(fontSize = Tokens.TextMd)
        Text(
            // A title cut short already ends in an ellipsis.
            if (call != null) verbAndSubject(call.activeVerb, call.title, if (call.title.endsWith("…")) "" else "…", mono = !call.proseTitle) else AnnotatedString("Thinking…"),
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).graphicsLayer { this.alpha = alpha },
        )
        if (onOpen != null) {
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = "Show details",
                tint = Tokens.TextDim,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
