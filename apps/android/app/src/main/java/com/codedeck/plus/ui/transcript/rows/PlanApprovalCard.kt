package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import uniffi.client_ffi.UniffiIntent

/**
 * Plan approval — one choice per option the agent offered (e.g. approve and
 * auto-accept edits, approve, keep planning). A tapped choice is recorded
 * alongside the answer so the card can name it before the bridge resolves
 * the request. The first option is the agent's own go-ahead, so it is the
 * one shown as the primary choice.
 *
 * The option that sends the plan back (`revise`, when the agent has one)
 * asks what should change first: the feedback goes to the agent with the
 * choice, in one answer, rather than as a message after it — by then the
 * agent may already be revising without it. Sending it empty keeps planning
 * with no feedback.
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
        Column(Modifier.interactionCard(waiting = false)) {
            Text(item.answered ?: chosen ?: "Response sent…", color = Tokens.Success, fontSize = Tokens.TextSm)
        }
        return
    }

    var writingFeedback by remember(item.requestId) { mutableStateOf(false) }
    var feedback by remember(item.requestId) { mutableStateOf("") }
    fun respond(optionId: String, withFeedback: String?) {
        actions(UniffiIntent.SetPlanApprovalChoice(cardId = item.requestId, key = optionId))
        actions(
            UniffiIntent.RespondPlan(
                machine = machine,
                sessionId = sessionId,
                requestId = item.requestId,
                optionId = optionId,
                feedback = withFeedback?.trim()?.takeIf { it.isNotEmpty() },
            ),
        )
    }

    Column(Modifier.interactionCard(waiting = true)) {
        Text("Approve this plan?", color = Tokens.Text, fontSize = Tokens.TextMd)
        val revise = item.revise
        if (writingFeedback && revise != null) {
            Row(
                Modifier.fillMaxWidth().padding(top = Tokens.Space2),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                OutlinedTextField(
                    value = feedback,
                    onValueChange = { feedback = it },
                    placeholder = { Text("What should change? (optional)") },
                    modifier = Modifier.weight(1f),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { respond(revise, feedback) }),
                )
                ActionChip("Send", Tokens.Text) { respond(revise, feedback) }
            }
            // Choosing to revise is not a commitment until it is sent: the
            // other choices stay one tap away, and the draft is kept.
            TextButton(onClick = { writingFeedback = false }) {
                Text("Back to options", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
            }
            return@Column
        }
        item.options.forEachIndexed { i, option ->
            PlanOption(option.label, option.description, primary = i == 0) {
                if (option.id == revise) writingFeedback = true else respond(option.id, null)
            }
        }
    }
}

@Composable
private fun PlanOption(label: String, description: String?, primary: Boolean, onClick: () -> Unit) {
    // Emphasis is inversion here: the primary choice is white with black text.
    val (fill, text, secondary) = if (primary) {
        Triple(Tokens.Accent, Tokens.AccentContrast, Tokens.AccentContrast.copy(alpha = 0.65f))
    } else {
        Triple(Tokens.SurfaceHover, Tokens.Text, Tokens.TextMuted)
    }
    Column(
        Modifier
            .minimumInteractiveComponentSize()
            .fillMaxWidth()
            .padding(top = Tokens.Space2)
            .clip(RoundedCornerShape(Tokens.RadiusMd + 4.dp))
            .background(fill)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2 + 2.dp),
    ) {
        Text(label, color = text, fontSize = Tokens.TextSm)
        description?.let { Text(it, color = secondary, fontSize = Tokens.TextXs) }
    }
}
