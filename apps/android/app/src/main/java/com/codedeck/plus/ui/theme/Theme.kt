package com.codedeck.plus.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

/** Dark-only, exactly like `apps/mobile` — `isSystemInDarkTheme()` is read
 *  only to note the (permanent) intent, never branched on. */
private val CodeDeckColorScheme = darkColorScheme(
    background = Tokens.Bg,
    surface = Tokens.Surface,
    surfaceVariant = Tokens.SurfaceRaised,
    onBackground = Tokens.Text,
    onSurface = Tokens.Text,
    primary = Tokens.Accent,
    onPrimary = Tokens.AccentContrast,
    outline = Tokens.Border,
    outlineVariant = Tokens.BorderStrong,
    error = Tokens.Danger,
)

@Composable
fun CodeDeckTheme(content: @Composable () -> Unit) {
    @Suppress("UNUSED_EXPRESSION") isSystemInDarkTheme() // see doc comment above
    MaterialTheme(
        colorScheme = CodeDeckColorScheme,
        typography = CodeDeckTypography,
        content = content,
    )
}
