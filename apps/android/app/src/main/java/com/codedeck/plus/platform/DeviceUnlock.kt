package com.codedeck.plus.platform

import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The platform's own unlock prompt — a fingerprint, or the screen lock when
 * there is none — asked before a terminal opens when the user turned that
 * on. Only Android 11 and later can offer both in one prompt, so older
 * phones do not offer the setting at all rather than a weaker check.
 */
object DeviceUnlock {
    /** Read only behind the Android 11 check: the constants are Android 11's. */
    @RequiresApi(Build.VERSION_CODES.R)
    private object Api30 {
        const val AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }

    /** Whether this phone can ask: Android 11+, with a fingerprint or a screen lock set up. */
    fun available(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        val manager = context.getSystemService(BiometricManager::class.java) ?: return false
        return manager.canAuthenticate(Api30.AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
    }

    /** Ask, and return whether the user passed. A cancel, a failure or a phone that cannot ask is false. */
    suspend fun ask(context: Context, title: String): Boolean {
        if (!available(context) || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        return suspendCancellableCoroutine { cont ->
            val cancel = CancellationSignal()
            cont.invokeOnCancellation { cancel.cancel() }
            BiometricPrompt.Builder(context)
                .setTitle(title)
                .setAllowedAuthenticators(Api30.AUTHENTICATORS)
                .build()
                .authenticate(
                    cancel,
                    context.mainExecutor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            if (cont.isActive) cont.resume(true)
                        }

                        // A single failed read leaves the prompt up for another
                        // try; only an error (cancel, lockout) ends it.
                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (cont.isActive) cont.resume(false)
                        }
                    },
                )
        }
    }
}
