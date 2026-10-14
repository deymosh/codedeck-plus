package com.codedeck.plus.ui.components

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import uniffi.client_ffi.UniffiAgentStyle
import uniffi.client_ffi.UniffiUserMessageShape

/** The app's own spinner: Claude Code's glyphs, played forward and back. */
internal val DEFAULT_SPINNER_FRAMES = listOf("·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢")
internal const val DEFAULT_SPINNER_MS = 120L

/**
 * How a session draws its agent's own marks, so it reads like that agent's
 * terminal UI: the knobs of the agent's style (see `AgentStyle` in the
 * protocol crate), each falling back to the app's own look when the style
 * leaves it unset — [Plain] is the app with no style at all. Colours that
 * mean a state stay the app's; the agent's [accent] is worn only by its own
 * marks (the spinner, the working word, the wordmark), and a mode's colour
 * only by the user's side (their messages' mark and the mode chip).
 */
@Immutable
data class AgentLook(
    /** The agent's name, for what is read aloud of its marks. */
    val name: String = "",
    val spinnerFrames: List<String> = DEFAULT_SPINNER_FRAMES,
    val spinnerIntervalMs: Long = DEFAULT_SPINNER_MS,
    /** Shown beside the spinner instead of "Thinking", one per turn. */
    val workingWords: List<String> = emptyList(),
    /** Glyph before a tool row, by tool kind; `other` for any kind not listed. */
    val toolGlyphs: Map<String, String> = emptyMap(),
    val userMessage: UniffiUserMessageShape = UniffiUserMessageShape.Bubble,
    /** Block-art lines, one character per cell; the first [wordmarkSplit] cells muted. */
    val wordmark: List<String> = emptyList(),
    val wordmarkSplit: Int = 0,
    val accent: Color? = null,
    /** The colour of the mode the session runs in, when its agent gives it one. */
    val modeColor: Color? = null,
    private val modeColors: Map<String, Color> = emptyMap(),
) {
    /** This look for a session running in [mode]. */
    fun inMode(mode: String?): AgentLook = copy(modeColor = mode?.let { modeColors[it] })

    /** The colour [mode] wears, if any. */
    fun colorOf(mode: String?): Color? = mode?.let { modeColors[it] }

    /** The glyph for a row of calls of [kinds]: that kind's when they are all
     *  one kind, else `other`'s; null for a row with no call (the agent's
     *  thinking alone) and when the style names neither. */
    fun glyphFor(kinds: Collection<String>): String? {
        if (kinds.isEmpty()) return null
        val kind = kinds.distinct().singleOrNull()
        return kind?.let { toolGlyphs[it] } ?: toolGlyphs["other"]
    }

    /** The working word for the turn [turn] names (any number that stays the
     *  same for one turn): a different word each turn, the same one while it
     *  runs. Null when the agent has none. */
    fun workingWord(turn: Long): String? =
        workingWords.takeIf { it.isNotEmpty() }?.let { it[Math.floorMod(turn * 2_654_435_761L, it.size.toLong()).toInt()] }

    companion object {
        val Plain = AgentLook()

        fun of(name: String, style: UniffiAgentStyle?, mode: String? = null): AgentLook {
            if (style == null) return Plain.copy(name = name)
            val colors = style.modeColors.mapValues { (_, argb) -> Color(argb.toLong()) }
            return AgentLook(
                name = name,
                spinnerFrames = style.spinnerFrames.ifEmpty { DEFAULT_SPINNER_FRAMES },
                spinnerIntervalMs = if (style.spinnerFrames.isEmpty()) DEFAULT_SPINNER_MS else style.spinnerIntervalMs.toLong(),
                workingWords = style.workingWords,
                toolGlyphs = style.toolGlyphs,
                userMessage = style.userMessage,
                wordmark = style.wordmark,
                wordmarkSplit = style.wordmarkSplit.toInt(),
                accent = style.accent?.let { Color(it.toLong()) },
                modeColors = colors,
            ).inMode(mode)
        }
    }
}

/** The look of the session being drawn; [AgentLook.Plain] outside one. */
val LocalAgentLook = staticCompositionLocalOf { AgentLook.Plain }
