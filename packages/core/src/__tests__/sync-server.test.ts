/**
 * SyncServer: the v10 ranged sync protocol, bridge side. This is the direct
 * regression suite for the "phone loses session history" bug — fire-and-forget
 * history chunks with no persistence, no acks, and no retries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BridgeToPhoneMessage, OutputEntry, SyncRequestMessage } from '@codedeck/protocol';
import { TranscriptStore } from '../session/transcript';
import { SyncServer, type SyncTimers } from '../sync/server';

function entry(n: number): OutputEntry {
  return { entryType: 'text', content: `entry ${n}`, timestamp: '2026-08-05T00:00:00Z' };
}

/** Deterministic manual timers — the sync server's injectable clock seam. */
class FakeTimers implements SyncTimers {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();

  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance the clock, firing due timers in order; lets async fs work settle. */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) { break; }
      this.timers.delete(first[0]);
      first[1].fn();
      await settle();
    }
    await settle();
  }
}

/** Let in-flight async work (fs reads, send chains) complete. */
function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) { throw new Error('waitFor timeout'); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Sent = { msg: BridgeToPhoneMessage; phone: string };

function request(sessionId: string, haveRanges: [number, number][]): SyncRequestMessage {
  return { type: 'sync-request', sessionId, haveRanges };
}

describe('SyncServer', () => {
  let dir: string;
  let transcript: TranscriptStore;
  let timers: FakeTimers;
  let sent: Sent[];
  let sendResult: boolean;
  let logs: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-sync-'));
    transcript = await TranscriptStore.open(dir);
    timers = new FakeTimers();
    sent = [];
    sendResult = true;
    logs = [];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeServer(overrides: Partial<ConstructorParameters<typeof SyncServer>[0]> = {}): SyncServer {
    return new SyncServer({
      transcript,
      send: async (msg, phone) => {
        sent.push({ msg, phone });
        return sendResult;
      },
      timers,
      log: (msg) => logs.push(msg),
      ...overrides,
    });
  }

  const ofType = <T extends BridgeToPhoneMessage['type']>(type: T) =>
    sent
      .filter((s): s is { msg: Extract<BridgeToPhoneMessage, { type: T }>; phone: string } =>
        s.msg.type === type)
      .map((s) => s.msg);

  async function fill(sessionId: string, count: number): Promise<void> {
    for (let i = 1; i <= count; i++) { await transcript.append(sessionId, entry(i)); }
  }

  it('full sync from empty haveRanges: begin → 50-entry chunks → acked → complete end', async () => {
    await fill('s1', 120);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 3);

    const begin = ofType('sync-begin')[0];
    expect(begin).toMatchObject({ sessionId: 's1', seqHigh: 120, ranges: [[1, 120]] });
    expect(sent[0]?.msg.type).toBe('sync-begin');
    expect(sent[0]?.phone).toBe('phoneA');

    const chunks = ofType('sync-chunk');
    expect(chunks.map((c) => c.range)).toEqual([[1, 50], [51, 100], [101, 120]]);
    expect(chunks[0]?.entries).toHaveLength(50);
    expect(chunks[2]?.entries).toHaveLength(20);
    // Chunk contents match the transcript exactly.
    expect(chunks[1]?.entries[0]).toEqual({ seq: 51, entry: entry(51) });
    expect(chunks[2]?.entries[19]).toEqual({ seq: 120, entry: entry(120) });

    // Ack every chunk → sync-end reports full delivery.
    const syncId = begin!.syncId;
    for (const c of chunks) { server.handleAck(syncId, c.range); }
    await waitFor(() => ofType('sync-end').length === 1);
    expect(ofType('sync-end')[0]).toMatchObject({ syncId, deliveredRanges: [[1, 120]] });
    expect(server.activeSyncCount()).toBe(0);
  });

  it('gap-fill: only the missing ranges are sent', async () => {
    await fill('s1', 40);
    const server = makeServer();
    server.handleSyncRequest(request('s1', [[1, 10], [20, 30]]), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 2);

    expect(ofType('sync-begin')[0]?.ranges).toEqual([[11, 19], [31, 40]]);
    const chunks = ofType('sync-chunk');
    expect(chunks.map((c) => c.range)).toEqual([[11, 19], [31, 40]]);
    expect(chunks[0]?.entries.map((e) => e.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(chunks[1]?.entries.map((e) => e.seq)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  });

  it('already-complete haveRanges: begin with empty ranges, immediate empty end', async () => {
    await fill('s1', 30);
    const server = makeServer();
    server.handleSyncRequest(request('s1', [[1, 30]]), 'phoneA');
    await waitFor(() => ofType('sync-end').length === 1);

    expect(ofType('sync-begin')[0]).toMatchObject({ seqHigh: 30, ranges: [] });
    expect(ofType('sync-chunk')).toHaveLength(0);
    expect(ofType('sync-end')[0]?.deliveredRanges).toEqual([]);
    expect(server.activeSyncCount()).toBe(0);
  });

  it('missing acks: retried with backoff, then honest partial deliveredRanges', async () => {
    await fill('s1', 120);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 3);
    const syncId = ofType('sync-begin')[0]!.syncId;

    // Only the first chunk gets acked — the other two go dark.
    server.handleAck(syncId, [1, 50]);

    await timers.advance(10_000); // retry pass 1
    expect(ofType('sync-chunk')).toHaveLength(5); // 3 initial + 2 resends
    await timers.advance(20_000); // retry pass 2
    expect(ofType('sync-chunk')).toHaveLength(7);
    expect(ofType('sync-end')).toHaveLength(0);

    await timers.advance(40_000); // retries exhausted
    const end = ofType('sync-end');
    expect(end).toHaveLength(1);
    // Honesty over completeness: ONLY the acked range is reported.
    expect(end[0]?.deliveredRanges).toEqual([[1, 50]]);
    expect(server.activeSyncCount()).toBe(0);

    // Retried chunks were resent exactly 3x, and re-reads matched the transcript.
    const resends = ofType('sync-chunk').filter((c) => c.range[0] === 51);
    expect(resends).toHaveLength(3);
    expect(resends[2]?.entries[0]).toEqual({ seq: 51, entry: entry(51) });
  });

  it('a chunk acked during retries completes the sync early', async () => {
    await fill('s1', 60);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 2);
    const syncId = ofType('sync-begin')[0]!.syncId;

    server.handleAck(syncId, [1, 50]);
    await timers.advance(10_000); // pass 1 resends [51,60]
    server.handleAck(syncId, [51, 60]);
    await waitFor(() => ofType('sync-end').length === 1);
    expect(ofType('sync-end')[0]?.deliveredRanges).toEqual([[1, 60]]);
  });

  it('a new sync-request for the same (session, phone) supersedes the old one', async () => {
    await fill('s1', 60);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 2);
    const oldSyncId = ofType('sync-begin')[0]!.syncId;

    server.handleSyncRequest(request('s1', [[1, 50]]), 'phoneA');
    await waitFor(() => ofType('sync-begin').length === 2);
    const newSyncId = ofType('sync-begin')[1]!.syncId;
    expect(newSyncId).not.toBe(oldSyncId);
    expect(server.activeSyncCount()).toBe(1);

    // Acks for the superseded sync are ignored (aborted, not finished).
    server.handleAck(oldSyncId, [1, 50]);
    await settle();
    expect(ofType('sync-end')).toHaveLength(0);

    // The new sync still completes normally.
    server.handleAck(newSyncId, [51, 60]);
    await waitFor(() => ofType('sync-end').length >= 1);
    expect(ofType('sync-end')[0]).toMatchObject({ syncId: newSyncId, deliveredRanges: [[51, 60]] });

    // Even long after, the superseded sync never emits a sync-end.
    await timers.advance(500_000);
    expect(ofType('sync-end').filter((e) => e.syncId === oldSyncId)).toHaveLength(0);
    expect(ofType('sync-end')).toHaveLength(1);
  });

  it('different phones sync the same session independently', async () => {
    await fill('s1', 10);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    server.handleSyncRequest(request('s1', []), 'phoneB');
    await waitFor(() => ofType('sync-chunk').length === 2);
    expect(server.activeSyncCount()).toBe(2);
    const phones = new Set(sent.filter((s) => s.msg.type === 'sync-chunk').map((s) => s.phone));
    expect(phones).toEqual(new Set(['phoneA', 'phoneB']));
  });

  it('idle timeout closes an abandoned sync with honest partial delivery', async () => {
    await fill('s1', 20);
    const server = makeServer({ ackTimeoutMs: 100_000, idleTimeoutMs: 60_000 });
    server.handleSyncRequest(request('s1', []), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 1);

    await timers.advance(60_000); // idle fires before the (100s) ack check
    expect(ofType('sync-end')).toHaveLength(1);
    expect(ofType('sync-end')[0]?.deliveredRanges).toEqual([]);
    expect(server.activeSyncCount()).toBe(0);
    expect(logs.some((l) => l.includes('idle'))).toBe(true);
  });

  it('never throws into the caller: failing sends and bogus acks are absorbed', async () => {
    await fill('s1', 10);
    sendResult = false; // every publish "fails"
    const server = makeServer({ maxRetries: 0 });
    expect(() => server.handleSyncRequest(request('s1', []), 'phoneA')).not.toThrow();
    expect(() => server.handleAck('no-such-sync', [1, 10])).not.toThrow();
    await waitFor(() => ofType('sync-chunk').length === 1);
    expect(() => server.handleAck(ofType('sync-begin')[0]!.syncId, [999, 1000])).not.toThrow();
    await timers.advance(10_000); // retries exhausted instantly (maxRetries 0)
    expect(ofType('sync-end')[0]?.deliveredRanges).toEqual([]);
  });

  it('close() aborts all in-flight syncs without sync-end', async () => {
    await fill('s1', 10);
    const server = makeServer();
    server.handleSyncRequest(request('s1', []), 'phoneA');
    server.handleSyncRequest(request('s1', []), 'phoneB');
    await waitFor(() => ofType('sync-chunk').length === 2);
    server.close();
    expect(server.activeSyncCount()).toBe(0);
    await timers.advance(500_000);
    expect(ofType('sync-end')).toHaveLength(0);
  });

  it('THE RESTART SCENARIO: seq survives restart, phone gap-fills exactly [81,120]', async () => {
    // Session runs, bridge persists 120 entries...
    await fill('s1', 120);

    // ...bridge restarts: brand-new store + server instances over the same dir.
    const restartedStore = await TranscriptStore.open(dir);
    expect(restartedStore.seqHigh('s1')).toBe(120); // old bridge: 0 (amnesia)
    const server = makeServer({ transcript: restartedStore });

    // Phone reconnects holding [1,80] and asks for the rest.
    server.handleSyncRequest(request('s1', [[1, 80]]), 'phoneA');
    await waitFor(() => ofType('sync-chunk').length === 1);

    expect(ofType('sync-begin')[0]).toMatchObject({ seqHigh: 120, ranges: [[81, 120]] });
    const chunk = ofType('sync-chunk')[0]!;
    expect(chunk.range).toEqual([81, 120]);
    expect(chunk.entries.map((e) => e.seq)).toEqual(
      Array.from({ length: 40 }, (_, i) => 81 + i),
    );
    expect(chunk.entries[0]?.entry.content).toBe('entry 81');
    expect(chunk.entries[39]?.entry.content).toBe('entry 120');

    server.handleAck(ofType('sync-begin')[0]!.syncId, [81, 120]);
    await waitFor(() => ofType('sync-end').length === 1);
    expect(ofType('sync-end')[0]?.deliveredRanges).toEqual([[81, 120]]);
  });
});
