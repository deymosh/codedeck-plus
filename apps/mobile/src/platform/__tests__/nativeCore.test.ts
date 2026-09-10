/**
 * nativeCore seam tests — injected `invoke` / `listen` fakes prove the command
 * names, the argument shape, and that inbound `core://message` payloads are
 * re-validated through the real decoder before reaching a store.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeBridgeToPhone } from '@codedeck/protocol';
import { nativeCoreOver, type TauriInvoke, type TauriListen } from '../nativeCore';

function fakes() {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  const invoke: TauriInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'core_publish') return 'accepted' as unknown as never;
    if (cmd === 'core_connection_status') {
      return { status: 'connected', needs_pairing_check: true } as unknown as never;
    }
    return undefined as unknown as never;
  });
  const listen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  }) as unknown as TauriListen;
  return { calls, listeners, invoke, listen };
}

describe('nativeCoreOver', () => {
  it('maps every method to its core_* command with the right args', async () => {
    const { calls, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);

    await core.init({
      relays: ['wss://r'],
      identitySecretHex: 'ab'.repeat(32),
      proxy: '127.0.0.1:9050',
      tor: true,
    });
    await core.start();
    await core.stop();
    await core.pause();
    await core.resume();
    await core.setOnline(false);
    await core.setMachines(['m1']);
    await core.setRelays(['wss://r2']);
    await core.send('m1', { type: 'refresh-sessions' });
    const verdict = await core.publish('m1', { type: 'refresh-sessions' });

    expect(verdict).toBe('accepted');
    expect(calls.map((c) => c.cmd)).toEqual([
      'core_init',
      'core_start',
      'core_stop',
      'core_pause',
      'core_resume',
      'core_set_online',
      'core_set_machines',
      'core_set_relays',
      'core_send',
      'core_publish',
    ]);
    expect(calls[0]!.args).toEqual({
      config: {
        relays: ['wss://r'],
        identitySecretHex: 'ab'.repeat(32),
        proxy: '127.0.0.1:9050',
        tor: true,
      },
    });
    expect(calls[5]!.args).toEqual({ online: false });
    expect(calls[8]!.args).toEqual({ machine: 'm1', message: { type: 'refresh-sessions' } });
  });

  it('connectionStatus normalises snake_case + an unknown status', async () => {
    const { invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    expect(await core.connectionStatus()).toEqual({ status: 'connected', needsPairingCheck: true });
  });

  it('onMessage decodes the payload and drops an undecodable one', async () => {
    const { listeners, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    const seen: Array<[string, string]> = [];
    await core.onMessage((machine, msg) => seen.push([machine, msg.type]));

    const emit = listeners.get('core://message')!;
    const good = JSON.parse(
      encodeBridgeToPhone({ type: 'input-ack', sessionId: 's1', inputId: 'i1' }),
    );
    emit({ payload: { machine: 'm1', message: good } });
    emit({ payload: { machine: 'm1', message: { type: 'not-a-real-type' } } });

    expect(seen).toEqual([['m1', 'input-ack']]);
  });

  it('onConnection normalises each event payload', async () => {
    const { listeners, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    const snapshots: unknown[] = [];
    await core.onConnection((s) => snapshots.push(s));

    listeners.get('core://connection')!({ payload: { status: 'waiting-retry', needsPairingCheck: false } });
    expect(snapshots).toEqual([{ status: 'waiting-retry', needsPairingCheck: false }]);
  });
});
