/**
 * nativeBridgeApi — proves `createNativeBridgeApi` presents the SAME
 * `BridgeApiLike` shape `BridgeApi` does for every method that has a real
 * `Intent` mapping, that `send` pattern-matches the three real message types
 * card actions use, and that the three documented gaps (`createFolder`,
 * `uploadImageBlossom`, `uploadImageChunk`) fail honestly rather than
 * pretending to succeed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createNativeBridgeApi } from '../services/nativeBridgeApi';
import type { CoreEvent, Intent } from '../nativeCoreTypes';
import type { NativeCore } from '../../platform/nativeCore';

function fakeCore(shouldFail = false) {
  const dispatched: Intent[] = [];
  const core: NativeCore = {
    init: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    pause: () => Promise.reject(new Error('unused')),
    resume: () => Promise.reject(new Error('unused')),
    setOnline: () => Promise.reject(new Error('unused')),
    setMachines: () => Promise.reject(new Error('unused')),
    setRelays: () => Promise.reject(new Error('unused')),
    send: () => Promise.reject(new Error('unused')),
    publish: () => Promise.reject(new Error('unused')),
    connectionStatus: () => Promise.reject(new Error('unused')),
    onMessage: () => Promise.reject(new Error('unused')),
    onConnection: () => Promise.reject(new Error('unused')),
    onActionFailed: () => Promise.reject(new Error('unused')),
    onResume: () => Promise.resolve(() => {}),
    dispatch: vi.fn(async (intent: Intent) => {
      if (shouldFail) throw new Error('boom');
      dispatched.push(intent);
    }),
    machinesView: () => Promise.reject(new Error('unused')),
    settingsView: () => Promise.reject(new Error('unused')),
    outboxView: () => Promise.reject(new Error('unused')),
    pairingView: () => Promise.reject(new Error('unused')),
    dmView: () => Promise.reject(new Error('unused')),
    marmotView: () => Promise.reject(new Error('unused')),
    quickPromptsView: () => Promise.reject(new Error('unused')),
    pendingSessionsView: () => Promise.reject(new Error('unused')),
    uiView: () => Promise.reject(new Error('unused')),
    transcriptView: () => Promise.reject(new Error('unused')),
    onCoreEvent: () => Promise.resolve(() => {}),
  };
  return { core, dispatched };
}

describe('createNativeBridgeApi', () => {
  it.each([
    ['createSession', ['m', {}], { createSession: { machine: 'm', cwd: null, createCwd: null, model: null, defaultEffort: null, providerId: null, testSession: null } }],
    ['refreshSessions', ['m'], { refreshSessions: { machine: 'm' } }],
    ['closeSession', ['m', 's1'], { closeSession: { machine: 'm', sessionId: 's1' } }],
    ['interrupt', ['m', 's1'], { interrupt: { machine: 'm', sessionId: 's1' } }],
    ['permissionResponse', ['m', 's1', 'req1', true], { respondPermission: { machine: 'm', sessionId: 's1', requestId: 'req1', allow: true, modifier: null } }],
    ['keypress', ['m', 's1', '1'], { keypress: { machine: 'm', sessionId: 's1', key: '1', context: null } }],
    ['questionInput', ['m', 's1', 'answer', 2], { answerQuestion: { machine: 'm', sessionId: 's1', text: 'answer', optionCount: 2 } }],
    ['modeChange', ['m', 's1', 'plan'], { setMode: { machine: 'm', sessionId: 's1', mode: 'plan' } }],
    ['effortChange', ['m', 's1', 'high'], { setEffort: { machine: 'm', sessionId: 's1', level: 'high' } }],
    ['modelChange', ['m', 's1', 'opus'], { setModel: { machine: 'm', sessionId: 's1', model: 'opus' } }],
    ['usageRequest', ['m', 's1'], { requestUsage: { machine: 'm', sessionId: 's1' } }],
    ['gsdRequest', ['m', 's1'], { requestGsd: { machine: 'm', sessionId: 's1' } }],
    ['modelsRequest', ['m'], { requestModels: { machine: 'm' } }],
    ['requestProviderProfiles', ['m'], { requestProviderProfiles: { machine: 'm' } }],
  ] as const)('%s dispatches %j', async (method, args, expected) => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });
    const result = await (api[method] as (...a: unknown[]) => Promise<boolean>)(...args);
    expect(result).toBe(true);
    expect(dispatched).toEqual([expected]);
  });

  it('setCredentials omits undefined fields but forwards null (clear) and strings (set)', async () => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });

    await api.setCredentials('m', { anthropicApiKey: 'sk-ant', githubPat: null });
    expect(dispatched).toEqual([{ setCredentials: { machine: 'm', anthropicApiKey: 'sk-ant', githubPat: null } }]);

    dispatched.length = 0;
    await api.setCredentials('m', {});
    expect(dispatched).toEqual([{ setCredentials: { machine: 'm' } }]);
  });

  it('setProviderProfile forwards the write or null (delete)', async () => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });

    const profile = { label: 'Anthropic', baseUrl: 'https://api.example', models: [{ id: 'opus' }] };
    await api.setProviderProfile('m', 'p1', profile);
    expect(dispatched).toEqual([{ setProviderProfile: { machine: 'm', profileId: 'p1', profile } }]);

    dispatched.length = 0;
    await api.setProviderProfile('m', 'p1', null);
    expect(dispatched).toEqual([{ setProviderProfile: { machine: 'm', profileId: 'p1', profile: null } }]);
  });

  it('setDeviceConfig forwards the config verbatim', async () => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });
    const config = { label: 'phone-1', appUnderTest: 'veil' as const };

    await api.setDeviceConfig('m', config);
    expect(dispatched).toEqual([{ setDeviceConfig: { machine: 'm', config } }]);
  });

  it('send maps permission-res/keypress/question-input to their Intents', async () => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });

    await api.send('m', { type: 'permission-res', sessionId: 's1', requestId: 'r1', allow: true });
    await api.send('m', { type: 'keypress', sessionId: 's1', key: '2', context: 'plan-approval' });
    await api.send('m', { type: 'question-input', sessionId: 's1', text: 'hi', optionCount: 0 });

    expect(dispatched).toEqual([
      { respondPermission: { machine: 'm', sessionId: 's1', requestId: 'r1', allow: true, modifier: null } },
      { keypress: { machine: 'm', sessionId: 's1', key: '2', context: 'plan-approval' } },
      { answerQuestion: { machine: 'm', sessionId: 's1', text: 'hi', optionCount: 0 } },
    ]);
  });

  it('send returns false and does not throw for an unmapped message type', async () => {
    const { core, dispatched } = fakeCore();
    const api = createNativeBridgeApi({ core });

    const result = await api.send('m', { type: 'refresh-sessions' });
    expect(result).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('a dispatch failure resolves false rather than rejecting', async () => {
    const { core } = fakeCore(true);
    const api = createNativeBridgeApi({ core });

    expect(await api.interrupt('m', 's1')).toBe(false);
  });

  it('createFolder resolves a failed ack rather than hanging or throwing', async () => {
    const { core } = fakeCore();
    const api = createNativeBridgeApi({ core });

    const ack = await api.createFolder('m', 'some/path');
    expect(ack.success).toBe(false);
  });

  it('diagnostics stays zeroed — Rust owns inbound decode/routing entirely', async () => {
    const { core } = fakeCore();
    const api = createNativeBridgeApi({ core });

    expect(api.diagnostics).toEqual({ decryptFailures: 0, decodeFailures: 0, invalid: [] });
  });

  it('uploadImageBlossom and uploadImageChunk both reject with an explanatory error', async () => {
    const { core } = fakeCore();
    const api = createNativeBridgeApi({ core });

    await expect(
      api.uploadImageBlossom('m', {
        sessionId: 's1',
        hash: 'h',
        url: 'https://blossom.example/h',
        key: 'k',
        iv: 'i',
        filename: 'f',
        mimeType: 'image/png',
        text: '',
        sizeBytes: 0,
      }),
    ).rejects.toThrow(/sendSessionImage/);
    await expect(
      api.uploadImageChunk('m', {
        sessionId: 's1',
        uploadId: 'u1',
        filename: 'f',
        mimeType: 'image/png',
        base64Data: 'AA==',
        text: '',
        chunkIndex: 0,
        totalChunks: 1,
      }),
    ).rejects.toThrow(/sendSessionImage/);
  });
});
