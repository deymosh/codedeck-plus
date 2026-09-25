package com.codedeck.plus.platform

/** What the stay-connected notification says: a headline and one line of
 *  detail. The app name already sits in the notification's header, so
 *  neither repeats it. */
internal data class StayConnectedStatus(val title: String, val text: String)

private fun plural(count: Int, one: String, many: String = "${one}s") = "$count ${if (count == 1) one else many}"

/**
 * The stay-connected notification's content, from the core's live views.
 * The title names how many machines are paired. The detail line puts
 * anything that needs the user first, then what is running, then relay
 * health. Only the parts that are worth reading appear: no "0 waiting",
 * and the relay count only once connected (before that, the connection
 * state itself is the news).
 *
 * @param sessionStates every paired machine's session states, in the
 *   `SessionState` wire spelling (`running`, `waiting_permission`, …).
 * @param connectionStatus the connection FSM's status; null before the
 *   first connection view arrives.
 */
internal fun stayConnectedStatus(
    machineCount: Int,
    sessionStates: List<String?>,
    connectionStatus: String?,
    connectedRelays: Int,
    configuredRelays: Int,
): StayConnectedStatus {
    val title = if (machineCount == 0) "No machines paired" else "Paired with ${plural(machineCount, "machine")}"

    val waiting = sessionStates.count { it == "waiting_permission" || it == "waiting_question" }
    val running = sessionStates.count { it == "running" }
    val parts = buildList {
        if (waiting > 0) add("${plural(waiting, "session")} waiting for you")
        if (running > 0) add("$running running")
        if (waiting == 0 && running == 0 && machineCount > 0) add("No sessions running")
        add(
            when (connectionStatus) {
                "connected" ->
                    if (configuredRelays > 0) {
                        "$connectedRelays/${plural(configuredRelays, "relay")}"
                    } else {
                        "Connected"
                    }
                "connecting", "idle", null -> "Connecting…"
                "waiting-retry" -> "Reconnecting…"
                "offline" -> "Offline"
                else -> "Disconnected"
            },
        )
    }
    return StayConnectedStatus(title, parts.joinToString(" · "))
}
