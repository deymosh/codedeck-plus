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
 * F3.3.2 — reproduces `spike/markdown-compose-probe`'s verdict for real,
 * inside `apps/android` itself, against this project's actual Kotlin 2.4.20/
 * AGP 9.4.0/Compose BOM 2026.09.00 toolchain (the spike ran on an older,
 * throwaway pin). A screenshot regression here is the guardrail the spike's
 * README asked F3 to set up before deleting it.
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
