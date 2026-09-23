package com.codedeck.plus.ui.session

import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.OutputEntry
import com.codedeck.plus.ui.transcript.QuestionOption
import com.codedeck.plus.ui.transcript.QuestionSpecView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActiveQuestionTest {

    private fun spec(optionCount: Int) = QuestionSpecView(
        entry = OutputEntry(entryType = "question", content = "Which one?", timestamp = "2026-09-23T10:00:00Z"),
        options = List(optionCount) { QuestionOption("option $it") },
    )

    private fun message(seq: Long) = DisplayEntry.System(
        seq,
        OutputEntry(entryType = "system", content = "note", timestamp = "2026-09-23T10:00:00Z"),
    )

    @Test
    fun an_unanswered_single_question_takes_the_composer_text() {
        val entries = listOf(message(1), DisplayEntry.Question(seq = 2, toolUseId = "t1", question = spec(3)))
        assertEquals(ActiveQuestion(3uL, advanceKey = null), activeQuestionOf(entries, emptySet()))
    }

    @Test
    fun an_answered_or_responded_question_does_not() {
        val answered = DisplayEntry.Question(seq = 2, toolUseId = "t1", question = spec(3), answered = "option 1")
        assertNull(activeQuestionOf(listOf(answered), emptySet()))
        val responded = DisplayEntry.Question(seq = 2, toolUseId = "t1", question = spec(3))
        assertNull(activeQuestionOf(listOf(responded), setOf("t1")))
    }

    @Test
    fun a_group_answers_its_first_unanswered_sub_question() {
        val group = DisplayEntry.QuestionGroup(seq = 5, toolUseId = "g", questions = listOf(spec(2), spec(4)))
        assertEquals(ActiveQuestion(2uL, "g:q0"), activeQuestionOf(listOf(group), emptySet()))
        assertEquals(ActiveQuestion(4uL, "g:q1"), activeQuestionOf(listOf(group), setOf("g:q0")))
        assertNull(activeQuestionOf(listOf(group), setOf("g:q0", "g:q1")))
    }

    @Test
    fun only_the_newest_question_counts() {
        val stale = DisplayEntry.Question(seq = 1, toolUseId = "old", question = spec(3))
        val newest = DisplayEntry.Question(seq = 4, toolUseId = "new", question = spec(2), answered = "option 0")
        assertNull(activeQuestionOf(listOf(stale, message(2), newest), emptySet()))
    }
}
