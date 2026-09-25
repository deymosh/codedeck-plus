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
import androidx.compose.material3.TextButton
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
import com.codedeck.plus.ui.transcript.QuestionView
import com.codedeck.plus.ui.transcript.questionCardKey
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
 *  free-text input. `onSelect` gets 0-based option indices. */
@Composable
private fun QuestionAnswerBody(
    question: QuestionView,
    onSelect: (List<Int>) -> Unit,
    onTextAnswer: (String) -> Unit,
) {
    var showTextInput by remember(question) { mutableStateOf(false) }
    var textValue by remember(question) { mutableStateOf("") }
    var selected by remember(question) { mutableStateOf(setOf<Int>()) }

    val options = question.options
    val hasOptions = options.isNotEmpty()
    val isMulti = question.multiSelect && hasOptions
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
        // Choosing to type is not a commitment: the offered replies stay one
        // tap away (the draft is kept if the user comes back to typing).
        if (hasOptions) {
            TextButton(onClick = { showTextInput = false }) {
                Text("Back to options", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
            }
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
            if (selected.isNotEmpty()) onSelect(selected.sorted())
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
                    .clickable { if (i == freeTextIndex) showTextInput = true else onSelect(listOf(i)) }
                    .padding(Tokens.Space2),
            ) {
                Column {
                    Text(opt.label, color = Tokens.Text, fontSize = Tokens.TextSm)
                    opt.description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextXs) }
                }
            }
        }
        if (freeTextIndex == -1) {
            TextButton(onClick = { showTextInput = true }) {
                Text("Type your own answer…", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
            }
        }
    }
}

/**
 * One ask — a single question, or several answered in order. Each answer
 * names its question's `index`; the core marks that question responded
 * ([questionCardKey]), so the card moves on to the next unanswered question
 * right away, and the whole card resolves when the bridge reports the ask
 * answered.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuestionCard(
    item: DisplayEntry.Question,
    machine: String,
    sessionId: String,
    respondedCards: Set<String>,
    actions: CardActions,
) {
    val answeredSet = item.questions
        .filter { respondedCards.contains(questionCardKey(item.requestId, it.index)) }
        .map { it.index }
        .toSet()
    val active = item.questions.firstOrNull { it.index !in answeredSet }
    val multi = item.questions.size > 1

    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceRaised).padding(Tokens.Space3),
    ) {
        if (item.answered != null || active == null) {
            item.questions.forEach { q ->
                Text(
                    (if (multi) "✓ " else "") + (q.header ?: q.question),
                    color = if (multi) Tokens.TextMuted else Tokens.Text,
                    fontSize = if (multi) Tokens.TextXs else Tokens.TextMd,
                )
            }
            Text(item.answered ?: "Response sent…", color = Tokens.Success, fontSize = Tokens.TextXs)
            return@Column
        }

        if (multi) {
            // Wraps: one plain Row clipped the trailing headers of a larger ask.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                item.questions.forEach { q ->
                    val done = q.index in answeredSet
                    Text(
                        (if (done) "✓ " else "") + (q.header ?: "Question ${q.index + 1}"),
                        color = if (q == active) Tokens.Text else if (done) Tokens.Success else Tokens.TextDim,
                        fontSize = Tokens.TextXs,
                    )
                }
            }
        } else {
            active.header?.let { Text(it, color = Tokens.Text, fontSize = Tokens.TextMd) }
        }
        Text(active.question, color = Tokens.TextMuted, fontSize = Tokens.TextSm)
        QuestionAnswerBody(
            question = active,
            onSelect = { indices ->
                actions(
                    UniffiIntent.AnswerQuestion(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = item.requestId,
                        index = active.index.toUInt(),
                        selected = indices.map { it.toUInt() },
                        text = null,
                    ),
                )
            },
            onTextAnswer = { text ->
                actions(
                    UniffiIntent.AnswerQuestion(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = item.requestId,
                        index = active.index.toUInt(),
                        selected = emptyList(),
                        text = text,
                    ),
                )
            },
        )
    }
}
