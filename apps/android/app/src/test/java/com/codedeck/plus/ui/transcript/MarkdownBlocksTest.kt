package com.codedeck.plus.ui.transcript

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownBlocksTest {
    private fun paragraphs(n: Int, size: Int = 300) = (1..n).joinToString("\n\n") { i -> "Paragraph $i " + "word ".repeat(size / 5) }

    @Test fun shortTextIsOneBlockAsItIs() {
        val text = "# Title\n\nSome *text*.\n"
        assertEquals(listOf(text), markdownBlocks(text))
    }

    @Test fun longTextBreaksAtBlankLinesAndLosesNothing() {
        val text = paragraphs(60)
        val blocks = markdownBlocks(text, target = 1_000)
        assertTrue(blocks.size > 1)
        assertTrue(blocks.all { it.length <= 2_000 })
        // Each block is whole paragraphs, and together they are the text.
        assertTrue(blocks.all { it.startsWith("Paragraph ") })
        assertEquals(text, blocks.joinToString("\n\n"))
    }

    @Test fun aCodeFenceIsNeverLeftOpenAcrossBlocks() {
        val code = (1..400).joinToString("\n") { "let x$it = $it;" }
        val text = "Intro\n\n```rust\n$code\n```\n\nAfter"
        val blocks = markdownBlocks(text, target = 1_000)
        assertTrue(blocks.size > 2)
        for (block in blocks.filter { it.contains("let x") }) {
            assertTrue(block, block.trimStart().startsWith("```rust") || block.startsWith("Intro"))
            assertEquals(block, 0, block.lines().count { it.trimStart().startsWith("```") } % 2)
        }
        // Every line of code is still there, in order.
        val shown = blocks.flatMap { it.lines() }.filter { it.startsWith("let x") }
        assertEquals(code.lines(), shown)
    }

    @Test fun aBlankLineInsideAFenceIsNotABreak() {
        val text = "```\n" + "a\n\n".repeat(600) + "```"
        val blocks = markdownBlocks(text, target = 500)
        for (block in blocks) assertEquals(block, 0, block.lines().count { it.trim() == "```" } % 2)
    }

    @Test fun aLongTableRepeatsItsHeader() {
        val rows = (1..300).joinToString("\n") { "| row $it | value $it |" }
        val text = "| Name | Value |\n|---|---|\n$rows"
        val blocks = markdownBlocks(text, target = 1_000)
        assertTrue(blocks.size > 1)
        for (block in blocks) assertTrue(block, block.startsWith("| Name | Value |\n|---|---|\n"))
    }

    @Test fun aSingleHugeLineIsCutAtSpaces() {
        val text = "word ".repeat(10_000).trim()
        val blocks = markdownBlocks(text, target = 1_000)
        assertTrue(blocks.size > 1)
        assertTrue(blocks.all { it.length <= 2_000 })
        assertEquals(text.split(' ').size, blocks.joinToString(" ").split(Regex("\\s+")).size)
    }

    @Test fun aMegabyteSplitsQuickly() {
        val text = paragraphs(4_000)
        val start = System.nanoTime()
        val blocks = markdownBlocks(text)
        val ms = (System.nanoTime() - start) / 1_000_000
        assertTrue("${blocks.size} blocks", blocks.size > 200)
        assertTrue("took $ms ms", ms < 1_000)
    }
}
