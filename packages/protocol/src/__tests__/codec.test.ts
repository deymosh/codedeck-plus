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
  agent: 'claude-code',
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
    { type: 'question-response', sessionId: 's1', requestId: 'q1', index: 1, answer: { kind: 'text', text: 'option B please' } },
    { type: 'question-response', sessionId: 's1', requestId: 'q1', index: 0, answer: { kind: 'options', selected: [0, 2] } },
    { type: 'permission-response', sessionId: 's1', requestId: 'r1', optionId: 'allow_always' },
    { type: 'plan-response', sessionId: 's1', requestId: 'p1', optionId: 'acceptEdits' },
    { type: 'set-option', sessionId: 's1', option: 'mode', value: 'acceptEdits' },
    { type: 'set-option', sessionId: 's1', option: 'effort', value: 'xhigh' },
    { type: 'set-option', sessionId: 's1', option: 'model', value: 'claude-opus-5' },
    { type: 'sync-request', sessionId: 's1', haveRanges: [[1, 100], [150, 200]] },
    { type: 'sync-ack', syncId: 'sy1', range: [101, 149] },
    { type: 'create-session', agent: 'claude-code', cwd: 'my-project', createCwd: true, model: 'claude-opus-5', effort: 'high' },
    { type: 'refresh-sessions' },
    { type: 'close-session', sessionId: 's1' },
    { type: 'interrupt', sessionId: 's1' },
    { type: 'create-folder', path: 'new-app', requestId: 'f1' },
    { type: 'usage-request', sessionId: 's1' },
    { type: 'gsd-request', sessionId: 's1' },
    { type: 'models-request', agent: 'opencode' },
    { type: 'set-credentials', agent: 'claude-code', values: { anthropic_api_key: null } },
    { type: 'set-credentials', values: { github_pat: 'ghp_x' } },
    { type: 'pair-request', npub: 'npub1xyz', pubkeyHex: 'ab'.repeat(32), label: 'Phone', token: 'tok' },
  ];

  it.each(commands.map((m, i) => [`${m.type} #${i}`, m] as const))('round-trips %s', (_t, msg) => {
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
      encodePhoneToBridge({ type: 'set-option', sessionId: 's1', option: 'temperature', value: '1' } as never),
    ).toThrow();
  });

  it('v10 answer and option commands are gone', () => {
    for (const msg of [
      { type: 'permission-res', sessionId: 's', requestId: 'r', allow: true },
      { type: 'keypress', sessionId: 's', key: '1', context: 'plan-approval' },
      { type: 'question-input', sessionId: 's', text: 'x', optionCount: 2 },
      { type: 'mode', sessionId: 's', mode: 'plan' },
    ]) {
      expect(decodePhoneToBridge(JSON.stringify(msg)).ok, msg.type).toBe(false);
    }
  });
});

describe('bridge → phone codec', () => {
  const sessionsMsg: SessionListMessage = {
    type: 'sessions',
    machine: 'vps-1',
    host: 'cli',
    sessions: [session],
    agents: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        modes: [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }],
        efforts: [{ id: 'high', label: 'High' }],
        defaultMode: 'default',
        supports: { models: true, usage: true, providers: true, gsd: true, interrupt: true },
        credentials: [{ id: 'anthropic_api_key', label: 'Anthropic API key', present: true, fromEnv: true }],
      },
    ],
    credentials: [{ id: 'github_pat', label: 'GitHub token', present: false }],
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
      entry: { entryType: 'text', role: 'agent', text: 'Done.', timestamp: '2026-08-05T10:00:01Z' },
    },
    { type: 'input-ack', sessionId: 's1', inputId: 'i-1' },
    { type: 'sync-begin', sessionId: 's1', syncId: 'sy1', seqHigh: 917, ranges: [[101, 149]] },
    {
      type: 'sync-chunk',
      sessionId: 's1',
      syncId: 'sy1',
      range: [101, 101],
      entries: [
        {
          seq: 101,
          entry: { entryType: 'tool_call', callId: 'c1', toolName: 'Read', kind: 'read', title: 'x', timestamp: 't' },
        },
      ],
    },
    { type: 'sync-end', sessionId: 's1', syncId: 'sy1', deliveredRanges: [[101, 149]] },
    { type: 'session-pending', pendingId: 'p1', machine: 'vps-1', createdAt: 't' },
    { type: 'session-ready', pendingId: 'p1', session },
    { type: 'session-failed', pendingId: 'p1', reason: 'timeout' },
    { type: 'input-failed', sessionId: 's1', reason: 'no-session', inputId: 'i-1' },
    { type: 'close-session-ack', sessionId: 's1', success: true },
    { type: 'option-confirmed', sessionId: 's1', option: 'mode', value: 'plan' },
    { type: 'option-confirmed', sessionId: 's1', option: 'effort', value: 'max' },
    { type: 'folder-ack', requestId: 'f1', success: true, path: 'new-app' },
    {
      type: 'models',
      agent: 'claude-code',
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
      defaultModel: 'claude-opus-5',
    },
    {
      type: 'credentials-ack',
      machine: 'vps-1',
      agent: 'claude-code',
      success: true,
      credentials: [{ id: 'anthropic_api_key', label: 'Anthropic API key', present: true, valid: true }],
    },
    {
      type: 'usage',
      sessionId: 's1',
      usage: {
        available: true,
        plan: 'max',
        windows: [{ label: '5h', utilization: 42, resetsAt: 't' }],
        fetchedAt: 't',
      },
    },
    { type: 'pair-ack', machine: 'vps-1', ok: false, reason: 'bad-token' },
  ];

  // CDX-035: the empty-list-plus-reason answer, and the wire compatibility that
  // makes `error` safe to add — an older bridge omits it, an older phone
  // ignores it, so both directions still decode.
  it('models round-trips an empty list carrying an error reason (CDX-035)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'models',
      agent: 'claude-code',
      models: [],
      error: 'No live Claude session answered — start or open a session and try again.',
    };
    expect(decodeBridgeToPhone(encodeBridgeToPhone(msg))).toEqual({ ok: true, msg });
  });

  it('models must name the agent it answers for', () => {
    expect(decodeBridgeToPhone(JSON.stringify({ type: 'models', models: [{ id: 'm1' }] })).ok).toBe(false);
  });

  it.each(events.map((m, i) => [`${m.type} #${i}`, m] as const))('round-trips %s', (_t, msg) => {
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
    expect(decoded).toEqual({ ok: true, msg });
  });

  it('session list REQUIRES protocolVersion and the agent catalog', () => {
    const { protocolVersion: _pv, ...withoutVersion } = sessionsMsg;
    expect(decodeBridgeToPhone(JSON.stringify(withoutVersion)).ok).toBe(false);
    const { agents: _a, ...withoutAgents } = sessionsMsg;
    expect(decodeBridgeToPhone(JSON.stringify(withoutAgents)).ok).toBe(false);
  });

  it('agent descriptors default their optional lists', () => {
    const res = decodeBridgeToPhone(JSON.stringify({
      ...sessionsMsg,
      agents: [{ id: 'pi', displayName: 'Pi' }],
    }));
    expect(res.ok).toBe(true);
    if (res.ok && res.msg.type === 'sessions') {
      expect(res.msg.agents[0]).toEqual({
        id: 'pi',
        displayName: 'Pi',
        modes: [],
        efforts: [],
        supports: { models: false, usage: false, providers: false, gsd: false, interrupt: false },
        credentials: [],
      });
    }
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

  it('output entries accept entryType "diff" with its lines (CDX-050)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 8,
      entry: {
        entryType: 'diff',
        timestamp: '2026-08-08T10:00:00Z',
        path: 'src/app.ts',
        callId: 'toolu_9',
        lines: [
          { type: 'del', text: 'const a = 1;' },
          { type: 'add', text: 'const a = 2;' },
        ],
      },
    };
    const decoded = decodeBridgeToPhone(encodeBridgeToPhone(msg));
    expect(decoded).toEqual({ ok: true, msg });

    // truncated flag round-trips
    const truncated: BridgeToPhoneMessage = {
      ...msg,
      entry: { ...msg.entry, lines: [{ type: 'add', text: 'x' }], truncated: true },
    } as BridgeToPhoneMessage;
    expect(decodeBridgeToPhone(encodeBridgeToPhone(truncated))).toEqual({ ok: true, msg: truncated });

    // a bad line type is rejected
    expect(decodeBridgeToPhone(JSON.stringify({
      ...msg,
      entry: { ...msg.entry, lines: [{ type: 'changed', text: 'x' }] },
    })).ok).toBe(false);
  });

  it('the capability lists match the Rust v11 set', () => {
    expect(ALL_BRIDGE_CAPABILITIES).toEqual(['sync/1', 'folders', 'images', 'device-actions', 'chunked']);
    expect(ALL_PHONE_CAPABILITIES).toEqual([CAPABILITIES.chunked]);
  });

  it('output entries accept entryType "thinking" (with the redacted flag)', () => {
    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 7,
      entry: {
        entryType: 'thinking',
        text: 'pondering…',
        timestamp: '2026-08-05T10:00:00Z',
        redacted: false,
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
      agent: 'claude-code',
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
