/**
 * transcriptStore — haveRanges + insert-or-ignore dedup + the sync client's
 * bounded attempts / backoff / reconnect reset (the structural replacement of
 * bug B's never-reset autoHistoryRequested Set).
 */
import { describe, it, expect } from 'vitest';
import type { OutputEntry, PhoneToBridgeMessage, SeqRange } from '@codedeck/protocol';
import {
  SYNC_MAX_ATTEMPTS,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX_MS,
  createTranscriptStore,
  syncRetryDelayMs,
} from '../stores/transcript';
import { memoryTranscriptStorage } from '../ports';

const entry = (content: string): OutputEntry => ({
  entryType: 'text',
  content,
  timestamp: new Date(0).toISOString(),
});

function harness(opts: { maxAttempts?: number } = {}) {
  const storage = memoryTranscriptStorage();
  const sent: Array<{ machine: string; msg: PhoneToBridgeMessage }> = [];
  let nowMs = 0;
  const store = createTranscriptStore({
    storage,
    send: (machine, msg) => sent.push({ machine, msg }),
    now: () => nowMs,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  });
  return {
    storage,
    sent,
    store,
    s: () => store.getState(),
    setNow: (ms: number) => { nowMs = ms; },
    syncRequests: () => sent.filter((x) => x.msg.type === 'sync-request'),
    acks: () => sent.filter((x) => x.msg.type === 'sync-ack'),
  };
}

describe('transcriptStore — entries, dedup, haveRanges', () => {
  it('applyOutput builds haveRanges and localHigh; duplicates are ignored', async () => {
    const h = harness();
    await h.s().applyOutput('m', 'sess', 1, entry('one'));
    await h.s().applyOutput('m', 'sess', 2, entry('two'));
    await h.s().applyOutput('m', 'sess', 5, entry('five'));
    await h.s().applyOutput('m', 'sess', 2, entry('two')); // dup, identical — ignored quietly
    await h.s().flush();

    expect(h.s().haveRangesOf('m', 'sess')).toEqual([[1, 2], [5, 5]]);
    expect(h.s().session('m', 'sess')!.localHigh).toBe(5);
    expect(h.s().entriesOf('m', 'sess').map((e) => e.seq)).toEqual([1, 2, 5]);
    expect(h.s().seqConflicts).toEqual([]);
    expect(h.s().hasContiguous('m', 'sess')).toBe(false);
    expect(await h.storage.seqs('m', 'sess')).toEqual([1, 2, 5]);
  });

  it('a seq re-arriving with DIFFERENT content is a recorded conflict, not applied', async () => {
    const h = harness();
    await h.s().applyOutput('m', 'sess', 3, entry('original'));
    await h.s().applyOutput('m', 'sess', 3, entry('renumbered!'));
    await h.s().flush();
    expect(h.s().seqConflicts).toEqual([{ machine: 'm', sessionId: 'sess', seq: 3 }]);
    expect(h.s().entriesOf('m', 'sess')[0]!.entry.content).toBe('original');
  });

  it('hydrateSession restores coverage from the storage port (boot path)', async () => {
    const storage = memoryTranscriptStorage();
    await storage.insertIgnore('m', 'sess', [
      { seq: 1, entry: entry('a') },
      { seq: 2, entry: entry('b') },
      { seq: 4, entry: entry('d') },
    ]);
    const store = createTranscriptStore({ storage, send: () => {}, now: () => 0 });
    await store.getState().hydrateSession('m', 'sess');
    expect(store.getState().haveRangesOf('m', 'sess')).toEqual([[1, 2], [4, 4]]);
    expect(store.getState().entriesOf('m', 'sess').length).toBe(3);
  });

  it('removeSession drops state AND persisted rows', async () => {
    const h = harness();
    await h.s().applyOutput('m', 'sess', 1, entry('a'));
    await h.s().removeSession('m', 'sess');
    expect(h.s().session('m', 'sess')).toBeUndefined();
    expect(await h.storage.seqs('m', 'sess')).toEqual([]);
  });
});

describe('transcriptStore — sync client', () => {
  it('ensureSynced sends a sync-request carrying the REAL haveRanges', async () => {
    const h = harness();
    await h.s().applyOutput('m', 'sess', 1, entry('a'));
    await h.s().applyOutput('m', 'sess', 2, entry('b'));
    await h.s().ensureSynced('m', 'sess', 10);
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(1);
    expect(h.syncRequests()[0]!.msg).toMatchObject({
      type: 'sync-request',
      sessionId: 'sess',
      haveRanges: [[1, 2]],
    });
    expect(h.s().session('m', 'sess')!.sync.state).toBe('requested');
  });

  it('ensureSynced is idempotent while a cycle is in flight (no request storm)', async () => {
    const h = harness();
    await h.s().ensureSynced('m', 'sess', 10);
    await h.s().ensureSynced('m', 'sess', 12);
    await h.s().ensureSynced('m', 'sess', 12);
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(1);
    expect(h.s().session('m', 'sess')!.sync.target).toBe(12); // target still raised
  });

  it('already covered → complete, no request', async () => {
    const h = harness();
    await h.s().applyOutput('m', 'sess', 1, entry('a'));
    await h.s().applyOutput('m', 'sess', 2, entry('b'));
    await h.s().ensureSynced('m', 'sess', 2);
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(0);
    expect(h.s().session('m', 'sess')!.sync.state).toBe('complete');
  });

  it('chunks are stored (dedup) and acked AFTER storage; sync-end completes when covered', async () => {
    const h = harness();
    await h.s().ensureSynced('m', 'sess', 3);
    await h.s().applySyncBegin('m', { type: 'sync-begin', sessionId: 'sess', syncId: 'sy1', seqHigh: 3, ranges: [[1, 3]] });
    expect(h.s().session('m', 'sess')!.sync.state).toBe('syncing');
    await h.s().applySyncChunk('m', {
      type: 'sync-chunk',
      sessionId: 'sess',
      syncId: 'sy1',
      range: [1, 3],
      entries: [
        { seq: 1, entry: entry('a') },
        { seq: 2, entry: entry('b') },
        { seq: 3, entry: entry('c') },
      ],
    });
    await h.s().flush();
    expect(h.acks()).toHaveLength(1);
    expect(h.acks()[0]!.msg).toMatchObject({ type: 'sync-ack', syncId: 'sy1', range: [1, 3] });
    expect(await h.storage.seqs('m', 'sess')).toEqual([1, 2, 3]);

    await h.s().applySyncEnd('m', { type: 'sync-end', sessionId: 'sess', syncId: 'sy1', deliveredRanges: [[1, 3]] });
    const sync = h.s().session('m', 'sess')!.sync;
    expect(sync.state).toBe('complete');
    expect(sync.attempts).toBe(0);
    expect(h.s().hasContiguous('m', 'sess', 3)).toBe(true);
  });

  it('an incomplete sync-end re-requests immediately while attempts remain', async () => {
    const h = harness();
    await h.s().ensureSynced('m', 'sess', 4);
    await h.s().applySyncBegin('m', { type: 'sync-begin', sessionId: 'sess', syncId: 'sy1', seqHigh: 4, ranges: [[1, 4]] });
    // Only [3,4] arrives; [1,2] was lost on the wire.
    await h.s().applySyncChunk('m', {
      type: 'sync-chunk', sessionId: 'sess', syncId: 'sy1', range: [3, 4],
      entries: [{ seq: 3, entry: entry('c') }, { seq: 4, entry: entry('d') }],
    });
    await h.s().applySyncEnd('m', { type: 'sync-end', sessionId: 'sess', syncId: 'sy1', deliveredRanges: [[3, 4]] });
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(2);
    expect(h.syncRequests()[1]!.msg).toMatchObject({ haveRanges: [[3, 4]] });
    expect(h.s().session('m', 'sess')!.sync.state).toBe('requested');
    expect(h.s().session('m', 'sess')!.sync.attempts).toBe(2);
  });

  it('attempts exhausted → failed WITH a retry timestamp (never permanent), retrySweep retries after backoff', async () => {
    const h = harness();
    // Exhaust: each cycle = request + empty-handed sync-end.
    for (let i = 0; i < SYNC_MAX_ATTEMPTS; i++) {
      if (i === 0) await h.s().ensureSynced('m', 'sess', 5);
      await h.s().applySyncEnd('m', { type: 'sync-end', sessionId: 'sess', syncId: `sy${i}`, deliveredRanges: [] });
    }
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(SYNC_MAX_ATTEMPTS);
    const sync = h.s().session('m', 'sess')!.sync;
    expect(sync.state).toBe('failed');
    expect(sync.nextRetryAt).toBeGreaterThan(0);

    // Backoff not elapsed: neither ensureSynced nor retrySweep fires.
    await h.s().ensureSynced('m', 'sess', 5);
    await h.s().retrySweep();
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(SYNC_MAX_ATTEMPTS);

    // Backoff elapsed: retrySweep starts a new cycle.
    h.setNow(sync.nextRetryAt!);
    await h.s().retrySweep();
    await h.s().flush();
    expect(h.syncRequests()).toHaveLength(SYNC_MAX_ATTEMPTS + 1);
  });

  it('onReconnect resets failed AND stuck in-flight cycles — a fresh connection always gets a fresh chance', async () => {
    const h = harness({ maxAttempts: 1 });
    await h.s().ensureSynced('m', 'a', 3); // will fail
    await h.s().applySyncEnd('m', { type: 'sync-end', sessionId: 'a', syncId: 'x', deliveredRanges: [] });
    await h.s().ensureSynced('m', 'b', 3); // stays stuck in flight (responses lost)
    await h.s().flush();
    expect(h.s().session('m', 'a')!.sync.state).toBe('failed');
    expect(h.s().session('m', 'b')!.sync.state).toBe('requested');

    h.s().onReconnect();
    expect(h.s().session('m', 'a')!.sync).toMatchObject({ state: 'idle', attempts: 0, nextRetryAt: null });
    expect(h.s().session('m', 'b')!.sync.state).toBe('idle');

    // And the next ensureSynced fires immediately — no leftover backoff gate.
    await h.s().ensureSynced('m', 'a', 3);
    await h.s().flush();
    expect(h.syncRequests().filter((r) => (r.msg as { sessionId?: string }).sessionId === 'a')).toHaveLength(2);
  });

  it('syncRetryDelayMs backs off exponentially to the cap', () => {
    expect(syncRetryDelayMs(1)).toBe(SYNC_RETRY_BASE_MS);
    expect(syncRetryDelayMs(2)).toBe(SYNC_RETRY_BASE_MS * 2);
    expect(syncRetryDelayMs(3)).toBe(SYNC_RETRY_BASE_MS * 4);
    expect(syncRetryDelayMs(30)).toBe(SYNC_RETRY_MAX_MS);
  });

  it('live output arriving during a sync raises coverage without conflicts', async () => {
    const h = harness();
    await h.s().ensureSynced('m', 'sess', 3);
    await h.s().applyOutput('m', 'sess', 4, entry('live')); // concurrent live tail
    await h.s().applySyncBegin('m', { type: 'sync-begin', sessionId: 'sess', syncId: 'sy', seqHigh: 3, ranges: [[1, 3]] });
    await h.s().applySyncChunk('m', {
      type: 'sync-chunk', sessionId: 'sess', syncId: 'sy', range: [1, 3],
      entries: [1, 2, 3].map((seq) => ({ seq, entry: entry(`e${seq}`) })),
    });
    await h.s().applySyncEnd('m', { type: 'sync-end', sessionId: 'sess', syncId: 'sy', deliveredRanges: [[1, 3]] });
    await h.s().flush();
    expect(h.s().hasContiguous('m', 'sess', 4)).toBe(true);
    expect(h.s().seqConflicts).toEqual([]);
    expect(h.s().session('m', 'sess')!.sync.state).toBe('complete');
  });
});

describe('transcriptStore — range coverage sanity', () => {
  it('haveRanges never regresses over random insert orders', async () => {
    const h = harness();
    const seqs = [7, 1, 3, 2, 9, 8, 4, 6, 5, 10];
    const covered: SeqRange[][] = [];
    for (const seq of seqs) {
      await h.s().applyOutput('m', 'sess', seq, entry(`e${seq}`));
      covered.push(h.s().haveRangesOf('m', 'sess'));
    }
    await h.s().flush();
    expect(h.s().haveRangesOf('m', 'sess')).toEqual([[1, 10]]);
    // Coverage grows monotonically.
    const sizes = covered.map((r) => r.reduce((n, [a, b]) => n + b - a + 1, 0));
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });
});
