package com.codedeck.plus.ui.screens

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.Density
import com.codedeck.plus.platform.SignerAppInfo
import com.codedeck.plus.ui.theme.CodeDeckTheme
import org.junit.Rule
import org.junit.Test

/** The first-launch screen: with a signer app installed, without one (the
 *  import field open, after a bad key), and while a signer is asked. */
class WelcomeScreenSnapshotTest {

    @get:Rule
    val paparazzi = Paparazzi(
        // What a 360x740 dp phone leaves between its status and navigation
        // bars (the app pads for both): 360x680 dp. The whole screen fits it
        // without scrolling.
        deviceConfig = DeviceConfig.PIXEL_6.copy(
            softButtons = false,
            screenWidth = 1080,
            screenHeight = 2040,
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
    fun without_a_signer_importing_a_bad_key() {
        paparazzi.snapshot {
            CodeDeckTheme {
                WelcomeScreen(
                    signers = emptyList(),
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

    @Test
    fun asking_the_signer() {
        paparazzi.snapshot {
            CodeDeckTheme {
                WelcomeScreen(
                    signers = listOf(amber, SignerAppInfo("com.example.signer", "Other signer")),
                    busy = WelcomeBusy.Signer(amber.packageName),
                    error = null,
                    onUseSigner = {},
                    onCreateKey = {},
                    onImportKey = {},
                )
            }
        }
    }

    /** The tallest the screen gets: two signers, the import open, an error.
     *  It must still fit, nothing below the fold. */
    @Test
    fun the_tallest_state_still_fits() {
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
