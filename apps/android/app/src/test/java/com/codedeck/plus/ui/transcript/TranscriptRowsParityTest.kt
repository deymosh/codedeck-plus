package com.codedeck.plus.ui.transcript

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.ide.common.rendering.api.SessionParams
import com.codedeck.plus.ui.theme.CodeDeckTheme
import com.codedeck.plus.ui.theme.Tokens
import com.codedeck.plus.ui.transcript.rows.ActivityBar
import com.codedeck.plus.ui.transcript.rows.ActivityRow
import com.codedeck.plus.ui.transcript.rows.ActivitySheetContent
import com.codedeck.plus.ui.transcript.rows.TaskRow
import com.codedeck.plus.ui.transcript.rows.DiffRow
import com.codedeck.plus.ui.transcript.rows.ToolSheetContent
import com.codedeck.plus.ui.transcript.rows.PermissionCard
import com.codedeck.plus.ui.transcript.rows.PlanApprovalCard
import com.codedeck.plus.ui.transcript.rows.QuestionCard
import com.codedeck.plus.ui.transcript.rows.ToolGroupRow
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test

/**
 * Paparazzi goldens for a representative sample of transcript rows and
 * cards, sourced from the same shared fixture
 * `crates/client-ffi/fixtures/display_entries_corpus.json` that
 * `DisplayEntriesFixtureTest.kt` decodes — one corpus, exercised as both a
 * decode-correctness test and a render-fidelity golden.
 *
 * Each card kind is covered once in its PENDING (unanswered) state; the
 * resolved-state branches are the simple `answered`/`responded` early return
 * in each card rather than a rendering risk.
 */
class TranscriptRowsParityTest {

    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false),
        renderingMode = SessionParams.RenderingMode.V_SCROLL,
        showSystemUi = false,
    )

    @Composable
    private fun dark(content: @Composable () -> Unit) {
        CodeDeckTheme {
            Surface(color = Tokens.Bg, contentColor = Tokens.Text) {
                Column(Modifier.background(Tokens.Bg).fillMaxWidth().padding(16.dp)) { content() }
            }
        }
    }

    private fun corpus(): List<DisplayEntry> {
        val root = displayEntriesJson.parseToJsonElement(
            javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!.bufferedReader().readText(),
        ).jsonObject
        return parseDisplayEntries(root.getValue("displayEntries").toString())
    }

    @Test
    fun tool_group_rows() {
        val groups = corpus().filterIsInstance<DisplayEntry.ToolGroup>()
        val work = editGroup()
        // A lone running command, as the transcript shows it mid-turn.
        val lone = work.copy(
            steps = listOf((work.steps[1] as ToolStep.Call).copy(result = null)),
            summary = "Ran",
            subject = "cargo test -p core \\…",
            added = 0, removed = 0, failed = 0,
        )
        paparazzi.snapshot {
            dark {
                Column {
                    groups.forEach { ToolGroupRow(it, live = false, onOpen = {}) }
                    ToolGroupRow(lone, live = true, onOpen = {})
                    ActivityRow(lone.runningCall, onOpen = {})
                    ActivityRow(null, onOpen = null)
                    // A sub-agent at work, and background tasks as rows.
                    ActivityRow(agentGroup().steps[0] as ToolStep.Call, onOpen = {})
                    corpus().filterIsInstance<DisplayEntry.Task>().forEach { TaskRow(it) }
                    TaskRow(DisplayEntry.Task(0, "bg-2", "shell", "npm run dev", "stopped"))
                }
            }
        }
    }

    @Composable
    private fun sheet(content: @Composable () -> Unit) {
        CodeDeckTheme {
            Surface(color = Tokens.SurfaceRaised, contentColor = Tokens.Text) {
                Column(Modifier.background(Tokens.SurfaceRaised).fillMaxWidth().padding(top = 16.dp)) { content() }
            }
        }
    }

    @Test
    fun tool_sheet_timeline() {
        val work = corpus().filterIsInstance<DisplayEntry.ToolGroup>()[1]
        paparazzi.snapshot { sheet { ToolSheetContent(work, live = false, openPath = emptyList(), onOpenPath = {}, onClose = {}) } }
    }

    @Test
    fun tool_sheet_edit_page() {
        val work = editGroup()
        paparazzi.snapshot { sheet { ToolSheetContent(work, live = false, openPath = listOf(work.steps[0].seq), onOpenPath = {}, onClose = {}) } }
    }

    @Test
    fun tool_sheet_failed_command_page() {
        val work = editGroup()
        paparazzi.snapshot { sheet { ToolSheetContent(work, live = false, openPath = listOf(work.steps[1].seq), onOpenPath = {}, onClose = {}) } }
    }

    /** The group with an edit and a failed command. */
    private fun editGroup(): DisplayEntry.ToolGroup =
        corpus().filterIsInstance<DisplayEntry.ToolGroup>().first { it.added > 0 }

    /** The group holding the corpus's sub-agent, checklist and background
     *  command. */
    private fun agentGroup(): DisplayEntry.ToolGroup =
        corpus().filterIsInstance<DisplayEntry.ToolGroup>().first { g -> g.steps.any { (it as? ToolStep.Call)?.toolKind == "agent" } }

    @Test
    fun tool_sheet_agent_page() {
        val group = agentGroup()
        paparazzi.snapshot { sheet { ToolSheetContent(group, live = true, openPath = listOf(group.steps[0].seq), onOpenPath = {}, onClose = {}) } }
    }

    @Test
    fun tool_sheet_agent_timeline() {
        val group = agentGroup()
        paparazzi.snapshot { sheet { ToolSheetContent(group, live = true, openPath = emptyList(), onOpenPath = {}, onClose = {}) } }
    }

    @Test
    fun tool_sheet_plan_page() {
        val group = agentGroup()
        paparazzi.snapshot { sheet { ToolSheetContent(group, live = false, openPath = listOf(group.steps[1].seq), onOpenPath = {}, onClose = {}) } }
    }

    private fun activity(): ActivityView {
        val root = displayEntriesJson.parseToJsonElement(
            javaClass.classLoader!!.getResourceAsStream("display_entries_corpus.json")!!.bufferedReader().readText(),
        ).jsonObject
        return parseActivity(root.getValue("activity").toString())
    }

    @Test
    fun activity_sheet() {
        paparazzi.snapshot {
            sheet { ActivitySheetContent(activity(), live = false, canStop = true, onOpenAgent = {}, onStopTask = {}, onClose = {}) }
        }
    }

    @Test
    fun activity_bar() {
        val a = activity()
        paparazzi.snapshot {
            dark {
                Column {
                    ActivityBar(a, live = false, onOpen = {})
                    // No plan: what the sub-agent does leads.
                    ActivityBar(a.copy(todos = emptyList()), live = false, onOpen = {})
                }
            }
        }
    }

    @Test
    fun diff_card() {
        val diff = corpus().filterIsInstance<DisplayEntry.Diff>().first()
        paparazzi.snapshot { dark { DiffRow(diff.path, diff.lines, diff.truncated, expanded = false, onToggle = {}) } }
    }

    @Test
    fun permission_card_pending() {
        val permission = corpus().filterIsInstance<DisplayEntry.PermissionRequest>().last()
        paparazzi.snapshot {
            dark { PermissionCard(permission, "machine", "session", responded = false, actions = {}) }
        }
    }

    @Test
    fun plan_approval_card_pending() {
        val plan = corpus().filterIsInstance<DisplayEntry.PlanApproval>().first()
        paparazzi.snapshot {
            dark { PlanApprovalCard(plan, "machine", "session", responded = false, choice = null, actions = {}) }
        }
    }

    @Test
    fun question_card_pending() {
        val question = corpus().filterIsInstance<DisplayEntry.Question>().first()
        paparazzi.snapshot {
            dark { QuestionCard(question, "machine", "session", respondedCards = emptySet(), actions = {}) }
        }
    }

    @Test
    fun question_group_card_pending() {
        val group = corpus().filterIsInstance<DisplayEntry.Question>().first { it.questions.size > 1 }
        paparazzi.snapshot {
            dark { QuestionCard(group, "machine", "session", respondedCards = emptySet(), actions = {}) }
        }
    }
}
