package com.codedeck.plus.ui.transcript.rows

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.TranscriptMarkdown

/** A message the user sent. */
@Composable
fun UserMessageRow(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            Modifier
                .clip(RoundedCornerShape(Tokens.RadiusLg))
                .background(Tokens.SurfaceRaised)
                .padding(Tokens.Space3),
        ) {
            TranscriptMarkdown(text)
        }
    }
}

/** Agent text (markdown). `isPlan` frames it as a plan document, which stays
 *  readable after the plan is approved. */
@Composable
fun AgentTextRow(text: String, isPlan: Boolean = false) {
    Column(
        Modifier
            .fillMaxWidth()
            .let { if (isPlan) it.background(Tokens.SurfaceRaised, RoundedCornerShape(Tokens.RadiusMd)) else it }
            .padding(if (isPlan) Tokens.Space3 else Tokens.Space1),
    ) {
        if (isPlan) {
            Text("Plan", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        }
        TranscriptMarkdown(text)
    }
}

/** A one-line status message from the bridge or agent. */
@Composable
fun StatusRow(text: String) {
    if (text.isBlank()) return
    Text(
        text,
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        modifier = Modifier.fillMaxWidth().padding(vertical = Tokens.Space1),
    )
}

/** An agent or bridge error. */
@Composable
fun ErrorRow(text: String, label: String? = null) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Danger.copy(alpha = 0.12f), RoundedCornerShape(Tokens.RadiusMd))
            .padding(Tokens.Space2),
    ) {
        if (label != null) {
            Text(label, color = Tokens.Danger, fontSize = Tokens.TextXs)
        }
        Text(text, color = Tokens.Danger, fontSize = Tokens.TextSm)
    }
}

/**
 * A lifecycle notice. A session that died, failed or hit an auth error is
 * shown as a labelled error, so it is unmistakable; a restart (or any other
 * notice) is a centered divider line.
 */
@Composable
fun NoticeRow(notice: String, text: String) {
    val errorLabel = when (notice) {
        "session_died" -> "Session died"
        "session_failed" -> "Session failed"
        "auth_error" -> "Authentication error"
        else -> null
    }
    if (errorLabel != null) {
        ErrorRow(text, errorLabel)
        return
    }
    Text(
        text,
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
fun OutboxRow(item: uniffi.client_ffi.UniffiOutboxItem, onRetry: (String) -> Unit) {
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
                        .minimumInteractiveComponentSize()
                        .clip(RoundedCornerShape(Tokens.RadiusSm))
                        .background(Tokens.SurfaceHover)
                        .clickable { onRetry(item.id) }
                        .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
                )
            }
        }
    }
}
