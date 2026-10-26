package com.codedeck.plus.ui

import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import com.codedeck.plus.ui.session.SessionOptions
import com.codedeck.plus.ui.transcript.ActivityView
import com.codedeck.plus.ui.transcript.DisplayEntry
import com.codedeck.plus.ui.transcript.OptionChoice
import com.codedeck.plus.ui.transcript.PermissionOption
import com.codedeck.plus.ui.transcript.QuestionOption
import com.codedeck.plus.ui.transcript.QuestionView
import com.codedeck.plus.ui.transcript.displayEntriesJson
import com.codedeck.plus.ui.transcript.parseActivity
import com.codedeck.plus.ui.transcript.parseDisplayEntries
import kotlinx.serialization.json.jsonObject
import uniffi.client_ffi.UniffiAccountConnection
import uniffi.client_ffi.UniffiAccountField
import uniffi.client_ffi.UniffiAccountMethod
import uniffi.client_ffi.UniffiAgentAccount
import uniffi.client_ffi.UniffiAgentAccounts
import uniffi.client_ffi.UniffiAgentPermissionRules
import uniffi.client_ffi.UniffiFieldCondition
import uniffi.client_ffi.UniffiSignIn
import uniffi.client_ffi.UniffiPermissionRule
import uniffi.client_ffi.UniffiAgent
import uniffi.client_ffi.UniffiAgentDefaults
import uniffi.client_ffi.UniffiAgentPersonas
import uniffi.client_ffi.UniffiAgentModels
import uniffi.client_ffi.UniffiAgentPlugins
import uniffi.client_ffi.UniffiAvailablePlugin
import uniffi.client_ffi.UniffiBackupStatus
import uniffi.client_ffi.UniffiBackupView
import uniffi.client_ffi.UniffiInstalledPlugin
import uniffi.client_ffi.UniffiAgentMcp
import uniffi.client_ffi.UniffiMcpImport
import uniffi.client_ffi.UniffiMcpImportProblem
import uniffi.client_ffi.UniffiMcpServer
import uniffi.client_ffi.UniffiMcpServerSpec
import uniffi.client_ffi.UniffiContextBreakdown
import uniffi.client_ffi.UniffiContextCategory
import uniffi.client_ffi.UniffiContextGroup
import uniffi.client_ffi.UniffiContextItem
import uniffi.client_ffi.UniffiSessionMcp
import uniffi.client_ffi.UniffiSessionMcpServer
import uniffi.client_ffi.UniffiPluginFailure
import uniffi.client_ffi.UniffiPluginMarketplace
import uniffi.client_ffi.UniffiPluginNotice
import uniffi.client_ffi.UniffiCredentialStatus
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiModelEntry
import uniffi.client_ffi.UniffiProviderProfileInfo
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiPersona
import uniffi.client_ffi.UniffiQuickPrompt
import uniffi.client_ffi.UniffiSessionCommands
import uniffi.client_ffi.UniffiSessionSummary
import uniffi.client_ffi.UniffiSlashCommand
import uniffi.client_ffi.UniffiSettingsView
import uniffi.client_ffi.UniffiAgentStyle
import uniffi.client_ffi.UniffiUserMessageShape

/** Fixed data the design snapshots render: two machines, their agents and
 *  sessions, settings, and a transcript with every entry kind. */
internal object DesignFixtures {
    const val NOW = 1_800_000_000_000L

    fun session(id: String, title: String, project: String, state: String?, agent: String = "claude-code", committed: Boolean? = null) =
        UniffiSessionSummary(
            id = id, title = title, slug = id, cwd = "/home/me/code/$project", project = project, state = state,
            presence = "live", lastActivity = "2026-09-27T10:00:00Z", agent = agent, model = null, mode = null, effort = null,
            contextPercentage = null, contextWindow = null, committed = committed, seqHigh = null, usage = null, commands = null, mcp = null,
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

    /** Claude Code's style as its driver reports it (its word list cut short). */
    val claudeStyle = UniffiAgentStyle(
        spinnerFrames = listOf("·", "✢", "✳", "✶", "✻", "✽", "✽", "✻", "✶", "✳", "✢", "·"), spinnerIntervalMs = 120u,
        workingWords = listOf("Brewing", "Pondering", "Wrangling"), workingCounter = true,
        toolGlyphs = mapOf("other" to "●"), resultMark = "⎿", userMessage = UniffiUserMessageShape.Prompt(">"),
        wordmark = listOf(" ▐▛███▜▌ ", "▝▜█████▛▘", "  ▘▘ ▝▝  "), wordmarkSplit = 0u,
        accent = 0xFFD77757u, modeColors = mapOf("plan" to 0xFF48968Cu, "acceptEdits" to 0xFFAF87FFu),
    )

    /** OpenCode's style as its driver reports it, its mode colours keyed by this fixture's modes. */
    val opencodeStyle = UniffiAgentStyle(
        spinnerFrames = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"), spinnerIntervalMs = 80u,
        workingWords = emptyList(), workingCounter = false,
        toolGlyphs = mapOf("read" to "→", "edit" to "←", "delete" to "←", "search" to "✱", "fetch" to "%", "execute" to "$", "agent" to "→", "other" to "→"),
        resultMark = "↳", userMessage = UniffiUserMessageShape.Block,
        wordmark = listOf(
            "                                 ▄     ",
            "█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
            "█  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
            "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
        ),
        wordmarkSplit = 20u, accent = null, modeColors = mapOf("build" to 0xFF5C9CF5u, "plan" to 0xFF9D7CD8u),
    )

    /** DeepSeek Harness's style as its driver reports it: a one-tone wordmark and nothing else. */
    val deepseekStyle = UniffiAgentStyle(
        spinnerFrames = emptyList(), spinnerIntervalMs = 0u, workingWords = emptyList(), workingCounter = false,
        toolGlyphs = emptyMap(), resultMark = null, userMessage = UniffiUserMessageShape.Bubble,
        wordmark = listOf(
            "   ▄                               ▄   ",
            "█▀▀█ █▀▀█ █▀▀█ █▀▀█ █▀▀▀ █▀▀█ █▀▀█ █ ▄▀",
            "█  █ █▀▀▀ █▀▀▀ █  █ ▀▀▀█ █▀▀▀ █▀▀▀ █▀▄ ",
            "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀  ▀",
        ),
        wordmarkSplit = 0u, accent = null, modeColors = emptyMap(),
    )

    /** Qwen Code's style as its driver reports it: its CLI's spinner and prompt mark, a gold "QWEN", its mode colours. */
    val qwenStyle = UniffiAgentStyle(
        spinnerFrames = listOf("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"), spinnerIntervalMs = 80u,
        workingWords = emptyList(), workingCounter = true,
        toolGlyphs = emptyMap(), resultMark = null, userMessage = UniffiUserMessageShape.Prompt(">"),
        wordmark = listOf(
            "▄▄▄▄ ▄  ▄ ▄▄▄▄ ▄▖ ▄",
            "█  █ █  █ █    █▜▖█",
            "█ ▜█ █▐▌█ █▀▀  █ ▜█",
            "▀▀▀█ ▀▀▀▀ ▀▀▀▀ ▀  ▀",
        ),
        wordmarkSplit = 0u, accent = 0xFFFFD700u,
        modeColors = mapOf("plan" to 0xFFAAD94Cu, "auto-edit" to 0xFFFFD700u, "auto" to 0xFF39BAE6u),
    )

    val claude = UniffiAgent(
        id = "claude-code", displayName = "Claude Code",
        modes = listOf(UniffiOptionChoice("default", "Ask first", null), UniffiOptionChoice("acceptEdits", "Accept edits", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = listOf(UniffiOptionChoice("low", "Low", null), UniffiOptionChoice("high", "High", null)),
        defaultMode = "default", defaultEffort = null,
        supportsModels = true, supportsUsage = true, supportsProviders = true, supportsProviderModels = false, supportsInterrupt = true, supportsCommands = true, supportsPlugins = true, supportsMcp = true, supportsTasks = true, supportsPermissionRules = false, supportsAccounts = false,
        credentials = listOf(UniffiCredentialStatus("oauth", "Claude token", present = true, fromEnv = false, valid = true)),
        installState = "ready", removable = false, installError = null, actionBusy = null, actionFailure = null, style = claudeStyle,
    )
    val opencode = UniffiAgent(
        id = "opencode", displayName = "OpenCode",
        modes = listOf(UniffiOptionChoice("build", "Build", null), UniffiOptionChoice("plan", "Plan", null)),
        efforts = emptyList(), defaultMode = "build", defaultEffort = null, defaultPersona = "build",
        supportsModels = true, supportsUsage = false, supportsProviders = false, supportsProviderModels = true, supportsInterrupt = true, supportsCommands = true, supportsPlugins = true, supportsMcp = true, supportsTasks = true, supportsPermissionRules = true, supportsAccounts = true,
        supportsPersonas = true,
        credentials = emptyList(),
        installState = "ready", removable = true, installError = null, actionBusy = null, actionFailure = null, style = opencodeStyle, version = "2.0.28",
    )
    /** OpenCode's own agent, a machine-wide one and a project's (with its colour). */
    val buildPersona = UniffiPersona("build", "Build", "The default agent. Executes tools based on configured permissions.", null)
    val docsPersona = UniffiPersona("docs-writer", "docs-writer", "Writes and edits documentation only", null)
    val reviewerPersona = UniffiPersona("reviewer", "reviewer", "Reviews code without changing it", 0xFFE5C07Bu)

    /** An agent the bridge offers and the machine does not have yet: a name, nothing it supports. */
    val deepseek = UniffiAgent(
        id = "deepseek-harness", displayName = "DeepSeek Harness",
        modes = emptyList(), efforts = emptyList(), defaultMode = null, defaultEffort = null,
        supportsModels = false, supportsUsage = false, supportsProviders = false, supportsProviderModels = false, supportsInterrupt = false, supportsCommands = false, supportsPlugins = false, supportsMcp = false, supportsTasks = false, supportsPermissionRules = false, supportsAccounts = false,
        credentials = emptyList(),
        installState = "not_installed", removable = false, installError = null, actionBusy = null, actionFailure = null, style = null,
    )

    private const val OFFICIAL = "claude-plugins-official"

    /** A gateway at home and OpenRouter for OpenCode, their models read from
     *  each; and one saved before providers named their agent. */
    val providerProfiles = listOf(
        UniffiProviderProfileInfo(
            id = "home-gateway", agent = "opencode", label = "Home gateway", baseUrl = "http://192.168.1.2:3458",
            models = listOf(
                UniffiModelEntry("OpenCode Go/deepseek-v4.1-flash", "deepseek-v4.1-flash", "Home gateway · OpenCode Go", 1_000_000u, emptyList()),
                UniffiModelEntry("Z.ai/glm-5.3-flash", "glm-5.3-flash", "Home gateway · Z.ai", 200_000u, emptyList()),
                UniffiModelEntry("qwen3.8-coder", null, "Home gateway", null, emptyList()),
            ),
            modelsFromProvider = true, defaultModel = "OpenCode Go/deepseek-v4.1-flash", hasToken = true, error = null,
        ),
        UniffiProviderProfileInfo(
            id = "openrouter", agent = "opencode", label = "OpenRouter", baseUrl = "https://openrouter.ai/api",
            models = (1..42).map { UniffiModelEntry("vendor/model-$it", "model-$it", "OpenRouter · vendor", null, emptyList()) },
            modelsFromProvider = true, defaultModel = null, hasToken = false,
            error = "OpenCode already has a provider called 'openrouter'. Give this profile another name.",
        ),
        UniffiProviderProfileInfo(
            id = "kimi-k3", agent = "", label = "Kimi K3", baseUrl = "https://api.moonshot.ai/anthropic",
            models = listOf(UniffiModelEntry("kimi-k3", "Kimi K3", "Kimi K3", null, emptyList())),
            modelsFromProvider = false, defaultModel = "kimi-k3", hasToken = true, error = null,
        ),
    )

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
        notice = UniffiPluginNotice("update", "commit-commands@$OFFICIAL", "Updated from 2a8ad9f74633 to fa59bc903774."),
        failure = UniffiPluginFailure("install", "nope@$OFFICIAL", "Plugin \"nope\" not found in marketplace \"$OFFICIAL\""),
    )

    val opencodePlugins = UniffiAgentPlugins(
        agent = "opencode",
        installed = listOf(UniffiInstalledPlugin("opencode-wakatime", "opencode-wakatime", null, null, null, enabled = true)),
        marketplaces = null, toggles = false, available = null, error = null, busy = emptyList(), notice = null, failure = null,
    )

    /** GitHub Copilot's sign-in as OpenCode offers it: a choice, then an
     *  address asked only for GitHub Enterprise. */
    val copilotSignIn = UniffiAccountMethod(
        "device", "sign-in", "Login with GitHub Copilot",
        listOf(
            UniffiAccountField(
                "deploymentType", "GitHub deployment", null, required = true,
                options = listOf(UniffiOptionChoice("github.com", "GitHub.com", "Public"), UniffiOptionChoice("enterprise", "GitHub Enterprise", null)),
                placeholder = null, defaultValue = null, `when` = emptyList(),
            ),
            UniffiAccountField(
                "enterpriseUrl", "GitHub Enterprise URL", null, required = true, options = emptyList(),
                placeholder = "company.ghe.com", defaultValue = null,
                `when` = listOf(UniffiFieldCondition("deploymentType", "enterprise", not = false)),
            ),
        ),
    )

    /** OpenCode's provider accounts: a key in use beside a second one, a
     *  token from the machine's environment, and part of the catalogue. */
    val opencodeConnected = listOf(
        UniffiAgentAccount(
            "github-copilot", "GitHub Copilot",
            methods = listOf(copilotSignIn),
            connections = listOf(UniffiAccountConnection("GITHUB_TOKEN", "GITHUB_TOKEN", "env", active = false, removable = false)),
        ),
        UniffiAgentAccount(
            "openrouter", "OpenRouter",
            methods = listOf(UniffiAccountMethod("key", "key", null, emptyList())),
            connections = listOf(
                UniffiAccountConnection("cred_1", "work", "key", active = true, removable = true),
                UniffiAccountConnection("cred_2", "personal", "key", active = false, removable = true),
            ),
        ),
    )

    val opencodeAccounts = UniffiAgentAccounts(
        agent = "opencode",
        connected = opencodeConnected,
        all = opencodeConnected + listOf(
            UniffiAgentAccount("anthropic", "Anthropic", listOf(UniffiAccountMethod("key", "key", null, emptyList())), emptyList()),
            UniffiAgentAccount("deepseek", "DeepSeek", listOf(UniffiAccountMethod("key", "key", null, emptyList())), emptyList()),
            UniffiAgentAccount(
                "openai", "OpenAI",
                listOf(UniffiAccountMethod("key", "key", null, emptyList()), UniffiAccountMethod("chatgpt-token-sharing", "sign-in", "Sign in with ChatGPT", emptyList())),
                emptyList(),
            ),
            UniffiAgentAccount(
                "opencode", "OpenCode Console",
                listOf(UniffiAccountMethod("key", "key", "API key (service account)", emptyList()), UniffiAccountMethod("device", "sign-in", "OpenCode Console account", emptyList())),
                emptyList(),
            ),
        ).sortedBy { it.name },
        error = null,
        busy = emptyList(),
        signIn = null,
    )

    /** A device sign-in waiting on its code, and a sign-in finished by pasting back. */
    val deviceSignIn = UniffiSignIn(
        account = "opencode", status = "started", attemptId = "con_1",
        url = "https://opencode.ai/console/device?user_code=WFZW-JRCC", instructions = "Enter code: WFZW-JRCC",
        expiresAt = 1_792_010_428_118u, pasteBack = false, error = null,
    )
    val pasteBackSignIn = UniffiSignIn(
        account = "openai", status = "started", attemptId = "con_2",
        url = "https://auth.openai.com/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A45493%2Fauth%2Fcallback",
        instructions = "Complete authorization in your browser. This window will close automatically.",
        expiresAt = 1_792_010_428_118u, pasteBack = true, error = null,
    )

    /** OpenCode's saved permissions: two projects, one rule being removed. */
    val opencodeRules = UniffiAgentPermissionRules(
        agent = "opencode",
        rules = listOf(
            UniffiPermissionRule("psv_1", "/home/me/code/codedeck-plus", "shell", "git status *", 1_792_008_058_637u),
            UniffiPermissionRule("psv_2", "/home/me/code/codedeck-plus", "shell", "pnpm test *", 1_792_008_000_000u),
            UniffiPermissionRule("psv_3", "/home/me/code/codedeck-plus", "edit", "docs/**", 1_791_900_000_000u),
            UniffiPermissionRule("psv_4", "/home/me/code/notes", "webfetch", "*", 1_791_800_000_000u),
        ),
        error = null,
        busy = listOf("psv_2"),
    )

    /** Claude Code's MCP servers: remote ones with a token header, a local
     *  command with an env variable, one being added. */
    val claudeMcp = UniffiAgentMcp(
        agent = "claude-code",
        servers = listOf(
            UniffiMcpServer("github", "http", "https://api.githubcopilot.com/mcp/", envKeys = emptyList(), headerKeys = listOf("Authorization"), enabled = true),
            UniffiMcpServer("linear", "sse", "https://mcp.linear.app/sse", envKeys = emptyList(), headerKeys = emptyList(), enabled = true),
            UniffiMcpServer("postgres", "stdio", "npx", envKeys = listOf("DATABASE_URL"), headerKeys = emptyList(), enabled = true),
        ),
        toggles = false, error = null, busy = listOf("postgres"), failure = null,
    )

    /** A running session's servers: connected, waiting on a sign-in, broken, and one switched off. */
    val sessionMcp = UniffiSessionMcp(
        servers = listOf(
            UniffiSessionMcpServer("github", "connected", null, 41u),
            UniffiSessionMcpServer("linear", "needs-auth", null, null),
            UniffiSessionMcpServer("postgres", "failed", "connect ECONNREFUSED 127.0.0.1:5432", null),
            UniffiSessionMcpServer("playwright", "disabled", null, null),
        ),
        toggles = true, projectWide = false, error = null, busy = emptyList(),
    )

    /** What the core finds in the pasted JSON of the import snapshot. */
    val mcpImport = UniffiMcpImport(
        servers = listOf(
            UniffiMcpServerSpec("filesystem", "stdio", "npx", listOf("-y", "@modelcontextprotocol/server-filesystem", "/home/me/code"), emptyMap(), "", emptyMap()),
            UniffiMcpServerSpec("sentry", "http", "", emptyList(), emptyMap(), "https://mcp.sentry.dev/mcp", mapOf("Authorization" to "Bearer sntrys_x")),
        ),
        problems = listOf(UniffiMcpImportProblem("old-ws", "old-ws: the transport \"websocket\" is not supported.")),
        error = null,
    )

    val workstation = UniffiMachineSummary(
        pubkeyHex = "a".repeat(64), name = "Workstation", host = "service",
        sessions = listOf(
            session("s1", "Fix the flaky reconnect test", "codedeck-plus", "running"),
            session("s2", "Per-machine relays", "codedeck-plus", "waiting_permission"),
            session("s3", "Tidy the release notes", "website", "idle", agent = "opencode", committed = true),
        ),
        capabilities = emptyList(), folders = listOf("codedeck-plus", "website", "dotfiles"), roots = emptyList(),
        agents = listOf(claude, opencode, deepseek),
        credentials = listOf(UniffiCredentialStatus("github", "GitHub token", present = false, fromEnv = false, valid = null)),
        models = listOf(UniffiAgentModels(
            "claude-code",
            listOf(
                UniffiModelEntry("opus", "Opus", "Anthropic", null, emptyList()),
                UniffiModelEntry("fable", "Fable", "Anthropic", null, emptyList()),
                UniffiModelEntry("OpenCode Go/glm-5.3-flash", "glm-5.3-flash", "OpenCode Go", null, emptyList()),
                UniffiModelEntry("Z.ai/glm-5.3-flash", "glm-5.3-flash", "Z.ai", null, emptyList()),
            ),
            "opus",
            null,
        ), UniffiAgentModels(
            "opencode",
            listOf(
                UniffiModelEntry(
                    "home-gateway/OpenCode Go/deepseek-v4.1-flash", "deepseek-v4.1-flash", "Home gateway · OpenCode Go", null,
                    listOf("default" to "Default", "low" to "Low", "medium" to "Medium", "high" to "High", "max" to "Max")
                        .map { (id, label) -> UniffiOptionChoice(id, label, null) },
                ),
                UniffiModelEntry("opencode/big-pickle", "Big Pickle", "OpenCode Zen", null, emptyList()),
            ),
            "home-gateway/OpenCode Go/deepseek-v4.1-flash",
            null,
        )),
        providerProfiles = providerProfiles, plugins = listOf(claudePlugins, opencodePlugins), mcp = listOf(claudeMcp), permissionRules = listOf(opencodeRules), accounts = listOf(opencodeAccounts),
        directAdvertised = listOf("wss://192.168.1.20:7447"), directPinned = true,
        directEndpoints = listOf("wss://workstation.tail1234.ts.net:7447"), directUp = "wss://192.168.1.20:7447",
        npub = "npub1q8zy7gyw0l9fh2qkj6x4wlcw5h6xyq9d0k3e8w2yv3m5l6n7p8r9s0tuvw",
        relays = listOf("wss://relay.example.org", "wss://nostr.home.lan:4869"),
        lastHeartbeatAt = (NOW - 20_000).toULong(), machineOffline = false,
        defaultAgent = "claude-code",
        agentDefaults = listOf(
            UniffiAgentDefaults("claude-code", mode = "acceptEdits", effort = "", model = "Z.ai/glm-5.3-flash"),
            UniffiAgentDefaults("opencode", mode = "", effort = "", model = "", persona = "docs-writer"),
        ),
        personas = listOf(UniffiAgentPersonas("opencode", listOf(buildPersona, docsPersona), null)),
    )
    val buildBox = workstation.copy(
        pubkeyHex = "b".repeat(64), name = "Build box", host = "cli",
        sessions = listOf(session("s4", "Bump the NDK", "infra", "idle")),
        agents = listOf(claude), directAdvertised = emptyList(), directEndpoints = emptyList(), directUp = null,
        lastHeartbeatAt = (NOW - 3 * 3_600_000).toULong(), machineOffline = true,
        relays = listOf("wss://relay.example.org"), defaultAgent = null, agentDefaults = emptyList(),
    )

    val settings = UniffiSettingsView(
        uiScale = 1.0, stayConnected = true, torProxyEnabled = false, blossomServer = "", maxUploadBytes = 5_250_000uL,
        notificationsEnabled = true, showUsageBadge = true, showCommitBadge = true,
        backup = UniffiBackupView(relay = null, savedAt = null, machines = null, status = UniffiBackupStatus.Idle),
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

    /** The corpus's activity: a plan under way, a sub-agent at work and a
     *  background command running beside one that failed. */
    fun activity(): ActivityView {
        val raw = javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!.bufferedReader().readText()
        return parseActivity(displayEntriesJson.parseToJsonElement(raw).jsonObject.getValue("activity").toString())
    }

    /** A plan document and the cards that wait on the user, unanswered. */
    val waitingCards: List<DisplayEntry> = listOf(
        DisplayEntry.AgentMessage(
            seq = 1,
            isPlan = true,
            text = "1. Move the reducer into `client-core`.\n2. Port its tests.\n3. Delete the TypeScript copy.",
        ),
        DisplayEntry.PlanApproval(
            seq = 2,
            requestId = "p1",
            options = listOf(
                OptionChoice("accept", "Yes, and auto-accept edits", "Edits apply without asking"),
                OptionChoice("default", "Yes, and ask before each edit"),
                OptionChoice("plan", "No, keep planning", "Stay in plan mode and send feedback"),
            ),
            revise = "plan",
        ),
        DisplayEntry.Question(
            seq = 3,
            requestId = "q1",
            questions = listOf(
                QuestionView(
                    index = 0,
                    header = "Tests",
                    question = "Should the ported tests keep their TypeScript names?",
                    options = listOf(QuestionOption("Keep them", "Easier to compare"), QuestionOption("Rename to Rust style")),
                ),
            ),
        ),
        DisplayEntry.PermissionRequest(
            seq = 4,
            requestId = "r1",
            toolName = "Bash",
            toolKind = "execute",
            title = "cargo test -p client-core",
            options = listOf(
                PermissionOption("allow", "Allow", "allow_once"),
                PermissionOption("always", "Always allow", "allow_always"),
                PermissionOption("deny", "Deny", "reject_once"),
            ),
        ),
        DisplayEntry.PermissionRequest(
            seq = 5,
            requestId = "r2",
            toolName = "Bash",
            toolKind = "execute",
            title = "git push --force origin release",
            reason = "Force-pushing a release branch needs a second look.",
            hook = "PreToolUse:Bash",
            hookPlugin = "guard-rails",
            options = listOf(
                PermissionOption("allow", "Allow", "allow_once"),
                PermissionOption("deny", "Deny", "reject_once"),
            ),
        ),
    )

    /** The QR scanner's permission launcher needs an owner; nothing launches in a snapshot. */
    val noResults = object : ActivityResultRegistryOwner {
        override val activityResultRegistry = object : ActivityResultRegistry() {
            override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {}
        }
    }

    /** A Claude Code session in plan mode, on Opus at high effort, with MCP servers. */
    /** What fills a Claude Code session's window, as its context view says. */
    val contextBreakdown = UniffiContextBreakdown(
        usedTokens = 84_200u,
        windowTokens = 200_000u,
        categories = listOf(
            UniffiContextCategory("Messages", 41_600u, "used"),
            UniffiContextCategory("System tools", 23_200u, "used"),
            UniffiContextCategory("MCP tools", 8_100u, "used"),
            UniffiContextCategory("System prompt", 6_200u, "used"),
            UniffiContextCategory("Memory files", 5_100u, "used"),
            UniffiContextCategory("Autocompact buffer", 33_000u, "buffer"),
            UniffiContextCategory("Free space", 82_800u, "free"),
            UniffiContextCategory("MCP tools (deferred)", 22_900u, "deferred"),
        ),
        groups = listOf(
            UniffiContextGroup(
                "MCP tools", 8_100u,
                listOf("create_issue" to 1_500u, "list_issues" to 1_200u, "get_pull_request" to 900u).map { (n, t) -> UniffiContextItem("github · $n", t) } +
                    (1..14).map { UniffiContextItem("linear · tool_$it", 321u) },
            ),
            UniffiContextGroup("Memory files", 5_100u, listOf(UniffiContextItem("/home/me/.claude/CLAUDE.md", 5_100u))),
        ),
    )

    val claudeOptions by lazy {
        SessionOptions(
            modelName = "Opus", model = "opus", models = workstation.models.first { it.agent == "claude-code" }.models,
            modes = claude.modes, mode = "plan", modePending = false,
            efforts = claude.efforts, effort = "high", mcp = sessionMcp,
        )
    }

    /** An OpenCode session on a gateway's model, from a list too long for the main page. */
    val opencodeOptions = SessionOptions(
        modelName = "deepseek-v4.1-flash", model = "home-gateway/OpenCode Go/deepseek-v4.1-flash",
        models = listOf(UniffiModelEntry("home-gateway/OpenCode Go/deepseek-v4.1-flash", "deepseek-v4.1-flash", "Home gateway · OpenCode Go", null, emptyList())) +
            (1..8).map { UniffiModelEntry("vendor/model-$it", "model-$it", "OpenRouter · vendor", null, emptyList()) },
        modes = opencode.modes, mode = "build", modePending = false,
        efforts = emptyList(), effort = null,
        personas = listOf(buildPersona, docsPersona, reviewerPersona), persona = "reviewer", defaultPersona = "build",
    )

    /** A DeepSeek Harness session on its own model, asking first. */
    val deepseekOptions = SessionOptions(
        modelName = "DeepSeek-V4-Pro", model = "deepseek-v4-pro",
        models = listOf(UniffiModelEntry("deepseek-v4-pro", "DeepSeek-V4-Pro", null, null, emptyList())),
        modes = listOf(UniffiOptionChoice("ask", "Ask first", null), UniffiOptionChoice("default", "Default", null)), mode = "ask", modePending = false,
        efforts = listOf(UniffiOptionChoice("high", "High", null)), effort = "high",
    )

    /** A Qwen Code session on a provider profile's model, planning. */
    val qwenOptions = SessionOptions(
        modelName = "qwen3-coder-plus", model = "qwen3-coder-plus",
        models = listOf(UniffiModelEntry("qwen3-coder-plus", "qwen3-coder-plus", "DashScope", null, emptyList())),
        modes = listOf(
            UniffiOptionChoice("default", "Ask", null), UniffiOptionChoice("auto-edit", "Auto edit", null),
            UniffiOptionChoice("plan", "Plan", null), UniffiOptionChoice("auto", "Auto", null), UniffiOptionChoice("yolo", "YOLO", null),
        ),
        mode = "plan", modePending = false,
        efforts = listOf(UniffiOptionChoice("medium", "Medium", null), UniffiOptionChoice("high", "High", null)), effort = "high",
    )
}
