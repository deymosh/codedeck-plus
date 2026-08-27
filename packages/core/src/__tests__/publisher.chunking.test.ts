/**
 * Publisher fragmentation — the fix for:
 *   Bridge publish FAILED: error: content is too large: 65628, max is 65535
 *
 * A large model reply is one `output` message whose NIP-44 `content` lands past
 * the relay's 65535-byte cap. The publisher now splits such a message into
 * `chunk` events BELOW the semantic layer:
 *  - every event's `content` is within the cap,
 *  - fragments share one `created_at` and the original message's kind/expiry,
 *  - reassembling the fragments reproduces the message byte-for-byte (so `seq`
 *    and everything else are untouched),
 *  - small messages are still published as exactly one unchanged event.
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  LIVE_KIND,
  RESPONSE_KIND,
  MAX_EVENT_CONTENT_BYTES,
  encodeBridgeToPhone,
  parseChunkEnvelope,
  utf8Size,
  type BridgeToPhoneMessage,
} from '@codedeck/protocol';
import { Publisher, type PublishTransport } from '../nostr/publisher';
import { decryptFrom } from '../nostr/crypto';

function makeTransport(relays = ['wss://a.test', 'wss://b.test']) {
  const published: NostrEvent[] = [];
  const transport: PublishTransport = {
    relays,
    publish(event) {
      published.push(event);
      return relays.map(() => Promise.resolve('ok'));
    },
    notePublishSuccess() {},
  };
  return { transport, published };
}

function makePublisher(transport: PublishTransport) {
  const secretKey = generateSecretKey();
  let cid = 0;
  const publisher = new Publisher({
    secretKey,
    machineName: 'M',
    transport,
    now: () => 1_754_000_000_000,
    makeChunkId: () => `cid-${cid++}`,
  });
  return { publisher, bridgePubkey: getPublicKey(secretKey) };
}

/** An `output` message whose serialized JSON is ~`bytes` long. */
function bigOutput(bytes: number): BridgeToPhoneMessage {
  const skeleton = encodeBridgeToPhone({
    type: 'output',
    sessionId: 'sess-abcdef',
    seq: 4242,
    entry: { entryType: 'text', content: '', timestamp: '2026-08-05T00:00:00.000Z' },
  });
  const pad = Math.max(0, bytes - utf8Size(skeleton));
  return {
    type: 'output',
    sessionId: 'sess-abcdef',
    seq: 4242,
    entry: {
      entryType: 'text',
      content: 'A'.repeat(pad),
      timestamp: '2026-08-05T00:00:00.000Z',
    },
  };
}

const tag = (e: NostrEvent, name: string) => e.tags.find(([n]) => n === name)?.[1];

describe('Publisher — small messages are unchanged', () => {
  it('a normal output publishes as exactly one LIVE event with s/seq tags', async () => {
    const { transport, published } = makeTransport();
    const { publisher, bridgePubkey } = makePublisher(transport);
    const phoneSecret = generateSecretKey();
    const phone = getPublicKey(phoneSecret);

    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 7,
      entry: { entryType: 'text', content: 'short and sweet', timestamp: '2026-08-05T00:00:00Z' },
    };
    const ok = await publisher.publishToPhones(msg, [phone]);

    expect(ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(LIVE_KIND);
    expect(tag(published[0]!, 's')).toBe('s1');
    expect(tag(published[0]!, 'seq')).toBe('7');
    // Decrypts straight to the message — no chunk wrapper.
    const plain = decryptFrom(phoneSecret, bridgePubkey, published[0]!.content);
    expect(parseChunkEnvelope(plain)).toBeNull();
    expect(JSON.parse(plain)).toEqual(msg);
  });

  it('an output right at the size threshold still goes out as one event under the cap', async () => {
    const { transport, published } = makeTransport();
    const { publisher } = makePublisher(transport);
    await publisher.publishToPhones(bigOutput(40_900), [getPublicKey(generateSecretKey())]);
    expect(published).toHaveLength(1);
    expect(utf8Size(published[0]!.content)).toBeLessThanOrEqual(MAX_EVENT_CONTENT_BYTES);
  });
});

describe('Publisher — oversize messages fragment (regression: content is too large: 65628)', () => {
  it('an output that would encrypt to 65628 bytes is split; every event is within the cap', async () => {
    const { transport, published } = makeTransport();
    const { publisher, bridgePubkey } = makePublisher(transport);
    const phoneSecret = generateSecretKey();
    const phone = getPublicKey(phoneSecret);

    // ~49KB of message JSON is exactly the band that pads to `content = 65628`.
    const msg = bigOutput(49_000);

    const ok = await publisher.publishToPhones(msg, [phone]);
    expect(ok).toBe(true);
    expect(published.length).toBeGreaterThanOrEqual(2);

    for (const e of published) {
      expect(e.kind).toBe(LIVE_KIND);
      expect(e.created_at).toBe(published[0]!.created_at); // one timestamp for the group
      expect(utf8Size(e.content)).toBeLessThanOrEqual(MAX_EVENT_CONTENT_BYTES);
      expect(tag(e, 's')).toBeUndefined(); // fragments carry no seq of their own
      expect(tag(e, 'seq')).toBeUndefined();
    }

    // Decrypt each fragment, check envelope shape, reassemble → original message.
    const envs = published.map((e) => parseChunkEnvelope(decryptFrom(phoneSecret, bridgePubkey, e.content)));
    expect(envs.every((x) => x !== null)).toBe(true);
    expect(new Set(envs.map((x) => x!.cid)).size).toBe(1);
    expect(envs.map((x) => x!.i).sort((a, b) => a - b)).toEqual(envs.map((_, i) => i));
    expect(envs.every((x) => x!.n === envs.length)).toBe(true);

    const rebuilt = envs
      .sort((a, b) => a!.i - b!.i)
      .map((x) => x!.part)
      .join('');
    expect(JSON.parse(rebuilt)).toEqual(msg);
  });

  it('consecutive outputs keep ordering: the chunked seq shares a created_at strictly below the next', async () => {
    const { transport, published } = makeTransport();
    const { publisher } = makePublisher(transport);
    const phone = getPublicKey(generateSecretKey());

    // getNextTimestamp increments per publishToPhones call, so freeze-clock +
    // monotonic bump means: all of seq 100's fragments < seq 101 < seq 102.
    await publisher.publishToPhones(bigOutput(160_000), [phone]); // seq 4242, many frames
    const afterBig = published.length;
    await publisher.publishToPhones(
      { type: 'output', sessionId: 'sess-abcdef', seq: 4243, entry: { entryType: 'text', content: 'next', timestamp: '2026-08-05T00:00:00Z' } },
      [phone],
    );
    await publisher.publishToPhones(
      { type: 'output', sessionId: 'sess-abcdef', seq: 4244, entry: { entryType: 'text', content: 'last', timestamp: '2026-08-05T00:00:00Z' } },
      [phone],
    );

    const bigStamp = published[0]!.created_at;
    for (let i = 1; i < afterBig; i++) expect(published[i]!.created_at).toBe(bigStamp);
    expect(published[afterBig]!.created_at).toBeGreaterThan(bigStamp);
    expect(published[afterBig + 1]!.created_at).toBeGreaterThan(published[afterBig]!.created_at);
  });

  it('an oversize sync-chunk fragments onto RESPONSE_KIND with a NIP-40 expiration (catch-up safe)', async () => {
    const { transport, published } = makeTransport();
    const { publisher, bridgePubkey } = makePublisher(transport);
    const phoneSecret = generateSecretKey();
    const phone = getPublicKey(phoneSecret);

    const entry = { entryType: 'text' as const, content: 'B'.repeat(70_000), timestamp: '2026-08-05T00:00:00Z' };
    const msg: BridgeToPhoneMessage = {
      type: 'sync-chunk',
      sessionId: 's1',
      syncId: 'y1',
      range: [10, 10],
      entries: [{ seq: 10, entry }],
    };

    const ok = await publisher.publishToPhones(msg, [phone]);
    expect(ok).toBe(true);
    expect(published.length).toBeGreaterThanOrEqual(2);
    for (const e of published) {
      expect(e.kind).toBe(RESPONSE_KIND);
      expect(tag(e, 'expiration')).toBe(String(e.created_at + 60 * 60));
      expect(utf8Size(e.content)).toBeLessThanOrEqual(MAX_EVENT_CONTENT_BYTES);
    }
    const rebuilt = published
      .map((e) => parseChunkEnvelope(decryptFrom(phoneSecret, bridgePubkey, e.content))!)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.part)
      .join('');
    expect(JSON.parse(rebuilt)).toEqual(msg);
  });

  it('reports success only when a phone received EVERY fragment', async () => {
    // A transport that rejects the 2nd publish → that phone is missing a frame.
    const relays = ['wss://only.test'];
    const published: NostrEvent[] = [];
    let n = 0;
    const transport: PublishTransport = {
      relays,
      publish(event) {
        published.push(event);
        n++;
        return [n === 2 ? Promise.reject(new Error('blocked')) : Promise.resolve('ok')];
      },
    };
    const { publisher } = makePublisher(transport);
    const ok = await publisher.publishToPhones(bigOutput(120_000), [getPublicKey(generateSecretKey())]);
    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(ok).toBe(false);
  });
});
