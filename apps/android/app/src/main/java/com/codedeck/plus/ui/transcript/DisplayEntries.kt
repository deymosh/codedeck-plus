package com.codedeck.plus.ui.transcript

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Kotlin mirror of `crates/client-core/src/presentation/display_entries.rs`'s
 * `DisplayEntry` and the `OutputEntry`/`SeqEntry`/`QuestionSpecView`/
 * `PendingPermissionSummary` types it carries — the exact JSON shape
 * `crates/uniffi-bridge/src/views.rs`'s `build_uniffi_transcript_view`
 * crosses as `UniffiTranscriptRowsView.displayEntriesJson`/
 * `pendingPermissionJson`. The grouping ALGORITHM lives only in Rust (see
 * that file's own doc comment for why it was already ported there but
 * unwired until F3.3) — this file is a decode target, not a second
 * implementation: it defines the shape and parses it, nothing more.
 *
 * `crates/uniffi-bridge/fixtures/display_entries_corpus.json` is the same
 * fixture both sides verify against — `DisplayEntriesFixtureTest` decodes it
 * here, `display_entries_corpus.rs`'s `matches_the_committed_fixture` test
 * asserts the real Rust serializer still produces it. A shape change on
 * either side that the other doesn't mirror shows up as a decode failure or
 * a git diff on the fixture, not a silent divergence.
 */
val displayEntriesJson: Json = Json {
    classDiscriminator = "kind"
    ignoreUnknownKeys = true
}

/** `OutputEntryType`'s `snake_case` wire spelling (`text`, `tool_use`,
 *  `tool_result`, `system`, `error`, `progress`, `thinking`, `diff`). */
@Serializable
data class OutputEntry(
    val entryType: String,
    val content: String,
    val timestamp: String,
    /** Arbitrary bridge-supplied JSON, keys in their ORIGINAL `snake_case`
     *  wire spelling (e.g. `tool_use_id`, `has_plan`) — this field alone is
     *  not re-cased, unlike every typed field around it, because it is
     *  genuinely untyped passthrough (see `protocol::common::OutputEntry`'s
     *  own doc comment). Row renderers read it the same loose way the TS
     *  renderer reads `entry.metadata?.tool_use_id`. */
    val metadata: JsonObject? = null,
    /** Present iff `entryType == "diff"`. */
    val diff: DiffData? = null,
)

@Serializable
data class DiffData(
    val path: String,
    val lines: List<DiffLine>,
    val truncated: Boolean? = null,
)

/** `type`'s wire spelling is `add` / `del` / `context` (`DiffLineType`,
 *  `lowercase`). */
@Serializable
data class DiffLine(val type: String, val text: String)

@Serializable
data class SeqEntry(val seq: Long, val entry: OutputEntry)

@Serializable
data class QuestionOption(val label: String, val description: String? = null)

@Serializable
data class QuestionSpecView(
    val entry: OutputEntry,
    val header: String? = null,
    val options: List<QuestionOption>? = null,
    val multiSelect: Boolean? = null,
)

/** Mirrors `PendingPermissionSummary` — the always-visible pending-permission
 *  bar's data, independent of whichever `DisplayEntry` row (possibly buried
 *  in a collapsed tool group) actually carries the request. */
@Serializable
data class PendingPermissionSummary(
    val requestId: String,
    val toolName: String,
    val description: String,
    val isSubAgent: Boolean,
    val agentLabel: String? = null,
)

/**
 * One rendered transcript row. `seq` is the stable key — the seq of the
 * first entry making up this item, same contract as the TS `DisplayEntry`
 * union's own `seq` field.
 */
@Serializable
sealed class DisplayEntry {
    abstract val seq: Long

    @Serializable
    @SerialName("userMessage")
    data class UserMessage(override val seq: Long, val entry: OutputEntry) : DisplayEntry()

    @Serializable
    @SerialName("assistantMessage")
    data class AssistantMessage(
        override val seq: Long,
        val entry: OutputEntry,
        /** `true` for `special=plan` entries (plan markdown, stays visible). */
        val isPlan: Boolean = false,
    ) : DisplayEntry()

    @Serializable
    @SerialName("toolGroup")
    data class ToolGroup(override val seq: Long, val entries: List<SeqEntry>, val summary: String) : DisplayEntry()

    /** Standalone — never absorbed into a tool group; the point of a diff
     *  card is to be seen (CDX-050). */
    @Serializable
    @SerialName("diff")
    data class Diff(override val seq: Long, val entry: OutputEntry) : DisplayEntry()

    @Serializable
    @SerialName("error")
    data class Error(override val seq: Long, val entry: OutputEntry) : DisplayEntry()

    @Serializable
    @SerialName("system")
    data class System(override val seq: Long, val entry: OutputEntry) : DisplayEntry()

    @Serializable
    @SerialName("lifecycle")
    data class Lifecycle(override val seq: Long, val entry: OutputEntry) : DisplayEntry()

    @Serializable
    @SerialName("planApproval")
    data class PlanApproval(
        override val seq: Long,
        val entry: OutputEntry,
        val toolUseId: String? = null,
        val hasPlan: Boolean,
        /** `"Plan approved"` once a matching `tool_result` resolved it. */
        val answered: String? = null,
    ) : DisplayEntry()

    @Serializable
    @SerialName("question")
    data class Question(
        override val seq: Long,
        val toolUseId: String? = null,
        val question: QuestionSpecView,
        val answered: String? = null,
    ) : DisplayEntry()

    /** A multi-question turn (grouped by `toolUseId`), sorted by
     *  `question_index` server-side — the broker answers questions IN
     *  ORDER, so the active tab is always the first unanswered one. */
    @Serializable
    @SerialName("questionGroup")
    data class QuestionGroup(
        override val seq: Long,
        val toolUseId: String,
        val questions: List<QuestionSpecView>,
        val answered: String? = null,
    ) : DisplayEntry()

    @Serializable
    @SerialName("permissionRequest")
    data class PermissionRequest(
        override val seq: Long,
        val entry: OutputEntry,
        val toolName: String,
        val description: String,
        val requestId: String,
        val isSubAgent: Boolean,
        val agentLabel: String? = null,
        val answered: String? = null,
    ) : DisplayEntry()
}

/** Parses `UniffiTranscriptRowsView.displayEntriesJson` (a bare
 *  `Vec<DisplayEntry>` array — NOT wrapped the way the shared test fixture
 *  is). Total by construction: `Json.decodeFromString` throws on a genuinely
 *  malformed payload, which would mean the FFI boundary itself is broken —
 *  there is no partial/defensive parse to fall back to on this side, same as
 *  every other `*View` crossing this FFI. */
fun parseDisplayEntries(json: String): List<DisplayEntry> =
    displayEntriesJson.decodeFromString(json)

fun parsePendingPermission(json: String): PendingPermissionSummary =
    displayEntriesJson.decodeFromString(json)
