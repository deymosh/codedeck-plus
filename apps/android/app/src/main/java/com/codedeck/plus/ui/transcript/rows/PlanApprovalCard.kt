package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
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
import uniffi.client_ffi.UniffiIntent

/**
 * Plan approval — one choice per option the agent offered (e.g. approve and
 * auto-accept edits, approve, keep planning). A tapped choice is recorded
 * alongside the answer so the card can name it before the bridge resolves
 * the request.
 */
@Composable
fun PlanApprovalCard(
    item: DisplayEntry.PlanApproval,
    machine: String,
    sessionId: String,
    responded: Boolean,
    choice: String?,
    actions: CardActions,
) {
    if (item.answered != null || responded) {
        val chosen = choice?.let { id -> item.options.firstOrNull { it.id == id }?.label }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Tokens.RadiusMd))
                .background(Tokens.SurfaceRaised)
                .padding(Tokens.Space3),
        ) {
            Text(item.answered ?: chosen ?: "Response sent…", color = Tokens.Success, fontSize = Tokens.TextSm)
        }
        return
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
        Text("Approve this plan?", color = Tokens.Text, fontSize = Tokens.TextMd)
        item.options.forEach { option ->
            PlanOption(option.label, option.description) {
                actions(UniffiIntent.SetPlanApprovalChoice(cardId = item.requestId, key = option.id))
                actions(
                    UniffiIntent.RespondPlan(
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

@Composable
private fun PlanOption(label: String, description: String?, onClick: () -> Unit) {
    Column(
        Modifier
            .minimumInteractiveComponentSize()
            .fillMaxWidth()
            .padding(top = Tokens.Space2)
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onClick)
            .padding(Tokens.Space2),
    ) {
        Text(label, color = Tokens.Text, fontSize = Tokens.TextSm)
        description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextXs) }
    }
}
