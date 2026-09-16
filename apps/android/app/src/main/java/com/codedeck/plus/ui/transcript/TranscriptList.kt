package com.codedeck.plus.ui.transcript

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.AssistantTextRow
import com.codedeck.plus.ui.transcript.rows.DiffRow
import com.codedeck.plus.ui.transcript.rows.ErrorRow
import com.codedeck.plus.ui.transcript.rows.LifecycleRow
import com.codedeck.plus.ui.transcript.rows.OutboxRow
import com.codedeck.plus.ui.transcript.rows.PermissionCard
import com.codedeck.plus.ui.transcript.rows.PlanApprovalCard
import com.codedeck.plus.ui.transcript.rows.QuestionCard
import com.codedeck.plus.ui.transcript.rows.QuestionGroupCard
import com.codedeck.plus.ui.transcript.rows.SyncGapRow
import com.codedeck.plus.ui.transcript.rows.SystemRow
import com.codedeck.plus.ui.transcript.rows.ToolGroupRow
import com.codedeck.plus.ui.transcript.rows.UserMessageRow
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiOutboxItem

/**
 * The virtualized transcript — port of `TranscriptView.tsx`. `LazyColumn` +
 * [rememberTranscriptPin] replace virtua's `VList` + `useTranscriptPin`;
 * rows come from the already-grouped `displayEntries` (Rust's
 * `presentation::display_entries`, decoded by `DisplayEntries.kt`), followed
 * by the session's uncovered outbox items (CDX-063,
 * [visibleOutboxItems]), plus a sync-gap placeholder while a cycle fills a
 * known gap.
 */
@Composable
fun TranscriptList(
    displayEntries: List<DisplayEntry>,
    outboxItems: List<UniffiOutboxItem>,
    machine: String,
    sessionId: String,
    syncState: String,
    contiguous: Boolean,
    respondedCards: Set<String>,
    planApprovalChoices: Map<String, String>,
    dispatch: (UniffiIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    var expandedGroups by remember(sessionId) { mutableStateOf(setOf<Long>()) }

    // Question-group progression bookkeeping — see QuestionGroupCard's
    // `onAdvance` doc comment for why this exists: the wire only signals a
    // group's resolution once, for the whole group, never per sub-question.
    var locallyAdvanced by remember(sessionId) { mutableStateOf(setOf<String>()) }
    val mergedResponded = respondedCards + locallyAdvanced

    val visibleOutbox = remember(outboxItems, displayEntries, machine, sessionId) {
        visibleOutboxItems(outboxItems, machine, sessionId, displayEntries)
    }
    val showSyncGap = !contiguous && (syncState == "requested" || syncState == "syncing" || syncState == "failed")
    val itemCount = displayEntries.size + visibleOutbox.size + (if (showSyncGap) 1 else 0)
    val pin = rememberTranscriptPin(listState, itemCount)

    if (itemCount == 0) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                if (syncState == "requested" || syncState == "syncing") "Syncing transcript…" else "No transcript yet — send a message to start.",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
            )
        }
        return
    }

    Box(modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(Tokens.Space3),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            if (showSyncGap) {
                item(key = "sync-gap") { SyncGapRow(failed = syncState == "failed") }
            }
            items(displayEntries, key = { "e${it.seq}" }) { entry ->
                TranscriptRow(
                    item = entry,
                    machine = machine,
                    sessionId = sessionId,
                    expanded = expandedGroups.contains(entry.seq),
                    onToggle = {
                        expandedGroups = if (expandedGroups.contains(entry.seq)) {
                            expandedGroups - entry.seq
                        } else {
                            expandedGroups + entry.seq
                        }
                    },
                    respondedCards = mergedResponded,
                    planChoices = planApprovalChoices,
                    onAdvance = { id -> locallyAdvanced = locallyAdvanced + id },
                    actions = dispatch,
                )
            }
            items(visibleOutbox, key = { "o${it.id}" }) { item ->
                OutboxRow(item) { id -> dispatch(UniffiIntent.RetryOutboxItem(machine = machine, id = id)) }
            }
        }
        if (!pin.pinned) {
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = Tokens.Space3)
                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                    .background(Tokens.SurfaceRaised)
                    .clickable(onClick = pin.jumpToBottom)
                    .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
            ) {
                Text(
                    "↓" + if (pin.missedEntries > 0) " ${pin.missedEntries} new" else " Latest",
                    color = Tokens.Text,
                    fontSize = Tokens.TextSm,
                )
            }
        }
    }
}

@Composable
private fun TranscriptRow(
    item: DisplayEntry,
    machine: String,
    sessionId: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    respondedCards: Set<String>,
    planChoices: Map<String, String>,
    onAdvance: (String) -> Unit,
    actions: (UniffiIntent) -> Unit,
) {
    when (item) {
        is DisplayEntry.UserMessage -> UserMessageRow(item.entry)
        is DisplayEntry.AssistantMessage -> AssistantTextRow(item.entry, item.isPlan)
        is DisplayEntry.ToolGroup -> ToolGroupRow(item.entries, item.summary, expanded, onToggle)
        is DisplayEntry.Diff -> DiffRow(item.entry, expanded, onToggle)
        is DisplayEntry.Error -> ErrorRow(item.entry)
        is DisplayEntry.System -> SystemRow(item.entry)
        is DisplayEntry.Lifecycle -> LifecycleRow(item.entry)
        is DisplayEntry.PlanApproval -> PlanApprovalCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            responded = item.toolUseId != null && respondedCards.contains(item.toolUseId),
            choice = item.toolUseId?.let { planChoices[it] },
            actions = actions,
        )
        is DisplayEntry.Question -> QuestionCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            responded = item.toolUseId != null && respondedCards.contains(item.toolUseId),
            actions = actions,
        )
        is DisplayEntry.QuestionGroup -> QuestionGroupCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            respondedCards = respondedCards,
            onAdvance = onAdvance,
            actions = actions,
        )
        is DisplayEntry.PermissionRequest -> PermissionCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            responded = respondedCards.contains(item.requestId),
            actions = actions,
        )
    }
}
