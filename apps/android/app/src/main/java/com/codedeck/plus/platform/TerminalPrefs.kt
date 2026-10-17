package com.codedeck.plus.platform

import android.content.Context
import androidx.core.content.edit

/**
 * This phone's own terminal preferences: whether opening a terminal needs the
 * fingerprint (or the screen lock), and the text size the user pinched to.
 * Kept on the phone, outside the core and its backup: both are about this
 * device — its sensor, its screen — not the identity.
 */
class TerminalPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var requireUnlock: Boolean
        get() = prefs.getBoolean(REQUIRE_UNLOCK, false)
        set(value) = prefs.edit { putBoolean(REQUIRE_UNLOCK, value) }

    /** The terminal's text size, in sp. */
    var textSp: Int
        get() = prefs.getInt(TEXT_SP, DEFAULT_TEXT_SP).coerceIn(MIN_TEXT_SP, MAX_TEXT_SP)
        set(value) = prefs.edit { putInt(TEXT_SP, value.coerceIn(MIN_TEXT_SP, MAX_TEXT_SP)) }

    companion object {
        private const val PREFS = "terminal"
        private const val REQUIRE_UNLOCK = "require_unlock"
        private const val TEXT_SP = "text_sp"

        /** About 60 columns across a 412 dp phone held upright. */
        const val DEFAULT_TEXT_SP = 11
        const val MIN_TEXT_SP = 6
        const val MAX_TEXT_SP = 28
    }
}
