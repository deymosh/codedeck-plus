package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.QuestionSpecView
import uniffi.client_ffi.UniffiIntent

/** Heuristic: detect "type your own answer" style options — port of
 *  `isFreeTextOption` in `QuestionCard.tsx`. */
fun isFreeTextOption(label: String, index: Int, total: Int): Boolean {
    if (total < 3) return false
    val lower = label.lowercase()
    val freeTextPhrase = Regex("\\b(something else|your own|type something|type your )\\b")
    if (freeTextPhrase.containsMatchIn(lower)) return true
    val isLast = index == total - 1
    return isLast && Regex("\\b(provide|write |specify|custom|other)\\b").containsMatchIn(lower)
}

/** The answering surface for ONE question: options / multi-select toggles /
 *  free-text input. Port of `QuestionAnswerBody` in `QuestionCard.tsx`. */
@Composable
private fun QuestionAnswerBody(
    question: QuestionSpecView,
    onKeypressAnswer: (String) -> Unit,
    onTextAnswer: (String) -> Unit,
) {
    var showTextInput by remember(question) { mutableStateOf(false) }
    var textValue by remember(question) { mutableStateOf("") }
    var selected by remember(question) { mutableStateOf(setOf<Int>()) }

    val options = question.options.orEmpty()
    val hasOptions = options.isNotEmpty()
    val isMulti = question.multiSelect == true && hasOptions
    val freeTextIndex = if (hasOptions) {
        options.withIndex().firstOrNull { (i, opt) -> isFreeTextOption(opt.label, i, options.size) }?.index ?: -1
    } else {
        -1
    }

    fun submitText() {
        val trimmed = textValue.trim()
        if (trimmed.isEmpty()) return
        onTextAnswer(trimmed)
        textValue = ""
        showTextInput = false
    }

    if (!hasOptions || showTextInput) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            OutlinedTextField(
                value = textValue,
                onValueChange = { textValue = it },
                placeholder = { Text("Type your answer…") },
                modifier = Modifier.weight(1f),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { submitText() }),
            )
            ActionChip("Send", Tokens.Text, onClick = ::submitText)
        }
        return
    }

    if (isMulti) {
        Text("Select all that apply", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        options.forEachIndexed { i, opt ->
            val on = selected.contains(i)
            Row(
                Modifier
                    .minimumInteractiveComponentSize()
                    .fillMaxWidth()
                    .padding(top = Tokens.Space1)
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(if (on) Tokens.SurfaceHover else Tokens.SurfaceInput)
                    .clickable { selected = if (on) selected - i else selected + i }
                    .padding(Tokens.Space2),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                Text(if (on) "☑" else "☐", color = Tokens.Text)
                Column {
                    Text(opt.label, color = Tokens.Text, fontSize = Tokens.TextSm)
                    opt.description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextXs) }
                }
            }
        }
        ActionChip(
            if (selected.isNotEmpty()) "Send (${selected.size})" else "Send",
            // Dimmed until something is selected — the tap does nothing then.
            if (selected.isNotEmpty()) Tokens.Text else Tokens.TextDim,
            modifier = Modifier.padding(top = Tokens.Space2),
        ) {
            if (selected.isNotEmpty()) onTextAnswer(selected.sorted().joinToString(", ") { options[it].label })
        }
        return
    }

    Column {
        options.forEachIndexed { i, opt ->
            Row(
                Modifier
                    .minimumInteractiveComponentSize()
                    .fillMaxWidth()
                    .padding(top = Tokens.Space1)
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.SurfaceInput)
                    .clickable {
                        if (i == freeTextIndex) showTextInput = true else onKeypressAnswer((i + 1).toString())
                    }
                    .padding(Tokens.Space2),
            ) {
                Column {
                    Text(opt.label, color = Tokens.Text, fontSize = Tokens.TextSm)
                    opt.description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextXs) }
                }
            }
        }
        if (freeTextIndex == -1) {
            Text(
                "Type your own answer…",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextXs,
                modifier = Modifier.padding(top = Tokens.Space2).clickable { showTextInput = true },
            )
        }
    }
}

@Composable
fun QuestionCard(
    item: DisplayEntry.Question,
    machine: String,
    sessionId: String,
    responded: Boolean,
    actions: CardActions,
) {
    val q = item.question
    val optionCount = (q.options?.size ?: 0).toULong()

    if (item.answered != null || responded) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceRaised).padding(Tokens.Space3),
        ) {
            q.header?.let { Text(it, color = Tokens.Text, fontSize = Tokens.TextMd) }
            Text(q.entry.content, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
            Text(item.answered ?: "Response sent…", color = Tokens.Success, fontSize = Tokens.TextXs)
        }
        return
    }

    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceRaised).padding(Tokens.Space3),
    ) {
        q.header?.let { Text(it, color = Tokens.Text, fontSize = Tokens.TextMd) }
        Text(q.entry.content, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        QuestionAnswerBody(
            question = q,
            onKeypressAnswer = { key ->
                actions(UniffiIntent.Keypress(machine = machine, sessionId = sessionId, key = key, context = "question"))
            },
            onTextAnswer = { text ->
                actions(UniffiIntent.AnswerQuestion(machine = machine, sessionId = sessionId, text = text, optionCount = optionCount))
            },
        )
    }
}

/**
 * `onAdvance`: unlike `RespondPermission`, `AnswerQuestion`/`Keypress` do
 * NOT mark `ui.responded_cards` server-side (checked against
 * `Intent::apply` directly — only the permission path calls
 * `mark_card_responded`), and the wire only signals a multi-question
 * group's resolution once, for the WHOLE group, when its shared
 * `toolUseId` gets an answering `tool_result` — never per sub-question. The
 * broker resolves questions strictly in order, so without some local
 * "already tapped" bookkeeping this card would keep re-showing the same
 * first sub-question after each tap instead of advancing. `onAdvance` is
 * that bookkeeping's write side — TranscriptList owns a small in-memory
 * set (session-scoped, not synced anywhere) and folds it into
 * `respondedCards` the same way `apps/mobile`'s old client-only
 * `uiStore.markCardResponded` did before that store moved into Rust.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuestionGroupCard(
    item: DisplayEntry.QuestionGroup,
    machine: String,
    sessionId: String,
    respondedCards: Set<String>,
    onAdvance: (String) -> Unit,
    actions: CardActions,
) {
    val answeredSet = item.questions.indices.filter { respondedCards.contains("${item.toolUseId}:q$it") }.toSet()
    val firstUnanswered = item.questions.indices.firstOrNull { it !in answeredSet } ?: -1
    val allAnswered = firstUnanswered == -1

    if (item.answered != null || allAnswered) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceRaised).padding(Tokens.Space3),
        ) {
            item.questions.forEachIndexed { i, q ->
                Text("✓ ${q.header ?: "Question ${i + 1}"}", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
            }
            Text(item.answered ?: "All responses sent", color = Tokens.Success, fontSize = Tokens.TextXs)
        }
        return
    }

    val active = item.questions[firstUnanswered]
    val optionCount = (active.options?.size ?: 0).toULong()

    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceRaised).padding(Tokens.Space3),
    ) {
        // Wraps: one plain Row clipped the trailing headers of a larger group.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            item.questions.forEachIndexed { i, q ->
                val done = i in answeredSet
                val isActive = i == firstUnanswered
                Text(
                    (if (done) "✓ " else "") + (q.header ?: "Question ${i + 1}"),
                    color = if (isActive) Tokens.Text else if (done) Tokens.Success else Tokens.TextDim,
                    fontSize = Tokens.TextXs,
                )
            }
        }
        Text(active.entry.content, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        QuestionAnswerBody(
            question = active,
            onKeypressAnswer = { key ->
                onAdvance("${item.toolUseId}:q$firstUnanswered")
                actions(UniffiIntent.Keypress(machine = machine, sessionId = sessionId, key = key, context = "question"))
            },
            onTextAnswer = { text ->
                onAdvance("${item.toolUseId}:q$firstUnanswered")
                actions(UniffiIntent.AnswerQuestion(machine = machine, sessionId = sessionId, text = text, optionCount = optionCount))
            },
        )
    }
}
