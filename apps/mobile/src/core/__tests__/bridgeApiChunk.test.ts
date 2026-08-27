/**
 * BridgeApi.ingest — oversize-message reassembly (chunking.ts).
 *
 * The bridge splits a message whose encoded JSON would blow the relay's
 * 65535-byte content cap into N `chunk` events. BridgeApi must buffer those and
 * dispatch the reassembled message EXACTLY ONCE, as if it had arrived whole —
 * so `onOutput` still gets one `(seq, entry)` and `seq` semantics are untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
  LIVE_KIND,
  encodeBridgeToPhone,
  frameEncodedMessage,
  type BridgeToPhoneMessage,
  type OutputEntry,
} from '@codedeck/protocol';
import { BridgeApi } from '../services/bridgeApi';
import { encryptTo, generateKeypair, type Keypair } from '../crypto';
import type { Timers } from '../ports';

const timers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function setup() {
  const phone = generateKeypair();
  const machine = generateKeypair();
  const onOutput = vi.fn();
  let now = 1_000_000;
  const api = new BridgeApi({
    identity: () => phone,
    isKnownMachine: (pk) => pk === machine.pubkeyHex,
    publish: async () => true,
    handlers: { onOutput },
    now: () => now,
    timers,
  });
  return { api, phone, machine, onOutput, advance: (ms: number) => (now += ms) };
}

/** One encrypted event carrying `payload` (a whole message or one fragment). */
function eventOf(payload: string, machine: Keypair, phone: Keypair): NostrEvent {
  return finalizeEvent(
    {
      kind: LIVE_KIND,
      created_at: 1_700_000_000,
      tags: [['p', phone.pubkeyHex]],
      content: encryptTo(machine.secretKey, phone.pubkeyHex, payload),
    },
    machine.secretKey,
  );
}

type OutputMessage = Extract<BridgeToPhoneMessage, { type: 'output' }>;

function bigOutput(bytes: number, seq = 100): { msg: OutputMessage; entry: OutputEntry } {
  const entry: OutputEntry = {
    entryType: 'text',
    content: 'Z'.repeat(bytes),
    timestamp: '2026-08-05T00:00:00.000Z',
    metadata: { role: 'assistant' },
  };
  return { msg: { type: 'output', sessionId: 's1', seq, entry }, entry };
}

let cidN = 0;
const nextCid = () => `t-cid-${cidN++}`;

describe('BridgeApi.ingest — chunk reassembly', () => {
  it('a small message still dispatches directly (unchanged path)', () => {
    const { api, machine, phone, onOutput } = setup();
    const msg: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 1,
      entry: { entryType: 'text', content: 'hi', timestamp: '2026-08-05T00:00:00Z' },
    };
    api.ingest(eventOf(encodeBridgeToPhone(msg), machine, phone));
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput.mock.calls[0]![0]).toEqual(msg);
  });

  it('in-order fragments → one onOutput with the reassembled entry and its single seq', () => {
    const { api, machine, phone, onOutput } = setup();
    const { msg, entry } = bigOutput(150_000, 100);
    const frames = frameEncodedMessage(encodeBridgeToPhone(msg), nextCid);
    expect(frames.length).toBeGreaterThan(1);

    frames.forEach((f) => api.ingest(eventOf(f, machine, phone)));

    expect(onOutput).toHaveBeenCalledTimes(1);
    const got = onOutput.mock.calls[0]![0] as Extract<BridgeToPhoneMessage, { type: 'output' }>;
    expect(got.seq).toBe(100);
    expect(got.entry).toEqual(entry);
  });

  it('out-of-order + a duplicated fragment still reassemble exactly once', () => {
    const { api, machine, phone, onOutput } = setup();
    const { msg } = bigOutput(120_000, 205);
    const frames = frameEncodedMessage(encodeBridgeToPhone(msg), nextCid);

    const shuffled = [...frames].reverse();
    api.ingest(eventOf(shuffled[0]!, machine, phone));
    api.ingest(eventOf(shuffled[0]!, machine, phone)); // duplicate
    for (let i = 1; i < shuffled.length; i++) api.ingest(eventOf(shuffled[i]!, machine, phone));

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect((onOutput.mock.calls[0]![0] as { entry: OutputEntry }).entry).toEqual(msg.entry);
  });

  it('a missing fragment never dispatches and is not recorded as a decode failure', () => {
    const { api, machine, phone, onOutput } = setup();
    const { msg } = bigOutput(150_000, 300);
    const frames = frameEncodedMessage(encodeBridgeToPhone(msg), nextCid);

    // Deliver all but the middle one.
    frames.forEach((f, i) => {
      if (i !== Math.floor(frames.length / 2)) api.ingest(eventOf(f, machine, phone));
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(api.diagnostics.decodeFailures).toBe(0);
    expect(api.diagnostics.decryptFailures).toBe(0);
  });

  it('a whole output interleaved with another output\'s fragments is not blocked', () => {
    const { api, machine, phone, onOutput } = setup();
    const big = bigOutput(150_000, 100);
    const frames = frameEncodedMessage(encodeBridgeToPhone(big.msg), nextCid);
    const small: BridgeToPhoneMessage = {
      type: 'output',
      sessionId: 's1',
      seq: 101,
      entry: { entryType: 'text', content: 'quick follow-up', timestamp: '2026-08-05T00:00:00Z' },
    };

    api.ingest(eventOf(frames[0]!, machine, phone));
    api.ingest(eventOf(encodeBridgeToPhone(small), machine, phone)); // whole message, mid-stream
    for (let i = 1; i < frames.length; i++) api.ingest(eventOf(frames[i]!, machine, phone));

    const seqs = onOutput.mock.calls.map((c) => (c[0] as { seq: number }).seq).sort((a, b) => a - b);
    expect(seqs).toEqual([100, 101]);
  });

  it('an invalid chunk envelope (index out of range) is recorded and dropped', () => {
    const { api, machine, phone, onOutput } = setup();
    const bad = JSON.stringify({ type: 'chunk', cid: 'x', i: 9, n: 3, part: 'p' });
    api.ingest(eventOf(bad, machine, phone));
    expect(onOutput).not.toHaveBeenCalled();
    expect(api.diagnostics.decodeFailures).toBe(1);
  });
});
