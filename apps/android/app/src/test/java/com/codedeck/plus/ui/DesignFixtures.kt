package com.codedeck.plus.ui

import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.displayEntriesJson
import com.codedeck.plus.ui.transcript.parseDisplayEntries
import kotlinx.serialization.json.jsonObject
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiAgentDefaults
import uniffi.client_ffi.UniffiAgentModels
import uniffi.client_ffi.UniffiCredentialStatus
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiQuickPrompt
import uniffi.client_ffi.UniffiSessionSummary
import uniffi.client_ffi.UniffiSettingsView

/** Fixed data the design snapshots render: two machines, their agents and
 *  sessions, settings, and a transcript with every entry kind. */
internal object DesignFixtures {
    const val NOW = 1_800_000_000_000L

    fun session(id: String, title: String, project: String, state: String?, agent: String = "claude-code", committed: Boolean? = null) =
        UniffiSessionSummary(
            id = id, title = title, slug = id, cwd = "/home/me/code/$project", project = project, state = state,
            presence = "live", lastActivity = "2026-09-27T10:00:00Z", agent = agent, model = null, mode = null, effort = null,
            contextPercentage = null, contextWindow = null, committed = committed, seqHigh = null, usage = null, gsd = null,
        )

    val claude = UniffiAgent(
        id = "claude-code", displayName = "Claude Code",
        modes = listOf(UniffiOptionChoice("default", "Ask first", null), UniffiOptionChoice("acceptEdits", "Accept edits", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = listOf(UniffiOptionChoice("low", "Low", null), UniffiOptionChoice("high", "High", null)),
        defaultMode = "default", defaultEffort = null,
        supportsModels = true, supportsUsage = true, supportsProviders = true, supportsGsd = false, supportsInterrupt = true,
        credentials = listOf(UniffiCredentialStatus("oauth", "Claude token", present = true, fromEnv = false, valid = true)),
    )
    val opencode = UniffiAgent(
        id = "opencode", displayName = "OpenCode",
        modes = listOf(UniffiOptionChoice("build", "Build", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = emptyList(), defaultMode = "build", defaultEffort = null,
        supportsModels = true, supportsUsage = false, supportsProviders = false, supportsGsd = false, supportsInterrupt = true,
        credentials = emptyList(),
    )

    val workstation = UniffiMachineSummary(
        pubkeyHex = "a".repeat(64), name = "Workstation", host = "service",
        sessions = listOf(
            session("s1", "Fix the flaky reconnect test", "codedeck-plus", "running"),
            session("s2", "Per-machine relays", "codedeck-plus", "waiting_permission"),
            session("s3", "Tidy the release notes", "website", "idle", agent = "opencode", committed = true),
        ),
        capabilities = emptyList(), folders = listOf("codedeck-plus", "website", "dotfiles"), roots = emptyList(),
        agents = listOf(claude, opencode),
        credentials = listOf(UniffiCredentialStatus("github", "GitHub token", present = false, fromEnv = false, valid = null)),
        models = listOf(UniffiAgentModels("claude-code", listOf(UniffiModelEntry("opus", "Opus"), UniffiModelEntry("fable", "Fable")), "opus", null)),
        providerProfiles = emptyList(), directAdvertised = listOf("wss://192.168.1.20:7447"), directPinned = true,
        directEndpoints = listOf("wss://workstation.tail1234.ts.net:7447"), directUp = "wss://192.168.1.20:7447",
        npub = "npub1q8zy7gyw0l9fh2qkj6x4wlcw5h6xyq9d0k3e8w2yv3m5l6n7p8r9s0tuvw",
        relays = listOf("wss://relay.example.org", "wss://nostr.home.lan:4869"),
        lastHeartbeatAt = (NOW - 20_000).toULong(), machineOffline = false,
        defaultAgent = "claude-code",
        agentDefaults = listOf(UniffiAgentDefaults("claude-code", mode = "acceptEdits", effort = "", model = "opus")),
    )
    val buildBox = workstation.copy(
        pubkeyHex = "b".repeat(64), name = "Build box", host = "cli",
        sessions = listOf(session("s4", "Bump the NDK", "infra", "idle")),
        agents = listOf(claude), directAdvertised = emptyList(), directEndpoints = emptyList(), directUp = null,
        lastHeartbeatAt = (NOW - 3 * 3_600_000).toULong(), machineOffline = true,
        relays = listOf("wss://relay.example.org"), defaultAgent = null, agentDefaults = emptyList(),
    )

    val settings = UniffiSettingsView(
        uiScale = 1.0, stayConnected = true, torProxyEnabled = false, blossomServer = "",
        notificationsEnabled = true, showUsageBadge = true, showCommitBadge = true,
    )

    val quickPrompts = listOf(
        UniffiQuickPrompt("q1", "Continue", "Continue where you left off."),
        UniffiQuickPrompt("q2", "Run the tests", "Run the tests and fix what fails."),
    )

    /** The shared transcript corpus (see `DisplayEntriesFixtureTest`): every entry kind. */
    fun transcript(): List<DisplayEntry> {
        val raw = javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!.bufferedReader().readText()
        return parseDisplayEntries(displayEntriesJson.parseToJsonElement(raw).jsonObject.getValue("displayEntries").toString())
    }

    /** The QR scanner's permission launcher needs an owner; nothing launches in a snapshot. */
    val noResults = object : ActivityResultRegistryOwner {
        override val activityResultRegistry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {}
        }
    }
}
