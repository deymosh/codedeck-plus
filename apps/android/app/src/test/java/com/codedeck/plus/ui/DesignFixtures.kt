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
import uniffi.client_ffi.UniffiAgentPlugins
import uniffi.client_ffi.UniffiAvailablePlugin
import uniffi.client_ffi.UniffiInstalledPlugin
import uniffi.client_ffi.UniffiPluginFailure
import uniffi.client_ffi.UniffiPluginMarketplace
import uniffi.client_ffi.UniffiCredentialStatus
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiQuickPrompt
import uniffi.client_ffi.UniffiSessionCommands
import uniffi.client_ffi.UniffiSessionSummary
import uniffi.client_ffi.UniffiSlashCommand
import uniffi.client_ffi.UniffiSettingsView

/** Fixed data the design snapshots render: two machines, their agents and
 *  sessions, settings, and a transcript with every entry kind. */
internal object DesignFixtures {
    const val NOW = 1_800_000_000_000L

    fun session(id: String, title: String, project: String, state: String?, agent: String = "claude-code", committed: Boolean? = null) =
        UniffiSessionSummary(
            id = id, title = title, slug = id, cwd = "/home/me/code/$project", project = project, state = state,
            presence = "live", lastActivity = "2026-09-27T10:00:00Z", agent = agent, model = null, mode = null, effort = null,
            contextPercentage = null, contextWindow = null, committed = committed, seqHigh = null, usage = null, gsd = null, commands = null,
        )

    /** A Claude Code session's commands, a plugin's among them. */
    val commands = UniffiSessionCommands(
        commands = listOf(
            UniffiSlashCommand("compact", "Free up context by summarizing the conversation so far", "<optional custom summarization instructions>"),
            UniffiSlashCommand("code-review", "Review the current diff, or a PR, for correctness bugs", "[low|medium|high] [--fix] [<pr#>]"),
            UniffiSlashCommand("commit-commands:commit", "(commit-commands) Create a git commit", null),
            UniffiSlashCommand("commit-commands:commit-push-pr", "(commit-commands) Commit, push, and open a PR", null),
            UniffiSlashCommand("context", "Show current context usage", null),
            UniffiSlashCommand("init", "Initialize a new CLAUDE.md file with codebase documentation", null),
        ),
        error = null,
    )

    val claude = UniffiAgent(
        id = "claude-code", displayName = "Claude Code",
        modes = listOf(UniffiOptionChoice("default", "Ask first", null), UniffiOptionChoice("acceptEdits", "Accept edits", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = listOf(UniffiOptionChoice("low", "Low", null), UniffiOptionChoice("high", "High", null)),
        defaultMode = "default", defaultEffort = null,
        supportsModels = true, supportsUsage = true, supportsProviders = true, supportsGsd = false, supportsInterrupt = true, supportsCommands = true, supportsPlugins = true,
        credentials = listOf(UniffiCredentialStatus("oauth", "Claude token", present = true, fromEnv = false, valid = true)),
    )
    val opencode = UniffiAgent(
        id = "opencode", displayName = "OpenCode",
        modes = listOf(UniffiOptionChoice("build", "Build", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = emptyList(), defaultMode = "build", defaultEffort = null,
        supportsModels = true, supportsUsage = false, supportsProviders = false, supportsGsd = false, supportsInterrupt = true, supportsCommands = true, supportsPlugins = true,
        credentials = emptyList(),
    )

    private const val OFFICIAL = "claude-plugins-official"

    /** Claude Code's plugins: two installed (one off), two marketplaces, an
     *  install under way, and a change that failed. */
    val claudePlugins = UniffiAgentPlugins(
        agent = "claude-code",
        installed = listOf(
            UniffiInstalledPlugin("commit-commands@$OFFICIAL", "commit-commands", OFFICIAL, "fa59bc903774", "Streamline your git workflow with simple commands for committing, pushing, and creating pull requests", enabled = true),
            UniffiInstalledPlugin("my-skills@deymosh-skills", "my-skills", "deymosh-skills", "1.4.0", "The skills I carry from project to project", enabled = false),
        ),
        marketplaces = listOf(
            UniffiPluginMarketplace(OFFICIAL, "anthropics/claude-plugins-official"),
            UniffiPluginMarketplace("deymosh-skills", "https://github.com/deymosh/claude-skills.git"),
        ),
        toggles = true,
        available = listOf(
            UniffiAvailablePlugin("code-review@$OFFICIAL", "code-review", OFFICIAL, "Automated code review for pull requests using multiple specialized agents", 9120uL),
            UniffiAvailablePlugin("frontend-design@$OFFICIAL", "frontend-design", OFFICIAL, "Distinctive, intentional visual design for new UI", 5874uL),
            UniffiAvailablePlugin("security-guidance@$OFFICIAL", "security-guidance", OFFICIAL, "Warns about risky patterns while Claude edits files", 3327uL),
            UniffiAvailablePlugin("agentforce-adlc@$OFFICIAL", "agentforce-adlc", OFFICIAL, "Agentforce Agent Development Life Cycle — author, discover, scaffold, deploy, test, and optimize .agent files", 1490uL),
        ),
        error = null,
        busy = listOf("frontend-design@$OFFICIAL"),
        failure = UniffiPluginFailure("install", "nope@$OFFICIAL", "Plugin \"nope\" not found in marketplace \"$OFFICIAL\""),
    )

    val opencodePlugins = UniffiAgentPlugins(
        agent = "opencode",
        installed = listOf(UniffiInstalledPlugin("opencode-wakatime", "opencode-wakatime", null, null, null, enabled = true)),
        marketplaces = null, toggles = false, available = null, error = null, busy = emptyList(), failure = null,
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
        providerProfiles = emptyList(), plugins = listOf(claudePlugins, opencodePlugins),
        directAdvertised = listOf("wss://192.168.1.20:7447"), directPinned = true,
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
