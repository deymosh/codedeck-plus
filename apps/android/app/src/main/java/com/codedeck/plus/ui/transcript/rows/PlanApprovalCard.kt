package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import uniffi.client_ffi.UniffiIntent

/**
 * v10 handles plan approval via the keypress command (`context:
 * "plan-approval"`) — options ported from the old app: 1 = approve/
 * acceptEdits, 2 = approve/default(YOLO), 3 = revise (deny, stay in plan
 * mode). Port of `PlanApprovalCard.tsx`.
 */
val PLAN_APPROVAL_LABELS = mapOf(
    "1" to "Plan approved — Accept Edits",
    "2" to "Plan approved — YOLO",
    "3" to "Revising — type your feedback below",
)

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
        val label = choice?.let { PLAN_APPROVAL_LABELS[it] } ?: item.answered ?: "Response sent…"
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Tokens.RadiusMd))
                .background(Tokens.SurfaceRaised)
                .padding(Tokens.Space3),
        ) {
            Text(label, color = Tokens.Success, fontSize = Tokens.TextSm)
        }
        return
    }

    fun respond(key: String) {
        val cardId = item.toolUseId
        if (cardId != null) actions(UniffiIntent.SetPlanApprovalChoice(cardId = cardId, key = key))
        actions(UniffiIntent.Keypress(machine = machine, sessionId = sessionId, key = key, context = "plan-approval"))
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceRaised)
            .padding(Tokens.Space3),
    ) {
        Text(
            if (item.hasPlan) "Approve this plan?" else "Exit plan mode?",
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
        )
        PlanOption("Approve — mode EDITS", "Auto-accepts file edits, prompts for Bash/Web") { respond("1") }
        PlanOption("Approve — mode YOLO", "Auto-approves all tool actions") { respond("2") }
        PlanOption("Revise plan", "Stay in plan mode and type feedback") { respond("3") }
    }
}

@Composable
private fun PlanOption(label: String, description: String, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = Tokens.Space2)
            .clip(RoundedCornerShape(Tokens.RadiusSm))
            .background(Tokens.SurfaceHover)
            .clickable(onClick = onClick)
            .padding(Tokens.Space2),
    ) {
        Text(label, color = Tokens.Text, fontSize = Tokens.TextSm)
        Text(description, color = Tokens.TextMuted, fontSize = Tokens.TextXs)
    }
}
