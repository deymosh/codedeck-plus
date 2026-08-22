package com.codedeck.stt

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.result.ActivityResult
import java.util.Locale
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

/**
 * Mic button STT (plan §5): fire the SYSTEM speech recognizer via
 * RecognizerIntent.ACTION_RECOGNIZE_SPEECH and hand the recognized text back
 * to the webview. The system recognizer activity records audio under its own
 * RECORD_AUDIO permission — this app declares none. Cancel/unavailable both
 * resolve `{ text: null }` (never a reject): the JS side treats null as
 * "focus the input instead".
 */
/*
 * CDX-089 — dictating a long message returned only the first half. This is a
 * ONE-SHOT recognizer activity: it decides on its own that you have finished as
 * soon as it detects end-of-speech, and returns whatever it had. A natural pause
 * mid-sentence is enough. The silence extras below ask it to wait longer.
 *
 * READ THIS BEFORE TRUSTING THEM: all three are ADVISORY. AOSP documents them as
 * hints that may be ignored, and several OEM recognizers (and Google's own, on
 * some versions) do exactly that. This is a mitigation, not a cure, and it can
 * only be judged on a device — the oracle is: speak, pause 3+ seconds, speak
 * again, and check that BOTH halves land in the draft.
 *
 * If it still truncates on comet, the real fix is a different architecture:
 * android.speech.SpeechRecognizer with a RecognitionListener, accumulating
 * partial results in Kotlin and streaming them over a Tauri Channel, plus an
 * in-app "listening, tap to stop" control so the USER ends dictation. That was
 * deliberately NOT built here — the founder chose to keep the system sheet.
 */
@TauriPlugin
class SttPlugin(private val activity: Activity) : Plugin(activity) {

    private companion object {
        /** Silence that ends dictation once speech is judged complete. */
        const val COMPLETE_SILENCE_MS = 4000L

        /** Silence that ends it when speech MIGHT be complete — this is the one
         *  that was cutting the founder's sentences in half. */
        const val POSSIBLY_COMPLETE_SILENCE_MS = 4000L

        /** Floor on the whole utterance, so an early pause cannot end it. */
        const val MINIMUM_LENGTH_MS = 20000L
    }

    @Command
    fun recognizeSpeech(invoke: Invoke) {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
            )
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your message")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Recognize in the device's language rather than the recognizer's
            // default, which is not reliably the same thing.
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            // CDX-089: advisory hints. See the note above the class.
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                COMPLETE_SILENCE_MS
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                POSSIBLY_COMPLETE_SILENCE_MS
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS,
                MINIMUM_LENGTH_MS
            )
        }
        if (intent.resolveActivity(activity.packageManager) == null) {
            // No recognizer on this device (rare; e.g. stripped AOSP builds).
            invoke.resolve(nullResult())
            return
        }
        startActivityForResult(invoke, intent, "onSpeechResult")
    }

    @ActivityCallback
    fun onSpeechResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve(nullResult())
            return
        }
        val text = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }
        if (text == null) {
            invoke.resolve(nullResult())
            return
        }
        invoke.resolve(JSObject().put("text", text))
    }

    /** JSONObject.NULL keeps the key present as an explicit JSON null. */
    private fun nullResult(): JSObject = JSObject().put("text", JSONObject.NULL)
}
