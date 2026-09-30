package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.PermissionOption
import uniffi.client_ffi.UniffiIntent

/** An option's chip color: reject choices read as danger, the first allow
 *  choice as the positive default, further allow choices neutral. */
internal fun permissionOptionColor(option: PermissionOption, options: List<PermissionOption>) = when {
    option.isReject -> Tokens.Danger
    option == options.firstOrNull { !it.isReject } -> Tokens.Success
    else -> Tokens.Text
}

/**
 * Permission card — one chip per option the agent offered; a resolved card
 * shows the outcome inline.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PermissionCard(
    item: DisplayEntry.PermissionRequest,
    machine: String,
    sessionId: String,
    responded: Boolean,
    actions: CardActions,
) {
    val description = item.description?.takeIf { it.isNotBlank() }
    val originNote = if (item.isSubAgent) {
        "${item.agentLabel?.let { "$it agent" } ?: "Sub-agent"} wants to run this"
    } else {
        null
    }

    if (item.answered != null || responded) {
        ResolvedCard(
            title = "${item.toolName} ${item.title}".trim(),
            description = listOfNotNull(description, item.hook?.let { askedBy(item.hookPlugin) }).joinToString("\n").ifEmpty { null },
            outcome = item.answered ?: "Response sent…",
            danger = item.answered != null && Regex("den|reject", RegexOption.IGNORE_CASE).containsMatchIn(item.answered),
        )
        return
    }

    Column(Modifier.interactionCard(waiting = true)) {
        Text("Permission: ${item.toolName}", color = Tokens.Text, fontSize = Tokens.TextMd)
        if (originNote != null) {
            Text(originNote, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        }
        if (item.title.isNotBlank()) {
            Text(item.title, color = Tokens.TextDim, fontFamily = Tokens.FontMono, fontSize = Tokens.TextXs)
        }
        if (description != null && description != item.title) {
            Text(description, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
        AskedBecause(item.reason, item.hook, item.hookPlugin)
        FlowRow(
            Modifier.fillMaxWidth().padding(top = Tokens.Space2),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            item.options.forEach { option ->
                ActionChip(option.label, permissionOptionColor(option, item.options)) {
                    actions(
                        UniffiIntent.RespondPermission(
                            machine = machine,
                            sessionId = sessionId,
                            requestId = item.requestId,
                            optionId = option.id,
                        ),
                    )
                }
            }
        }
    }
}

/** Who asked, when a hook did: the plugin it comes from when that is known.
 *  The hook's own name (`PreToolUse:Bash`) would only repeat the card's tool. */
internal fun askedBy(hookPlugin: String?): String =
    if (hookPlugin != null) "Asked by your $hookPlugin plugin" else "Asked by one of your hooks"

/**
 * Why the agent stopped to ask: the reason in its own words beside a
 * warn-coloured rule, and, when a hook asked, who it belongs to. A hook asks
 * every time, so its card offers no "always" choice; naming it says why.
 */
@Composable
internal fun AskedBecause(reason: String?, hook: String?, hookPlugin: String?) {
    val text = reason?.takeIf { it.isNotBlank() }
    if (text == null && hook == null) return
    Row(Modifier.padding(top = Tokens.Space2).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().clip(RoundedCornerShape(1.dp)).background(Tokens.Warn.copy(alpha = 0.7f)))
        Column(Modifier.padding(start = Tokens.Space3), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            text?.let { Text(it, color = Tokens.Text, fontSize = Tokens.TextSm) }
            if (hook != null) {
                Text(
                    if (hookPlugin == null) {
                        AnnotatedString(askedBy(null))
                    } else {
                        buildAnnotatedString {
                            append("Asked by your ")
                            withStyle(SpanStyle(fontFamily = Tokens.FontMono, color = Tokens.TextMuted)) { append(hookPlugin) }
                            append(" plugin")
                        }
                    },
                    color = Tokens.TextDim,
                    fontSize = Tokens.TextXs,
                )
            }
        }
    }
}

/**
 * The surface every interaction card sits on. While the agent waits on the
 * user the card carries a warn-coloured edge — the same colour that marks a
 * waiting session elsewhere — so a card that needs an answer stands apart
 * from answered ones and from the tool activity around it.
 */
internal fun Modifier.interactionCard(waiting: Boolean): Modifier {
    val shape = RoundedCornerShape(Tokens.RadiusLg)
    return this
        .fillMaxWidth()
        .clip(shape)
        .background(Tokens.SurfaceRaised)
        .let { if (waiting) it.border(1.dp, Tokens.Warn.copy(alpha = 0.7f), shape) else it }
        .padding(Tokens.Space3)
}

@Composable
internal fun ActionChip(
    label: String,
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Text(
        label,
        color = color,
        fontSize = Tokens.TextSm,
        fontWeight = FontWeight.Medium,
        modifier = modifier
            .minimumInteractiveComponentSize()
            .clip(RoundedCornerShape(Tokens.RadiusPill))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
    )
}

@Composable
internal fun ResolvedCard(title: String, description: String?, outcome: String, danger: Boolean) {
    Column(Modifier.interactionCard(waiting = false)) {
        Text(title, color = Tokens.Text, fontSize = Tokens.TextMd)
        description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm) }
        Text(outcome, color = if (danger) Tokens.Danger else Tokens.Success, fontSize = Tokens.TextXs)
    }
}
