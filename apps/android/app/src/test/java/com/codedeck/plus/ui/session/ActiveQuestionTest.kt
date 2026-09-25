package com.codedeck.plus.ui.session

import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.QuestionOption
import com.codedeck.plus.ui.transcript.QuestionView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActiveQuestionTest {

    private fun view(index: Int, optionCount: Int) = QuestionView(
        index = index,
        question = "Which one?",
        options = List(optionCount) { QuestionOption("option $it") },
    )

    private fun ask(seq: Long, requestId: String, vararg optionCounts: Int, answered: String? = null) =
        DisplayEntry.Question(
            seq = seq,
            requestId = requestId,
            questions = optionCounts.mapIndexed { i, n -> view(i, n) },
            answered = answered,
        )

    private fun message(seq: Long) = DisplayEntry.Status(seq, "note")

    @Test
    fun an_unanswered_single_question_takes_the_composer_text() {
        val entries = listOf(message(1), ask(2, "t1", 3))
        assertEquals(ActiveQuestion("t1", 0), activeQuestionOf(entries, emptySet()))
    }

    @Test
    fun an_answered_or_responded_question_does_not() {
        assertNull(activeQuestionOf(listOf(ask(2, "t1", 3, answered = "option 1")), emptySet()))
        assertNull(activeQuestionOf(listOf(ask(2, "t1", 3)), setOf("t1:q0")))
    }

    @Test
    fun a_multi_question_ask_answers_its_first_unanswered_question() {
        val group = ask(5, "g", 2, 4)
        assertEquals(ActiveQuestion("g", 0), activeQuestionOf(listOf(group), emptySet()))
        assertEquals(ActiveQuestion("g", 1), activeQuestionOf(listOf(group), setOf("g:q0")))
        assertNull(activeQuestionOf(listOf(group), setOf("g:q0", "g:q1")))
    }

    @Test
    fun only_the_newest_question_counts() {
        val stale = ask(1, "old", 3)
        val newest = ask(4, "new", 2, answered = "option 0")
        assertNull(activeQuestionOf(listOf(stale, message(2), newest), emptySet()))
    }
}
