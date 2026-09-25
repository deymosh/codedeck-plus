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
import org.junit.Rule
import org.junit.Test

/**
 * Pins the Markdown renderer's output (tables, task lists, code blocks) on
 * this project's actual Kotlin/AGP/Compose toolchain: the library was chosen
 * on an older pin, and a screenshot regression here is the guardrail that
 * a renderer or toolchain bump did not quietly break those cases.
 */
class MarkdownParityTest {

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

    @Test
    fun assistant_markdown_gfm_and_code() {
        paparazzi.snapshot { dark { TranscriptMarkdown(MarkdownCorpus.ASSISTANT_MARKDOWN) } }
    }
}
