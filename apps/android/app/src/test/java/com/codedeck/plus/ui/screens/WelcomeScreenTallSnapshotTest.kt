package com.codedeck.plus.ui.screens

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.codedeck.plus.platform.SignerAppInfo
import com.codedeck.plus.ui.theme.CodeDeckTheme
import org.junit.Rule
import org.junit.Test

/** The welcome screen on a tall phone: centred while it fits, the options
 *  scrolling between the hero and the footnote once the import is open and
 *  an error shows. */
class WelcomeScreenTallSnapshotTest {

    @get:Rule
    val paparazzi = Paparazzi(
        // What a 411x914 dp phone leaves between its status and navigation
        // bars: 411x860 dp.
        deviceConfig = DeviceConfig.PIXEL_6.copy(
            softButtons = false,
            screenWidth = 1233,
            screenHeight = 2580,
            density = Density.XXHIGH,
        ),
        showSystemUi = false,
    )

    private val amber = SignerAppInfo("com.greenart7c3.nostrsigner", "Amber")

    @Test
    fun with_a_signer_installed() {
        paparazzi.snapshot {
            CodeDeckTheme {
                WelcomeScreen(
                    signers = listOf(amber),
                    busy = null,
                    error = null,
                    onUseSigner = {},
                    onCreateKey = {},
                    onImportKey = {},
                )
            }
        }
    }

    @Test
    fun the_tallest_state_scrolls_only_the_options() {
        paparazzi.snapshot {
            CodeDeckTheme {
                WelcomeScreen(
                    signers = listOf(amber, SignerAppInfo("com.example.signer", "Other signer")),
                    busy = null,
                    error = "That is not an nsec or a hex secret key.",
                    onUseSigner = {},
                    onCreateKey = {},
                    onImportKey = {},
                    importInitiallyOpen = true,
                )
            }
        }
    }
}
