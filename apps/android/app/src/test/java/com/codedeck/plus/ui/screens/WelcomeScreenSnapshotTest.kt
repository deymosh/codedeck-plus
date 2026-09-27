package com.codedeck.plus.ui.screens

import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.codedeck.plus.platform.SignerAppInfo
import com.codedeck.plus.ui.theme.CodeDeckTheme
import org.junit.Rule
import org.junit.Test

/** The first-launch screen: with a signer app installed, without one (the
 *  import field open, after a bad key), and while a signer is asked. */
class WelcomeScreenSnapshotTest {

    @get:Rule
    val paparazzi = Paparazzi(
        // Taller than a phone, so the whole scrolling screen is in the shot.
        deviceConfig = DeviceConfig.PIXEL_6.copy(softButtons = false, screenHeight = 3000),
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
}
