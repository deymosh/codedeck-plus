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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.ActivityBar
import com.codedeck.plus.ui.transcript.rows.ActivityRow
import com.codedeck.plus.ui.transcript.rows.ActivitySheet
import com.codedeck.plus.ui.transcript.rows.TaskRow
import com.codedeck.plus.ui.transcript.rows.ongoing
import com.codedeck.plus.ui.transcript.rows.AgentTextRow
import com.codedeck.plus.ui.transcript.rows.activityOf
import com.codedeck.plus.ui.transcript.rows.DiffRow
import com.codedeck.plus.ui.transcript.rows.ErrorRow
import com.codedeck.plus.ui.transcript.rows.NoticeRow
import com.codedeck.plus.ui.transcript.rows.OutboxRow
import com.codedeck.plus.ui.transcript.rows.PermissionCard
import com.codedeck.plus.ui.transcript.rows.PlanApprovalCard
import com.codedeck.plus.ui.transcript.rows.QuestionCard
import com.codedeck.plus.ui.transcript.rows.SyncGapRow
import com.codedeck.plus.ui.transcript.rows.StatusRow
import com.codedeck.plus.ui.transcript.rows.Segment
import com.codedeck.plus.ui.transcript.rows.ToolGroupRow
import com.codedeck.plus.ui.transcript.rows.ToolGroupSheet
import com.codedeck.plus.ui.transcript.rows.UserMessageRow
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiOutboxItem

/**
 * The virtualized transcript — port of `TranscriptView.tsx`. `LazyColumn` +
 * [rememberTranscriptPin] replace virtua's `VList` + `useTranscriptPin`;
 * rows come from the already-grouped `displayEntries` (Rust's
 * `presentation::display_entries`, decoded by `DisplayEntries.kt`), followed
 * by the session's uncovered outbox items (CDX-063,
 * [visibleOutboxItems]), plus a sync-gap placeholder while a cycle fills a
 * known gap.
 */
/**
 * Wraps the actual content in `key(sessionId)` — a session switch is a
 * REMOUNT (CDX-086's own fix, mirrored here exactly as
 * `rememberTranscriptPin`'s doc comment describes), so every `remember`
 * below (pin state, expanded groups) resets fresh
 * per session without needing every future caller to remember to wrap this
 * itself.
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
    /** A turn is running: the list ends on what the agent is doing, and a
     *  call still waiting on its result is running, not cut short. */
    running: Boolean,
    /** The plan, sub-agents and background tasks: a line under the list
     *  while any is ongoing, opening the activity sheet. */
    activity: ActivityView?,
    /** The agent stops a background task on request (`supportsTasks`). */
    canStopTasks: Boolean,
    dispatch: (UniffiIntent) -> Unit,
    modifier: Modifier = Modifier,
) = key(sessionId) {
    TranscriptListContent(
        displayEntries, outboxItems, machine, sessionId, syncState, contiguous,
        respondedCards, planApprovalChoices, running, activity, canStopTasks, dispatch, modifier,
    )
}

/** An open tool-group sheet: the group's seq, the step it opens on (see
 *  [ToolGroupSheet]'s `openAt`) if not its own first page, and whether it
 *  was opened from the activity sheet, which Back then returns to. */
private data class OpenGroup(val seq: Long, val at: List<Long>? = null, val fromActivity: Boolean = false)

@Composable
private fun TranscriptListContent(
    displayEntries: List<DisplayEntry>,
    outboxItems: List<UniffiOutboxItem>,
    machine: String,
    sessionId: String,
    syncState: String,
    contiguous: Boolean,
    respondedCards: Set<String>,
    planApprovalChoices: Map<String, String>,
    running: Boolean,
    activity: ActivityView?,
    canStopTasks: Boolean,
    dispatch: (UniffiIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expandedGroups by remember(sessionId) { mutableStateOf(setOf<Long>()) }
    // The tool group whose sheet is open, by seq: the sheet reads the group
    // from the live rows, so results landing while it is open show up in it.
    var openGroup by remember(sessionId) { mutableStateOf<OpenGroup?>(null) }
    var activityOpen by remember(sessionId) { mutableStateOf(false) }

    val visibleOutbox = remember(outboxItems, displayEntries, machine, sessionId) {
        visibleOutboxItems(outboxItems, machine, sessionId, displayEntries)
    }
    val showSyncGap = !contiguous && (syncState == "requested" || syncState == "syncing" || syncState == "failed")
    // A long message is several items, one per block, so only what is on
    // screen is composed and laid out.
    val rows = remember(displayEntries) { listRowsOf(displayEntries) }
    val itemCount = rows.size + visibleOutbox.size + (if (showSyncGap) 1 else 0) + (if (running) 1 else 0)

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

    // Created only once there is something to show (the transcript loads
    // asynchronously, so the first frames of an opened session — or of an
    // activity recreated by a rotation — are empty), and created AT the last
    // row: the list's first frame is already the bottom of the conversation
    // instead of its top followed by a visible scroll down. The pin owner's
    // first positioning finishes the job for a last row taller than the
    // viewport.
    val listState = remember { LazyListState(firstVisibleItemIndex = itemCount - 1) }
    val pin = rememberTranscriptPin(listState, itemCount)

    Column(modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(Tokens.Space3),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space2),
            ) {
                if (showSyncGap) {
                    item(key = "sync-gap", contentType = "sync-gap") { SyncGapRow(failed = syncState == "failed") }
                }
                // contentType lets the lazy list reuse a scrolled-off row's
                // composition only for a row of the same kind (a tool group never
                // gets recycled into a Markdown message and vice versa).
                items(rows, key = { it.key }, contentType = { it.contentType }) { row ->
                    val entry = row.entry
                    if (row is ListRow.Block) {
                        when (entry) {
                            is DisplayEntry.AgentMessage -> AgentTextRow(row.text, entry.isPlan, row.segment)
                            is DisplayEntry.UserMessage -> UserMessageRow(row.text, row.segment)
                            else -> {}
                        }
                        return@items
                    }
                    TranscriptRow(
                        item = entry,
                        machine = machine,
                        sessionId = sessionId,
                        live = running,
                        onOpenGroup = { openGroup = OpenGroup(entry.seq) },
                        expanded = expandedGroups.contains(entry.seq),
                        onToggle = {
                            expandedGroups = if (expandedGroups.contains(entry.seq)) {
                                expandedGroups - entry.seq
                            } else {
                                expandedGroups + entry.seq
                            }
                        },
                        respondedCards = respondedCards,
                        planChoices = planApprovalChoices,
                        actions = dispatch,
                    )
                }
                if (running) {
                    item(key = "activity", contentType = "activity") {
                        val last = displayEntries.lastOrNull() as? DisplayEntry.ToolGroup
                        val call = activityOf(displayEntries)
                        // A sub-agent at work opens on its own page, with its steps.
                        val at = call?.takeIf { it.toolKind == "agent" }?.let { listOf(it.seq) }
                        ActivityRow(call, onOpen = last?.let { { openGroup = OpenGroup(it.seq, at) } })
                    }
                }
                items(visibleOutbox, key = { "o${it.id}" }, contentType = { "outbox" }) { item ->
                    OutboxRow(item) { id -> dispatch(UniffiIntent.RetryOutboxItem(machine = machine, id = id)) }
                }
            }
            openGroup?.let { open ->
                (displayEntries.firstOrNull { it.seq == open.seq } as? DisplayEntry.ToolGroup)?.let { group ->
                    ToolGroupSheet(
                        group,
                        live = running,
                        openAt = open.at,
                        onDismiss = { openGroup = null },
                        onBackOut = if (open.fromActivity) {
                            {
                                openGroup = null
                                activityOpen = true
                            }
                        } else {
                            null
                        },
                    )
                }
            }
            if (activityOpen && activity != null) {
                ActivitySheet(
                    activity = activity,
                    live = running,
                    canStop = canStopTasks,
                    onOpenAgent = { agent ->
                        activityOpen = false
                        openGroup = OpenGroup(agent.groupSeq, listOf(agent.callSeq), fromActivity = true)
                    },
                    onStopTask = { taskId ->
                        dispatch(UniffiIntent.StopTask(machine = machine, sessionId = sessionId, taskId = taskId))
                    },
                    onDismiss = { activityOpen = false },
                )
            }
            if (!pin.pinned) {
                Column(
                    Modifier
                        .minimumInteractiveComponentSize()
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
        if (activity != null && activity.ongoing()) {
            ActivityBar(activity, live = running, onOpen = { activityOpen = true })
        }
    }
}

/** One item of the transcript list: an entry, or one block of a long message. */
private sealed interface ListRow {
    val entry: DisplayEntry
    val key: String
    val contentType: Any

    data class Entry(override val entry: DisplayEntry) : ListRow {
        override val key get() = "e${entry.seq}"
        override val contentType: Any get() = entry::class
    }

    /** Block [index] of a message cut by `markdownBlocks`. The first keeps
     *  the entry's own key, so a message that grows past one block keeps its
     *  item (and scroll position) rather than being replaced. */
    data class Block(override val entry: DisplayEntry, val index: Int, val text: String, val segment: Segment) : ListRow {
        override val key get() = if (index == 0) "e${entry.seq}" else "e${entry.seq}.$index"
        override val contentType: Any get() = entry::class
    }
}

private fun listRowsOf(entries: List<DisplayEntry>): List<ListRow> = buildList {
    for (entry in entries) {
        val blocks = when (entry) {
            is DisplayEntry.AgentMessage -> entry.blocks
            is DisplayEntry.UserMessage -> entry.blocks
            else -> null
        }
        if (blocks == null || blocks.size == 1) {
            add(ListRow.Entry(entry))
            continue
        }
        blocks.forEachIndexed { i, text ->
            val segment = when (i) {
                0 -> Segment.First
                blocks.lastIndex -> Segment.Last
                else -> Segment.Middle
            }
            add(ListRow.Block(entry, i, text, segment))
        }
    }
}

@Composable
private fun TranscriptRow(
    item: DisplayEntry,
    machine: String,
    sessionId: String,
    live: Boolean,
    onOpenGroup: () -> Unit,
    expanded: Boolean,
    onToggle: () -> Unit,
    respondedCards: Set<String>,
    planChoices: Map<String, String>,
    actions: (UniffiIntent) -> Unit,
) {
    when (item) {
        is DisplayEntry.UserMessage -> UserMessageRow(item.text)
        is DisplayEntry.AgentMessage -> AgentTextRow(item.text, item.isPlan)
        is DisplayEntry.ToolGroup -> ToolGroupRow(item, live, onOpenGroup)
        is DisplayEntry.Diff -> DiffRow(item.path, item.lines, item.truncated, expanded, onToggle)
        is DisplayEntry.Error -> ErrorRow(item.text)
        is DisplayEntry.Status -> StatusRow(item.text)
        is DisplayEntry.Notice -> NoticeRow(item.notice, item.text)
        is DisplayEntry.Task -> TaskRow(item)
        is DisplayEntry.PlanApproval -> PlanApprovalCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            responded = respondedCards.contains(item.requestId),
            choice = planChoices[item.requestId],
            actions = actions,
        )
        is DisplayEntry.Question -> QuestionCard(
            item = item,
            machine = machine,
            sessionId = sessionId,
            respondedCards = respondedCards,
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
