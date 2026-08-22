/**
 * TranscriptStore: seq assignment, restart recovery, torn-line repair,
 * readRange, per-session isolation, prune without renumbering, and
 * non-interleaving concurrent appends. This is bug-B's regression suite —
 * the old bridge lost history because none of this was persisted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OutputEntry } from '@codedeck/protocol';
import { TranscriptStore } from '../session/transcript';

function entry(n: number): OutputEntry {
  return { entryType: 'text', content: `entry ${n}`, timestamp: '2026-08-05T00:00:00Z' };
}

describe('TranscriptStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-transcript-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fileFor = (sessionId: string) =>
    path.join(dir, 'transcripts', `${encodeURIComponent(sessionId)}.jsonl`);

  it('append assigns 1..N monotonically', async () => {
    const store = await TranscriptStore.open(dir);
    const seqs: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const { seq } = await store.append('s1', entry(i));
      seqs.push(seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(store.seqHigh('s1')).toBe(5);
  });

  it('seqHigh survives a NEW instance over the same dir (restart)', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 7; i++) { await store.append('s1', entry(i)); }

    const reopened = await TranscriptStore.open(dir);
    expect(reopened.seqHigh('s1')).toBe(7);
    expect(reopened.sessions()).toEqual(['s1']);

    // The next append continues the sequence — no reset, no renumbering.
    const { seq } = await reopened.append('s1', entry(8));
    expect(seq).toBe(8);
  });

  it('recovers from a torn final line by truncating it', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 3; i++) { await store.append('s1', entry(i)); }
    // Simulate a crash mid-write: a partial JSON line without trailing newline.
    await fs.appendFile(fileFor('s1'), '{"seq":4,"entry":{"entryTy');

    const reopened = await TranscriptStore.open(dir);
    expect(reopened.seqHigh('s1')).toBe(3);

    // The torn line is gone from disk and seq 4 is reassigned cleanly.
    const { seq } = await reopened.append('s1', entry(4));
    expect(seq).toBe(4);
    const lines = (await fs.readFile(fileFor('s1'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
  });

  it('readRange returns exactly the requested inclusive range', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 10; i++) { await store.append('s1', entry(i)); }
    const lines = await store.readRange('s1', [3, 6]);
    expect(lines.map((l) => l.seq)).toEqual([3, 4, 5, 6]);
    expect(lines[0]?.entry.content).toBe('entry 3');
  });

  it('readRange tolerates gaps in the file (post-prune)', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 10; i++) { await store.append('s1', entry(i)); }
    await store.prune('s1', 4); // keeps seqs 7..10
    const lines = await store.readRange('s1', [5, 8]);
    expect(lines.map((l) => l.seq)).toEqual([7, 8]);
  });

  it('readRange of an unknown session returns empty', async () => {
    const store = await TranscriptStore.open(dir);
    expect(await store.readRange('nope', [1, 100])).toEqual([]);
    expect(store.seqHigh('nope')).toBe(0);
  });

  it('sessions are isolated — independent seq counters and files', async () => {
    const store = await TranscriptStore.open(dir);
    await store.append('s1', entry(1));
    await store.append('s2', entry(1));
    await store.append('s1', entry(2));
    expect(store.seqHigh('s1')).toBe(2);
    expect(store.seqHigh('s2')).toBe(1);
    expect(new Set(store.sessions())).toEqual(new Set(['s1', 's2']));
    const s2 = await store.readRange('s2', [1, 10]);
    expect(s2.map((l) => l.seq)).toEqual([1]);
  });

  it('prune keeps the last N entries WITHOUT renumbering, seqHigh unchanged', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 20; i++) { await store.append('s1', entry(i)); }
    await store.prune('s1', 5);

    const lines = await store.readRange('s1', [1, 20]);
    expect(lines.map((l) => l.seq)).toEqual([16, 17, 18, 19, 20]);
    expect(store.seqHigh('s1')).toBe(20);

    // Restart after prune: seqHigh still recovers to 20, next seq is 21.
    const reopened = await TranscriptStore.open(dir);
    expect(reopened.seqHigh('s1')).toBe(20);
    const { seq } = await reopened.append('s1', entry(21));
    expect(seq).toBe(21);
  });

  it('prune is a no-op when the file has fewer entries than keepLast', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 3; i++) { await store.append('s1', entry(i)); }
    await store.prune('s1', 10);
    const lines = await store.readRange('s1', [1, 10]);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('concurrent appends do not interleave (50 un-awaited appends)', async () => {
    const store = await TranscriptStore.open(dir);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.append('s1', entry(i + 1))),
    );
    expect(results.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // Every line on disk parses, seqs are 1..50 in order, contents match.
    const raw = await fs.readFile(fileFor('s1'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(50);
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as { seq: number; entry: OutputEntry };
      expect(parsed.seq).toBe(i + 1);
      expect(parsed.entry.content).toBe(`entry ${i + 1}`);
    });
  });

  it('remove deletes the file and forgets the session', async () => {
    const store = await TranscriptStore.open(dir);
    await store.append('s1', entry(1));
    await store.remove('s1');
    expect(store.seqHigh('s1')).toBe(0);
    expect(store.sessions()).toEqual([]);
    await expect(fs.access(fileFor('s1'))).rejects.toThrow();
    // Removing an unknown session is a no-op, not an error.
    await expect(store.remove('never-existed')).resolves.toBeUndefined();
  });

  it('handles sessionIds needing filename encoding', async () => {
    const store = await TranscriptStore.open(dir);
    const weird = 'sess/with:odd chars?';
    await store.append(weird, entry(1));
    const reopened = await TranscriptStore.open(dir);
    expect(reopened.seqHigh(weird)).toBe(1);
    expect(reopened.sessions()).toEqual([weird]);
  });

  it('idle() drains in-flight writes so a re-open sees every append (CDX-013)', async () => {
    const store = await TranscriptStore.open(dir);
    // Fire appends WITHOUT awaiting them — the enqueued appendFiles are in
    // flight. A re-open mid-flight could read a torn line and recover a lower
    // seqHigh, re-using a seq. idle() closes that window.
    for (let i = 1; i <= 25; i++) void store.append('s1', entry(i));
    await store.idle();

    const reopened = await TranscriptStore.open(dir);
    expect(reopened.seqHigh('s1')).toBe(25);
    const lines = (await fs.readFile(fileFor('s1'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(25);
    // The next append continues from 26 — no seq is ever re-used.
    const { seq } = await reopened.append('s1', entry(26));
    expect(seq).toBe(26);
  });

  // --- CDX-066: the atomicWrite temp-name race (the CDX-060 disease class) ---

  it('CDX-066: two stores over the same dir rewrite concurrently without temp-name collisions', async () => {
    // Pre-fix, both stores (same pid, PER-INSTANCE counters) minted the
    // identical `<session>.jsonl.tmp-<pid>-<n>` sequence, so interleaved
    // rewrites renamed each other's temp file away and the loser's rename(2)
    // threw ENOENT. Only prune/recover rewrite, which is why this never showed
    // up in the append-heavy paths — but it is the same defect registry.json
    // hit as CDX-060. The shared per-process counter makes this deterministic.
    const seed = await TranscriptStore.open(dir);
    for (let i = 1; i <= 60; i++) { await seed.append('s1', entry(i)); }

    const a = await TranscriptStore.open(dir);
    const b = await TranscriptStore.open(dir);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(a.prune('s1', 50 - i));
      writes.push(b.prune('s1', 50 - i));
    }
    await Promise.all(writes); // pre-fix: a coin-flip ENOENT rejection here

    // What CDX-066 guarantees, and all it guarantees: no rejection above, and a
    // file that is still intact JSONL — every line a complete record, seqs
    // strictly increasing, and each one an original line rather than two
    // rewrites spliced together.
    const lines = (await fs.readFile(fileFor('s1'), 'utf8')).trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    let prevSeq = 0;
    for (const line of lines) {
      const parsed = JSON.parse(line) as { seq: number; entry: { content: string } };
      expect(parsed.seq).toBeGreaterThan(prevSeq);
      expect(parsed.entry.content).toBe(`entry ${parsed.seq}`); // un-torn original
      prevSeq = parsed.seq;
    }
    expect(prevSeq).toBe(60); // the newest entry is never lost by a prune race
    // No temp files were orphaned by the winning path.
    const leftovers = (await fs.readdir(path.join(dir, 'transcripts'))).filter((f) =>
      f.includes('.tmp-'),
    );
    expect(leftovers).toEqual([]);

    // KNOWN HAZARD — CDX-075, filed and UNFIXED, the same disease one file over:
    // prune() is read → filter → whole-file atomicWrite, so a second store's
    // rewrite replaces the first's outright and anything appended between the
    // loser's read and the winner's rename is dropped. Deliberately NOT asserted
    // as a line count: "whichever store renamed last wins" is the hazard, not
    // the contract, and pinning a number here would make a fix look like a
    // regression. The invariants above are what a fix must keep.
  });

  it('CDX-066: ENOENT on rename is retried as a lost race, not thrown', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 10; i++) { await store.append('s1', entry(i)); }

    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, rename 's1.jsonl.tmp-x'"), {
        code: 'ENOENT',
      }),
    );
    try {
      await store.prune('s1', 4); // must succeed via the retry
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
    const lines = (await fs.readFile(fileFor('s1'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    // Seqs are never renumbered by a prune — the file just starts higher.
    expect((JSON.parse(lines[0]!) as { seq: number }).seq).toBe(7);
    expect(store.seqHigh('s1')).toBe(10);
  });

  it('CDX-066: a non-ENOENT rename failure still surfaces and does not wedge the session queue', async () => {
    const store = await TranscriptStore.open(dir);
    for (let i = 1; i <= 10; i++) { await store.append('s1', entry(i)); }

    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    try {
      await expect(store.prune('s1', 4)).rejects.toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
    // enqueue() runs the next job regardless of its predecessor's outcome.
    const { seq } = await store.append('s1', entry(11));
    expect(seq).toBe(11);
    await store.prune('s1', 3);
    expect((await store.readRange('s1', [1, 100])).length).toBe(3);
  });
});
