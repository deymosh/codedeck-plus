package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import com.codedeck.plus.core.CoreBridge
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.theme.stateColor
import com.codedeck.plus.ui.transcript.PendingPermissionSummary
import com.codedeck.plus.ui.transcript.TranscriptList
import com.codedeck.plus.ui.transcript.parseDisplayEntries
import com.codedeck.plus.ui.transcript.parsePendingPermission
import kotlinx.coroutines.launch
import uniffi.uniffi_bridge.UniffiIntent
import uniffi.uniffi_bridge.UniffiTranscriptRowsView
import java.util.UUID

/**
 * F3.3.6 — the vertical slice's session screen: a minimal header (state/cwd/
 * connection/model+context, Stop while running — no mode-cycle tap, no
 * model/effort selects, no GSD strip; those are F4), [TranscriptList], the
 * always-visible pending-permission bar, and a text-only input bar. Port of
 * `SessionScreen.tsx` narrowed to exactly the F3.3 execution plan's scope —
 * image attachment, mic/STT, quick prompts, and usage badges are F4.
 */
@Composable
fun SessionScreen(bridge: CoreBridge, machine: String, sessionId: String, modifier: Modifier = Modifier) {
    val connection by bridge.connection.collectAsState()
    val machinesView by bridge.machines.collectAsState()
    val uiView by bridge.ui.collectAsState()
    val outboxView by bridge.outbox.collectAsState()
    val scope = rememberCoroutineScope()

    val sessionInfo = machinesView?.machines?.firstOrNull { it.pubkeyHex == machine }
        ?.sessions?.firstOrNull { it.id == sessionId }

    var transcriptView by remember(machine, sessionId) { mutableStateOf<UniffiTranscriptRowsView?>(null) }
    LaunchedEffect(machine, sessionId) {
        bridge.transcriptFlow(machine, sessionId).collect { transcriptView = it }
    }
    val displayEntries = remember(transcriptView) {
        transcriptView?.displayEntriesJson?.let(::parseDisplayEntries).orEmpty()
    }
    val pendingPermission: PendingPermissionSummary? = remember(transcriptView) {
        transcriptView?.pendingPermissionJson?.let(::parsePendingPermission)
    }

    val sessionKey = "$machine $sessionId"
    val respondedCards = uiView?.respondedCards?.get(sessionKey)?.toSet().orEmpty()
    val planChoices = uiView?.planApprovalChoices.orEmpty()

    var draft by remember(machine, sessionId) { mutableStateOf("") }

    fun dispatch(intent: UniffiIntent) {
        scope.launch { bridge.dispatch(intent) }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        dispatch(
            UniffiIntent.SendInput(
                machine = machine,
                sessionId = sessionId,
                text = text,
                inputId = UUID.randomUUID().toString(),
            ),
        )
    }

    Column(modifier.fillMaxSize()) {
        SessionHeader(
            state = sessionInfo?.state,
            cwd = sessionInfo?.cwd,
            connectionStatus = connection?.status,
            model = sessionInfo?.model,
            contextPercentage = sessionInfo?.contextPercentage,
            running = sessionInfo?.state == "running",
            onStop = { dispatch(UniffiIntent.Interrupt(machine = machine, sessionId = sessionId)) },
        )

        TranscriptList(
            displayEntries = displayEntries,
            outboxItems = outboxView?.items.orEmpty(),
            machine = machine,
            sessionId = sessionId,
            syncState = transcriptView?.syncState ?: "idle",
            contiguous = transcriptView?.contiguous ?: true,
            respondedCards = respondedCards,
            planApprovalChoices = planChoices,
            dispatch = ::dispatch,
            modifier = Modifier.weight(1f),
        )

        pendingPermission?.let { pending ->
            PendingPermissionBar(pending) { allow ->
                dispatch(
                    UniffiIntent.RespondPermission(
                        machine = machine,
                        sessionId = sessionId,
                        requestId = pending.requestId,
                        allow = allow,
                        modifier = null,
                    ),
                )
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(Tokens.Space2),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("Message the session…") },
                modifier = Modifier.weight(1f),
            )
            Button(onClick = ::send, enabled = draft.isNotBlank()) {
                Text("Send")
            }
        }
    }
}

@Composable
private fun SessionHeader(
    state: String?,
    cwd: String?,
    connectionStatus: String?,
    model: String?,
    contextPercentage: Double?,
    running: Boolean,
    onStop: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        if (state != null) {
            Text(
                state,
                color = Tokens.Bg,
                fontSize = Tokens.TextXs,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(stateColor(state))
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1 / 2),
            )
        }
        Text(
            cwd.orEmpty(),
            color = Tokens.TextMuted,
            fontSize = Tokens.TextXs,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(connectionStatus ?: "…", color = Tokens.TextDim, fontSize = Tokens.TextXs)
        if (model != null) {
            val ctx = contextPercentage?.let { " · ${it.toInt()}%" } ?: ""
            Text("$model$ctx", color = Tokens.TextMuted, fontSize = Tokens.TextXs)
        }
        if (running) {
            Text(
                "Stop",
                color = Tokens.Danger,
                fontSize = Tokens.TextSm,
                modifier = Modifier
                    .clip(RoundedCornerShape(Tokens.RadiusSm))
                    .background(Tokens.SurfaceHover)
                    .clickable(onClick = onStop)
                    .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
            )
        }
    }
}

@Composable
private fun PendingPermissionBar(pending: PendingPermissionSummary, onRespond: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(Tokens.Warn.copy(alpha = 0.12f))
            .padding(Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
    ) {
        val label = if (pending.isSubAgent) {
            "${pending.agentLabel ?: "Sub-agent"}: ${pending.toolName} needs permission"
        } else {
            "${pending.toolName} needs permission"
        }
        Text(label, color = Tokens.Text, fontSize = Tokens.TextSm, modifier = Modifier.weight(1f))
        Text(
            "Allow",
            color = Tokens.Success,
            fontSize = Tokens.TextSm,
            modifier = Modifier.clickable { onRespond(true) }.padding(Tokens.Space2),
        )
        Text(
            "Deny",
            color = Tokens.Danger,
            fontSize = Tokens.TextSm,
            modifier = Modifier.clickable { onRespond(false) }.padding(Tokens.Space2),
        )
    }
}
