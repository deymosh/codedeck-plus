package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.metaObj
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import uniffi.client_ffi.UniffiIntent

/** Compact one-line summary of the tool input (the card's subtitle) — port
 *  of `PermissionCard.tsx`'s `summarizeToolInput`. */
fun summarizeToolInput(toolInput: JsonObject?): String {
    // snake_case keys are Claude Code tool inputs, camelCase ones OpenCode's.
    val keys = listOf("command", "file_path", "filePath", "notebook_path", "pattern", "url", "query", "description")
    val first = keys.firstNotNullOfOrNull { k -> (toolInput?.get(k) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } }
    val summary = first ?: toolInput?.toString().orEmpty()
    return if (summary.length > 200) summary.take(200) + "…" else summary
}

/**
 * Permission card — Allow / Always(-domain) / Deny; resolved cards show the
 * outcome inline. Port of `PermissionCard.tsx`.
 */
@Composable
fun PermissionCard(
    item: DisplayEntry.PermissionRequest,
    machine: String,
    sessionId: String,
    responded: Boolean,
    actions: CardActions,
) {
    val inputSummary = summarizeToolInput(item.entry.metadata.metaObj("tool_input"))
    val originNote = if (item.isSubAgent) {
        "${item.agentLabel?.let { "$it agent" } ?: "Sub-agent"} wants to run this"
    } else {
        null
    }

    if (item.answered != null) {
        val denied = Regex("denied|deny", RegexOption.IGNORE_CASE).containsMatchIn(item.answered)
        ResolvedCard(item.toolName, item.description, if (denied) "Denied" else "Allowed", denied)
        return
    }
    if (responded) {
        ResolvedCard(item.toolName, item.description, "Response sent…", danger = false)
        return
    }

    val isWebTool = item.toolName == "WebFetch" || item.toolName == "WebSearch"
    val alwaysLabel = if (isWebTool) "Allow domain" else "Always allow"

    fun respond(allow: Boolean, modifier: String? = null) {
        actions(
            UniffiIntent.RespondPermission(
                machine = machine,
                sessionId = sessionId,
                requestId = item.requestId,
                allow = allow,
                modifier = modifier,
            ),
        )
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
        Text(item.description, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        if (inputSummary.isNotEmpty() && inputSummary != item.description) {
            Text(
                inputSummary,
                color = Tokens.TextDim,
                fontFamily = Tokens.FontMono,
                fontSize = Tokens.TextXs,
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(top = Tokens.Space2),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            ActionChip("Allow", Tokens.Success) { respond(true) }
            ActionChip(alwaysLabel, Tokens.Text) { respond(true, "always") }
            ActionChip("Deny", Tokens.Danger) { respond(false) }
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
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
    )
}

@Composable
internal fun ResolvedCard(title: String, description: String, outcome: String, danger: Boolean) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
        Text(title, color = Tokens.Text, fontSize = Tokens.TextMd)
        Text(description, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        Text(outcome, color = if (danger) Tokens.Danger else Tokens.Success, fontSize = Tokens.TextXs)
    }
}
