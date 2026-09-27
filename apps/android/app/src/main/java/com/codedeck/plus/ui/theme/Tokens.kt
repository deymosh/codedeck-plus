package com.codedeck.plus.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Mechanical, category-by-category translation of `apps/mobile/src/styles/
 * tokens.css` — the single source of truth for the design language both UIs
 * share (per the migration plan's own §3 rule, only *pixels* differ by
 * platform, never the *scale*). Kept as one flat object rather than spread
 * across Material3's theme slots, matching tokens.css's own flat
 * `:root { --* }` shape — `Theme.kt` is what maps a SUBSET of this into
 * Compose's `ColorScheme`/`Typography` where Material3 needs it.
 */
object Tokens {
    // --- Spacing (tokens.css --space-1..--space-7: 0.25rem..3rem @ 16px/rem) ---
    val Space1 = 4.dp
    val Space2 = 8.dp
    val Space3 = 12.dp
    val Space4 = 16.dp
    val Space5 = 24.dp
    val Space6 = 32.dp
    val Space7 = 48.dp

    // --- Type sizes (tokens.css --text-*: px, not rem — deliberately, so a
    // user's own OS font-scale setting still applies via `sp` here, same as
    // the CSS side reads `--text-scale` as a separate multiplier on top of
    // these base px values). ---
    val TextXs = 12.sp
    val TextSm = 13.sp
    val TextMd = 14.sp
    val TextLg = 16.sp
    val TextXl = 20.sp
    /** A page's own title. */
    val TextTitle = 26.sp

    // --- Fonts (tokens.css --font-sans / --font-mono) ---
    val FontSans = FontFamily.Default
    // No bundled webfont on the TS side either (falls back to Roboto Mono on
    // Android, JetBrains Mono is a WEB font stack there) — same fallback
    // reasoning applies here: the platform monospace is close enough.
    val FontMono = FontFamily.Monospace

    // --- Layout constants ---
    /** Android's minimum touch target (Material / accessibility guideline),
     *  not tokens.css's 44px web value. */
    val TapMin = 48.dp

    // --- Radii (tokens.css --radius-*) ---
    val RadiusSm = 4.dp
    val RadiusMd = 8.dp
    val RadiusLg = 16.dp
    /** Grouped settings blocks and the larger surfaces. */
    val RadiusXl = 20.dp
    val RadiusPill = 999.dp

    // --- Z-order (tokens.css --z-*, Compose zIndex float) ---
    const val ZBar = 10f
    const val ZSheet = 20f
    const val ZModal = 30f
    const val ZToast = 40f

    // --- Transitions (ms) ---
    const val TransitionFastMs = 120
    const val TransitionMs = 200

    // --- Color ramp: dark-only, monochrome. The page is true black; each
    // raised layer (a group, a card, a sheet) steps up in lightness, and
    // white is the only accent. Colour is kept for state (running, waiting,
    // failed), so it always means something. ---
    val Bg = Color(0xFF000000)
    val Surface = Color(0xFF0B0B0C)
    val SurfaceRaised = Color(0xFF141416)
    val SurfaceInput = Color(0xFF0F0F11)
    val SurfaceHover = Color(0xFF1D1D20)
    val Border = Color(0xFF222226)
    val BorderStrong = Color(0xFF36363C)
    val Text = Color(0xFFF7F7F8)
    val TextMuted = Color(0xFFA0A0A8)
    val TextDim = Color(0xFF5E5E66)

    // --- Accent: inversion-as-emphasis identity ---
    val Accent = Color(0xFFFFFFFF)
    val AccentContrast = Color(0xFF000000)

    // --- Semantic ---
    val Success = Color(0xFF22C55E)
    val Warn = Color(0xFFF59E0B)
    val Danger = Color(0xFFEF4444)

    /** `live` / `stale` / `offline` presence dot colors — aliases onto the
     *  semantic ramp above, exactly as tokens.css defines them. */
    val PresenceLive = Success
    val PresenceStale = Warn
    val PresenceOffline = TextDim
}

/** A minimal Material3 `Typography` built from `Tokens`' type scale — filled
 *  in as screens actually need named text styles, not exhaustively
 *  up front. */
val CodeDeckTypography = Typography(
    bodyMedium = TextStyle(fontFamily = Tokens.FontSans, fontSize = Tokens.TextMd),
    bodySmall = TextStyle(fontFamily = Tokens.FontSans, fontSize = Tokens.TextSm),
    labelSmall = TextStyle(fontFamily = Tokens.FontSans, fontSize = Tokens.TextXs),
    titleMedium = TextStyle(fontFamily = Tokens.FontSans, fontSize = Tokens.TextLg),
    titleLarge = TextStyle(fontFamily = Tokens.FontSans, fontSize = Tokens.TextXl),
)
