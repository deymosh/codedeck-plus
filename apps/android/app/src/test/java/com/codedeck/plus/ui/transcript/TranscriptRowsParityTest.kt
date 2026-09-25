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
import com.codedeck.plus.ui.transcript.rows.DiffRow
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
    fun tool_group_collapsed_and_expanded() {
        val group = corpus().filterIsInstance<DisplayEntry.ToolGroup>().first()
        paparazzi.snapshot {
            dark {
                Column {
                    ToolGroupRow(group.steps, group.summary, expanded = false, onToggle = {})
                    ToolGroupRow(group.steps, group.summary, expanded = true, onToggle = {})
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
