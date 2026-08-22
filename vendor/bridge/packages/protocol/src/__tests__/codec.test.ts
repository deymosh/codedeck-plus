import { describe, expect, it } from 'vitest';
import {
  decodeBridgeToPhone,
  decodePhoneToBridge,
  encodeBridgeToPhone,
  encodePhoneToBridge,
} from '../codec';
import {
  ALL_BRIDGE_CAPABILITIES,
  ALL_PHONE_CAPABILITIES,
  CAPABILITIES,
  PROTOCOL_VERSION,
} from '../capabilities';
import { isValidProviderBaseUrl, PROVIDER_BASE_URL_ERROR } from '../schemas/common';
import type { PhoneToBridgeMessage } from '../schemas/commands';
import type { BridgeToPhoneMessage, SessionListMessage } from '../schemas/events';

const session = {
  id: 'a1b2c3',
  slug: 'fix-scroll',
  cwd: '/home/user/projects/app',
  lastActivity: '2026-08-05T10:00:00Z',
  lineCount: 42,
  title: 'Fix scroll',
  project: 'app',
  state: 'running' as const,
  seqHigh: 917,
};

describe('phone → bridge codec', () => {
  const commands: PhoneToBridgeMessage[] = [
    { type: 'input', sessionId: 's1', text: 'hello', inputId: 'i-1', v: PROTOCOL_VERSION },
    { type: 'question-input', sessionId: 's1', text: 'option B please', optionCount: 3 },
    { type: 'permission-res', sessionId: 's1', requestId: 'r1', allow: true, modifier: 'always' },
    { type: 'keypress', sessionId: 's1', key: '2', context: 'plan-approval' },
    { type: 'mode', sessionId: 's1', mode: 'acceptEdits' },
    { type: 'effort', sessionId: 's1', level: 'xhigh' },
    { type: 'model', sessionId: 's1', model: 'claude-opus-5' },
    { type: 'sync-request', sessionId: 's1', haveRanges: [[1, 100], [150, 200]] },
    { type: 'sync-ack', syncId: 'sy1', range: [101, 149] },
    { type: 'create-session', cwd: 'my-project', createCwd: true, model: 'claude-opus-5', defaultEffort: 'high' },
    { type: 'refresh-sessions' },
    { type: 'close-session', sessionId: 's1' },
    { type: 'interrupt', sessionId: 's1' },
    { type: 'create-folder', path: 'new-app', requestId: 'f1' },
    { type: 'usage-request', sessionId: 's1' },
    { type: 'gsd-request', sessionId: 's1' },
    { type: 'models-request' },
    { type: 'set-credentials', anthropicApiKey: null, githubPat: 'ghp_x' },
    { type: 'pair-request', npub: 'npub1xyz', pubkeyHex: 'ab'.repeat(32), label: 'Phone', token: 'tok' },
  ];

  it.each(commands.map((m) => [m.type, m] as const))('round-trips %s', (_t, msg) => {
    const decoded = decodePhoneToBridge(encodePhoneToBridge(msg));
    expect(decoded).toEqual({ ok: true, msg });
  });

  it('rejects invalid JSON without throwing', () => {
    const res = decodePhoneToBridge('{nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid JSON/);
  });

  it('rejects unknown message types with the type named in the error', () => {
    const res = decodePhoneToBridge(JSON.stringify({ type: 'launch-missiles' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('launch-missiles');
  });

  it('rejects a structurally-wrong known type (input without sessionId)', () => {
    const res = decodePhoneToBridge(JSON.stringify({ type: 'input', text: 'hi' }));
    expect(res.ok).toBe(false);
  });

  it('encode validates outbound — a malformed message fails at the sender', () => {
    expect(() =>
      encodePhoneToBridge({ type: 'mode', sessionId: 's1', mode: 'yolo' } as never),
    ).toThrow();
  });
});

describe('bridge → phone codec', () => {
  const sessionsMsg: SessionListMessage = {
    type: 'sessions',
    machine: 'vps-1',
    host: 'cli',
    sessions: [session],
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['sync/1', 'folders'],
    folders: ['app', 'tools/cli'],
    removedSessions: ['dead-1'],
  };

  const events: BridgeToPhoneMessage[] = [
    sessionsMsg,
    {
      type: 'output',
      sessionId: 's1',
      seq: 918,
      entry: { entryType: 'text', content: 'Done.', timestamp: '2026-08-05T10:00:01Z' },
    },
    { type: 'input-ack', sessionId: 's1', inputId: 'i-1' },
    { type: 'sync-begin', sessionId: 's1', syncId: 'sy1', seqHigh: 917, ranges: [[101, 149]] },
    {
      type: 'sync-chunk',
      sessionId: 's1',
      syncId: 'sy1',
      range: [101, 101],
      entries: [{ seq: 101, entry: { entryType: 'tool_use', content: 'Read(x)', timestamp: 't' } }],
    },
    { type: 'sync-end', sessionId: 's1', syncId: 'sy1', deliveredRanges: [[101, 149]] },
    { type: 'session-pending', pendingId: 'p1', machine: 'vps-1', createdAt: 't' },
    { type: 'session-ready', pendingId: 'p1', session },
    { type: 'session-failed', pendingId: 'p1', reason: 'timeout' },
    { type: 'input-failed', sessionId: 's1', reason: 'no-session', inputId: 'i-1' },
    { type: 'close-session-ack', sessionId: 's1', success: true },
    { type: 'mode-confirmed', sessionId: 's1', mode: 'plan' },
    { type: 'effort-confirmed', sessionId: 's1', level: 'max' },
    { type: 'model-confirmed', sessionId: 's1', model: 'claude-opus-5' },
    { type: 'folder-ack', requestId: 'f1', success: true, path: 'new-app' },
    { type: 'models', models: [{ id: 'claude-opus-5', label: 'Opus 5' }], defaultModel: 'claude-opus-5' },
    { type: 'pair-ack', machine: 'vps-1', ok: false, reason: 'bad-token' },
  ];

  // CDX-035: the empty-list-plus-reason answer, and the wire compatibility that
  // makes `error` safe to add — an older bridge omits it, an older phone
  // ignores it, so both directions still decode.
  it('models round-trips an empty list carrying an error reason (CDX-035)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'models',
      models: [],
      error: 'No live Claude session answered — start or open a session and try again.',
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(msg))).toEqual({ ok: true, msg });
  });

  it('models without `error` still decodes (older bridges stay wire-compatible)', () => {
    const res = decodeBridgeToPhone(JSON.stringify({ type: 'models', models: [{ id: 'm1' }] }));
    expect(res.ok).toBe(true);
  });

  it.each(events.map((m) => [m.type, m] as const))('round-trips %s', (_t, msg) => {
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
    expect(decoded).toEqual({ ok: true, msg });
  });

  it('session list REQUIRES protocolVersion in v10 (no more silent pre-v1 fallback)', () => {
    const { protocolVersion: _pv, ...withoutVersion } = sessionsMsg;
    const res = decodeBridgeToPhone(JSON.stringify(withoutVersion));
    expect(res.ok).toBe(false);
  });

  it('phone codec refuses bridge-only messages and vice versa', () => {
    expect(decodePhoneToBridge(JSON.stringify({ type: 'input-ack', sessionId: 's', inputId: 'i' })).ok).toBe(false);
    expect(decodeBridgeToPhone(JSON.stringify({ type: 'input', sessionId: 's', text: 'x' })).ok).toBe(false);
  });
});

describe('CDX protocol nits — pair-ack extras, input-failed reasons, thinking entries', () => {
  it('pair-ack round-trips optional relays + host (and stays valid without them)', () => {
    const withExtras: BridgeToPhoneMessage = {
      type: 'pair-ack',
      machine: 'laptop',
      ok: true,
      relays: ['wss://relay2.descendant.io', 'wss://relay.primal.net'],
      host: 'cli',
    };
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(withExtras));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.msg).toEqual(withExtras);

    const bare: BridgeToPhoneMessage = { type: 'pair-ack', machine: 'laptop', ok: false, reason: 'bad-token' };
    const decodedBare = decodeBridgeToPhone(encodeBridgeToPhone(bare));
    expect(decodedBare.ok).toBe(true);
    if (decodedBare.ok) expect(decodedBare.msg).toEqual(bare);
  });

  it('input-failed accepts the extended reason set', () => {
    for (const reason of ['no-session', 'expired', 'busy', 'error'] as const) {
      const msg: BridgeToPhoneMessage = { type: 'input-failed', sessionId: 's1', reason };
      const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
      expect(decoded.ok).toBe(true);
    }
    expect(decodeBridgeToPhone(JSON.stringify({
      type: 'input-failed', sessionId: 's1', reason: 'gremlins',
    })).ok).toBe(false);
  });

  it('output entries accept entryType "diff" with the structured payload (CDX-050)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 8,
      entry: {
        entryType: 'diff',
        content: '-const a = 1;\n+const a = 2;',
        timestamp: '2026-08-08T10:00:00Z',
        metadata: { role: 'assistant', tool_name: 'Edit', tool_use_id: 'toolu_9' },
        diff: {
          path: 'src/app.ts',
          lines: [
            { type: 'del', text: 'const a = 1;' },
            { type: 'add', text: 'const a = 2;' },
          ],
        },
      },
    };
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
    expect(decoded).toEqual({ ok: true, msg });

    // truncated flag round-trips
    const truncated: BridgeToPhoneMessage = {
      ...msg,
      entry: {
        ...msg.entry,
        diff: { path: 'src/app.ts', lines: [{ type: 'add', text: 'x' }], truncated: true },
      },
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(truncated))).toEqual({ ok: true, msg: truncated });

    // a bad line type is rejected
    expect(decodeBridgeToPhone(JSON.stringify({
      ...msg,
      entry: {
        ...msg.entry,
        diff: { path: 'src/app.ts', lines: [{ type: 'changed', text: 'x' }] },
      },
    })).ok).toBe(false);

    // an empty path is rejected
    expect(decodeBridgeToPhone(JSON.stringify({
      ...msg,
      entry: { ...msg.entry, diff: { path: '', lines: [] } },
    })).ok).toBe(false);
  });

  it('the diff capability string is advertised by bridge and phone (CDX-050)', () => {
    expect(CAPABILITIES.diff).toBe('diff');
    expect(ALL_BRIDGE_CAPABILITIES).toContain('diff');
    expect(ALL_PHONE_CAPABILITIES).toContain('diff');
  });

  it('output entries accept entryType "thinking" (with redacted metadata)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 7,
      entry: {
        entryType: 'thinking',
        content: 'pondering…',
        timestamp: '2026-08-05T10:00:00Z',
        metadata: { role: 'assistant', redacted: false },
      },
    };
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
    expect(decoded.ok).toBe(true);
    expect(decodeBridgeToPhone(JSON.stringify({
      ...msg,
      entry: { ...msg.entry, entryType: 'daydreaming' },
    })).ok).toBe(false);
  });
});

describe('CDX-062 — custom provider profiles', () => {
  const profileBody = {
    label: 'Kimi K3',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
    defaultModel: 'kimi-k3',
  };

  it('set-provider-profile round-trips an upsert carrying a token', () => {
    const msg: PhoneToBridgeMessage = {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { ...profileBody, authToken: 'sk-moonshot-xyz' },
      v: PROTOCOL_VERSION,
    };
    expect(decodePhoneToBridge(encodePhoneToBridge(msg))).toEqual({ ok: true, msg });
  });

  it('set-provider-profile round-trips authToken tri-state (null = delete token, absent = keep)', () => {
    const withNull: PhoneToBridgeMessage = {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { ...profileBody, authToken: null },
    };
    expect(decodePhoneToBridge(encodePhoneToBridge(withNull))).toEqual({ ok: true, msg: withNull });

    const withoutToken: PhoneToBridgeMessage = {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: profileBody,
    };
    expect(decodePhoneToBridge(encodePhoneToBridge(withoutToken))).toEqual({ ok: true, msg: withoutToken });
  });

  it('set-provider-profile round-trips profile: null (delete the whole profile)', () => {
    const msg: PhoneToBridgeMessage = {
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: null,
    };
    expect(decodePhoneToBridge(encodePhoneToBridge(msg))).toEqual({ ok: true, msg });
  });

  it('provider-profiles-request round-trips', () => {
    const msg: PhoneToBridgeMessage = { type: 'provider-profiles-request', v: PROTOCOL_VERSION };
    expect(decodePhoneToBridge(encodePhoneToBridge(msg))).toEqual({ ok: true, msg });
  });

  it('provider-profiles round-trips the redacted list (hasToken, never the token)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'provider-profiles',
      machine: 'vps-1',
      profiles: [
        {
          id: 'kimi',
          label: 'Kimi K3',
          baseUrl: 'https://api.moonshot.ai/anthropic',
          models: [{ id: 'kimi-k3', label: 'Kimi K3' }],
          defaultModel: 'kimi-k3',
          hasToken: true,
        },
      ],
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(msg))).toEqual({ ok: true, msg });

    // an empty list round-trips too — "no profiles stored" is a valid answer
    const empty: BridgeToPhoneMessage = { type: 'provider-profiles', machine: 'vps-1', profiles: [] };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(empty))).toEqual({ ok: true, msg: empty });
  });

  it('provider-profile-ack round-trips (with tokenValid and bare)', () => {
    const withVerdict: BridgeToPhoneMessage = {
      type: 'provider-profile-ack',
      machine: 'vps-1',
      profileId: 'kimi',
      success: true,
      tokenValid: false,
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(withVerdict))).toEqual({ ok: true, msg: withVerdict });

    // absent tokenValid = the probe could not run (tri-state, like keyValid)
    const bare: BridgeToPhoneMessage = {
      type: 'provider-profile-ack',
      machine: 'vps-1',
      profileId: 'kimi',
      success: false,
      error: 'storage write failed',
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(bare))).toEqual({ ok: true, msg: bare });
  });

  it('create-session with providerId parses and providerId survives', () => {
    const msg: PhoneToBridgeMessage = {
      type: 'create-session',
      cwd: 'my-project',
      model: 'kimi-k3',
      providerId: 'kimi',
      v: PROTOCOL_VERSION,
    };
    const decoded = decodePhoneToBridge(encodePhoneToBridge(msg));
    expect(decoded).toEqual({ ok: true, msg });
    if (decoded.ok && decoded.msg.type === 'create-session') {
      expect(decoded.msg.providerId).toBe('kimi');
    }
  });

  it('rejects set-provider-profile with an empty models array', () => {
    expect(decodePhoneToBridge(JSON.stringify({
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { ...profileBody, models: [] },
    })).ok).toBe(false);
  });

  it('rejects set-provider-profile with a missing label', () => {
    const { label: _label, ...withoutLabel } = profileBody;
    expect(decodePhoneToBridge(JSON.stringify({
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: withoutLabel,
    })).ok).toBe(false);
  });

  it('rejects set-provider-profile with an empty profileId', () => {
    expect(decodePhoneToBridge(JSON.stringify({
      type: 'set-provider-profile',
      profileId: '',
      profile: profileBody,
    })).ok).toBe(false);
  });

  // --- CDX-071: the base URL carries a bearer token; it must be TLS ---

  it('rejects a plain http:// base URL — the token would ride the wire in cleartext', () => {
    for (const baseUrl of [
      'http://api.moonshot.ai/anthropic',
      'http://gateway.internal.corp/v1',
      'http://10.0.0.5:8080',
      // Not loopback: a bind address, and a DNS name that merely ends in it.
      'http://0.0.0.0:11434',
      'http://evil.localhost/anthropic',
      'http://localhost.attacker.example',
    ]) {
      expect(decodePhoneToBridge(JSON.stringify({
        type: 'set-provider-profile',
        profileId: 'kimi',
        profile: { ...profileBody, baseUrl },
      })).ok, baseUrl).toBe(false);
    }
  });

  it('rejects a base URL with no scheme, or a non-http(s) one', () => {
    for (const baseUrl of [
      'api.moonshot.ai/anthropic',
      '//api.moonshot.ai/anthropic',
      'ftp://api.moonshot.ai',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'HTTP://api.moonshot.ai',
    ]) {
      expect(decodePhoneToBridge(JSON.stringify({
        type: 'set-provider-profile',
        profileId: 'kimi',
        profile: { ...profileBody, baseUrl },
      })).ok, baseUrl).toBe(false);
    }
  });

  it('accepts https anywhere, and http ONLY on loopback (Ollama / LM Studio)', () => {
    for (const baseUrl of [
      'https://api.moonshot.ai/anthropic',
      'https://openrouter.ai/api',
      'HTTPS://api.moonshot.ai/anthropic', // scheme is case-insensitive
      'http://localhost:11434',
      'http://LocalHost:1234/v1',
      'http://127.0.0.1:11434',
      'http://[::1]:11434',
    ]) {
      const msg: PhoneToBridgeMessage = {
        type: 'set-provider-profile',
        profileId: 'local',
        profile: { ...profileBody, baseUrl },
      };
      expect(decodePhoneToBridge(encodePhoneToBridge(msg)), baseUrl).toEqual({ ok: true, msg });
    }
  });

  it('a cleartext base URL fails LOUDLY at the sender, naming the rule', () => {
    // encodePhoneToBridge validates on the way out, so the phone throws instead
    // of the bridge silently dropping the command and never acking.
    expect(() => encodePhoneToBridge({
      type: 'set-provider-profile',
      profileId: 'kimi',
      profile: { ...profileBody, baseUrl: 'http://api.moonshot.ai/anthropic' },
    })).toThrow(new RegExp(PROVIDER_BASE_URL_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('isValidProviderBaseUrl is the one shared rule the phone can reuse', () => {
    expect(isValidProviderBaseUrl('https://api.moonshot.ai/anthropic')).toBe(true);
    expect(isValidProviderBaseUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isValidProviderBaseUrl('http://api.moonshot.ai/anthropic')).toBe(false);
    expect(isValidProviderBaseUrl('')).toBe(false);
    expect(isValidProviderBaseUrl('   ')).toBe(false);
  });

  it('the redacted bridge→phone echo still lists an http profile stored before the gate', () => {
    // Deliberate asymmetry: tightening the READ echo too would make the bridge
    // unable to publish its own stored list, hiding the profile that needs
    // fixing. The operator must be able to see it to delete or correct it.
    const msg: BridgeToPhoneMessage = {
      type: 'provider-profiles',
      machine: 'vps-1',
      profiles: [{
        id: 'legacy',
        label: 'Legacy gateway',
        baseUrl: 'http://gateway.internal.corp/v1',
        models: [{ id: 'kimi-k3' }],
        hasToken: true,
      }],
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(msg))).toEqual({ ok: true, msg });
  });

  it('the custom-providers capability is bridge-only (CDX-062)', () => {
    expect(CAPABILITIES.customProviders).toBe('custom-providers');
    expect(ALL_BRIDGE_CAPABILITIES).toContain('custom-providers');
    expect(ALL_PHONE_CAPABILITIES).not.toContain('custom-providers');
  });

  // Old-peer safety, same mechanism the wrong-direction test above exercises:
  // a zod union WITHOUT the 'provider-profiles' member (i.e. a pre-CDX-062
  // phone's bridgeToPhoneSchema) rejects it as a structured ok:false — one
  // dropped message, never a throw.
  it("a union without the type rejects 'provider-profiles' cleanly (old-phone behaviour)", () => {
    const wire = encodeBridgeToPhone({ type: 'provider-profiles', machine: 'vps-1', profiles: [] });
    const res = decodePhoneToBridge(wire); // phoneToBridge union has no 'provider-profiles'
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('provider-profiles');
  });
});
