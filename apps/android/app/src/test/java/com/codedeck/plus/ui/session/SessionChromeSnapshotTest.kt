package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.android.ide.common.rendering.api.SessionParams
import com.codedeck.plus.ui.theme.CodeDeckTheme
import com.codedeck.plus.ui.theme.Tokens
import org.junit.Rule
import org.junit.Test
import uniffi.client_ffi.UniffiOptionChoice
import uniffi.client_ffi.UniffiUsageData
import uniffi.client_ffi.UniffiUsageWindow

/**
 * The session screen's chrome on a narrow (360dp) phone, where it has to
 * fit: the top bar with a long title, the running-turn line, the failed-send
 * line, and the controls bar above the composer.
 */
class SessionChromeSnapshotTest {

    @get:Rule
    val paparazzi = Paparazzi(
        // 1080 px at 3x density = a 360dp-wide phone.
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false, screenWidth = 1080, density = Density.XXHIGH),
        renderingMode = SessionParams.RenderingMode.SHRINK,
        showSystemUi = false,
    )

    @Test
    fun session_chrome_on_a_narrow_phone() {
        paparazzi.snapshot {
            CodeDeckTheme {
                Surface(color = Tokens.Bg, contentColor = Tokens.Text) {
                    Column(Modifier.background(Tokens.Bg).fillMaxWidth()) {
                        SessionTopBar(
                            title = "Refactor the relay reconnect logic so a flapping socket never duplicates subscriptions",
                            workspace = "/home/dev/projects/codedeck-docker",
                            sessionState = "running",
                            onBack = {},
                        )
                        Spacer(Modifier.height(120.dp))
                        ThinkingIndicator(onStop = {})
                        SendFailedBar(
                            text = "Also make sure the reconnect backoff resets after a clean close",
                            failedCount = 2,
                            onRetry = {},
                        )
                        SessionControlsBar(
                            effort = "high",
                            efforts = listOf(
                                UniffiOptionChoice("low", "Low", null),
                                UniffiOptionChoice("high", "High", null),
                            ),
                            modeLabel = "EDITS",
                            modePending = false,
                            model = "claude-opus-5-5",
                            contextPercentage = 82.0,
                            contextWindow = 200_000,
                            onEffortSelect = {},
                            onModeTap = {},
                            showUsageBadge = true,
                            usage = UniffiUsageData(
                                available = true,
                                plan = "max",
                                windows = listOf(
                                    UniffiUsageWindow(label = "5h", utilization = 61.0, resetsAt = null),
                                    UniffiUsageWindow(label = "7d", utilization = 23.0, resetsAt = null),
                                ),
                                sessionCostUsd = null,
                                fetchedAt = "2026-09-23T10:00:00Z",
                            ),
                        )
                    }
                }
            }
        }
    }
}
