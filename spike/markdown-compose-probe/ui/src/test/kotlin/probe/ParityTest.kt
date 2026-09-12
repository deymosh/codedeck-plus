package probe

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.ide.common.rendering.api.SessionParams
import org.junit.Rule
import org.junit.Test

class ParityTest {

    @get:Rule
    val paparazzi = Paparazzi(
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false),
        renderingMode = SessionParams.RenderingMode.V_SCROLL,
        showSystemUi = false,
    )

    @Test fun assistant_markdown_gfm_and_code() {
        paparazzi.snapshot { CodeDeckDark { AssistantMarkdown(Corpus.ASSISTANT_MARKDOWN) } }
    }

    @Test fun user_message() {
        paparazzi.snapshot { CodeDeckDark { UserMessage(Corpus.USER_MESSAGE) } }
    }

    @Test fun diff_card() {
        paparazzi.snapshot { CodeDeckDark { DiffCard(Corpus.DIFF_FILE, Corpus.DIFF_LINES) } }
    }

    @Test fun tool_group() {
        paparazzi.snapshot { CodeDeckDark { ToolGroup(Corpus.TOOL_GROUP) } }
    }
}
