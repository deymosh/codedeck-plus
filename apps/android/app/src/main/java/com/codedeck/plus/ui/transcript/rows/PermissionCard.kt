package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
            description = description,
            outcome = item.answered ?: "Response sent…",
            danger = item.answered != null && Regex("den|reject", RegexOption.IGNORE_CASE).containsMatchIn(item.answered),
        )
        return
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
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
        modifier = modifier
            .minimumInteractiveComponentSize()
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
    )
}

@Composable
internal fun ResolvedCard(title: String, description: String?, outcome: String, danger: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
        Text(title, color = Tokens.Text, fontSize = Tokens.TextMd)
        description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm) }
        Text(outcome, color = if (danger) Tokens.Danger else Tokens.Success, fontSize = Tokens.TextXs)
    }
}
