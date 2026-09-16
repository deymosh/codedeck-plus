package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.OutputEntry
import com.codedeck.plus.ui.transcript.TranscriptMarkdown
import com.codedeck.plus.ui.transcript.metaStr

/** User input echoed by the SDK — port of `UserMessageRow.tsx`. */
@Composable
fun UserMessageRow(entry: OutputEntry) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            Modifier
                .clip(RoundedCornerShape(Tokens.RadiusLg))
                .background(Tokens.SurfaceRaised)
                .padding(Tokens.Space3),
        ) {
            TranscriptMarkdown(entry.content)
        }
    }
}

/** Assistant text (markdown). `isPlan` marks a `special=plan` entry — the
 *  plan body stays readable after approval, framed as a plan document. Port
 *  of `AssistantTextRow.tsx`. */
@Composable
fun AssistantTextRow(entry: OutputEntry, isPlan: Boolean = false) {
    Column(
        Modifier
            .fillMaxWidth()
            .let { if (isPlan) it.background(Tokens.SurfaceRaised, RoundedCornerShape(Tokens.RadiusMd)) else it }
            .padding(if (isPlan) Tokens.Space3 else Tokens.Space1),
    ) {
        if (isPlan) {
            Text("Plan", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        }
        TranscriptMarkdown(entry.content)
    }
}

/** Plain status/system line — init banners etc. are filtered upstream by
 *  the Rust grouping. Port of `SystemRow.tsx`. */
@Composable
fun SystemRow(entry: OutputEntry) {
    if (entry.content.isBlank()) return
    Text(
        entry.content,
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Space1),
    )
}

/** Generic result errors plus the runner's lifecycle specials
 *  (`session_died`/`session_failed`/`auth_error`), labelled so a dead
 *  session is unmistakable. Port of `ErrorRow.tsx`. */
@Composable
fun ErrorRow(entry: OutputEntry) {
    val label = when (entry.metadata.metaStr("special")) {
        "session_died" -> "Session died"
        "session_failed" -> "Session failed"
        "auth_error" -> "Authentication error"
        else -> null
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Danger.copy(alpha = 0.12f), RoundedCornerShape(Tokens.RadiusMd))
            .padding(Tokens.Space2),
    ) {
        if (label != null) {
            Text(label, color = Tokens.Danger, fontSize = Tokens.TextXs)
        }
        Text(entry.content, color = Tokens.Danger, fontSize = Tokens.TextSm)
    }
}

/** Session lifecycle marker (`special=session_restart`) — a centered
 *  divider line. Port of `LifecycleRow.tsx`. */
@Composable
fun LifecycleRow(entry: OutputEntry) {
    Text(
        entry.content,
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Space2),
    )
}

/** Visible "fetching missed output…" while a sync cycle fills a range the
 *  phone knows it's missing. Port of `SyncGapRow.tsx`. */
@Composable
fun SyncGapRow(failed: Boolean) {
    Text(
        if (failed) "Some output could not be fetched yet — retrying…" else "Fetching missed output…",
        color = Tokens.TextMuted,
        fontSize = Tokens.TextXs,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(Tokens.Space2),
    )
}

/** A user send the transcript does not yet CONTAIN (CDX-063) — its outbox
 *  lifecycle state, Retry on failure. Port of `OutboxRow.tsx`. */
@Composable
fun OutboxRow(item: uniffi.uniffi_bridge.UniffiOutboxItem, onRetry: (String) -> Unit) {
    val failed = item.state == "failed"
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                if (failed) Tokens.Danger.copy(alpha = 0.1f) else Tokens.SurfaceRaised,
                RoundedCornerShape(Tokens.RadiusMd),
            )
            .padding(Tokens.Space2),
    ) {
        Text(item.text, color = Tokens.Text, fontSize = Tokens.TextMd)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Text(
                when (item.state) {
                    "pending" -> "sending…"
                    "published" -> "sent — waiting for bridge"
                    "confirmed" -> "delivered"
                    "failed" -> "failed: ${item.error ?: "unknown"}"
                    else -> item.state
                },
                color = if (failed) Tokens.Danger else Tokens.TextMuted,
                fontSize = Tokens.TextXs,
            )
            if (failed) {
                Text(
                    "Retry",
                    color = Tokens.Text,
                    fontSize = Tokens.TextXs,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceHover)
                        .clickable { onRetry(item.id) }
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                )
            }
        }
    }
}
