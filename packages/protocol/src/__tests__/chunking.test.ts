/**
 * Event-content fragmentation (chunking.ts).
 *
 * The real failure this exists for:
 *   Bridge publish FAILED: error: content is too large: 65628, max is 65535
 *
 * A large model reply is one OutputEntry whose serialized message JSON, once
 * NIP-44-padded and base64'd, lands on `content = 65628`. These tests pin:
 *  - the safe-plaintext constant against the REAL nostr-tools/nip44 padding,
 *  - `frameEncodedMessage` never emits a fragment that would exceed the cap,
 *  - reassembly is exact, order-independent, dedup-safe, and never surfaces
 *    partial content.
 */
import { describe, expect, it } from 'vitest';
import { encrypt, getConversationKey } from 'nostr-tools/nip44';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  ChunkAssembler,
  CHUNK_MESSAGE_TYPE,
  MAX_EVENT_CONTENT_BYTES,
  NIP44_SAFE_PLAINTEXT_BYTES,
  chunkEnvelopeSchema,
  frameEncodedMessage,
  parseChunkEnvelope,
  utf8Size,
} from '../chunking';
import { encodeBridgeToPhone } from '../codec';
import type { BridgeToPhoneMessage } from '../schemas/events';

/** Deterministic cid factory for assertions. */
function cidGen(prefix = 'cid'): () => string {
  let n = 0;
  return () => `${prefix}${n++}`;
}

/** An `output` message whose serialized JSON is `targetBytes` give-or-take. */
function outputOfSize(targetBytes: number): BridgeToPhoneMessage {
  const base = encodeBridgeToPhone({
    type: 'output',
    sessionId: 'S'.repeat(36),
    seq: 12345,
    entry: { entryType: 'text', content: '', timestamp: '2026-08-05T00:00:00.000Z' },
  });
  const pad = Math.max(0, targetBytes - utf8Size(base));
  return {
    type: 'output',
    sessionId: 'S'.repeat(36),
    seq: 12345,
    entry: { entryType: 'text', content: 'x'.repeat(pad), timestamp: '2026-08-05T00:00:00.000Z' },
  };
}

describe('NIP44_SAFE_PLAINTEXT_BYTES — the real nostr-tools padding boundary', () => {
  const key = getConversationKey(generateSecretKey(), getPublicKey(generateSecretKey()));

  it('a plaintext of exactly NIP44_SAFE_PLAINTEXT_BYTES encrypts within the relay cap', () => {
    const ct = encrypt('x'.repeat(NIP44_SAFE_PLAINTEXT_BYTES), key);
    expect(utf8Size(ct)).toBeLessThanOrEqual(MAX_EVENT_CONTENT_BYTES);
  });

  it('one byte past it crosses the 8192 padding block and blows the cap (the 65628 step)', () => {
    const over = encrypt('x'.repeat(NIP44_SAFE_PLAINTEXT_BYTES + 1), key);
    expect(utf8Size(over)).toBeGreaterThan(MAX_EVENT_CONTENT_BYTES);
    // The exact number from the bug report, for the record.
    expect(utf8Size(over)).toBe(65628);
  });

  it('every plaintext length 1..SAFE encrypts within the cap (sampled)', () => {
    for (let len = 1; len <= NIP44_SAFE_PLAINTEXT_BYTES; len += 1023) {
      const ct = encrypt('x'.repeat(len), key);
      expect(utf8Size(ct), `len=${len}`).toBeLessThanOrEqual(MAX_EVENT_CONTENT_BYTES);
    }
  });
});

describe('frameEncodedMessage', () => {
  it('returns the input UNCHANGED (single element, identical string) when it fits', () => {
    const json = encodeBridgeToPhone({
      type: 'output',
      sessionId: 's1',
      seq: 7,
      entry: { entryType: 'text', content: 'hello', timestamp: '2026-08-05T00:00:00Z' },
    });
    const frames = frameEncodedMessage(json, cidGen());
    expect(frames).toEqual([json]);
    expect(frames[0]).toBe(json); // no wrapper, byte-for-byte
  });

  it('a message right at the threshold still goes out as one frame', () => {
    const json = encodeBridgeToPhone(outputOfSize(NIP44_SAFE_PLAINTEXT_BYTES));
    expect(utf8Size(json)).toBeLessThanOrEqual(NIP44_SAFE_PLAINTEXT_BYTES);
    expect(frameEncodedMessage(json, cidGen())).toEqual([json]);
  });

  it('an oversize message splits into ≥2 fragments, each within the plaintext cap', () => {
    const json = encodeBridgeToPhone(outputOfSize(200_000));
    const frames = frameEncodedMessage(json, cidGen());
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(utf8Size(frame)).toBeLessThanOrEqual(NIP44_SAFE_PLAINTEXT_BYTES);
      const env = parseChunkEnvelope(frame);
      expect(env).not.toBeNull();
      expect(env!.type).toBe(CHUNK_MESSAGE_TYPE);
      expect(env!.n).toBe(frames.length);
    }
    expect(frames.map((f) => parseChunkEnvelope(f)!.i)).toEqual(
      frames.map((_, i) => i),
    );
    // Concatenating the parts in index order reproduces the original JSON.
    const rebuilt = frames.map((f) => parseChunkEnvelope(f)!.part).join('');
    expect(rebuilt).toBe(json);
  });

  it('every fragment shares one cid; distinct messages get distinct cids', () => {
    const make = cidGen('grp');
    const a = frameEncodedMessage(encodeBridgeToPhone(outputOfSize(120_000)), make);
    const b = frameEncodedMessage(encodeBridgeToPhone(outputOfSize(120_000)), make);
    const cidOf = (frames: string[]) => new Set(frames.map((f) => parseChunkEnvelope(f)!.cid));
    expect(cidOf(a).size).toBe(1);
    expect(cidOf(b).size).toBe(1);
    expect([...cidOf(a)][0]).not.toBe([...cidOf(b)][0]);
  });

  it('survives multi-byte / quote-heavy content without corrupting the split', () => {
    const nasty = '“quote” 𝕏 \\ "escaped" \n'.repeat(20_000);
    const json = encodeBridgeToPhone({
      type: 'output',
      sessionId: 's1',
      seq: 1,
      entry: { entryType: 'text', content: nasty, timestamp: '2026-08-05T00:00:00Z' },
    });
    const frames = frameEncodedMessage(json, cidGen());
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(utf8Size(f)).toBeLessThanOrEqual(NIP44_SAFE_PLAINTEXT_BYTES);
    expect(frames.map((f) => parseChunkEnvelope(f)!.part).join('')).toBe(json);
  });
});

describe('parseChunkEnvelope', () => {
  it('returns null for ordinary messages and non-JSON', () => {
    expect(parseChunkEnvelope('{"type":"output","seq":1}')).toBeNull();
    expect(parseChunkEnvelope('not json')).toBeNull();
    expect(parseChunkEnvelope('[]')).toBeNull();
  });
  it('returns null for a chunk-shaped but schema-invalid payload', () => {
    expect(parseChunkEnvelope('{"type":"chunk","cid":"c","i":0}')).toBeNull(); // no n / part
    expect(parseChunkEnvelope('{"type":"chunk","cid":"c","i":0,"n":1,"part":"x"}')).toBeNull(); // n < 2
  });
  it('round-trips a valid envelope', () => {
    const env = { type: CHUNK_MESSAGE_TYPE, cid: 'c1', i: 2, n: 4, part: 'abc' };
    expect(parseChunkEnvelope(JSON.stringify(env))).toEqual(env);
    expect(chunkEnvelopeSchema.safeParse(env).success).toBe(true);
  });
});

describe('ChunkAssembler', () => {
  const framesFor = (bytes: number, cid = 'c'): string[] =>
    frameEncodedMessage(encodeBridgeToPhone(outputOfSize(bytes)), () => cid);

  it('passes ordinary messages straight through', () => {
    const a = new ChunkAssembler();
    expect(a.offer('{"type":"output","sessionId":"s","seq":1,"entry":{}}')).toEqual({
      kind: 'passthrough',
    });
  });

  it('reassembles in-order fragments into the exact original JSON', () => {
    const json = encodeBridgeToPhone(outputOfSize(150_000));
    const frames = frameEncodedMessage(json, () => 'g1');
    const a = new ChunkAssembler();
    for (let i = 0; i < frames.length - 1; i++) {
      expect(a.offer(frames[i]!)).toEqual({ kind: 'buffered' });
    }
    const last = a.offer(frames[frames.length - 1]!);
    expect(last).toEqual({ kind: 'assembled', json });
    expect(a.openCount).toBe(0);
  });

  it('reassembles out-of-order fragments', () => {
    const json = encodeBridgeToPhone(outputOfSize(150_000));
    const frames = [...frameEncodedMessage(json, () => 'g2')].reverse();
    const a = new ChunkAssembler();
    let result: ReturnType<ChunkAssembler['offer']> = { kind: 'buffered' };
    for (const f of frames) result = a.offer(f);
    expect(result).toEqual({ kind: 'assembled', json });
  });

  it('ignores a duplicated fragment (idempotent)', () => {
    const frames = framesFor(90_000, 'g3');
    const a = new ChunkAssembler();
    a.offer(frames[0]!);
    a.offer(frames[0]!); // dup
    a.offer(frames[0]!); // dup
    let last: ReturnType<ChunkAssembler['offer']> = { kind: 'buffered' };
    for (let i = 1; i < frames.length; i++) last = a.offer(frames[i]!);
    expect(last.kind).toBe('assembled');
  });

  it('rejects a fragment whose index is out of range', () => {
    const a = new ChunkAssembler();
    const bad = JSON.stringify({ type: CHUNK_MESSAGE_TYPE, cid: 'x', i: 5, n: 3, part: 'p' });
    expect(a.offer(bad)).toEqual({ kind: 'invalid', error: expect.stringContaining('out of range') });
  });

  it('never surfaces partial content when a fragment is missing, and sweeps it after the TTL', () => {
    let t = 0;
    const a = new ChunkAssembler({ now: () => t, ttlMs: 1000 });
    const frames = framesFor(150_000, 'gap');
    // Deliver all but one.
    for (let i = 0; i < frames.length - 1; i++) {
      expect(a.offer(frames[i]!).kind).toBe('buffered');
    }
    expect(a.openCount).toBe(1);
    t = 2000; // past TTL
    a.sweep();
    expect(a.openCount).toBe(0);
    // The straggler arriving now cannot resurrect a completed message.
    expect(a.offer(frames[frames.length - 1]!).kind).toBe('buffered');
  });

  it('keeps interleaved messages separate by cid', () => {
    const jsonA = encodeBridgeToPhone(outputOfSize(120_000));
    const jsonB = encodeBridgeToPhone(outputOfSize(90_000));
    const fa = frameEncodedMessage(jsonA, () => 'A');
    const fb = frameEncodedMessage(jsonB, () => 'B');
    const a = new ChunkAssembler();
    const out: string[] = [];
    // Interleave.
    const max = Math.max(fa.length, fb.length);
    for (let i = 0; i < max; i++) {
      if (fa[i]) { const r = a.offer(fa[i]!); if (r.kind === 'assembled') out.push(r.json); }
      if (fb[i]) { const r = a.offer(fb[i]!); if (r.kind === 'assembled') out.push(r.json); }
    }
    expect(out.sort()).toEqual([jsonA, jsonB].sort());
  });

  it('bounds open groups (oldest evicted past maxOpen)', () => {
    let t = 0;
    const a = new ChunkAssembler({ now: () => t++, maxOpen: 2 });
    for (const cid of ['a', 'b', 'c']) {
      a.offer(JSON.stringify({ type: CHUNK_MESSAGE_TYPE, cid, i: 0, n: 2, part: 'p' }));
    }
    expect(a.openCount).toBe(2);
  });
});
