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
import com.codedeck.plus.ui.transcript.rows.QuestionGroupCard
import com.codedeck.plus.ui.transcript.rows.ToolGroupRow
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test

/**
 * F3.3.5 — Paparazzi goldens for a representative sample of transcript rows
 * and cards, sourced from the same shared fixture
 * `crates/uniffi-bridge/fixtures/display_entries_corpus.json` /
 * `DisplayEntriesFixtureTest.kt` already decode — one corpus, exercised as
 * both a decode-correctness test and a render-fidelity golden.
 *
 * Scoped down from the F3.3 execution plan's "every card kind, both pending
 * and resolved states": this covers each kind once, in its PENDING
 * (unanswered) state — the resolved-state branches are simple, already
 * unit-testable string logic (`PLAN_APPROVAL_LABELS`, the `answered`/
 * `responded` early-return in each card) rather than a rendering risk on
 * the order of tables/checkboxes/diff coloring. Widen this suite before
 * shipping a real device build, not before this milestone lands.
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
                    ToolGroupRow(group.entries, group.summary, expanded = false, onToggle = {})
                    ToolGroupRow(group.entries, group.summary, expanded = true, onToggle = {})
                }
            }
        }
    }

    @Test
    fun diff_card() {
        val diff = corpus().filterIsInstance<DisplayEntry.Diff>().first()
        paparazzi.snapshot { dark { DiffRow(diff.entry, expanded = false, onToggle = {}) } }
    }

    @Test
    fun permission_card_pending() {
        val permission = corpus().filterIsInstance<DisplayEntry.PermissionRequest>().first()
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
            dark { QuestionCard(question, "machine", "session", responded = false, actions = {}) }
        }
    }

    @Test
    fun question_group_card_pending() {
        val group = corpus().filterIsInstance<DisplayEntry.QuestionGroup>().first()
        paparazzi.snapshot {
            dark {
                QuestionGroupCard(group, "machine", "session", respondedCards = emptySet(), onAdvance = {}, actions = {})
            }
        }
    }
}
