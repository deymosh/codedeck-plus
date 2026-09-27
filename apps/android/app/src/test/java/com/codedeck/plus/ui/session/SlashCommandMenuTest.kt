package com.codedeck.plus.ui.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.client_ffi.UniffiSlashCommand

/** When the command menu opens, and which commands it lists in what order. */
class SlashCommandMenuTest {
    private fun cmd(name: String) = UniffiSlashCommand(name, null, null)

    @Test
    fun opensOnlyWhileTheDraftIsABareSlashName() {
        assertEquals("", slashQuery("/"))
        assertEquals("comp", slashQuery("/comp"))
        assertEquals("commit-commands:co", slashQuery("/commit-commands:co"))
        assertNull(slashQuery("/compact now"))
        assertNull(slashQuery("/etc/hosts"))
        assertNull(slashQuery("fix /compact"))
        assertNull(slashQuery(""))
    }

    @Test
    fun namesStartingWithTheQueryComeBeforeNamesContainingIt() {
        val all = listOf(cmd("pr-tools:review"), cmd("init"), cmd("review-pr"), cmd("code-review"))
        assertEquals(
            listOf("review-pr", "pr-tools:review", "code-review"),
            matchingCommands(all, "review").map { it.name },
        )
        assertEquals(listOf("init"), matchingCommands(all, "IN").map { it.name })
        assertEquals(all, matchingCommands(all, ""))
    }

    @Test
    fun theMatchedPartOfANameIsWhatStandsOut() {
        val name = highlightedName("commit-commands:commit", "commands")
        assertEquals("/commit-commands:commit", name.text)
        val bold = name.spanStyles.single { it.item.fontWeight != null }
        assertEquals("commands", name.text.substring(bold.start, bold.end))
    }
}
