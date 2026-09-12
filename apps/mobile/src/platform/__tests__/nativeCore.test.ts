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
    expect(await core.connectionStatus()).toEqual({
      status: 'connected',
      needsPairingCheck: true,
      connectedRelays: [],
    });
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

    listeners.get('core://connection')!({
      payload: { status: 'waiting-retry', needsPairingCheck: false, connectedRelays: ['wss://relay.example'] },
    });
    expect(snapshots).toEqual([
      { status: 'waiting-retry', needsPairingCheck: false, connectedRelays: ['wss://relay.example'] },
    ]);
  });

  it('dispatch sends the Intent verbatim to core_dispatch', async () => {
    const { calls, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    await core.dispatch({ sendInput: { machine: 'm1', sessionId: 's1', text: 'hi', inputId: 'in-1' } });
    expect(calls).toEqual([
      { cmd: 'core_dispatch', args: { intent: { sendInput: { machine: 'm1', sessionId: 's1', text: 'hi', inputId: 'in-1' } } } },
    ]);
  });

  it('each *View method calls its own core_*_view command', async () => {
    const { calls, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    await core.machinesView();
    await core.settingsView();
    await core.outboxView();
    await core.pairingView();
    await core.dmView();
    await core.marmotView();
    expect(calls.map((c) => c.cmd)).toEqual([
      'core_machines_view',
      'core_settings_view',
      'core_outbox_view',
      'core_pairing_view',
      'core_dm_view',
      'core_marmot_view',
    ]);
  });

  it('onCoreEvent forwards the raw CoreEvent payload untouched', async () => {
    const { listeners, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    const seen: unknown[] = [];
    await core.onCoreEvent((e) => seen.push(e));

    listeners.get('core://event')!({ payload: { stateChanged: { slice: 'machines' } } });
    listeners.get('core://event')!({ payload: { pairingSettled: { paired: true } } });
    expect(seen).toEqual([
      { stateChanged: { slice: 'machines' } },
      { pairingSettled: { paired: true } },
    ]);
  });

  it('onResume fires on both tauri://resume and tauri://focus, and unlistens both', async () => {
    const { listeners, invoke, listen } = fakes();
    const core = nativeCoreOver(invoke, listen);
    let fired = 0;
    const unlisten = await core.onResume(() => {
      fired++;
    });

    expect(listeners.has('tauri://resume')).toBe(true);
    expect(listeners.has('tauri://focus')).toBe(true);
    listeners.get('tauri://resume')!({ payload: undefined });
    listeners.get('tauri://focus')!({ payload: undefined });
    expect(fired).toBe(2);

    unlisten();
    expect(listeners.has('tauri://resume')).toBe(false);
    expect(listeners.has('tauri://focus')).toBe(false); // both torn down, not just one
  });
});
