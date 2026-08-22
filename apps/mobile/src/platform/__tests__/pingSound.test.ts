// @vitest-environment jsdom
/**
 * pingSound (Phase 4) — the chime is pure Web Audio and must degrade to a
 * clean no-op wherever AudioContext is unavailable (jsdom here; also a WebView
 * with audio disabled). The synthesis itself is device-verified by ear; these
 * tests pin the guard rails: never throws, unlock listener is one-shot.
 */
import { describe, expect, it, vi } from 'vitest';
import { initPingAudio, playAttentionPing } from '../pingSound';

describe('pingSound without AudioContext', () => {
  it('playAttentionPing never throws when Web Audio is unavailable', () => {
    expect('AudioContext' in window && window.AudioContext).toBeFalsy();
    expect(() => playAttentionPing()).not.toThrow();
  });

  it('initPingAudio is idempotent and its unlock gesture listener self-removes', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    initPingAudio();
    const bound = add.mock.calls.filter(([type]) =>
      ['pointerdown', 'touchend', 'keydown'].includes(type as string),
    ).length;
    expect(bound).toBe(3);

    // Second init is a no-op (one-shot module guard).
    initPingAudio();
    expect(
      add.mock.calls.filter(([type]) =>
        ['pointerdown', 'touchend', 'keydown'].includes(type as string),
      ).length,
    ).toBe(3);

    // First gesture runs the unlock (no AudioContext → harmless) and unbinds.
    window.dispatchEvent(new Event('pointerdown'));
    expect(
      remove.mock.calls.filter(([type]) =>
        ['pointerdown', 'touchend', 'keydown'].includes(type as string),
      ).length,
    ).toBe(3);

    add.mockRestore();
    remove.mockRestore();
  });
});
