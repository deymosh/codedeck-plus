/**
 * Publisher: storage-class policy (exhaustive over the BridgeToPhoneMessage
 * union), monotonic created_at, per-phone NIP-44 encryption + tag shapes,
 * "replaced"-as-success, and the 5s per-relay publish timeout.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  SESSION_LIST_KIND,
  RESPONSE_KIND,
  LIVE_KIND,
  RESPONSE_EXPIRY_SECONDS,
  type BridgeToPhoneMessage,
  type RemoteSessionInfo,
  type GsdState,
} from '@codedeck/protocol';
import { kindForMessage, Publisher, type PublishTransport } from '../nostr/publisher';
import { decryptFrom } from '../nostr/crypto';

const session: RemoteSessionInfo = {
  id: 'sess-1',
  slug: 'sess',
  cwd: '/work',
  lastActivity: '2026-08-05T00:00:00Z',
  lineCount: 0,
  title: null,
  project: 'proj',
};

const gsd: GsdState = {
  installed: false,
  available: false,
  hasGit: false,
  situation: 'none',
  summary: '',
  milestone: null,
  currentPhase: null,
  totalPhases: null,
  percent: 0,
  phases: [],
  actions: [],
  recommended: null,
  paused: false,
  blockers: [],
  verifyFailed: false,
  execution: null,
};

const entry = { entryType: 'text' as const, content: 'hi', timestamp: '2026-08-05T00:00:00Z' };

/**
 * One minimal valid sample per message type. The mapped type makes this record
 * exhaustive at the TYPE level: adding a message to the union without adding a
 * sample here (and a route in kindForMessage) is a compile error.
 */
const samples: { [K in BridgeToPhoneMessage['type']]: Extract<BridgeToPhoneMessage, { type: K }> } = {
  'sessions': { type: 'sessions', machine: 'm', sessions: [], protocolVersion: 10 },
  'output': { type: 'output', sessionId: 's1', seq: 7, entry },
  'input-ack': { type: 'input-ack', sessionId: 's1', inputId: 'i1' },
  'sync-begin': { type: 'sync-begin', sessionId: 's1', syncId: 'y1', seqHigh: 9, ranges: [[0, 9]] },
  'sync-chunk': { type: 'sync-chunk', sessionId: 's1', syncId: 'y1', range: [0, 0], entries: [{ seq: 0, entry }] },
  'sync-end': { type: 'sync-end', sessionId: 's1', syncId: 'y1', deliveredRanges: [[0, 9]] },
  'session-pending': { type: 'session-pending', pendingId: 'p1', machine: 'm', createdAt: 't' },
  'session-ready': { type: 'session-ready', pendingId: 'p1', session },
  'session-failed': { type: 'session-failed', pendingId: 'p1', reason: 'nope' },
  'input-failed': { type: 'input-failed', sessionId: 's1', reason: 'no-session' },
  'close-session-ack': { type: 'close-session-ack', sessionId: 's1', success: true },
  'session-replaced': { type: 'session-replaced', oldSessionId: 's1', newSession: session },
  'mode-confirmed': { type: 'mode-confirmed', sessionId: 's1', mode: 'default' },
  'effort-confirmed': { type: 'effort-confirmed', sessionId: 's1', level: 'high' },
  'model-confirmed': { type: 'model-confirmed', sessionId: 's1', model: 'opus' },
  'folder-ack': { type: 'folder-ack', requestId: 'r1', success: true },
  'usage': { type: 'usage', sessionId: 's1', usage: { available: false, subscriptionType: null, fetchedAt: 't' } },
  'gsd-state': { type: 'gsd-state', sessionId: 's1', gsd },
  'models': { type: 'models', models: [] },
  'credentials-ack': { type: 'credentials-ack', machine: 'm', success: true, hasAnthropicKey: false, hasGithubPat: false },
  'device-config-ack': { type: 'device-config-ack', success: true },
  'pair-ack': { type: 'pair-ack', machine: 'm', ok: true },
  // CDX-062: redacted profile list + per-set ack — stored responses, so a
  // briefly-offline phone still receives them.
  'provider-profiles': {
    type: 'provider-profiles',
    machine: 'm',
    profiles: [{ id: 'kimi', label: 'Kimi K3', baseUrl: 'https://api.moonshot.ai/anthropic', models: [{ id: 'kimi-k3' }], hasToken: true }],
  },
  'provider-profile-ack': { type: 'provider-profile-ack', machine: 'm', profileId: 'kimi', success: true },
};

describe('kindForMessage storage-class policy', () => {
  const replaceable: Array<BridgeToPhoneMessage['type']> = ['sessions'];
  const ephemeral: Array<BridgeToPhoneMessage['type']> = ['output', 'usage', 'gsd-state'];

  it('routes every message type in the union', () => {
    for (const [type, msg] of Object.entries(samples) as Array<[BridgeToPhoneMessage['type'], BridgeToPhoneMessage]>) {
      const policy = kindForMessage(msg);
      if (replaceable.includes(type)) {
        expect(policy, type).toEqual({ kind: SESSION_LIST_KIND });
      } else if (ephemeral.includes(type)) {
        expect(policy, type).toEqual({ kind: LIVE_KIND });
      } else {
        expect(policy, type).toEqual({ kind: RESPONSE_KIND, expirySeconds: RESPONSE_EXPIRY_SECONDS });
      }
    }
  });
});

// --- Publisher wiring ---

interface Recorded { event: NostrEvent }

function makeTransport(
  outcome: (event: NostrEvent, relayIndex: number) => Promise<string>,
  relays: string[] = ['wss://a.example', 'wss://b.example'],
) {
  const published: Recorded[] = [];
  let successNotes = 0;
  const transport: PublishTransport = {
    relays,
    publish(event) {
      published.push({ event });
      return relays.map((_, i) => outcome(event, i));
    },
    notePublishSuccess() { successNotes++; },
  };
  return { transport, published, successNotes: () => successNotes };
}

function makePublisher(transport: PublishTransport, now?: () => number) {
  const secretKey = generateSecretKey();
  const publisher = new Publisher({ secretKey, machineName: 'Framework', transport, now });
  return { publisher, secretKey, bridgePubkey: getPublicKey(secretKey) };
}

const tag = (event: NostrEvent, name: string) => event.tags.find(([n]) => n === name)?.[1];

describe('Publisher', () => {
  it('created_at is strictly increasing across a burst of publishes in the same second', async () => {
    const { transport, published } = makeTransport(() => Promise.resolve('ok'));
    const { publisher } = makePublisher(transport, () => 1_754_000_000_000); // frozen clock
    const phone = getPublicKey(generateSecretKey());

    for (let i = 0; i < 5; i++) {
      await publisher.publishToPhones(samples['sessions'], [phone]);
    }

    const stamps = published.map((p) => p.event.created_at);
    expect(stamps).toHaveLength(5);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
    expect(stamps[0]).toBe(1_754_000_000);
  });

  it('encrypts per phone, tags p/d for the session list, and the phone can decrypt', async () => {
    const { transport, published, successNotes } = makeTransport(() => Promise.resolve('ok'));
    const { publisher, bridgePubkey } = makePublisher(transport);
    const phoneASecret = generateSecretKey();
    const phoneA = getPublicKey(phoneASecret);
    const phoneB = getPublicKey(generateSecretKey());

    const ok = await publisher.publishToPhones(samples['sessions'], [phoneA, phoneB]);

    expect(ok).toBe(true);
    expect(successNotes()).toBe(1);
    expect(published).toHaveLength(2); // one event per phone
    const [a, b] = published.map((p) => p.event);
    expect(a!.kind).toBe(SESSION_LIST_KIND);
    expect(verifyEvent(a!)).toBe(true);
    expect(tag(a!, 'p')).toBe(phoneA);
    expect(tag(b!, 'p')).toBe(phoneB);
    expect(tag(a!, 'd')).toBe('Framework'); // NIP-33 identifier
    expect(tag(a!, 'expiration')).toBeUndefined(); // replaceable — no expiry
    // Same message, different ciphertext per phone; phone A can decrypt its copy.
    expect(a!.content).not.toBe(b!.content);
    const plain = decryptFrom(phoneASecret, bridgePubkey, a!.content);
    expect(JSON.parse(plain)).toEqual(samples['sessions']);
  });

  it('output rides LIVE_KIND with s/seq tags and no expiration', async () => {
    const { transport, published } = makeTransport(() => Promise.resolve('ok'));
    const { publisher } = makePublisher(transport);

    await publisher.publishToPhones(samples['output'], [getPublicKey(generateSecretKey())]);

    const event = published[0]!.event;
    expect(event.kind).toBe(LIVE_KIND);
    expect(tag(event, 's')).toBe('s1');
    expect(tag(event, 'seq')).toBe('7');
    expect(tag(event, 'd')).toBeUndefined();
    expect(tag(event, 'expiration')).toBeUndefined();
  });

  it('stored responses ride RESPONSE_KIND with a NIP-40 expiration; sync messages carry the s tag', async () => {
    const { transport, published } = makeTransport(() => Promise.resolve('ok'));
    const { publisher } = makePublisher(transport, () => 1_754_000_000_000);

    await publisher.publishToPhones(samples['sync-chunk'], [getPublicKey(generateSecretKey())]);

    const event = published[0]!.event;
    expect(event.kind).toBe(RESPONSE_KIND);
    expect(tag(event, 's')).toBe('s1');
    expect(tag(event, 'seq')).toBeUndefined();
    expect(tag(event, 'expiration')).toBe(String(event.created_at + RESPONSE_EXPIRY_SECONDS));
  });

  it('treats "replaced:" / "newer event" relay rejections as success', async () => {
    const { transport, successNotes } = makeTransport((_e, i) =>
      i === 0
        ? Promise.reject(new Error('replaced: have newer event'))
        : Promise.reject(new Error('blocked: rate limited')),
    );
    const { publisher } = makePublisher(transport);

    const ok = await publisher.publishToPhones(samples['sessions'], [getPublicKey(generateSecretKey())]);

    expect(ok).toBe(true); // the "replaced" relay already has it — that IS success
    expect(successNotes()).toBe(1);
  });

  it('returns false when every relay genuinely rejects', async () => {
    const { transport, successNotes } = makeTransport(() => Promise.reject(new Error('blocked')));
    const { publisher } = makePublisher(transport);

    const ok = await publisher.publishToPhones(samples['pair-ack'], [getPublicKey(generateSecretKey())]);

    expect(ok).toBe(false);
    expect(successNotes()).toBe(0);
  });

  it('returns false with no phones (nothing published)', async () => {
    const { transport, published } = makeTransport(() => Promise.resolve('ok'));
    const { publisher } = makePublisher(transport);

    expect(await publisher.publishToPhones(samples['sessions'], [])).toBe(false);
    expect(published).toHaveLength(0);
  });

  it('a relay that never answers is treated as failed after the 5s timeout', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = makeTransport(() => new Promise<string>(() => { /* hangs */ }));
      const { publisher } = makePublisher(transport);

      const pending = publisher.publishToPhones(samples['pair-ack'], [getPublicKey(generateSecretKey())]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
