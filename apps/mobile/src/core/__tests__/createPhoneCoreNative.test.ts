/**
 * createPhoneCore — F1 native-core wiring. With `deps.nativeCore` present the
 * bridge protocol rides the in-process Rust runtime: init on boot, lifecycle
 * through the connection FSM's socket effects, outbound through BridgeApi's
 * native hooks, authors changes forwarded, and a pre-decoded inbound message
 * routed to the same handlers via `api.dispatchDecoded`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type BridgeToPhoneMessage,
  type RemoteSessionInfo,
  type SessionListMessage,
} from '@codedeck/protocol';
import { createPhoneCore, type PhoneCore } from '../createPhoneCore';
import { memoryKV, type PhoneTransport } from '../ports';
import type { NativeCoreControl } from '../nativeCore';

const nullTransport: PhoneTransport = {
  subscribe: () => ({ close: () => {} }),
  publish: async () => true,
};

function fakeNative() {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const rec =
    <R>(m: string, ret: R) =>
    (...args: unknown[]): Promise<R> => {
      calls.push({ m, args });
      return Promise.resolve(ret);
    };
  const native: NativeCoreControl = {
    init: rec('init', undefined),
    start: rec('start', undefined),
    stop: rec('stop', undefined),
    setMachines: rec('setMachines', undefined),
    setRelays: rec('setRelays', undefined),
    send: rec('send', true),
    publish: rec('publish', { verdict: 'accepted' as const }),
  };
  return { native, calls, names: () => calls.map((c) => c.m) };
}

const info = (id: string): RemoteSessionInfo => ({
  id,
  slug: `slug-${id}`,
  cwd: `/work/${id}`,
  lastActivity: '2026-08-08T10:00:00.000Z',
  lineCount: 0,
  title: null,
  project: `proj-${id}`,
});

const list = (sessions: RemoteSessionInfo[]): SessionListMessage => ({
  type: 'sessions',
  machine: 'laptop',
  sessions,
  protocolVersion: PROTOCOL_VERSION,
});

async function core(): Promise<{ phone: PhoneCore; f: ReturnType<typeof fakeNative> }> {
  const f = fakeNative();
  const phone = await createPhoneCore({
    kv: memoryKV(),
    transport: nullTransport,
    nativeCore: f.native,
    nativeCoreProxy: '127.0.0.1:9050',
  });
  return { phone, f };
}

describe('createPhoneCore — native core wiring', () => {
  it('init runs once on boot with relays + hex secret + proxy', async () => {
    const { phone, f } = await core();
    const initCall = f.calls.find((c) => c.m === 'init');
    expect(initCall).toBeTruthy();
    const cfg = initCall!.args[0] as {
      relays: string[];
      identitySecretHex: string;
      proxy: string | null;
      tor: boolean;
    };
    expect(cfg.relays.length).toBeGreaterThan(0);
    expect(cfg.identitySecretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.proxy).toBeNull(); // tor off by default
    expect(cfg.tor).toBe(false);
    await phone.stop();
  });

  it('start / stop flow through the FSM to native.start / native.stop, not the WebView client', async () => {
    const { phone, f } = await core();
    const clientConnect = vi.spyOn(phone.client, 'connect');
    phone.start();
    await Promise.resolve();
    expect(f.names()).toContain('start');
    expect(clientConnect).not.toHaveBeenCalled();
    await phone.stop();
    expect(f.names()).toContain('stop');
  });

  it('an outbound command goes through native.send, never the transport', async () => {
    const { phone, f } = await core();
    const publish = vi.spyOn(nullTransport, 'publish');
    await phone.api.input('machine-1', 's1', 'hi', 'in-1');
    const sendCall = f.calls.find((c) => c.m === 'send');
    expect(sendCall!.args[0]).toBe('machine-1');
    expect(sendCall!.args[1]).toEqual({ type: 'input', sessionId: 's1', text: 'hi', inputId: 'in-1' });
    expect(publish).not.toHaveBeenCalled();
    await phone.stop();
  });

  it('registering a machine forwards the new authors list to native.setMachines', async () => {
    const { phone, f } = await core();
    phone.pairing.getState();
    const before = f.calls.filter((c) => c.m === 'setMachines').length;
    phone.machines.getState().registerMachine({ pubkeyHex: 'a'.repeat(64), name: 'laptop' });
    await phone.removeMachine('a'.repeat(64));
    expect(f.calls.filter((c) => c.m === 'setMachines').length).toBeGreaterThan(before);
    await phone.stop();
  });

  it('a pre-decoded inbound message routes to the handlers via dispatchDecoded', async () => {
    const { phone } = await core();
    const machine = 'b'.repeat(64);
    phone.machines.getState().registerMachine({ pubkeyHex: machine, name: 'laptop' });

    const msg: BridgeToPhoneMessage = list([info('s1'), info('s2')]);
    phone.api.dispatchDecoded(msg, machine);

    const sessions = phone.machines.getState().machine(machine)?.sessions ?? {};
    expect(Object.keys(sessions).sort()).toEqual(['s1', 's2']);
    await phone.stop();
  });

  it('changing the relay list forwards to native.setRelays', async () => {
    const { phone, f } = await core();
    phone.settings.getState().addRelay('wss://new.example');
    const call = f.calls.find((c) => c.m === 'setRelays');
    expect(call!.args[0]).toContain('wss://new.example');
    await phone.stop();
  });
});
