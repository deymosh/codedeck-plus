/**
 * BridgeApi — the F1 in-process-runtime path. With `nativeSend` /
 * `nativePublishConfirmed` set, outbound skips buildCommand/publish (Rust
 * stamps + encrypts + signs), and `dispatchDecoded` routes a message the
 * native core already decoded straight to the handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeToPhoneMessage, PhoneToBridgeMessage } from '@codedeck/protocol';
import { BridgeApi } from '../services/bridgeApi';
import { generateKeypair } from '../crypto';
import type { Timers } from '../ports';

const timers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function nativeApi(over: Partial<ConstructorParameters<typeof BridgeApi>[0]> = {}) {
  const phone = generateKeypair();
  const nativeSend = vi.fn(async (_m: string, _msg: PhoneToBridgeMessage) => true);
  const nativePublishConfirmed = vi.fn(
    async (_m: string, _msg: PhoneToBridgeMessage) => ({ verdict: 'accepted' as const }),
  );
  const publish = vi.fn(async () => {
    throw new Error('the WebView transport must not be touched in native mode');
  });
  const onSessions = vi.fn();
  const onInputAck = vi.fn();
  const api = new BridgeApi({
    identity: () => phone,
    isKnownMachine: () => true,
    publish,
    nativeSend,
    nativePublishConfirmed,
    handlers: { onSessions, onInputAck },
    now: () => 1_000_000,
    timers,
    ...over,
  });
  return { api, nativeSend, nativePublishConfirmed, publish, onSessions, onInputAck };
}

describe('BridgeApi native (F1) path', () => {
  it('send routes the UNSTAMPED command to nativeSend, never publish', async () => {
    const { api, nativeSend, publish } = nativeApi();
    const ok = await api.input('machine-1', 's1', 'hello', 'in-1');
    expect(ok).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(nativeSend).toHaveBeenCalledTimes(1);
    const [machine, msg] = nativeSend.mock.calls[0]!;
    expect(machine).toBe('machine-1');
    expect(msg).toEqual({ type: 'input', sessionId: 's1', text: 'hello', inputId: 'in-1' });
    // Rust stamps v/caps — the WebView must not.
    expect(msg).not.toHaveProperty('v');
    expect(msg).not.toHaveProperty('caps');
  });

  it('a native send failure is contained (false, logged, not thrown)', async () => {
    const log = vi.fn();
    const { api, nativeSend } = nativeApi({ log });
    nativeSend.mockRejectedValueOnce(new Error('socket down'));
    await expect(api.refreshSessions('m')).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('native send'));
  });

  it('sendConfirmed routes to nativePublishConfirmed and returns its verdict', async () => {
    const { api, nativePublishConfirmed } = nativeApi();
    const r = await api.uploadImageBlossom('m', {
      sessionId: 's1',
      hash: 'c'.repeat(64),
      url: `https://blossom.example/${'c'.repeat(64)}`,
      key: 'a'.repeat(64),
      iv: 'b'.repeat(24),
      filename: 'p.png',
      mimeType: 'image/png',
      text: '',
      sizeBytes: 10,
    });
    expect(r.verdict).toBe('accepted');
    expect(nativePublishConfirmed).toHaveBeenCalledTimes(1);
    expect(nativePublishConfirmed.mock.calls[0]![0]).toBe('m');
    expect((nativePublishConfirmed.mock.calls[0]![1] as { type: string }).type).toBe('upload-image');
  });

  it('dispatchDecoded routes a pre-decoded message to its handler', () => {
    const { api, onInputAck } = nativeApi();
    const msg: BridgeToPhoneMessage = { type: 'input-ack', sessionId: 's1', inputId: 'in-9' };
    api.dispatchDecoded(msg, 'machine-1');
    expect(onInputAck).toHaveBeenCalledTimes(1);
    expect(onInputAck.mock.calls[0]![0]).toEqual(msg);
    expect(onInputAck.mock.calls[0]![1]).toBe('machine-1');
  });
});
