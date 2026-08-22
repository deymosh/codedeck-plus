/**
 * Speech-to-text seam (Phase 5c, plan §5 "mic button").
 *
 * Android: the codedeck-stt Tauri plugin fires
 * `RecognizerIntent.ACTION_RECOGNIZE_SPEECH` — the SYSTEM recognizer activity
 * (Gboard/Google voice UI), which holds the RECORD_AUDIO permission itself, so
 * the app needs no mic permission at all. The recognized text comes back via
 * the activity result.
 *
 * Desktop / browser / cancelled / unavailable: resolves null — the caller
 * falls back to focusing the text input (the plan's desktop behaviour).
 */

const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function recognizeSpeech(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ text: string | null }>('plugin:codedeck-stt|recognize_speech');
    const text = result?.text?.trim();
    return text ? text : null;
  } catch (err) {
    // Desktop no-op impl, recognizer missing, or the user backed out — all
    // "no text", never an error surface.
    console.log(`[STT] recognize_speech unavailable: ${err}`);
    return null;
  }
}
