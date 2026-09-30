package com.codedeck.plus.ui.transcript

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Kotlin mirror of `crates/client-core/src/presentation/display_entries.rs`'s
 * `DisplayEntry` / `ToolStep` / `QuestionView` / `PendingPermissionSummary` —
 * the exact JSON `crates/client-ffi/src/views.rs`'s
 * `build_uniffi_transcript_view` crosses as
 * `UniffiKeyedEntry.json` / `UniffiTranscriptDelta.pendingPermissionJson`.
 * These are render-ready rows: the grouping, the call/result pairing and the
 * answered-state detection all happen in Rust; this file is a decode target,
 * not a second implementation.
 *
 * `crates/client-ffi/fixtures/display_entries_corpus.json` is the fixture both
 * sides verify against — `DisplayEntriesFixtureTest` decodes it here,
 * `display_entries_corpus.rs` asserts the Rust serializer still produces it.
 */
val displayEntriesJson: Json = Json {
    classDiscriminator = "kind"
    ignoreUnknownKeys = true
}

/** `type` is `add` / `del` / `context`. */
@Serializable
data class DiffLine(val type: String, val text: String)

/** An option on a plan-approval card (and the shape of an agent's mode /
 *  effort choices). */
@Serializable
data class OptionChoice(val id: String, val label: String, val description: String? = null)

/** One choice on a permission card. `kind` is `allow_once` / `allow_always`
 *  / `reject_once` / `reject_always` — what picking it does, so a card can
 *  style it without knowing the agent. */
@Serializable
data class PermissionOption(val id: String, val label: String, val kind: String) {
    val isReject: Boolean get() = kind.startsWith("reject")
}

@Serializable
data class QuestionOption(val label: String, val description: String? = null)

/** One question of an ask; `index` is what an answer names. */
@Serializable
data class QuestionView(
    val index: Int,
    val header: String? = null,
    val question: String,
    val options: List<QuestionOption> = emptyList(),
    val multiSelect: Boolean = false,
)

/** One item of the agent's checklist. `status` is `pending` /
 *  `in_progress` / `completed` / `cancelled`; `activeText` is how the agent
 *  says it while working on it, when it gives one. */
@Serializable
data class TodoItem(val text: String, val status: String, val activeText: String? = null)

@Serializable
data class ToolResultView(val text: String, val isError: Boolean = false)

/** One file a call changed, with its lines and how many it added and
 *  removed. */
@Serializable
data class FileDiffView(
    val path: String,
    val lines: List<DiffLine>,
    val truncated: Boolean = false,
    val added: Int = 0,
    val removed: Int = 0,
)

/** One step inside a collapsed tool group. Tagged by its own `step` field,
 *  since `kind` is the row's discriminant. */
@OptIn(ExperimentalSerializationApi::class)
@JsonClassDiscriminator("step")
@Serializable
sealed class ToolStep {
    abstract val seq: Long

    /** A tool call and, once it landed, its result. `toolKind` is the
     *  normalized kind (`read`, `edit`, `execute`, `agent`, …); `verb` /
     *  `activeVerb` name what it did / is doing (`Ran` / `Running`). */
    @Serializable
    @SerialName("call")
    data class Call(
        override val seq: Long,
        val callId: String,
        val toolName: String,
        val toolKind: String,
        val title: String,
        val input: String? = null,
        val verb: String,
        val activeVerb: String,
        val subagent: String? = null,
        val isSubAgent: Boolean = false,
        val result: ToolResultView? = null,
        val diffs: List<FileDiffView> = emptyList(),
        /** What the sub-agent this call started did: an `agent` call's own
         *  timeline. */
        val children: List<ToolStep> = emptyList(),
        /** The checklist this call wrote, when it wrote one. */
        val todos: List<TodoItem> = emptyList(),
        /** Where the background task this call started stands
         *  (`running` / `completed` / `failed` / `stopped`), when it started
         *  one. */
        val background: String? = null,
    ) : ToolStep() {
        val added: Int get() = diffs.sumOf { it.added }
        val removed: Int get() = diffs.sumOf { it.removed }
        val failed: Boolean get() = result?.isError == true
    }

    /** A result whose call is not in the transcript. */
    @Serializable
    @SerialName("result")
    data class Result(override val seq: Long, val text: String, val isError: Boolean = false) : ToolStep()

    @Serializable
    @SerialName("thinking")
    data class Thinking(override val seq: Long, val text: String, val redacted: Boolean = false) : ToolStep()

    /** Text a sub-agent wrote while it worked. */
    @Serializable
    @SerialName("text")
    data class Text(override val seq: Long, val text: String) : ToolStep()
}

/** Mirrors `PendingPermissionSummary` — the always-visible pending-permission
 *  bar's data, independent of whichever row (possibly buried in a collapsed
 *  tool group) actually carries the request. */
@Serializable
data class PendingPermissionSummary(
    val requestId: String,
    val toolName: String,
    val title: String,
    val description: String? = null,
    val options: List<PermissionOption> = emptyList(),
    val reason: String? = null,
    val hook: String? = null,
    val hookPlugin: String? = null,
    val isSubAgent: Boolean = false,
    val agentLabel: String? = null,
)

/**
 * One rendered transcript row. `seq` is the stable key — the seq of the
 * first entry making up this item.
 */
@Serializable
sealed class DisplayEntry {
    abstract val seq: Long

    @Serializable
    @SerialName("userMessage")
    data class UserMessage(override val seq: Long, val text: String) : DisplayEntry()

    /** Agent markdown; `isPlan` frames it as a plan document. */
    @Serializable
    @SerialName("agentMessage")
    data class AgentMessage(override val seq: Long, val text: String, val isPlan: Boolean = false) : DisplayEntry()

    /** A run of tool activity. `summary` says what it did ("Ran 3
     *  commands, read a file"); a lone call is its verb, with `subject`
     *  what it acted on. `added` / `removed` total its changes, `failed`
     *  counts calls whose result is an error. */
    @Serializable
    @SerialName("toolGroup")
    data class ToolGroup(
        override val seq: Long,
        val steps: List<ToolStep>,
        val summary: String,
        val subject: String? = null,
        val added: Int = 0,
        val removed: Int = 0,
        val failed: Int = 0,
    ) : DisplayEntry() {
        /** The call still waiting for its result, latest first. */
        val runningCall: ToolStep.Call?
            get() = steps.lastOrNull { it is ToolStep.Call && it.result == null } as ToolStep.Call?
    }

    /** Standalone — never absorbed into a tool group; the point of a diff
     *  card is to be seen. */
    @Serializable
    @SerialName("diff")
    data class Diff(
        override val seq: Long,
        val path: String,
        val lines: List<DiffLine>,
        val truncated: Boolean = false,
    ) : DisplayEntry()

    @Serializable
    @SerialName("error")
    data class Error(override val seq: Long, val text: String) : DisplayEntry()

    @Serializable
    @SerialName("status")
    data class Status(override val seq: Long, val text: String) : DisplayEntry()

    /** A lifecycle notice; `notice` is `session_restart` / `session_died` /
     *  `session_failed` / `auth_error`. */
    @Serializable
    @SerialName("notice")
    data class Notice(override val seq: Long, val notice: String, val text: String) : DisplayEntry()

    @Serializable
    @SerialName("planApproval")
    data class PlanApproval(
        override val seq: Long,
        val requestId: String,
        val options: List<OptionChoice> = emptyList(),
        /** The outcome, once the bridge resolved it. */
        val answered: String? = null,
    ) : DisplayEntry()

    /** One ask — a single question or several, sorted by `index`. */
    @Serializable
    @SerialName("question")
    data class Question(
        override val seq: Long,
        val requestId: String,
        val questions: List<QuestionView>,
        val answered: String? = null,
    ) : DisplayEntry()

    /** A background task no visible call started, or one that ended.
     *  `taskKind` is `shell` / `agent` / `other`; `status` as on
     *  [ToolStep.Call.background]. */
    @Serializable
    @SerialName("task")
    data class Task(
        override val seq: Long,
        val taskId: String,
        val taskKind: String,
        val title: String,
        val status: String,
        val summary: String? = null,
    ) : DisplayEntry()

    @Serializable
    @SerialName("permissionRequest")
    data class PermissionRequest(
        override val seq: Long,
        val requestId: String,
        val toolName: String,
        val toolKind: String,
        val title: String,
        val description: String? = null,
        val locations: List<String> = emptyList(),
        val options: List<PermissionOption> = emptyList(),
        /** Why the agent asks, in its words, when it says. */
        val reason: String? = null,
        /** The hook that asked (`PreToolUse:Bash`), when one did. */
        val hook: String? = null,
        /** The plugin that hook comes from, when known. */
        val hookPlugin: String? = null,
        val isSubAgent: Boolean = false,
        val agentLabel: String? = null,
        val answered: String? = null,
    ) : DisplayEntry()
}

/** The response-card key the core uses for question `index` of an ask —
 *  `client_runtime::intent::question_card_key`. */
fun questionCardKey(requestId: String, index: Int): String = "$requestId:q$index"

/** Parses a bare `Vec<DisplayEntry>` JSON array (the shared test fixture
 *  wraps one). `Json.decodeFromString` throws on a genuinely malformed
 *  payload, which would mean the FFI boundary itself is broken. */
fun parseDisplayEntries(json: String): List<DisplayEntry> =
    displayEntriesJson.decodeFromString(json)

/** Parses one row, `UniffiKeyedEntry.json`. */
fun parseDisplayEntry(json: String): DisplayEntry =
    displayEntriesJson.decodeFromString(json)

fun parsePendingPermission(json: String): PendingPermissionSummary =
    displayEntriesJson.decodeFromString(json)

/** One sub-agent, as the `agent` call that started it — mirrors
 *  `crates/client-core/src/presentation/activity.rs`'s `AgentView`.
 *  [groupSeq] / [callSeq] say where its call is, to open it. */
@Serializable
data class AgentActivity(
    val groupSeq: Long,
    val callSeq: Long,
    val title: String,
    val label: String? = null,
    val finished: Boolean = false,
    val failed: Boolean = false,
    val toolUses: Int = 0,
    /** What it is doing, or did last: "Reading a.rs". */
    val current: String? = null,
)

/** One background task as its latest entry says — `TaskView`. */
@Serializable
data class TaskActivity(
    val taskId: String,
    val taskKind: String,
    val title: String,
    val status: String,
    val summary: String? = null,
    val callId: String? = null,
) {
    val running: Boolean get() = status == "running"
}

/** What a session has going on beside the conversation — `ActivityView`,
 *  crossing as `UniffiTranscriptDelta.activityJson`: the latest checklist,
 *  the running sub-agents then the last few that finished, and the
 *  background tasks likewise. */
@Serializable
data class ActivityView(
    val todos: List<TodoItem> = emptyList(),
    val agents: List<AgentActivity> = emptyList(),
    val tasks: List<TaskActivity> = emptyList(),
)

fun parseActivity(json: String): ActivityView =
    displayEntriesJson.decodeFromString(json)
