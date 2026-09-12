/**
 * createPhoneCoreNative — proves the F2b composition root: `core.init` gets
 * the identity secret + seeded relays from TS's own persisted KV, every one
 * of the eleven native store adapters is present on the returned `PhoneCore`
 * (matching `usePhoneCore()`'s consumers' expectations), `start`/`stop`
 * route through the connection adapter, `deleteSession`/`undoDelete`/
 * `removeMachine` dispatch the matching `Intent`, and boot-time hydration
 * fetches every known session's transcript.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPhoneCoreNative } from '../createPhoneCoreNative';
import { generateKeypair, bytesToHex } from '../crypto';
import { memoryKV } from '../ports';
import type { CoreEvent, Intent, MachinesView, TranscriptRowsView } from '../nativeCoreTypes';
import type { NativeCore, NativeCoreConfig } from '../../platform/nativeCore';

function fakeCore(machinesView: MachinesView = { machines: {} }) {
  const dispatched: Intent[] = [];
  const initCalls: NativeCoreConfig[] = [];
  const connectionCalls: string[] = [];
  const transcriptViewCalls: Array<[string, string]> = [];

  const core: NativeCore = {
    defaults: () =>
      Promise.resolve({
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
        permissionModes: ['default', 'acceptEdits', 'plan'],
        defaultRelays: ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'],
        marmotRelays: ['wss://relay.us.whitenoise.chat', 'wss://relay.eu.whitenoise.chat'],
        customProvidersCapability: 'custom-providers',
        providerBaseUrlError:
          'Base URL must be https:// (http:// is allowed only for localhost, 127.0.0.1 or [::1])',
      }),
    init: (config) => {
      initCalls.push(config);
      return Promise.resolve();
    },
    start: () => {
      connectionCalls.push('start');
      return Promise.resolve();
    },
    stop: () => {
      connectionCalls.push('stop');
      return Promise.resolve();
    },
    pause: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setOnline: () => Promise.resolve(),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.resolve({ status: 'idle', needsPairingCheck: false, connectedRelays: [] }),
    onConnection: () => Promise.resolve(() => {}),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),
    dispatch: vi.fn((intent: Intent) => {
      dispatched.push(intent);
      return Promise.resolve();
    }),
    machinesView: () => Promise.resolve(machinesView),
    settingsView: () => Promise.resolve(null),
    outboxView: () => Promise.resolve({ items: [] }),
    pairingView: () => Promise.resolve(null),
    dmView: () => Promise.resolve(null),
    marmotView: () => Promise.resolve(null),
    quickPromptsView: () => Promise.resolve({ prompts: [] }),
    pendingSessionsView: () => Promise.resolve({ pending: {} }),
    uiView: () =>
      Promise.resolve({
        selectedMachine: null,
        selectedSession: null,
        panelMode: 'session',
        activeDmPeer: null,
        activeMarmotGroup: null,
        unreadSessions: [],
        respondedCards: {},
        planApprovalChoices: {},
        credentialsStatus: {},
        deviceConfigStatus: {},
        providerProfileStatus: {},
        undoToast: null,
      }),
    transcriptView: (machine, sessionId): Promise<TranscriptRowsView> => {
      transcriptViewCalls.push([machine, sessionId]);
      return Promise.resolve({
        rows: [],
        haveRanges: [],
        sync: { state: 'idle', attempts: 0, nextRetryAt: null, localHigh: 0, target: 0, contiguous: true },
      });
    },
    onCoreEvent: () => Promise.resolve(() => {}),
  };

  return { core, dispatched, initCalls, connectionCalls, transcriptViewCalls };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createPhoneCoreNative', () => {
  it('calls core.init with the persisted identity secret and seeded relays', async () => {
    const { core, initCalls } = fakeCore();
    const kv = memoryKV();
    await kv.set('settings', JSON.stringify({ relays: ['wss://one.example'], torProxyEnabled: false }));

    const phone = await createPhoneCoreNative({ core, kv });
    await tick();

    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]!.relays).toEqual(['wss://one.example']);
    expect(initCalls[0]!.tor).toBe(false);
    expect(initCalls[0]!.proxy).toBeNull();
    expect(initCalls[0]!.identitySecretHex).toBe(bytesToHex(phone.identity.getState().keypair.secretKey));
  });

  it('passes the Tor proxy through only when torProxyEnabled', async () => {
    const { core, initCalls } = fakeCore();
    const kv = memoryKV();
    await kv.set('settings', JSON.stringify({ relays: [], torProxyEnabled: true }));

    await createPhoneCoreNative({ core, kv, nativeCoreProxy: '127.0.0.1:9050' });

    expect(initCalls[0]!.tor).toBe(true);
    expect(initCalls[0]!.proxy).toBe('127.0.0.1:9050');
  });

  it('reuses a persisted identity across two boots rather than generating a new one', async () => {
    const { core: core1 } = fakeCore();
    const kv = memoryKV();
    const phone1 = await createPhoneCoreNative({ core: core1, kv });

    const { core: core2 } = fakeCore();
    const phone2 = await createPhoneCoreNative({ core: core2, kv });

    expect(phone2.identity.getState().pubkeyHex).toBe(phone1.identity.getState().pubkeyHex);
  });

  it('every native store is present on the returned PhoneCore', async () => {
    const { core } = fakeCore();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV() });

    for (const key of [
      'identity', 'connection', 'machines', 'transcript', 'outbox', 'pendingSessions',
      'pairing', 'dm', 'marmot', 'settings', 'quickPrompts', 'ui', 'api',
    ] as const) {
      expect(phone[key]).toBeDefined();
    }
  });

  it('start/stop route through the connection adapter to core.start/core.stop', async () => {
    const { core, connectionCalls } = fakeCore();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV() });

    phone.start();
    await tick();
    expect(connectionCalls).toEqual(['start']);

    await phone.stop();
    expect(connectionCalls).toEqual(['start', 'stop']);
  });

  it('deleteSession and undoDelete dispatch the matching Intent', async () => {
    const { core, dispatched } = fakeCore();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV() });

    phone.deleteSession('m1', 's1', 'Session label');
    await tick();
    expect(dispatched).toContainEqual({
      deleteSession: { machine: 'm1', sessionId: 's1', label: 'Session label' },
    });

    phone.undoDelete();
    await tick();
    expect(dispatched).toContain('undoDelete');
  });

  it('hydrates the transcript for every session known at boot', async () => {
    const { core, transcriptViewCalls } = fakeCore({
      machines: {
        m1: {
          pubkeyHex: 'm1',
          name: 'devbox',
          capabilities: [],
          folders: [],
          roots: [],
          protocolVersion: null,
          machineOffline: false,
          lastHeartbeatAt: null,
          sessions: {
            s1: { info: {} as never, presence: 'live', lastListedAt: 0 },
            s2: { info: {} as never, presence: 'live', lastListedAt: 0 },
          },
        },
      },
    });

    await createPhoneCoreNative({ core, kv: memoryKV() });
    await tick();

    expect(transcriptViewCalls).toEqual(
      expect.arrayContaining([['m1', 's1'], ['m1', 's2']]),
    );
  });

  it('removeMachine dispatches the matching Intent', async () => {
    const { core, dispatched } = fakeCore();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV() });

    await phone.removeMachine('m1');
    expect(dispatched).toEqual([{ removeMachine: { pubkeyHex: 'm1' } }]);
  });

  it('removeMachine logs rather than throwing when the dispatch fails', async () => {
    const { core } = fakeCore();
    core.dispatch = vi.fn(() => Promise.reject(new Error('boom')));
    const log = vi.fn();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV(), log });

    await expect(phone.removeMachine('m1')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('removeMachine dispatch failed'));
  });

  it('sendSessionImageNative dispatches Intent::SendSessionImage with the raw bytes', async () => {
    const { core, dispatched } = fakeCore();
    const phone = await createPhoneCoreNative({ core, kv: memoryKV() });

    await phone.sendSessionImageNative({
      machine: 'm1',
      sessionId: 's1',
      text: 'look at this',
      image: new Uint8Array([1, 2, 3]),
      filename: 'cat.png',
      mimeType: 'image/png',
    });

    expect(dispatched).toEqual([
      {
        sendSessionImage: {
          machine: 'm1',
          sessionId: 's1',
          text: 'look at this',
          image: [1, 2, 3],
          filename: 'cat.png',
          mimeType: 'image/png',
        },
      },
    ]);
  });
});
