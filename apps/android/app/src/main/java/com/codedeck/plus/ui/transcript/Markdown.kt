package com.codedeck.plus.ui.transcript

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import com.codedeck.plus.ui.theme.Tokens
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState

/**
 * Shared markdown renderer for assistant/plan transcript rows — mirrors
 * `apps/mobile/src/ui/transcript/rows/Markdown.tsx`'s react-markdown +
 * remark-gfm pipeline. GFM (tables, task lists, strikethrough, autolinks) is
 * the renderer's own default AST → Composable handling — no separate "GFM
 * module" the way `remark-gfm` is a separate plugin on the TS side;
 * `GFMFlavourDescriptor` is `Markdown()`'s own default flavour.
 *
 * An earlier renderer probe found tables rendering as stacked
 * plain lines and task-list checkboxes as plain bullets at renderer version
 * 0.27 (2024-era), flagging both as needing custom `markdownComponents`
 * work. Re-checked against the actual 0.43.0 source: `checkbox` defaults to
 * a real `MarkdownCheckBox`, so it needs no override. `table` defaults to a
 * real grid too, but one with equal-width columns and single-line,
 * ellipsized cells — a long cell in an agent's table would be cut off — so
 * it is replaced by [TranscriptMarkdownTable] (content-sized columns, full
 * cell text, horizontal scroll when wider than the row). This file's own
 * Paparazzi golden (`MarkdownParityTest`) is the guardrail against a future
 * renderer bump silently regressing either one.
 *
 * `immediate = true`: transcript rows are already-received text, not a
 * live-typed editor buffer — synchronous parsing costs one frame on a cold
 * row and, unlike the renderer's default async path (`MarkdownState`
 * introduced in 0.33.0), is deterministic for Paparazzi's static snapshots.
 *
 * Syntax highlighting stays plain monochrome (no `-code` module, no
 * Rust-side span generation) — matches the TS renderer's own lazy/
 * progressive-enhancement treatment of `rehype-highlight`; a deliberately
 * separate decision, not bundled into this pass (master plan §9 risk #2).
 */
@Composable
fun TranscriptMarkdown(content: String, modifier: Modifier = Modifier) {
    val state = rememberMarkdownState(content, immediate = true)
    SelectionContainer(modifier = modifier) {
        Markdown(
            markdownState = state,
            // Per-element text color rides on `typography` below (each `TextStyle`
            // carries its own `color`) — `markdownColor()` only covers the
            // non-text surfaces (code/table backgrounds, the divider, alerts).
            colors = markdownColor(
                text = Tokens.Text,
                codeBackground = Tokens.SurfaceInput,
                inlineCodeBackground = Tokens.SurfaceInput,
                dividerColor = Tokens.BorderStrong,
                tableBackground = Tokens.Surface,
            ),
            typography = markdownTypography(
                h1 = headingStyle(22),
                h2 = headingStyle(18),
                h3 = headingStyle(16),
                h4 = headingStyle(15),
                h5 = headingStyle(14),
                h6 = headingStyle(13),
                text = bodyStyle(),
                paragraph = bodyStyle(),
                ordered = bodyStyle(),
                bullet = bodyStyle(),
                list = bodyStyle(),
                quote = bodyStyle(color = Tokens.TextMuted),
                code = monoStyle(),
                inlineCode = monoStyle(),
                table = bodyStyle(),
            ),
            components = markdownComponents(
                table = { TranscriptMarkdownTable(it.content, it.node, it.typography.table) },
            ),
            modifier = modifier.fillMaxWidth(),
        )
    }
}

private fun headingStyle(sizeSp: Int) = TextStyle(
    color = Tokens.Text,
    fontSize = androidx.compose.ui.unit.TextUnit(sizeSp.toFloat(), androidx.compose.ui.unit.TextUnitType.Sp),
    fontWeight = FontWeight.Bold,
)

private fun bodyStyle(color: androidx.compose.ui.graphics.Color = Tokens.Text) = TextStyle(
    color = color,
    fontSize = Tokens.TextMd,
)

private fun monoStyle() = TextStyle(
    color = Tokens.Text,
    fontFamily = Tokens.FontMono,
    fontSize = Tokens.TextSm,
)
