/**
 * Attention ping (Phase 4) — a short synthesized chime played when Claude needs
 * the user's attention (permission, question, plan approval, completion),
 * mirroring the desktop Claude Code hook that runs `pw-play complete.oga`.
 * Ported ~verbatim from the old app's src/services/pingSound.ts.
 *
 * Uses the Web Audio API (oscillator + gain envelope) so there's no bundled
 * audio asset, no Tauri asset-protocol path handling, and no extra plugin.
 * Works identically in the desktop/Android WebView and in browser dev mode;
 * no-ops cleanly where AudioContext is unavailable (vitest/jsdom).
 *
 * The ping is fired through the notification coordinator's `ping` dep
 * (core/notifications.ts), which already gates on decidePing ("app hidden or a
 * different session is active") and dedups via the shared cooldown — so this
 * module carries no gating or cooldown of its own.
 */

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let unlockBound = false;

/** Lazily create (or reuse) the shared AudioContext. Returns null if Web Audio is unavailable. */
function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor: AudioCtor | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Register a one-time gesture listener that resumes the (initially suspended) AudioContext.
 * WebView AudioContexts start in the 'suspended' state until a user gesture. Call once at
 * app startup. Idempotent; self-removes after the first gesture.
 */
export function initPingAudio(): void {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;

  const unlock = (): void => {
    const c = getCtx();
    if (c && c.state === 'suspended') {
      c.resume().catch(() => {});
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('touchend', unlock);
    window.removeEventListener('keydown', unlock);
  };

  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('touchend', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

/** Schedule one short tone on the shared context. */
function scheduleTone(c: AudioContext, freq: number, startAt: number, durSec: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startAt);

  // Quick attack, exponential decay — a soft chime rather than a flat beep.
  const peak = 0.15;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);

  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durSec + 0.02);
}

/**
 * Play a short two-tone "ping". No-ops cleanly if Web Audio is unavailable. Never throws —
 * it runs from the store's hot output path.
 */
export function playAttentionPing(): void {
  try {
    const c = getCtx();
    if (!c) return;
    // Android can re-suspend a backgrounded WebView's context; resume defensively.
    if (c.state === 'suspended') c.resume().catch(() => {});

    const t0 = c.currentTime + 0.01;
    const dur = 0.09;
    scheduleTone(c, 880, t0, dur); // A5
    scheduleTone(c, 1320, t0 + dur, dur); // ~E6
  } catch {
    // Ignore — audio is best-effort.
  }
}
