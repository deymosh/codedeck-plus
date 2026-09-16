package com.codedeck.plus.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Session-state → color, mirroring `apps/mobile/src/ui/shared.ts`'s
 * `stateBadge()`: running is emphasized, waiting states warn. Values are
 * `client_core`'s `SessionState`'s own `snake_case` wire spelling, crossed
 * verbatim by `crates/uniffi-bridge/src/views.rs`'s `wire_str()` helper —
 * see `UniffiSessionSummary.state`'s own doc comment.
 */
fun stateColor(state: String?): Color = when (state) {
    "running" -> Tokens.Success
    "waiting_permission", "waiting_question" -> Tokens.Warn
    else -> Tokens.TextMuted
}

/**
 * Presence-dot color, mirroring `shared.ts`'s `presenceBadge()`. Values are
 * `ListingPresence`'s `lowercase` wire spelling (`live` / `stale` /
 * `offline`).
 */
fun presenceColor(presence: String): Color = when (presence) {
    "live" -> Tokens.PresenceLive
    "stale" -> Tokens.PresenceStale
    else -> Tokens.PresenceOffline
}

/** Connection-status color for the sidebar's banner/dot. */
fun connectionColor(status: String?): Color = when (status) {
    "connected" -> Tokens.PresenceLive
    "connecting", "waiting-retry" -> Tokens.PresenceStale
    else -> Tokens.PresenceOffline
}
