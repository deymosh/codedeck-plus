import { describe, it, expect, afterEach } from 'vitest';
import type { FakeSdkFacade } from '@codedeck/testkit';
import { handleCommand } from '../control';
import { createHarness, type Harness } from '../harness';

describe('handleCommand — pure dispatch over a fake Harness', () => {
  it('routes emit-sdk-message to the facade and answers null on success', async () => {
    const emitted: { sessionId: string; msg: unknown }[] = [];
    const fake = {
      facade: { emit: (sessionId: string, msg: unknown) => emitted.push({ sessionId, msg }) },
    } as unknown as Harness;

    const res = await handleCommand(fake, {
      id: 'r1',
      cmd: 'emit-sdk-message',
      sessionId: 's1',
      message: { type: 'system' } as never,
    });

    expect(res).toEqual({ id: 'r1', ok: true, result: null });
    expect(emitted).toEqual([{ sessionId: 's1', msg: { type: 'system' } }]);
  });

  it('maps a thrown error to an ok:false response, never a rejection', async () => {
    const fake = {
      facade: {
        emit: () => {
          throw new Error('no such session');
        },
      },
    } as unknown as Harness;

    const res = await handleCommand(fake, {
      id: 'r2',
      cmd: 'emit-sdk-message',
      sessionId: 'missing',
      message: {} as never,
    });

    expect(res).toEqual({ id: 'r2', ok: false, error: 'no such session' });
  });

  it('get-bridge-transcript returns the rows the harness reports', async () => {
    const fake = {
      transcript: async (sessionId: string) =>
        sessionId === 's1' ? [{ seq: 1, entry: { type: 'system' } }] : [],
    } as unknown as Harness;

    expect(await handleCommand(fake, { id: 'r3', cmd: 'get-bridge-transcript', sessionId: 's1' })).toEqual({
      id: 'r3',
      ok: true,
      result: [{ seq: 1, entry: { type: 'system' } }],
    });
    expect(
      await handleCommand(fake, { id: 'r4', cmd: 'get-bridge-transcript', sessionId: 'unknown' }),
    ).toEqual({ id: 'r4', ok: true, result: [] });
  });

  it('drain-logs, restart-bridge, and shutdown delegate and answer null/logs', async () => {
    let restarted = false;
    let shutdown = false;
    const fake = {
      drainLogs: () => [{ level: 'info', message: 'hi' }],
      restart: async () => {
        restarted = true;
      },
      shutdown: async () => {
        shutdown = true;
      },
    } as unknown as Harness;

    expect(await handleCommand(fake, { id: 'a', cmd: 'drain-logs' })).toEqual({
      id: 'a',
      ok: true,
      result: [{ level: 'info', message: 'hi' }],
    });
    expect(await handleCommand(fake, { id: 'b', cmd: 'restart-bridge' })).toEqual({
      id: 'b',
      ok: true,
      result: null,
    });
    expect(restarted).toBe(true);
    expect(await handleCommand(fake, { id: 'c', cmd: 'shutdown' })).toEqual({
      id: 'c',
      ok: true,
      result: null,
    });
    expect(shutdown).toBe(true);
  });
});

describe('handleCommand — against a real Harness', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.shutdown();
  });

  async function realHarness(): Promise<Harness> {
    const h = await createHarness();
    harnesses.push(h);
    return h;
  }

  it('get-relay-url matches the harness relay server', async () => {
    const h = await realHarness();
    const res = await handleCommand(h, { id: '1', cmd: 'get-relay-url' });
    expect(res).toEqual({ id: '1', ok: true, result: { url: h.relayServer.url } });
  });

  it('open-pairing-window returns a codedeck:// URL with the harness token', async () => {
    const h = await realHarness();
    const res = await handleCommand(h, { id: '2', cmd: 'open-pairing-window' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    const result = res.result as { url: string; token: string; expiresAt: string };
    expect(result.url.startsWith('codedeck://pair')).toBe(true);
    expect(result.url).toContain(result.token);
    expect(() => new Date(result.expiresAt).toISOString()).not.toThrow();
  });

  it('restart-bridge swaps the underlying BridgeCore without touching the relay', async () => {
    const h = await realHarness();
    const before = h.core;
    const res = await handleCommand(h, { id: '3', cmd: 'restart-bridge' });
    expect(res).toEqual({ id: '3', ok: true, result: null });
    expect(h.core).not.toBe(before);
  });

  it('an unknown session transcript is empty, not an error', async () => {
    const h = await realHarness();
    const res = await handleCommand(h, { id: '4', cmd: 'get-bridge-transcript', sessionId: 'nope' });
    expect(res).toEqual({ id: '4', ok: true, result: [] });
  });
});

// Type-only smoke check that the exported facade type still matches what
// `emit-sdk-message` expects — a signature drift here should fail typecheck,
// not surface as a runtime "no such method".
function _typeCheck(facade: FakeSdkFacade): void {
  facade.emit('s', { type: 'system' } as never);
}
void _typeCheck;
