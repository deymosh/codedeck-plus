package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.ToolStep

private const val PREVIEW_LIMIT = 600

private fun preview(text: String): String =
    if (text.length > PREVIEW_LIMIT) text.take(PREVIEW_LIMIT) + "…" else text

/** One step's lines: a call's `toolName title` (a sub-agent's call names the
 *  sub-agent) followed by its result, or a lone result / thinking / folded
 *  text line. */
private fun stepLines(step: ToolStep): List<Pair<String, Boolean>> = when (step) {
    is ToolStep.Call -> buildList {
        val who = if (step.isSubAgent) "${step.subagent ?: "sub-agent"} · " else ""
        add("$who${step.toolName} ${step.title}".trim() to false)
        step.result?.let { add("↳ ${preview(it.text)}" to it.isError) }
    }
    is ToolStep.Result -> listOf("↳ ${preview(step.text)}" to step.isError)
    // A redacted block carries no readable text.
    is ToolStep.Thinking -> listOf((if (step.redacted) "Thinking (redacted)" else preview(step.text)) to false)
    is ToolStep.Text -> listOf(preview(step.text) to false)
}

/**
 * Collapsed turn activity — an "N actions" summary, expandable to each tool
 * call with its result, the model's thinking, and any folded agent text, in
 * transcript order so reasoning appears where it actually happened.
 */
@Composable
fun ToolGroupRow(steps: List<ToolStep>, summary: String, expanded: Boolean, onToggle: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(Tokens.Space3),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            Text(
                "▸",
                color = Tokens.TextMuted,
                modifier = Modifier.graphicsLayer { rotationZ = if (expanded) 90f else 0f },
            )
            Text(summary, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        }
        if (expanded) {
            SelectionContainer {
                Column(
                    Modifier.fillMaxWidth().padding(start = Tokens.Space5, end = Tokens.Space3, bottom = Tokens.Space3),
                ) {
                    steps.forEach { step ->
                        stepLines(step).forEach { (line, isError) ->
                            Text(
                                line,
                                color = if (isError) Tokens.Danger else Tokens.TextDim,
                                fontFamily = Tokens.FontMono,
                                fontSize = Tokens.TextXs,
                                modifier = Modifier.padding(vertical = Tokens.Space1 / 2),
                            )
                        }
                    }
                }
            }
        }
    }
}
